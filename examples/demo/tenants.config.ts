import { defineTenantsConfig } from '@massimiliano-dev/nestjs-prisma-tenants-cli';
import { PrismaMigrator } from '@massimiliano-dev/nestjs-prisma-tenants-prisma';
import pg from 'pg';

// Used by the `tenants` CLI. Tenant connection URLs come from env:TENANT_<SLUG>_DATABASE_URL.
export default defineTenantsConfig({
  controlDatabaseUrl: process.env.CONTROL_DATABASE_URL!,
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
  migrator: new PrismaMigrator({ migrationsDir: 'prisma/migrations', configPath: 'prisma.config.ts' }),
  defaultConnectionLimit: 3,
  async seed({ url, tenant }) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('INSERT INTO "Note" (title) VALUES ($1)', [`Welcome to ${tenant.slug}`]);
    await client.end();
  },
});
