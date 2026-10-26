# Getting started

This guide goes from an empty PostgreSQL server to a NestJS app serving two tenants.

## 1. Roles and databases

Use three kinds of roles (see the [hardening checklist](../SECURITY.md#hardening-checklist-for-production)):

```sql
-- Owns only the registry. The application connects with it.
CREATE ROLE tenants_control LOGIN PASSWORD '...';
CREATE DATABASE tenants_control OWNER tenants_control;

-- Provisions tenants. Used by the CLI or a deploy job, never by the running app.
CREATE ROLE tenants_admin LOGIN CREATEDB CREATEROLE PASSWORD '...';

-- Server hardening: nobody connects to the maintenance databases by default.
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;
```

Tenant roles are created by the toolkit from each tenant's secret URL.

## 2. Tenant schema with Prisma 7

```prisma
// prisma/schema.prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  moduleFormat        = "esm"
  importFileExtension = "js"
}

datasource db {
  provider = "postgresql"
}

model Note {
  id    Int    @id @default(autoincrement())
  title String
}
```

```ts
// prisma.config.ts
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

Create migrations as usual against a development database (`prisma migrate dev`). The toolkit only _deploys_
them, with `prisma migrate deploy`, once per tenant.

## 3. CLI configuration

```ts
// tenants.config.ts
import { defineTenantsConfig } from '@massimiliano-dev/nestjs-prisma-tenants-cli';
import { PrismaMigrator } from '@massimiliano-dev/nestjs-prisma-tenants-prisma';

export default defineTenantsConfig({
  controlDatabaseUrl: process.env.CONTROL_DATABASE_URL!,
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
  migrator: new PrismaMigrator({ migrationsDir: 'prisma/migrations', configPath: 'prisma.config.ts' }),
  defaultConnectionLimit: 3,
});
```

TypeScript configs load through Node's built-in type stripping (Node 22.18 or newer).

## 4. Create tenants

Each tenant's secret is a full connection URL whose user and password become the tenant's dedicated role. By
default the secret reference is `env:TENANT_<SLUG>_DATABASE_URL` and the database is `tenant_<slug>`.

```bash
export TENANT_ACME_DATABASE_URL="postgresql://tenant_acme:$(openssl rand -hex 24)@db:5432/tenant_acme?sslmode=verify-full"
npx tenants create acme
npx tenants create globex   # after exporting TENANT_GLOBEX_DATABASE_URL
npx tenants list
```

`create` does, in order: register the tenant as `provisioning`, check the secret is not a privileged role,
create the role (password sent as a SCRAM verifier), create the database owned by that role, revoke `PUBLIC`
access, run migrations, run your seed, mark the tenant `active`. If any step fails the tenant becomes `failed`
and running `create` again resumes it.

## 5. NestJS module

See the [README quick start](../README.md#quick-start). Then:

- inject `TenantClientService<PrismaClient>` with `@InjectTenantClient()`;
- mark routes that work without a tenant with `@PublicTenant()`;
- use `@CurrentTenant()` to receive the `TenantRecord` in a handler;
- implement `authorizeTenant` so users only reach their own tenants.

## 6. Deploying a new migration

```bash
npx tenants migrate --all --dry-run          # what would run where
npx tenants migrate --all --canary --concurrency 5
```

The command exits with code 1 if anything failed, so CI/CD pipelines stop. See [migrations](migrations.md).
