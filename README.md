# nestjs-prisma-tenants

Database-per-tenant toolkit for **NestJS + Prisma 7 + PostgreSQL**.

[![CI](https://github.com/massimiliano-dev/nestjs-prisma-tenants/actions/workflows/ci.yml/badge.svg)](https://github.com/massimiliano-dev/nestjs-prisma-tenants/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Each tenant gets its own PostgreSQL database and its own login role. This toolkit handles the parts that every
team ends up rewriting:

- **Tenant registry** in a control database. It stores slug, status, schema version and a _reference_ to the
  connection secret, never the password.
- **Tenant resolution** from subdomain, header or verified JWT claim. The tenant is carried through the request
  with `AsyncLocalStorage`, so there are **no request-scoped providers**.
- **Client manager.** An LRU cache of `PrismaClient` instances closes idle clients and caps connections per
  tenant. With 200 tenants you cannot keep 200 pools open against PostgreSQL's default `max_connections = 100`.
- **Fault isolation.** Each tenant has a circuit breaker: if one tenant database is down, its requests fail
  fast with 503 and every other tenant keeps working.
- **Migration CLI.** `tenants migrate --all --concurrency 5 --canary --dry-run` migrates a canary first and
  reports failures and tenants left behind.
- **Provisioning.** Creates the database and a dedicated role, revokes public access, migrates, seeds and
  registers the tenant. Archiving disables the role's login and never drops the database.

> Status: early (0.x). The API may change before 1.0. The Prisma adapter comes first; Drizzle is planned.

## Packages

| Package                                                             | What it is                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@massimiliano-dev/nestjs-prisma-tenants`](packages/nestjs)        | NestJS module, guard, decorators. Re-exports the core.                             |
| [`@massimiliano-dev/nestjs-prisma-tenants-core`](packages/core)     | Framework-agnostic registry, client manager, strategies, migrations, provisioning. |
| [`@massimiliano-dev/nestjs-prisma-tenants-prisma`](packages/prisma) | Prisma 7 driver-adapter factory and `PrismaMigrator`.                              |
| [`@massimiliano-dev/nestjs-prisma-tenants-cli`](packages/cli)       | The `tenants` command.                                                             |

## Quick start

```bash
pnpm add @massimiliano-dev/nestjs-prisma-tenants @massimiliano-dev/nestjs-prisma-tenants-prisma \
  @prisma/client @prisma/adapter-pg
pnpm add -D prisma @massimiliano-dev/nestjs-prisma-tenants-cli
```

Your tenant schema stays yours. Point `prisma.config.ts` at `env('DATABASE_URL')`; the toolkit sets it per
tenant when migrating.

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { SubdomainStrategy, TenantsModule } from '@massimiliano-dev/nestjs-prisma-tenants';
import { createPrismaAdapter, PrismaMigrator } from '@massimiliano-dev/nestjs-prisma-tenants-prisma';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    TenantsModule.forRootAsync<PrismaClient>({
      useFactory: () => ({
        controlDatabaseUrl: process.env.CONTROL_DATABASE_URL!,
        adapter: createPrismaAdapter((driver) => new PrismaClient({ adapter: driver })),
        migrator: new PrismaMigrator({ migrationsDir: 'prisma/migrations', configPath: 'prisma.config.ts' }),
        strategies: [new SubdomainStrategy({ baseDomain: 'example.com' })],
        // Resolution is not authorization: check that the caller belongs to the tenant.
        authorizeTenant: (tenant, ctx) =>
          ctx.switchToHttp().getRequest().user?.tenants?.includes(tenant.slug) ?? false,
        cache: { max: 20, idleTtlMs: 10 * 60_000 },
      }),
    }),
  ],
})
export class AppModule {}
```

```ts
// notes.controller.ts
@Controller('notes')
export class NotesController {
  constructor(@InjectTenantClient() private readonly tenants: TenantClientService<PrismaClient>) {}

  @Get()
  list() {
    // withClient reports connection failures to the tenant's circuit breaker.
    return this.tenants.withClient((db) => db.note.findMany());
  }
}
```

```bash
export TENANT_ACME_DATABASE_URL='postgresql://tenant_acme:<strong-password>@db:5432/tenant_acme?sslmode=verify-full'
npx tenants create acme          # role + database + migrations + seed + registry row
npx tenants migrate --all --canary --concurrency 5
npx tenants status               # who is behind the latest migration
```

## Try the demo

```bash
docker compose -f examples/demo/compose.yml up --build
curl http://acme.localhost:3000/notes
curl -H 'X-Tenant-Id: globex' http://127.0.0.1:3000/notes
```

Three tenants (`acme`, `globex`, `initech`) are provisioned on first boot. See [examples/demo](examples/demo).

## Documentation

- [Getting started](docs/getting-started.md): the full flow, from control database to first request.
- [Architecture](docs/architecture.md): request lifecycle, client cache, circuit breaker.
- [DB per tenant vs schema per tenant vs RLS](docs/multi-tenancy-models.md): when this toolkit is the right choice.
- [Connection budget](docs/connection-budget.md): sizing `cache.max` and `connectionLimit`.
- [Migrations](docs/migrations.md) and the [CLI](docs/cli.md).
- [Secrets](docs/secrets.md): environment variables, Azure Key Vault and custom providers.
- [Security](SECURITY.md): threat model, defaults and a hardening checklist.

## Development

```bash
pnpm install
pnpm test       # unit tests, no Docker
pnpm test:int   # integration tests: starts PostgreSQL with Testcontainers (Docker required)
pnpm lint && pnpm typecheck && pnpm build
```

The integration suite provisions real databases, including a run with 50 tenants that checks open
connections stay within the LRU bound, and verifies that a tenant role cannot connect to another tenant.

## License

[MIT](LICENSE)
