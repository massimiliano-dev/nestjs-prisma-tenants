import { LRUCache } from 'lru-cache';
import { TenantDbUnavailableError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { TenantLookup } from '../registry/tenant-registry.js';
import type { SecretResolver } from '../secrets/secret-provider.js';
import type { DbAdapter, Logger, TenantRecord } from '../types.js';
import { buildTenantUrl } from '../url/build-tenant-url.js';
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from './circuit-breaker.js';
import { isConnectivityError, TenantPingTimeoutError } from './connectivity-errors.js';

export interface TenantClientCacheOptions {
  /** Maximum number of tenant clients (and pools) kept open. Default 20. */
  max?: number;
  /** A client unused for this long is disconnected. Default 10 minutes. */
  idleTtlMs?: number;
  /**
   * Connections this process may open in total, control DB included. Default 90, leaving room
   * under PostgreSQL's default `max_connections` of 100. Exceeding it logs a warning.
   */
  maxConnectionsBudget?: number;
}

export interface TenantClientManagerOptions<TClient> {
  lookup: TenantLookup;
  secrets: SecretResolver;
  adapter: DbAdapter<TClient>;
  cache?: TenantClientCacheOptions;
  breaker?: CircuitBreakerOptions & { pingTimeoutMs?: number };
  /** Connections already used by this process outside tenant pools (e.g. the control DB pool). */
  reservedConnections?: number;
  /** Ping new clients before handing them out. Default true. */
  pingOnCreate?: boolean;
  logger?: Logger;
}

export interface TenantHealth {
  slug: string;
  ok: boolean;
  latencyMs: number;
  circuit: CircuitState;
  error?: string;
}

export interface TenantClientManagerStats {
  size: number;
  max: number;
  hits: number;
  misses: number;
  evictions: number;
  openConnectionsEstimate: number;
  maxConnectionsBudget: number;
  circuits: Record<string, CircuitState>;
}

interface Entry<TClient> {
  client: TClient;
  connectionLimit: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TenantPingTimeoutError(timeoutMs)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Keeps at most `cache.max` tenant clients open, closing the least recently used and the idle
 * ones. Concurrent requests for the same cold tenant share one client creation (single flight).
 * Each tenant has its own circuit breaker, so an unreachable database fails fast and alone.
 */
export class TenantClientManager<TClient> {
  private readonly cache: LRUCache<string, Entry<TClient>>;
  private readonly inflight = new Map<string, Promise<TClient>>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly pendingDisconnects = new Set<Promise<void>>();
  private readonly logger: Logger;
  private readonly budget: number;
  private readonly reserved: number;
  private readonly pingTimeoutMs: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private closed = false;

  constructor(private readonly options: TenantClientManagerOptions<TClient>) {
    this.logger = options.logger ?? silentLogger;
    this.budget = options.cache?.maxConnectionsBudget ?? 90;
    this.reserved = options.reservedConnections ?? 0;
    this.pingTimeoutMs = options.breaker?.pingTimeoutMs ?? 2_000;
    this.cache = new LRUCache<string, Entry<TClient>>({
      max: options.cache?.max ?? 20,
      ttl: options.cache?.idleTtlMs ?? 10 * 60_000,
      updateAgeOnGet: true,
      ttlAutopurge: true,
      dispose: (entry, slug, reason) => {
        if (reason !== 'set' && reason !== 'delete') this.evictions += 1;
        this.logger.debug('closing tenant client', { slug, reason });
        this.disconnect(slug, entry.client);
      },
    });
  }

  /** Client for an active tenant, looked up in the registry by slug. */
  async get(slug: string): Promise<TClient> {
    return this.getForRecord(await this.options.lookup.getActive(slug));
  }

  /** Client for a tenant record you already hold (skips the registry lookup). */
  async getForRecord(tenant: TenantRecord): Promise<TClient> {
    if (this.closed) throw new Error('TenantClientManager has been shut down');
    const cached = this.cache.get(tenant.slug);
    if (cached) {
      this.hits += 1;
      return cached.client;
    }
    const running = this.inflight.get(tenant.slug);
    if (running) return running;

    const breaker = this.breakerFor(tenant.slug);
    if (!breaker.tryAcquire()) throw new TenantDbUnavailableError(tenant.slug, breaker.state);

    this.misses += 1;
    const creation = this.create(tenant, breaker).finally(() => this.inflight.delete(tenant.slug));
    this.inflight.set(tenant.slug, creation);
    return creation;
  }

  /**
   * Report an error raised while using a tenant client. Connectivity errors count towards the
   * tenant's circuit; when it opens, the client is closed so the next request fails fast.
   */
  reportError(slug: string, error: unknown): void {
    if (!isConnectivityError(error)) return;
    const breaker = this.breakerFor(slug);
    breaker.onFailure();
    if (breaker.state === 'open') {
      this.logger.warn('tenant circuit opened', { slug, failures: breaker.consecutiveFailures });
      this.cache.delete(slug);
    }
  }

  async ping(slug: string): Promise<TenantHealth> {
    const started = performance.now();
    const breaker = this.breakerFor(slug);
    try {
      const client = await this.get(slug);
      await withTimeout(this.options.adapter.ping(client), this.pingTimeoutMs);
      return { slug, ok: true, latencyMs: Math.round(performance.now() - started), circuit: breaker.state };
    } catch (error) {
      this.reportError(slug, error);
      return {
        slug,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        circuit: breaker.state,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Closes a tenant's client, e.g. after archiving it or rotating its secret. */
  async evict(slug: string): Promise<void> {
    this.cache.delete(slug);
    await Promise.allSettled([...this.pendingDisconnects]);
  }

  circuitState(slug: string): CircuitState {
    return this.breakers.get(slug)?.state ?? 'closed';
  }

  stats(): TenantClientManagerStats {
    let open = this.reserved;
    for (const entry of this.cache.values()) open += entry.connectionLimit;
    const circuits: Record<string, CircuitState> = {};
    for (const [slug, breaker] of this.breakers) circuits[slug] = breaker.state;
    return {
      size: this.cache.size,
      max: this.cache.max,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      openConnectionsEstimate: open,
      maxConnectionsBudget: this.budget,
      circuits,
    };
  }

  /** Closes every client. Call it on application shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inflight.values()]);
    this.cache.clear();
    await Promise.allSettled([...this.pendingDisconnects]);
  }

  private async create(tenant: TenantRecord, breaker: CircuitBreaker): Promise<TClient> {
    const { adapter } = this.options;
    const connectionLimit = tenant.connectionLimit;
    let client: TClient | undefined;
    try {
      const secret = await this.options.secrets.resolve(tenant.secretRef);
      const url = buildTenantUrl(secret, { connectionLimit });
      client = await adapter.create({ url, tenant, connectionLimit });
      if (this.options.pingOnCreate ?? true) await withTimeout(adapter.ping(client), this.pingTimeoutMs);
    } catch (error) {
      if (client !== undefined) this.disconnect(tenant.slug, client);
      if (isConnectivityError(error)) {
        breaker.onFailure();
        throw new TenantDbUnavailableError(tenant.slug, breaker.state, { cause: error });
      }
      // Not a connectivity problem (bad secret, bug): release the half-open trial without penalty.
      breaker.releaseTrial();
      throw error;
    }
    breaker.onSuccess();
    if (this.closed) {
      this.disconnect(tenant.slug, client);
      throw new Error('TenantClientManager has been shut down');
    }
    this.cache.set(tenant.slug, { client, connectionLimit });
    this.checkBudget();
    return client;
  }

  private disconnect(slug: string, client: TClient): void {
    const pending = this.options.adapter
      .disconnect(client)
      .catch((error: unknown) =>
        this.logger.warn('failed to close tenant client', { slug, error: String(error) }),
      )
      .finally(() => this.pendingDisconnects.delete(pending));
    this.pendingDisconnects.add(pending);
  }

  private breakerFor(slug: string): CircuitBreaker {
    let breaker = this.breakers.get(slug);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options.breaker);
      this.breakers.set(slug, breaker);
    }
    return breaker;
  }

  private checkBudget(): void {
    const { openConnectionsEstimate } = this.stats();
    if (openConnectionsEstimate > this.budget) {
      this.logger.warn('tenant connection budget exceeded; lower cache.max or per-tenant connection limits', {
        openConnectionsEstimate,
        maxConnectionsBudget: this.budget,
      });
    }
  }
}

/** Worst-case connections for a configuration. Use it to size `cache.max` against `max_connections`. */
export function worstCaseConnections(options: {
  cacheMax: number;
  connectionLimit: number;
  reservedConnections?: number;
}): number {
  return options.cacheMax * options.connectionLimit + (options.reservedConnections ?? 0);
}
