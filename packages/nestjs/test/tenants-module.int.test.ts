import 'reflect-metadata';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  CurrentTenant,
  EnvSecretProvider,
  HeaderStrategy,
  InjectTenantClient,
  PublicTenant,
  stripPoolParams,
  SubdomainStrategy,
  TenantClientManager,
  TenantClientService,
  TenantRegistry,
  TenantsModule,
  type DbAdapter,
  type TenantRecord,
} from '../src/index.js';
import { createDatabase, uniquePrefix } from '../../../test/pg-helpers.js';

/** The toolkit is ORM-agnostic: here a plain pg.Pool is the tenant client. */
const pgAdapter: DbAdapter<pg.Pool> = {
  create: ({ url, connectionLimit }) =>
    new pg.Pool({ connectionString: stripPoolParams(url), max: connectionLimit }),
  ping: async (pool) => void (await pool.query('SELECT 1')),
  disconnect: (pool) => pool.end(),
};

@Controller()
class NotesController {
  constructor(@InjectTenantClient() private readonly tenants: TenantClientService<pg.Pool>) {}

  @Get('whoami')
  async whoami(@CurrentTenant() tenant: TenantRecord) {
    const { rows } = await this.tenants.withClient((pool) => pool.query('SELECT current_database() AS db'));
    return { slug: this.tenants.slug, tenant: tenant.slug, db: rows[0].db };
  }

  @PublicTenant()
  @Get('health')
  health() {
    return { ok: true };
  }
}

const adminUrl = inject('pgAdminUrl');
const prefix = uniquePrefix('nest');
const env: Record<string, string> = {};
let controlUrl: string;

beforeAll(async () => {
  controlUrl = await createDatabase(adminUrl, `${prefix}_control`);
  for (const slug of ['acme', 'globex'])
    env[`DB_${slug}`] = await createDatabase(adminUrl, `${prefix}_${slug}`);
  env.DB_down = 'postgresql://test:test@127.0.0.1:1/nowhere';
});

function appModule() {
  @Module({
    imports: [
      TenantsModule.forRootAsync<pg.Pool>({
        useFactory: () => ({
          controlDatabaseUrl: controlUrl,
          adapter: pgAdapter,
          secretProviders: [new EnvSecretProvider(env)],
          strategies: [new HeaderStrategy(), new SubdomainStrategy({ baseDomain: 'localhost' })],
          // Example policy: the "x-user-tenants" header stands in for the authenticated user's memberships.
          authorizeTenant: (tenant, ctx) => {
            const allowed = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
              'x-user-tenants'
            ];
            return allowed === undefined || allowed.split(',').includes(tenant.slug);
          },
          cache: { max: 5 },
          breaker: { failureThreshold: 1, resetTimeoutMs: 60_000, pingTimeoutMs: 1_000 },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        }),
      }),
    ],
    controllers: [NotesController],
  })
  class AppModule {}
  return AppModule;
}

async function seedRegistry(app: INestApplication) {
  const registry = app.get(TenantRegistry);
  if (await registry.findBySlug('acme')) return;
  await registry.create({ slug: 'acme', secretRef: 'env:DB_acme', status: 'active' });
  await registry.create({ slug: 'globex', secretRef: 'env:DB_globex', status: 'active' });
  await registry.create({ slug: 'old', secretRef: 'env:DB_acme', status: 'archived' });
  await registry.create({ slug: 'down', secretRef: 'env:DB_down', status: 'active' });
}

describe.each(['express', 'fastify'] as const)('TenantsModule on %s', (platform) => {
  let app: INestApplication;
  let server: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [appModule()] }).compile();
    if (platform === 'fastify') {
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    } else {
      app = moduleRef.createNestApplication();
    }
    await app.listen(0, '127.0.0.1');
    server = await app.getUrl();
    await seedRegistry(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the tenant from the subdomain and uses its own database', async () => {
    const res = await request(server).get('/whoami').set('Host', 'acme.localhost:3000').expect(200);
    expect(res.body).toEqual({ slug: 'acme', tenant: 'acme', db: `${prefix}_acme` });
  });

  it('resolves the tenant from a header and keeps concurrent requests isolated', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const slug = i % 2 ? 'acme' : 'globex';
        return request(server)
          .get('/whoami')
          .set('X-Tenant-Id', slug)
          .then((r) => [slug, r.body.db]);
      }),
    );
    for (const [slug, db] of responses) expect(db).toBe(`${prefix}_${slug}`);
  });

  it('maps registry problems to 400 and 404 without revealing which tenants exist', async () => {
    const missing = await request(server).get('/whoami').expect(400);
    expect(missing.body.error).toBe('TENANT_RESOLUTION_FAILED');
    const archived = await request(server).get('/whoami').set('X-Tenant-Id', 'old').expect(404);
    const unknown = await request(server).get('/whoami').set('X-Tenant-Id', 'nobody').expect(404);
    expect(archived.body).toEqual(unknown.body);
    expect(unknown.body).toEqual({ statusCode: 404, error: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
  });

  it('denies tenants the caller is not authorized for', async () => {
    const denied = await request(server)
      .get('/whoami')
      .set('X-Tenant-Id', 'acme')
      .set('X-User-Tenants', 'globex')
      .expect(403);
    expect(denied.body.error).toBe('TENANT_ACCESS_DENIED');
    await request(server)
      .get('/whoami')
      .set('X-Tenant-Id', 'acme')
      .set('X-User-Tenants', 'globex,acme')
      .expect(200);
  });

  it('ignores hostile tenant identifiers before any database access', async () => {
    for (const value of [
      "acme'; DROP TABLE tenants;--",
      '../../etc/passwd',
      'a'.repeat(500),
      'acme corp',
      '%61cme',
    ]) {
      await request(server).get('/whoami').set('X-Tenant-Id', value).expect(400);
    }
  });

  it('returns 503 for a tenant whose database is down, without affecting others', async () => {
    const down = await request(server).get('/whoami').set('X-Tenant-Id', 'down').expect(503);
    expect(down.body.error).toBe('TENANT_DB_UNAVAILABLE');
    expect(app.get(TenantClientManager).circuitState('down')).toBe('open');
    await request(server).get('/whoami').set('X-Tenant-Id', 'globex').expect(200);
  });

  it('serves public routes without a tenant and without touching any database', async () => {
    await request(server).get('/health').expect(200, { ok: true });
  });
});
