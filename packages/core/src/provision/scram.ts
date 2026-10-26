import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Builds a PostgreSQL SCRAM-SHA-256 verifier on the client side, so `CREATE ROLE ... PASSWORD`
 * never sends the plain password to the server (or to its statement logs).
 */
export function scramSha256Verifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
