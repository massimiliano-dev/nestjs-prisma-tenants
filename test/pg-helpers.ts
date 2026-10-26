import pg from 'pg';
import { withDatabase } from '../packages/core/src/index.js';

/** Creates a fresh database (optionally from a template) and returns its URL. */
export async function createDatabase(adminUrl: string, name: string, template?: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
  } finally {
    await client.end();
  }
  return withDatabase(adminUrl, name);
}

export async function countConnections(adminUrl: string, dbPrefix: string): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE datname LIKE $1',
      [`${dbPrefix}%`],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

/** Unique-ish prefix so test files never collide on the shared server. */
export function uniquePrefix(name: string): string {
  return `${name}_${Math.random().toString(36).slice(2, 7)}`;
}

/** URL for a tenant database logging in as its own role (created by the provisioner). */
export function tenantUrl(
  adminUrl: string,
  dbName: string,
  user = dbName,
  password = `${dbName}-pw`,
): string {
  const url = new URL(withDatabase(adminUrl, dbName));
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Tries to connect and returns the SQLSTATE / error code, or "ok". */
export async function tryConnect(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}
