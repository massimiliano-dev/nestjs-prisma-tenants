import { TenantClientManager, type TenantClientCacheOptions } from './clients/tenant-client-manager.js';
import type { CircuitBreakerOptions } from './clients/circuit-breaker.js';
import { consoleLogger } from './logger.js';
import { runMigrations, type Migrator, type RunMigrationsOptions } from './migrate/migrator.js';
import { TenantProvisioner, type TenantIsolationOptions } from './provision/provisioner.js';
import { ControlDb } from './registry/control-db.js';
import { TenantRegistry, type TenantRegistryOptions } from './registry/tenant-registry.js';
import { EnvSecretProvider, SecretResolver, type SecretProvider } from './secrets/secret-provider.js';
import type { DbAdapter, Logger } from './types.js';

export interface TenantsCoreOptions<TClient> {
  /** Database holding the tenant registry. */
  controlDatabaseUrl: string;
  /** Role with CREATEDB on the tenant server. Defaults to `controlDatabaseUrl`. */
  adminDatabaseUrl?: string;
  adapter: DbAdapter<TClient>;
  migrator?: Migrator;
  /** Default: environment variables (`env:NAME`). */
  secretProviders?: SecretProvider[];
  cache?: TenantClientCacheOptions;
  breaker?: CircuitBreakerOptions & { pingTimeoutMs?: number };
  registry?: TenantRegistryOptions & { poolMax?: number };
  /** How new tenant databases are locked down. All protections are on by default. */
  isolation?: TenantIsolationOptions;
  /** Apply control-DB migrations on startup. Default true. */
  migrateControlDb?: boolean;
  logger?: Logger;
}

export interface TenantsRuntime<TClient> {
  controlDb: ControlDb;
  registry: TenantRegistry;
  secrets: SecretResolver;
  manager: TenantClientManager<TClient>;
  provisioner: TenantProvisioner;
  migrator: Migrator | undefined;
  migrate(
    options?: Omit<RunMigrationsOptions, 'registry' | 'migrator' | 'secrets'>,
  ): ReturnType<typeof runMigrations>;
  close(): Promise<void>;
}

/** Wires the registry, secrets, client manager and provisioner from one options object. */
export async function createTenantsRuntime<TClient>(
  options: TenantsCoreOptions<TClient>,
): Promise<TenantsRuntime<TClient>> {
  const logger = options.logger ?? consoleLogger;
  const controlDb = new ControlDb({
    url: options.controlDatabaseUrl,
    poolMax: options.registry?.poolMax ?? 3,
  });
  if (options.migrateControlDb ?? true) {
    await controlDb.migrate();
    if (controlDb.hardeningWarning) logger.warn(controlDb.hardeningWarning);
  }

  const registry = new TenantRegistry(controlDb, options.registry);
  const secrets = new SecretResolver(options.secretProviders ?? [new EnvSecretProvider()]);
  const manager = new TenantClientManager<TClient>({
    lookup: registry,
    secrets,
    adapter: options.adapter,
    reservedConnections: controlDb.poolMax,
    logger,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.breaker ? { breaker: options.breaker } : {}),
  });
  const provisioner = new TenantProvisioner({
    registry,
    secrets,
    adminDatabaseUrl: options.adminDatabaseUrl ?? options.controlDatabaseUrl,
    logger,
    onArchived: (slug) => manager.evict(slug),
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(options.migrator ? { migrator: options.migrator } : {}),
  });

  return {
    controlDb,
    registry,
    secrets,
    manager,
    provisioner,
    migrator: options.migrator,
    migrate(runOptions = {}) {
      if (!options.migrator) throw new Error('No migrator configured');
      return runMigrations({ ...runOptions, registry, migrator: options.migrator, secrets });
    },
    async close() {
      await manager.shutdown();
      await controlDb.close();
    },
  };
}
