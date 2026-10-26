import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EnvSecretProvider } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { PrismaMigrator } from '@massimiliano-dev/nestjs-prisma-tenants-prisma';
import { defineTenantsConfig, runCli, type TenantsCliConfig } from '../src/index.js';
import { createDatabase, tenantUrl, uniquePrefix } from '../../../test/pg-helpers.js';

const adminUrl = inject('pgAdminUrl');
const fixture = fileURLToPath(new URL('../../prisma/test/fixture/', import.meta.url));
const binDir = fileURLToPath(new URL('../../prisma/', import.meta.url));
const INIT = '20260101000000_init';
const LATEST = '20260201000000_add_note_pinned';
const prefix = uniquePrefix('cli');
const env: Record<string, string> = {};
let v1Dir: string;
let v1: TenantsCliConfig;
let v2: TenantsCliConfig;

async function cli(config: TenantsCliConfig, ...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) };
  const code = await runCli(argv, { io, config });
  return { code, text: lines.join('\n') };
}

beforeAll(async () => {
  // "v1" of the app ships only the first migration; "v2" adds the second one.
  v1Dir = await mkdtemp(path.join(os.tmpdir(), 'tenants-v1-'));
  await cp(fixture, v1Dir, {
    recursive: true,
    filter: (src) => !src.includes('generated') && !src.includes(LATEST),
  });
  const base = {
    controlDatabaseUrl: await createDatabase(adminUrl, `${prefix}_control`),
    adminDatabaseUrl: adminUrl,
    secretProviders: [new EnvSecretProvider(env)],
    dbNameFor: (slug: string) => `${prefix}_${slug}`,
  };
  for (const slug of ['alpha', 'beta', 'delta']) {
    env[`TENANT_${slug.toUpperCase()}_DATABASE_URL`] = tenantUrl(adminUrl, `${prefix}_${slug}`);
  }
  v1 = defineTenantsConfig({
    ...base,
    migrator: new PrismaMigrator({
      migrationsDir: path.join(v1Dir, 'prisma/migrations'),
      configPath: path.join(v1Dir, 'prisma.config.ts'),
      binDir,
    }),
  });
  v2 = defineTenantsConfig({
    ...base,
    migrator: new PrismaMigrator({
      migrationsDir: path.join(fixture, 'prisma/migrations'),
      configPath: path.join(fixture, 'prisma.config.ts'),
      binDir,
    }),
  });
});

afterAll(async () => {
  await rm(v1Dir, { recursive: true, force: true });
});

describe('tenants CLI', () => {
  it('creates tenants on the v1 schema', async () => {
    for (const slug of ['alpha', 'beta', 'delta']) {
      const { code, text } = await cli(v1, 'create', slug, '--connection-limit', '2');
      expect(code, text).toBe(0);
      expect(text).toContain(`schema ${INIT}`);
    }
    const dup = await cli(v1, 'create', 'alpha');
    expect(dup.code).toBe(1);
    expect(dup.text).toMatch(/already exists/);
  });

  it('reports every tenant behind once v2 ships', async () => {
    const { code, text } = await cli(v2, 'status');
    expect(code).toBe(0);
    expect(text).toContain(`Target schema: ${LATEST}`);
    expect(text).toContain('Behind target: alpha, beta, delta');

    const list = await cli(v2, 'list');
    expect(list.text).toMatch(/alpha\s+active\s+20260101000000_init\s+yes\s+2/);
  });

  it('dry run lists pending migrations and changes nothing', async () => {
    const { code, text } = await cli(v2, 'migrate', '--all', '--dry-run');
    expect(code).toBe(0);
    expect(text).toContain(`would migrate alpha  ${INIT} -> ${LATEST}  [${LATEST}]`);
    expect(text).toContain('Would migrate: 3');
    expect((await cli(v2, 'status')).text).toContain('Behind target: alpha, beta, delta');
  });

  it('migrates with a canary, reports the failing tenant and who is left behind', async () => {
    // Break delta: the column the v2 migration adds already exists.
    const client = new pg.Client({ connectionString: env.TENANT_DELTA_DATABASE_URL });
    await client.connect();
    await client.query('ALTER TABLE "Note" ADD COLUMN "pinned" boolean');
    await client.end();

    const { code, text } = await cli(v2, 'migrate', '--all', '--canary', 'alpha', '--concurrency', '2');
    expect(code).toBe(1);
    expect(text).toContain('Canary: alpha');
    expect(text).toContain('Migrated: 2, up to date: 0, failed: 1');
    expect(text).toMatch(/delta: Migration failed: prisma migrate deploy exited with code 1/);
    expect(text).toMatch(/\| .*already exists/);
    expect(text).toContain(`delta (active): ${INIT}`);

    const json = JSON.parse((await cli(v2, 'list', '--json')).text) as {
      tenants: { slug: string; schemaVersion: string }[];
    };
    expect(Object.fromEntries(json.tenants.map((t) => [t.slug, t.schemaVersion]))).toEqual({
      alpha: LATEST,
      beta: LATEST,
      delta: INIT,
    });
  });

  it('archives without dropping the database and validates arguments', async () => {
    const archived = await cli(v2, 'archive', 'beta');
    expect(archived.code).toBe(0);
    expect(archived.text).toContain(`Database ${prefix}_beta was kept`);
    expect((await cli(v2, 'list', '--status', 'archived')).text).toContain('beta');
    expect((await cli(v2, 'migrate')).text).toContain('Pass --all or at least one --tenant');
    expect((await cli(v2, 'list', '--status', 'nope')).code).toBe(1);
  });
});
