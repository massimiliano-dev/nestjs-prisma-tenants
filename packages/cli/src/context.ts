import {
  ControlDb,
  EnvSecretProvider,
  SecretResolver,
  TenantProvisioner,
  TenantRegistry,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import type { TenantsCliConfig } from './config.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliContext {
  config: TenantsCliConfig;
  db: ControlDb;
  registry: TenantRegistry;
  secrets: SecretResolver;
  provisioner: TenantProvisioner;
  io: CliIo;
}

export async function openContext(config: TenantsCliConfig, io: CliIo): Promise<CliContext> {
  const db = new ControlDb({ url: config.controlDatabaseUrl, poolMax: 2 });
  await db.migrate();
  if (db.hardeningWarning) io.err(`Warning: ${db.hardeningWarning}`);
  const registry = new TenantRegistry(db, { cacheTtlMs: 0 });
  const secrets = new SecretResolver(config.secretProviders ?? [new EnvSecretProvider()]);
  const provisioner = new TenantProvisioner({
    registry,
    secrets,
    adminDatabaseUrl: config.adminDatabaseUrl ?? config.controlDatabaseUrl,
    ...(config.migrator ? { migrator: config.migrator } : {}),
    ...(config.dbNameFor ? { dbNameFor: config.dbNameFor } : {}),
    ...(config.secretRefFor ? { secretRefFor: config.secretRefFor } : {}),
    ...(config.isolation ? { isolation: config.isolation } : {}),
  });
  return { config, db, registry, secrets, provisioner, io };
}
