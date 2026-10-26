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

const POSTGRES_SCHEMES = ['postgresql://', 'postgres://'];

/**
 * Masks the password of any postgres URL inside a string, for logs and error output.
 * Linear scan with indexOf instead of a backtracking regex, so hostile input cannot cause ReDoS.
 */
export function redactSecrets(text: string): string {
  const lower = text.toLowerCase();
  // Next known position of each scheme; recomputed only once the cursor has passed it, so the whole scan
  // is linear in the length of the text.
  const next = POSTGRES_SCHEMES.map((scheme) => lower.indexOf(scheme));
  let out = '';
  let cursor = 0;
  for (;;) {
    let pick = -1;
    for (let i = 0; i < POSTGRES_SCHEMES.length; i++) {
      if (next[i]! !== -1 && next[i]! < cursor) next[i] = lower.indexOf(POSTGRES_SCHEMES[i]!, cursor);
      if (next[i]! !== -1 && (pick === -1 || next[i]! < next[pick]!)) pick = i;
    }
    if (pick === -1) break;
    const authorityStart = next[pick]! + POSTGRES_SCHEMES[pick]!.length;
    // Userinfo ends at the first "@" before any "/", whitespace or the end of the text.
    let end = authorityStart;
    let colon = -1;
    while (end < text.length) {
      const ch = text[end]!;
      if (ch === '@' || ch === '/' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') break;
      if (ch === ':' && colon === -1) colon = end;
      end += 1;
    }
    if (text[end] === '@' && colon !== -1) {
      out += `${text.slice(cursor, colon + 1)}***`;
    } else {
      out += text.slice(cursor, end);
    }
    cursor = end;
  }
  return out + text.slice(cursor);
}
