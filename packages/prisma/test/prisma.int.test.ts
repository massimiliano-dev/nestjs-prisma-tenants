import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createTenantsRuntime,
  EnvSecretProvider,
  TenantDbUnavailableError,
  type TenantsRuntime,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { createPrismaAdapter, PrismaMigrator } from '../src/index.js';
import { PrismaClient } from './fixture/generated/prisma/client.js';
import { countConnections, createDatabase, uniquePrefix } from '../../../test/pg-helpers.js';

const adminUrl = inject('pgAdminUrl');
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
const migrator = new PrismaMigrator({
  migrationsDir: `${fixture}prisma/migrations`,
  configPath: `${fixture}prisma.config.ts`,
  binDir: fileURLToPath(new URL('../', import.meta.url)),
});
const adapter = createPrismaAdapter((driver) => new PrismaClient({ adapter: driver }));
const INIT = '20260101000000_init';
const LATEST = '20260201000000_add_note_pinned';

describe('PrismaMigrator', () => {
  it('reads target version, deploys, and is idempotent', async () => {
    const url = await createDatabase(adminUrl, uniquePrefix('mig'));
    expect(await migrator.targetVersion()).toBe(LATEST);
    expect(await migrator.appliedVersion(url)).toBeNull();
    expect(await migrator.pendingMigrations(url)).toEqual([INIT, LATEST]);

    const first = await migrator.deploy(url);
    expect(first).toMatchObject({ applied: [INIT, LATEST], version: LATEST });
    const second = await migrator.deploy(url);
    expect(second).toMatchObject({ applied: [], version: LATEST });
  });

  it('surfaces CLI failures with a redacted output tail', async () => {
    const url = await createDatabase(adminUrl, uniquePrefix('broken'));
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('CREATE TABLE "Note" (id int)'); // non-empty schema: Prisma refuses to deploy (P3005)
    await client.end();
    const error = await migrator.deploy(url).catch((e: Error & { output?: string }) => e);
    expect(error).toMatchObject({ code: 'TENANT_MIGRATION_FAILED' });
    expect((error as Error).message).toMatch(/P3005/);
    expect((error as { output?: string }).output).toMatch(/schema is not empty/);
    expect((error as { output?: string }).output).not.toMatch(/:test@/);
  });
});

describe('database per tenant at scale (50 tenants)', () => {
  const TENANTS = 50;
  const CACHE_MAX = 10;
  const CONNECTION_LIMIT = 2;
  let prefix: string;
  let runtime: TenantsRuntime<PrismaClient>;
  const env: Record<string, string> = {};

  beforeAll(async () => {
    prefix = uniquePrefix('scale');
    // Migrate one template database once, then clone it: 50 `prisma migrate deploy` runs would take minutes.
    const templateName = `${prefix}_template`;
    const templateUrl = await createDatabase(adminUrl, templateName);
    await migrator.deploy(templateUrl);

    runtime = await createTenantsRuntime({
      controlDatabaseUrl: await createDatabase(adminUrl, `${prefix}_control`),
      adminDatabaseUrl: adminUrl,
      adapter,
      migrator,
      secretProviders: [new EnvSecretProvider(env)],
      cache: { max: CACHE_MAX, idleTtlMs: 60_000, maxConnectionsBudget: 90 },
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000, pingTimeoutMs: 2_000 },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    for (let i = 0; i < TENANTS; i++) {
      const slug = `t${String(i).padStart(3, '0')}`;
      const dbName = `${prefix}_${slug}`;
      await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${templateName}"`);
      env[`T_${slug}`] = new URL(`/${dbName}`, adminUrl).toString();
      await runtime.registry.create({
        slug,
        dbName,
        secretRef: `env:T_${slug}`,
        status: 'active',
        connectionLimit: CONNECTION_LIMIT,
      });
    }
    await admin.end();
    // A tenant whose database server is down.
    env.T_down = 'postgresql://test:test@127.0.0.1:1/nowhere';
    await runtime.registry.create({
      slug: 'down',
      dbName: `${prefix}_down`,
      secretRef: 'env:T_down',
      status: 'active',
    });
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it('serves every tenant while keeping open connections bounded by the LRU', async () => {
    const slugs = (await runtime.registry.list({ status: ['active'] }))
      .map((t) => t.slug)
      .filter((s) => s !== 'down');
    expect(slugs).toHaveLength(TENANTS);

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < slugs.length; i += 10) {
        await Promise.all(
          slugs.slice(i, i + 10).map(async (slug) => {
            const client = await runtime.manager.get(slug);
            await client.note.create({ data: { title: `hello ${slug}` } });
            const rows = await client.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db');
            expect(rows[0]?.db).toBe(`${prefix}_${slug}`);
          }),
        );
        const open = await countConnections(adminUrl, `${prefix}_t`);
        expect(open).toBeLessThanOrEqual(CACHE_MAX * CONNECTION_LIMIT);
      }
    }

    const stats = runtime.manager.stats();
    expect(stats.size).toBeLessThanOrEqual(CACHE_MAX);
    expect(stats.evictions).toBeGreaterThanOrEqual(TENANTS * 2 - CACHE_MAX);

    // Data stayed isolated: each tenant only sees its own two notes.
    const client = await runtime.manager.get('t007');
    const notes = await client.note.findMany();
    expect(notes.map((n) => n.title)).toEqual(['hello t007', 'hello t007']);
  });

  it('isolates a tenant whose database is down', async () => {
    const started = performance.now();
    await expect(runtime.manager.get('down')).rejects.toBeInstanceOf(TenantDbUnavailableError);
    await expect(runtime.manager.get('down')).rejects.toBeInstanceOf(TenantDbUnavailableError);
    expect(runtime.manager.circuitState('down')).toBe('open');

    const fastStart = performance.now();
    await expect(runtime.manager.get('down')).rejects.toMatchObject({ circuitState: 'open' });
    expect(performance.now() - fastStart).toBeLessThan(50);

    const ok = await runtime.manager.get('t001');
    await expect(ok.note.count()).resolves.toBe(2);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it('migrates all tenants with the CLI-equivalent API and reports who is behind', async () => {
    // Registry versions are unknown after cloning: a dry run detects that everyone is up to date.
    const dry = await runtime.migrate({ dryRun: true, concurrency: 10 });
    expect(dry.results.filter((r) => r.status === 'up-to-date')).toHaveLength(TENANTS);
    expect(dry.failed.map((f) => f.slug)).toEqual(['down']);

    const real = await runtime.migrate({ concurrency: 10, tenants: ['t000', 't001', 't002'] });
    expect(real.results.map((r) => r.status)).toEqual(['up-to-date', 'up-to-date', 'up-to-date']);
    expect(real.behind.map((b) => b.slug)).toContain('t003');
    expect(real.behind.map((b) => b.slug)).not.toContain('t000');
  });
});
