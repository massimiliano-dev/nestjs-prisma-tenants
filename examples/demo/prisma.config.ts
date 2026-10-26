import { defineConfig, env } from 'prisma/config';

// DATABASE_URL is set per tenant by `tenants migrate` / `tenants create`.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
