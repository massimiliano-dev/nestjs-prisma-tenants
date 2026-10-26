import pg from 'pg';
import { CONTROL_MIGRATIONS } from './sql/migrations.js';

export interface ControlDbOptions {
  url: string;
  /** Pool size for the control database. Keep it small: it serves registry lookups only. */
  poolMax?: number;
  /**
   * Revoke PUBLIC's default CONNECT/TEMPORARY on the control database during `migrate()`, so tenant
   * roles cannot even open a session there. Needs the control role to own the database. Default true.
   */
  revokePublicAccess?: boolean;
}

// Arbitrary constant used with pg_advisory_lock so concurrent processes never migrate twice.
const MIGRATION_LOCK_ID = 727_100_001;

/** Thin wrapper around a `pg` pool for the control database that holds the tenant registry. */
export class ControlDb {
  readonly pool: pg.Pool;
  readonly poolMax: number;
  private readonly revokePublicAccess: boolean;
  /** Set when hardening could not be applied, e.g. the control role does not own the database. */
  hardeningWarning: string | undefined;

  constructor(options: ControlDbOptions) {
    this.poolMax = options.poolMax ?? 3;
    this.revokePublicAccess = options.revokePublicAccess ?? true;
    this.pool = new pg.Pool({ connectionString: options.url, max: this.poolMax });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
    return this.pool.query<R>(text, values);
  }

  /** Applies pending control-DB migrations. Safe to call on every boot and from several processes. */
  async migrate(): Promise<number[]> {
    const client = await this.pool.connect();
    const applied: number[] = [];
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(`CREATE TABLE IF NOT EXISTS _tenants_meta (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<{ version: number }>('SELECT version FROM _tenants_meta');
      const done = new Set(rows.map((r) => r.version));
      for (const migration of CONTROL_MIGRATIONS) {
        if (done.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO _tenants_meta (version, name) VALUES ($1, $2)', [
            migration.version,
            migration.name,
          ]);
          await client.query('COMMIT');
          applied.push(migration.version);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      if (this.revokePublicAccess) {
        try {
          const { rows: db } = await client.query<{ name: string }>('SELECT current_database() AS name');
          await client.query(`REVOKE ALL ON DATABASE ${client.escapeIdentifier(db[0]!.name)} FROM PUBLIC`);
          this.hardeningWarning = undefined;
        } catch (error) {
          this.hardeningWarning = `could not revoke PUBLIC access on the control database: ${(error as Error).message}`;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
      client.release();
    }
    return applied;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
