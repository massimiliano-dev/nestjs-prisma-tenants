import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import pg from 'pg';
import {
  redactSecrets,
  stripPoolParams,
  TenantMigrationError,
  type Migrator,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

export interface PrismaMigratorOptions {
  /** Directory containing the timestamped migration folders, usually `prisma/migrations`. */
  migrationsDir: string;
  /** Path to `prisma.config.ts`. Its datasource URL must read `env('DATABASE_URL')`. */
  configPath?: string;
  /** Path to `schema.prisma`, for setups without a config file. */
  schemaPath?: string;
  /** Working directory for the Prisma CLI. Defaults to the directory of `configPath`, else `process.cwd()`. */
  cwd?: string;
  /** Prisma CLI command or path. Default `prisma`, looked up in `node_modules/.bin` from `binDir` upwards. */
  prismaBin?: string;
  /** Where to start looking for `node_modules/.bin/prisma`. Default `process.cwd()`. */
  binDir?: string;
  /** Kill a tenant migration that runs longer than this. Default 5 minutes. */
  timeoutMs?: number;
  env?: Record<string, string>;
}

const OUTPUT_TAIL_CHARS = 4_000;

/**
 * Runs `prisma migrate deploy` once per tenant with that tenant's `DATABASE_URL`. Uses only the
 * public CLI, so it follows Prisma's own locking and migration-table semantics.
 */
export class PrismaMigrator implements Migrator {
  private readonly cwd: string;

  constructor(private readonly options: PrismaMigratorOptions) {
    this.cwd =
      options.cwd ?? (options.configPath ? path.dirname(path.resolve(options.configPath)) : process.cwd());
  }

  /** Local migration folder names, sorted. Folder names start with a timestamp, so order is chronological. */
  async localMigrations(): Promise<string[]> {
    const entries = await readdir(this.options.migrationsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sql = path.join(this.options.migrationsDir, entry.name, 'migration.sql');
      if (
        await stat(sql).then(
          () => true,
          () => false,
        )
      )
        names.push(entry.name);
    }
    return names.sort();
  }

  async targetVersion(): Promise<string | null> {
    return (await this.localMigrations()).at(-1) ?? null;
  }

  async appliedMigrations(url: string): Promise<string[]> {
    const client = new pg.Client({ connectionString: stripPoolParams(url), connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      const { rows: exists } = await client.query<{ t: string | null }>(
        "SELECT to_regclass('_prisma_migrations')::text AS t",
      );
      if (!exists[0]?.t) return [];
      const { rows } = await client.query<{ migration_name: string }>(
        `SELECT migration_name FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
      );
      return rows.map((r) => r.migration_name);
    } finally {
      await client.end();
    }
  }

  async appliedVersion(url: string): Promise<string | null> {
    return (await this.appliedMigrations(url)).at(-1) ?? null;
  }

  async pendingMigrations(url: string): Promise<string[]> {
    const applied = new Set(await this.appliedMigrations(url));
    return (await this.localMigrations()).filter((name) => !applied.has(name));
  }

  async deploy(url: string): Promise<{ applied: string[]; version: string | null; output: string }> {
    const cleanUrl = stripPoolParams(url);
    const pending = await this.pendingMigrations(cleanUrl);
    const args = ['migrate', 'deploy'];
    if (this.options.configPath) args.push('--config', path.resolve(this.options.configPath));
    if (this.options.schemaPath) args.push('--schema', path.resolve(this.options.schemaPath));

    const result = await execa(this.options.prismaBin ?? 'prisma', args, {
      cwd: this.cwd,
      preferLocal: true,
      localDir: this.options.binDir ?? process.cwd(),
      all: true,
      reject: false,
      timeout: this.options.timeoutMs ?? 5 * 60_000,
      env: { ...this.options.env, DATABASE_URL: cleanUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    const output = redactSecrets(String(result.all ?? '')).slice(-OUTPUT_TAIL_CHARS);
    if (result.failed) {
      const prismaCode = /Error: (P\d{4})/.exec(output)?.[1];
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode === undefined
          ? `could not start the Prisma CLI (${result.code ?? 'unknown error'}); install prisma or set prismaBin`
          : `prisma migrate deploy exited with code ${result.exitCode}${prismaCode ? ` (${prismaCode})` : ''}`;
      throw new TenantMigrationError(undefined, reason, output);
    }
    return { applied: pending, version: await this.appliedVersion(cleanUrl), output };
  }
}
