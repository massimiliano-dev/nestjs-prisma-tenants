import { describe, expect, it, vi } from 'vitest';
import {
  EnvSecretProvider,
  SecretResolver,
  TenantClientManager,
  TenantDbUnavailableError,
  TenantNotFoundError,
  worstCaseConnections,
  type TenantLookup,
} from '../src/index.js';
import { envFor, fakeAdapter, tenant } from './helpers.js';

function setup(opts: {
  slugs: string[];
  max?: number;
  down?: Set<string>;
  createDelayMs?: number;
  idleTtlMs?: number;
}) {
  const records = new Map(opts.slugs.map((s) => [s, tenant(s)]));
  const lookup: TenantLookup = {
    async getActive(slug) {
      const record = records.get(slug);
      if (!record) throw new TenantNotFoundError(slug);
      return record;
    },
  };
  const { adapter, created } = fakeAdapter({
    ...(opts.down ? { down: opts.down } : {}),
    ...(opts.createDelayMs ? { createDelayMs: opts.createDelayMs } : {}),
  });
  const warn = vi.fn();
  const manager = new TenantClientManager({
    lookup,
    adapter,
    secrets: new SecretResolver([new EnvSecretProvider(envFor(opts.slugs))]),
    cache: { max: opts.max ?? 3, idleTtlMs: opts.idleTtlMs ?? 60_000, maxConnectionsBudget: 5 },
    breaker: { failureThreshold: 2, resetTimeoutMs: 50 },
    reservedConnections: 1,
    logger: { debug() {}, info() {}, warn, error() {} },
  });
  return { manager, created, warn };
}

describe('TenantClientManager', () => {
  it('caches one client per tenant and applies the connection limit to the URL', async () => {
    const { manager, created } = setup({ slugs: ['a', 'b'] });
    const first = await manager.get('a');
    expect(await manager.get('a')).toBe(first);
    expect(first.url).toContain('connection_limit=2');
    await manager.get('b');
    expect(created).toHaveLength(2);
    expect(manager.stats()).toMatchObject({ size: 2, hits: 1, misses: 2 });
  });

  it('evicts the least recently used client and disconnects it', async () => {
    const { manager, created, warn } = setup({ slugs: ['a', 'b', 'c', 'd'], max: 3 });
    for (const slug of ['a', 'b', 'c']) await manager.get(slug);
    await manager.get('a'); // a becomes most recent
    await manager.get('d'); // evicts b
    expect(created.find((c) => c.slug === 'b')?.closed).toBe(true);
    expect(created.find((c) => c.slug === 'a')?.closed).toBe(false);
    expect(manager.stats()).toMatchObject({ size: 3, evictions: 1 });
    // 3 clients x 2 connections + 1 reserved = 7 > budget 5
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget'), expect.anything());
  });

  it('disconnects idle clients after the TTL', async () => {
    const { manager, created } = setup({ slugs: ['a'], idleTtlMs: 20 });
    await manager.get('a');
    await new Promise((r) => setTimeout(r, 80));
    expect(created[0]?.closed).toBe(true);
    expect(manager.stats().size).toBe(0);
  });

  it('creates a cold client once for concurrent requests (single flight)', async () => {
    const { manager, created } = setup({ slugs: ['a'], createDelayMs: 20 });
    const clients = await Promise.all(Array.from({ length: 25 }, () => manager.get('a')));
    expect(new Set(clients).size).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('isolates an unreachable tenant and fails fast once its circuit opens', async () => {
    const down = new Set(['bad']);
    const { manager } = setup({ slugs: ['good', 'bad'], down });
    await expect(manager.get('bad')).rejects.toBeInstanceOf(TenantDbUnavailableError);
    await expect(manager.get('bad')).rejects.toBeInstanceOf(TenantDbUnavailableError);
    expect(manager.circuitState('bad')).toBe('open');
    const error = await manager.get('bad').catch((e: TenantDbUnavailableError) => e);
    expect(error).toMatchObject({ circuitState: 'open' });
    await expect(manager.get('good')).resolves.toMatchObject({ slug: 'good' });

    down.delete('bad');
    await new Promise((r) => setTimeout(r, 60));
    await expect(manager.get('bad')).resolves.toMatchObject({ slug: 'bad' });
    expect(manager.circuitState('bad')).toBe('closed');
  });

  it('opens the circuit from reported query-time errors and evicts the client', async () => {
    const { manager, created } = setup({ slugs: ['a'] });
    await manager.get('a');
    const err = Object.assign(new Error('terminated'), { code: '57P01' });
    manager.reportError('a', err);
    manager.reportError('a', new Error('business error'));
    manager.reportError('a', err);
    expect(manager.circuitState('a')).toBe('open');
    expect(created[0]?.closed).toBe(true);
  });

  it('shuts down every client', async () => {
    const { manager, created } = setup({ slugs: ['a', 'b'] });
    await manager.get('a');
    await manager.get('b');
    await manager.shutdown();
    expect(created.every((c) => c.closed)).toBe(true);
    await expect(manager.get('a')).rejects.toThrow(/shut down/);
  });

  it('computes worst-case connections', () => {
    expect(worstCaseConnections({ cacheMax: 20, connectionLimit: 3, reservedConnections: 3 })).toBe(63);
  });
});
