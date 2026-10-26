import { TenantMigrationError } from '../errors.js';
import type { SecretResolver } from '../secrets/secret-provider.js';
import type { TenantRecord, TenantStatus } from '../types.js';
import { redactSecrets } from '../url/build-tenant-url.js';
import { createLimiter } from './limit.js';

/** Applies the tenant schema to one database. The Prisma implementation spawns `prisma migrate deploy`. */
export interface Migrator {
  /** Name of the newest migration shipped with the application, or null if there is none. */
  targetVersion(): Promise<string | null>;
  /** Name of the newest migration applied to the database at `url`, or null. */
  appliedVersion(url: string): Promise<string | null>;
  /** Migrations that `deploy` would apply. */
  pendingMigrations(url: string): Promise<string[]>;
  deploy(url: string): Promise<{ applied: string[]; version: string | null; output?: string }>;
}

export type TenantMigrationStatus = 'migrated' | 'up-to-date' | 'would-migrate' | 'failed' | 'skipped';

export interface TenantMigrationResult {
  slug: string;
  status: TenantMigrationStatus;
  from: string | null;
  to: string | null;
  applied: string[];
  durationMs: number;
  error?: string;
  output?: string;
}

export interface MigrationReport {
  target: string | null;
  dryRun: boolean;
  canary: string | null;
  /** True when the canary failed and the remaining tenants were not touched. */
  aborted: boolean;
  results: TenantMigrationResult[];
  failed: TenantMigrationResult[];
  /** Non-archived tenants whose recorded schema version is not the target after the run. */
  behind: { slug: string; status: TenantStatus; version: string | null }[];
}

export interface MigrationRegistry {
  list(filter?: { status?: TenantStatus[] }): Promise<TenantRecord[]>;
  setSchemaVersion(slug: string, version: string | null): Promise<void>;
}

export interface RunMigrationsOptions {
  registry: MigrationRegistry;
  migrator: Migrator;
  secrets: SecretResolver;
  /** Explicit slugs. When omitted, every active tenant is migrated. */
  tenants?: string[];
  /** Default 5. Each tenant migration holds one connection and, with Prisma, one child process. */
  concurrency?: number;
  dryRun?: boolean;
  /** Migrate this tenant first (or the first candidate if `true`) and stop if it fails. */
  canary?: string | boolean;
  /** Also migrate suspended tenants when running on all tenants. */
  includeSuspended?: boolean;
  onResult?: (result: TenantMigrationResult) => void;
}

const MIGRATABLE: TenantStatus[] = ['active', 'suspended', 'provisioning', 'failed'];

async function migrateOne(
  tenant: TenantRecord,
  target: string | null,
  options: RunMigrationsOptions,
): Promise<TenantMigrationResult> {
  const started = performance.now();
  const base = {
    slug: tenant.slug,
    from: tenant.schemaVersion,
    to: tenant.schemaVersion,
    applied: [] as string[],
  };
  const done = (partial: Partial<TenantMigrationResult> & { status: TenantMigrationStatus }) => ({
    ...base,
    ...partial,
    durationMs: Math.round(performance.now() - started),
  });

  try {
    const url = await options.secrets.resolve(tenant.secretRef);
    const before = await options.migrator.appliedVersion(url);
    if (options.dryRun) {
      const pending = await options.migrator.pendingMigrations(url);
      return done({
        status: pending.length ? 'would-migrate' : 'up-to-date',
        from: before,
        to: target,
        applied: pending,
      });
    }
    if (before === target) {
      if (tenant.schemaVersion !== before) await options.registry.setSchemaVersion(tenant.slug, before);
      return done({ status: 'up-to-date', from: before, to: before });
    }
    const result = await options.migrator.deploy(url);
    await options.registry.setSchemaVersion(tenant.slug, result.version);
    return done({ status: 'migrated', from: before, to: result.version, applied: result.applied });
  } catch (error) {
    const output = error instanceof TenantMigrationError ? error.output : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return done({ status: 'failed', error: redactSecrets(message), ...(output ? { output } : {}) });
  }
}

/**
 * Migrates tenant databases with bounded concurrency. With `canary`, one tenant goes first and a
 * failure aborts the run. The report lists failures and tenants still behind the target version.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationReport> {
  const target = await options.migrator.targetVersion();
  const all = await options.registry.list();
  const results: TenantMigrationResult[] = [];
  const record = (result: TenantMigrationResult) => {
    results.push(result);
    options.onResult?.(result);
  };

  let candidates: TenantRecord[];
  if (options.tenants?.length) {
    const bySlug = new Map(all.map((t) => [t.slug, t]));
    candidates = [];
    for (const slug of options.tenants) {
      const tenant = bySlug.get(slug);
      if (!tenant) {
        record({
          slug,
          status: 'failed',
          from: null,
          to: null,
          applied: [],
          durationMs: 0,
          error: 'Tenant not found',
        });
      } else if (tenant.status === 'archived') {
        record({
          slug,
          status: 'skipped',
          from: tenant.schemaVersion,
          to: tenant.schemaVersion,
          applied: [],
          durationMs: 0,
          error: 'Tenant is archived',
        });
      } else {
        candidates.push(tenant);
      }
    }
  } else {
    const statuses: TenantStatus[] = options.includeSuspended ? ['active', 'suspended'] : ['active'];
    candidates = all.filter((t) => statuses.includes(t.status));
  }

  let canary: TenantRecord | undefined;
  if (options.canary) {
    canary =
      typeof options.canary === 'string' ? candidates.find((t) => t.slug === options.canary) : candidates[0];
    if (typeof options.canary === 'string' && !canary) {
      throw new TenantMigrationError(options.canary, 'canary tenant is not among the tenants to migrate');
    }
  }

  let aborted = false;
  if (canary) {
    const result = await migrateOne(canary, target, options);
    record(result);
    if (result.status === 'failed') {
      aborted = true;
      for (const tenant of candidates) {
        if (tenant !== canary) {
          record({
            slug: tenant.slug,
            status: 'skipped',
            from: tenant.schemaVersion,
            to: tenant.schemaVersion,
            applied: [],
            durationMs: 0,
            error: 'Canary failed',
          });
        }
      }
    }
  }

  if (!aborted) {
    const limit = createLimiter(options.concurrency ?? 5);
    await Promise.all(
      candidates
        .filter((t) => t !== canary)
        .map((tenant) => limit(async () => record(await migrateOne(tenant, target, options)))),
    );
  }

  const refreshed = options.dryRun ? all : await options.registry.list();
  const behind = refreshed
    .filter((t) => MIGRATABLE.includes(t.status) && t.schemaVersion !== target)
    .map((t) => ({ slug: t.slug, status: t.status, version: t.schemaVersion }));

  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    target,
    dryRun: options.dryRun ?? false,
    canary: canary?.slug ?? null,
    aborted,
    results,
    failed: results.filter((r) => r.status === 'failed'),
    behind,
  };
}
