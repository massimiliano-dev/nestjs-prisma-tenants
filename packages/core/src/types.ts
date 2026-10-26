export const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'archived', 'failed'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** One row of the control database `tenants` table. Never contains credentials. */
export interface TenantRecord {
  id: string;
  slug: string;
  status: TenantStatus;
  dbName: string;
  /** Reference to the connection secret, e.g. `env:TENANT_ACME_DATABASE_URL` or `akv://vault/secret`. */
  secretRef: string;
  /** Name of the last migration applied to the tenant database, as last recorded by the migrator. */
  schemaVersion: string | null;
  /** Maximum size of this tenant's connection pool. */
  connectionLimit: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ClientFactoryContext {
  /** Full connection URL, with `connection_limit` already applied. Treat as a secret. */
  url: string;
  tenant: TenantRecord;
  connectionLimit: number;
}

/**
 * Boundary between the toolkit and an ORM. The Prisma adapter lives in
 * `@massimiliano-dev/nestjs-prisma-tenants-prisma`; any other client (Drizzle, raw `pg`) can implement it.
 */
export interface DbAdapter<TClient> {
  create(ctx: ClientFactoryContext): TClient | Promise<TClient>;
  /** Cheap round trip, e.g. `SELECT 1`. Used for health checks and to validate new clients. */
  ping(client: TClient): Promise<void>;
  disconnect(client: TClient): Promise<void>;
}

/** Minimal request shape shared by Express, Fastify and plain Node `IncomingMessage`. */
export interface TenantRequestLike {
  headers: Record<string, string | string[] | undefined>;
  hostname?: string | undefined;
  url?: string | undefined;
}
