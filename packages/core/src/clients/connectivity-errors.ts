/** Node socket errors that mean the database cannot be reached. */
const NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

/** PostgreSQL SQLSTATE codes for connection, auth, missing database and shutdown problems. */
const PG_CODES = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '3D000', // invalid_catalog_name (database does not exist)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** Prisma error codes for unreachable, missing or timed-out databases. */
const PRISMA_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1011', 'P1017']);

/** Driver adapter error kinds (Prisma 7) with the same meaning. */
const ADAPTER_KINDS = new Set([
  'DatabaseNotReachable',
  'DatabaseDoesNotExist',
  'AuthenticationFailed',
  'TooManyConnections',
  'SocketTimeout',
  'ConnectionClosed',
  'DatabaseAccessDenied',
]);

const MESSAGE_HINTS = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connect ECONNREFUSED/i,
];

/**
 * True when an error means "this tenant's database is unreachable", as opposed to a query or
 * business error. Only these errors count towards opening a tenant's circuit.
 */
export function isConnectivityError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 6) return false;
  const e = error as Record<string, unknown>;

  if (e.name === 'PrismaClientInitializationError' || e.name === 'TenantPingTimeoutError') return true;
  for (const key of ['code', 'originalCode', 'errorCode']) {
    const code = e[key];
    if (typeof code === 'string' && (NODE_CODES.has(code) || PG_CODES.has(code) || PRISMA_CODES.has(code))) {
      return true;
    }
  }
  if (typeof e.kind === 'string' && ADAPTER_KINDS.has(e.kind)) return true;
  if (typeof e.message === 'string' && MESSAGE_HINTS.some((re) => re.test(e.message as string))) return true;

  // AggregateError (e.g. IPv4 + IPv6 connection attempts), causes and Prisma metadata.
  if (Array.isArray(e.errors) && e.errors.some((inner) => isConnectivityError(inner, depth + 1))) return true;
  return ['cause', 'meta', 'driverAdapterError'].some((key) => isConnectivityError(e[key], depth + 1));
}

export class TenantPingTimeoutError extends Error {
  override readonly name = 'TenantPingTimeoutError';
  constructor(timeoutMs: number) {
    super(`Database ping timed out after ${timeoutMs} ms`);
  }
}
