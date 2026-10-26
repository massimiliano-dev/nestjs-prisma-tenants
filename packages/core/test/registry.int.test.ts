import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ControlDb,
  EnvSecretProvider,
  SecretResolver,
  TenantInactiveError,
  TenantNotFoundError,
  TenantProvisioner,
  TenantProvisioningError,
  TenantRegistry,
  withDatabase,
} from '../src/index.js';
import pg from 'pg';
import { createDatabase, tenantUrl, tryConnect, uniquePrefix } from '../../../test/pg-helpers.js';

const adminUrl = inject('pgAdminUrl');
let db: ControlDb;
let controlDb: ControlDb;
let registry: TenantRegistry;
let prefix: string;

beforeAll(async () => {
  prefix = uniquePrefix('reg');
  db = new ControlDb({ url: await createDatabase(adminUrl, `${prefix}_control`) });
  registry = new TenantRegistry(db, { cacheTtlMs: 60_000 });
  controlDb = db;
});
afterAll(() => db.close());

describe('ControlDb + TenantRegistry', () => {
  it('migrates idempotently, also when called concurrently', async () => {
    const results = await Promise.all([db.migrate(), db.migrate(), db.migrate()]);
    expect(results.flat()).toEqual([1]);
    expect(await db.migrate()).toEqual([]);
  });

  it('creates, lists, caches and updates tenants', async () => {
    await registry.create({ slug: 'acme', status: 'active', metadata: { plan: 'pro' } });
    await registry.create({ slug: 'globex', secretRef: 'env:GLOBEX' });
    const acme = await registry.getActive('acme');
    expect(acme).toMatchObject({
      dbName: 'tenant_acme',
      secretRef: 'env:TENANT_ACME_DATABASE_URL',
      metadata: { plan: 'pro' },
    });
    expect((await registry.list()).map((t) => t.slug)).toEqual(['acme', 'globex']);
    expect((await registry.list({ status: ['provisioning'] })).map((t) => t.slug)).toEqual(['globex']);

    await expect(registry.getActive('globex')).rejects.toBeInstanceOf(TenantInactiveError);
    await expect(registry.getActive('nope')).rejects.toBeInstanceOf(TenantNotFoundError);

    await registry.setSchemaVersion('acme', '20260101000000_init');
    const archived = await registry.setStatus('acme', 'archived');
    expect(archived.archivedAt).toBeInstanceOf(Date);
    await expect(registry.getActive('acme')).rejects.toMatchObject({ status: 'archived' });
    expect(await registry.countByStatus()).toMatchObject({ archived: 1, provisioning: 1 });
  });

  it('enforces the slug rule in the database too', async () => {
    await expect(
      db.query("INSERT INTO tenants (slug, db_name, secret_ref) VALUES ('Bad Slug', 'x', 'env:X')"),
    ).rejects.toThrow(/check constraint/);
  });

  it('provisions a database, marks failures and retries them', async () => {
    const dbName = `${prefix}_t_beta`;
    const env: Record<string, string> = {};
    const provisioner = new TenantProvisioner({
      registry,
      secrets: new SecretResolver([new EnvSecretProvider(env)]),
      adminDatabaseUrl: adminUrl,
    });
    // Secret not configured yet: provisioning fails and the tenant is left in "failed".
    await expect(provisioner.create('beta', { dbName, secretRef: 'env:BETA' })).rejects.toBeInstanceOf(
      TenantProvisioningError,
    );
    expect((await registry.getBySlug('beta')).status).toBe('failed');

    env.BETA = tenantUrl(adminUrl, dbName);
    let seeded = '';
    const tenant = await provisioner.create('beta', {
      dbName,
      secretRef: 'env:BETA',
      seed: async ({ url }) => {
        seeded = url;
      },
    });
    expect(tenant.status).toBe('active');
    expect(seeded).toContain(dbName);
    await expect(provisioner.create('beta')).rejects.toThrow(/already exists/);

    const archived = await provisioner.archive('beta');
    expect(archived.status).toBe('archived');
  });
});

describe('tenant isolation', () => {
  const env: Record<string, string> = {};
  let provisioner: TenantProvisioner;
  const dbOf = (slug: string) => `${prefix}_iso_${slug}`;

  beforeAll(() => {
    provisioner = new TenantProvisioner({
      registry,
      secrets: new SecretResolver([new EnvSecretProvider(env)]),
      adminDatabaseUrl: adminUrl,
    });
  });

  it('gives each tenant its own role and blocks access to other tenants', async () => {
    for (const slug of ['red', 'blue']) {
      env[`ISO_${slug}`] = tenantUrl(adminUrl, dbOf(slug));
      await provisioner.create(`iso-${slug}`, { dbName: dbOf(slug), secretRef: `env:ISO_${slug}` });
    }
    expect(await tryConnect(env.ISO_red!)).toBe('ok');
    // red's credentials against blue's database: CONNECT was revoked from PUBLIC.
    expect(await tryConnect(tenantUrl(adminUrl, dbOf('blue'), dbOf('red'), `${dbOf('red')}-pw`))).toBe(
      '42501',
    );
    // wrong password
    expect(await tryConnect(tenantUrl(adminUrl, dbOf('red'), dbOf('red'), 'guess'))).toBe('28P01');

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const { rows } = await admin.query<{ rolpassword: string; rolsuper: boolean; rolcreatedb: boolean }>(
      'SELECT rolpassword, rolsuper, rolcreatedb FROM pg_authid WHERE rolname = $1',
      [dbOf('red')],
    );
    const { rows: owner } = await admin.query<{ owner: string }>(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
      [dbOf('red')],
    );
    await admin.end();
    expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(rows[0]).toMatchObject({ rolsuper: false, rolcreatedb: false });
    expect(owner[0]?.owner).toBe(dbOf('red'));
  });

  it('keeps tenant roles out of the control database', async () => {
    expect(controlDb.hardeningWarning).toBeUndefined();
    const controlName = new URL(controlDb.pool.options.connectionString!).pathname.slice(1);
    expect(await tryConnect(tenantUrl(adminUrl, controlName, dbOf('red'), `${dbOf('red')}-pw`))).toBe(
      '42501',
    );
  });

  it('refuses tenant secrets that use the admin or a superuser role', async () => {
    env.ISO_root = withDatabase(adminUrl, dbOf('root'));
    await expect(
      provisioner.create('iso-root', { dbName: dbOf('root'), secretRef: 'env:ISO_root' }),
    ).rejects.toThrow(/privileged role/);
  });

  it('refuses a secret pointing at another database', async () => {
    env.ISO_mismatch = tenantUrl(adminUrl, dbOf('blue'), dbOf('mismatch'));
    await expect(
      provisioner.create('iso-mismatch', { dbName: dbOf('mismatch'), secretRef: 'env:ISO_mismatch' }),
    ).rejects.toThrow(/points at database/);
  });

  it('disables login when a tenant is archived and restores it on activation', async () => {
    await provisioner.archive('iso-blue');
    expect(await tryConnect(env.ISO_blue!)).toBe('28000');
    await provisioner.activate('iso-blue');
    expect(await tryConnect(env.ISO_blue!)).toBe('ok');
  });
});
