import pg from 'pg';
import { TenantProvisioningError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { Migrator } from '../migrate/migrator.js';
import type { TenantRegistry } from '../registry/tenant-registry.js';
import type { SecretResolver } from '../secrets/secret-provider.js';
import { assertValidSlug, defaultDbName, defaultSecretRef } from '../slug.js';
import type { Logger, TenantRecord } from '../types.js';
import { redactSecrets, stripPoolParams } from '../url/build-tenant-url.js';
import { scramSha256Verifier } from './scram.js';

export interface TenantIsolationOptions {
  /**
   * Create a login role per tenant from the user and password in the tenant's secret URL, and make
   * it the owner of the tenant database. Tenants then cannot reach each other's data even with a
   * leaked connection string. Default true.
   */
  dedicatedRole?: boolean;
  /** Revoke the default CONNECT and TEMPORARY privileges of PUBLIC on the tenant database. Default true. */
  revokePublicAccess?: boolean;
  /** Refuse tenant secrets that log in as a superuser or as the admin role. Default true. */
  forbidPrivilegedRole?: boolean;
}

export interface TenantProvisionerOptions {
  registry: TenantRegistry;
  secrets: SecretResolver;
  /** URL of a role allowed to `CREATE DATABASE` on the tenant server. */
  adminDatabaseUrl: string;
  migrator?: Migrator;
  /** Called after an archive so open clients get closed. */
  onArchived?: (slug: string) => Promise<void> | void;
  dbNameFor?: (slug: string) => string;
  secretRefFor?: (slug: string, dbName: string) => string;
  isolation?: TenantIsolationOptions;
  logger?: Logger;
}

export interface CreateTenantOptions {
  secretRef?: string;
  dbName?: string;
  connectionLimit?: number;
  metadata?: Record<string, unknown>;
  /** Clone an existing database instead of migrating from scratch (`CREATE DATABASE ... TEMPLATE`). */
  template?: string;
  /** Load initial data. Receives the tenant connection URL. */
  seed?: (ctx: { url: string; tenant: TenantRecord }) => Promise<void>;
}

export interface ArchiveTenantOptions {
  /** e.g. run `pg_dump`. Runs before the status changes; a failure aborts the archive. */
  dump?: (ctx: { url: string; tenant: TenantRecord }) => Promise<void>;
}

interface TenantCredentials {
  user: string;
  password: string;
  database: string;
}

function credentialsOf(url: string): TenantCredentials {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

/**
 * Creates and decommissions tenant databases. Creation is resumable: a failure leaves the tenant
 * in `failed` status and calling `create` again retries. Archiving never drops the database.
 */
export class TenantProvisioner {
  private readonly logger: Logger;
  private readonly isolation: Required<TenantIsolationOptions>;

  constructor(private readonly options: TenantProvisionerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.isolation = {
      dedicatedRole: options.isolation?.dedicatedRole ?? true,
      revokePublicAccess: options.isolation?.revokePublicAccess ?? true,
      forbidPrivilegedRole: options.isolation?.forbidPrivilegedRole ?? true,
    };
  }

  async create(slugInput: string, options: CreateTenantOptions = {}): Promise<TenantRecord> {
    const slug = assertValidSlug(slugInput);
    const { registry, secrets, migrator } = this.options;
    const dbName = options.dbName ?? this.options.dbNameFor?.(slug) ?? defaultDbName(slug);
    const secretRef =
      options.secretRef ?? this.options.secretRefFor?.(slug, dbName) ?? defaultSecretRef(slug);

    let tenant = await registry.findBySlug(slug);
    if (tenant && tenant.status !== 'failed' && tenant.status !== 'provisioning') {
      throw new TenantProvisioningError(slug, `tenant already exists with status "${tenant.status}"`);
    }
    tenant ??= await registry.create({
      slug,
      dbName,
      secretRef,
      status: 'provisioning',
      ...(options.connectionLimit !== undefined ? { connectionLimit: options.connectionLimit } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    if (tenant.status === 'failed') tenant = await registry.setStatus(slug, 'provisioning');

    try {
      const url = stripPoolParams(await secrets.resolve(tenant.secretRef));
      const credentials = credentialsOf(url);
      if (credentials.database !== tenant.dbName) {
        throw new Error(
          `secret points at database "${credentials.database}" but the tenant database is "${tenant.dbName}"`,
        );
      }
      await this.createDatabase(tenant.dbName, credentials, options.template);
      if (migrator) {
        const result = await migrator.deploy(url);
        await registry.setSchemaVersion(slug, result.version);
      }
      if (options.seed) await options.seed({ url, tenant });
      const active = await registry.setStatus(slug, 'active');
      this.logger.info('tenant provisioned', { slug, dbName: tenant.dbName });
      return active;
    } catch (error) {
      await registry.setStatus(slug, 'failed').catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new TenantProvisioningError(slug, redactSecrets(message), { cause: error });
    }
  }

  async archive(slug: string, options: ArchiveTenantOptions = {}): Promise<TenantRecord> {
    const tenant = await this.options.registry.getBySlug(slug);
    if (tenant.status === 'archived') return tenant;
    if (options.dump) {
      const url = stripPoolParams(await this.options.secrets.resolve(tenant.secretRef));
      await options.dump({ url, tenant });
    }
    const archived = await this.options.registry.setStatus(slug, 'archived');
    await this.options.onArchived?.(slug);
    if (this.isolation.dedicatedRole) await this.setLogin(tenant.secretRef, tenant.dbName, false);
    this.logger.info('tenant archived', { slug });
    return archived;
  }

  async suspend(slug: string): Promise<TenantRecord> {
    const tenant = await this.options.registry.setStatus(slug, 'suspended');
    await this.options.onArchived?.(slug);
    return tenant;
  }

  async activate(slug: string): Promise<TenantRecord> {
    const tenant = await this.options.registry.getBySlug(slug);
    if (this.isolation.dedicatedRole) await this.setLogin(tenant.secretRef, tenant.dbName, true);
    return this.options.registry.setStatus(slug, 'active');
  }

  /** Archived tenants lose the ability to log in; open sessions are terminated. */
  private async setLogin(secretRef: string, dbName: string, enabled: boolean): Promise<void> {
    const { user } = credentialsOf(await this.options.secrets.resolve(secretRef));
    await this.withAdmin(async (admin) => {
      await admin.query(`ALTER ROLE ${admin.escapeIdentifier(user)} ${enabled ? 'LOGIN' : 'NOLOGIN'}`);
      if (!enabled) {
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
          [dbName, user],
        );
      }
    });
  }

  private async withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: this.options.adminDatabaseUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  private async createDatabase(
    dbName: string,
    credentials: TenantCredentials,
    template?: string,
  ): Promise<void> {
    await this.withAdmin(async (admin) => {
      const db = admin.escapeIdentifier(dbName);
      const role = admin.escapeIdentifier(credentials.user);

      if (this.isolation.forbidPrivilegedRole) {
        const adminUser = new URL(this.options.adminDatabaseUrl).username;
        const { rows } = await admin.query<{
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [
          credentials.user,
        ]);
        const existing = rows[0];
        if (
          decodeURIComponent(adminUser) === credentials.user ||
          existing?.rolsuper ||
          existing?.rolcreatedb ||
          existing?.rolcreaterole
        ) {
          throw new Error(
            `tenant secret logs in as privileged role "${credentials.user}"; use a dedicated role per tenant ` +
              '(or set isolation.forbidPrivilegedRole to false)',
          );
        }
      }

      if (this.isolation.dedicatedRole) {
        if (credentials.user.startsWith('pg_'))
          throw new Error('role names starting with "pg_" are reserved');
        if (!credentials.password) throw new Error('tenant secret has no password for its dedicated role');
        const { rowCount: roleExists } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
          credentials.user,
        ]);
        const verifier = admin.escapeLiteral(scramSha256Verifier(credentials.password));
        await admin.query(
          roleExists
            ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${verifier}`
            : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${verifier}`,
        );
      }

      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (rowCount) {
        this.logger.info('tenant database already exists, reusing it', { dbName });
      } else {
        const templateClause = template ? ` TEMPLATE ${admin.escapeIdentifier(template)}` : '';
        const ownerClause = this.isolation.dedicatedRole ? ` OWNER ${role}` : '';
        await admin.query(`CREATE DATABASE ${db}${templateClause}${ownerClause}`);
      }

      if (this.isolation.revokePublicAccess) {
        await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`);
      }
    });
  }
}
