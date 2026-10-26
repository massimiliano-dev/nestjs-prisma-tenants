import type { DbAdapter, TenantRecord, TenantStatus } from '../src/index.js';

export function tenant(slug: string, overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: `id-${slug}`,
    slug,
    status: 'active' as TenantStatus,
    dbName: `tenant_${slug}`,
    secretRef: `env:URL_${slug.toUpperCase()}`,
    schemaVersion: null,
    connectionLimit: 2,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
    ...overrides,
  };
}

export interface FakeClient {
  slug: string;
  url: string;
  closed: boolean;
}

/** Adapter whose clients are plain objects; `down` makes ping fail like an unreachable server. */
export function fakeAdapter(options: { down?: Set<string>; createDelayMs?: number } = {}) {
  const created: FakeClient[] = [];
  const adapter: DbAdapter<FakeClient> = {
    async create({ url, tenant }) {
      if (options.createDelayMs) await new Promise((r) => setTimeout(r, options.createDelayMs));
      const client = { slug: tenant.slug, url, closed: false };
      created.push(client);
      return client;
    },
    async ping(client) {
      if (options.down?.has(client.slug)) {
        throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5432`), { code: 'ECONNREFUSED' });
      }
    },
    async disconnect(client) {
      client.closed = true;
    },
  };
  return { adapter, created };
}

export function envFor(slugs: string[]): Record<string, string> {
  return Object.fromEntries(
    slugs.map((s) => [`URL_${s.toUpperCase()}`, `postgresql://u:p@localhost:5432/tenant_${s}`]),
  );
}
