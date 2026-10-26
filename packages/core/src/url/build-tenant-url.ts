export interface TenantUrlOptions {
  connectionLimit?: number;
  /** Seconds a query waits for a free pooled connection. */
  poolTimeoutSeconds?: number;
}

/**
 * Applies pool settings to a PostgreSQL connection URL. `connection_limit` and `pool_timeout`
 * are read by Prisma's URL parser; driver adapters receive the same value as pool `max`.
 */
export function buildTenantUrl(baseUrl: string, options: TenantUrlOptions = {}): string {
  const url = new URL(baseUrl);
  if (options.connectionLimit !== undefined) {
    url.searchParams.set('connection_limit', String(options.connectionLimit));
  }
  if (options.poolTimeoutSeconds !== undefined) {
    url.searchParams.set('pool_timeout', String(options.poolTimeoutSeconds));
  }
  return url.toString();
}

/** Returns the same server URL pointing at another database. */
export function withDatabase(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(dbName)}`;
  return url.toString();
}

/** Removes the toolkit's pool parameters, which plain `pg` and `psql` do not understand. */
export function stripPoolParams(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.delete('connection_limit');
  url.searchParams.delete('pool_timeout');
  return url.toString();
}

/** Masks the password of any postgres URL inside a string, for logs and error output. */
export function redactSecrets(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, '$1***@');
}
