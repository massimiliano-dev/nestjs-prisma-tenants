import { Module } from '@nestjs/common';
import { HeaderStrategy, SubdomainStrategy, TenantsModule } from '@massimiliano-dev/nestjs-prisma-tenants';
import { createPrismaAdapter, PrismaMigrator } from '@massimiliano-dev/nestjs-prisma-tenants-prisma';
import { PrismaClient } from './generated/prisma/client.js';
import { HealthController } from './health.controller.js';
import { NotesController } from './notes.controller.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

@Module({
  imports: [
    TenantsModule.forRootAsync<PrismaClient>({
      useFactory: () => ({
        controlDatabaseUrl: requireEnv('CONTROL_DATABASE_URL'),
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        adapter: createPrismaAdapter((driver) => new PrismaClient({ adapter: driver })),
        migrator: new PrismaMigrator({ migrationsDir: 'prisma/migrations', configPath: 'prisma.config.ts' }),
        strategies: [
          new SubdomainStrategy({ baseDomain: process.env.BASE_DOMAIN ?? 'localhost' }),
          new HeaderStrategy({ header: 'x-tenant-id' }),
        ],
        // 20 clients x 3 connections + 3 for the control DB = 63, under max_connections=100.
        cache: { max: 20, idleTtlMs: 5 * 60_000, maxConnectionsBudget: 90 },
      }),
    }),
  ],
  controllers: [NotesController, HealthController],
})
export class AppModule {}
