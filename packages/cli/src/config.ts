import type {
  Migrator,
  SecretProvider,
  TenantIsolationOptions,
  TenantRecord,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

export interface TenantsCliConfig {
  /** Database holding the tenant registry. */
  controlDatabaseUrl: string;
  /** Role with CREATEDB on the tenant server. Defaults to `controlDatabaseUrl`. */
  adminDatabaseUrl?: string;
  /** Needed by `migrate`, `create` and the "behind" column. Usually a `PrismaMigrator`. */
  migrator?: Migrator;
  /** Default: environment variables (`env:NAME`). */
  secretProviders?: SecretProvider[];
  defaultConnectionLimit?: number;
  dbNameFor?: (slug: string) => string;
  secretRefFor?: (slug: string, dbName: string) => string;
  /** How new tenant databases are locked down. All protections are on by default. */
  isolation?: TenantIsolationOptions;
  /** Initial data for new tenants. Receives the tenant connection URL. */
  seed?: (ctx: { url: string; tenant: TenantRecord }) => Promise<void>;
}

/** Identity helper that gives `tenants.config.ts` full type checking. */
export function defineTenantsConfig(config: TenantsCliConfig): TenantsCliConfig {
  return config;
}
