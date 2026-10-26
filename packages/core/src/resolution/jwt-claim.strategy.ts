import type { TenantRequestLike } from '../types.js';
import { headerValue, type TenantResolutionStrategy } from './strategy.js';

export interface JwtClaimStrategyOptions {
  /** Claim name, dotted paths allowed (`org.slug`). Default `tenant`. */
  claim?: string;
  /** Header carrying the token. Default `authorization`. */
  header?: string;
  /**
   * Verifies the token (signature, expiry, audience) and returns its payload, e.g. with `jose`'s
   * `jwtVerify`. Throw or return null to reject. Required unless `unsafeDecodeWithoutVerification`.
   */
  verify?: (token: string) => unknown | Promise<unknown>;
  /**
   * Skip verification and only decode the payload. Anyone can then pick any tenant by forging a
   * token, so use it only when a guard that runs before any data access verifies the same token.
   */
  unsafeDecodeWithoutVerification?: true;
}

/** Reads the tenant from a claim of a Bearer JWT. The result is then checked against the registry. */
export class JwtClaimStrategy implements TenantResolutionStrategy {
  readonly name = 'jwt-claim';
  private readonly path: string[];
  private readonly header: string;

  constructor(private readonly options: JwtClaimStrategyOptions) {
    if (!options?.verify && options?.unsafeDecodeWithoutVerification !== true) {
      throw new TypeError(
        'JwtClaimStrategy needs a `verify` function (or explicit `unsafeDecodeWithoutVerification: true`)',
      );
    }
    this.path = (options.claim ?? 'tenant').split('.');
    this.header = (options.header ?? 'authorization').toLowerCase();
  }

  async resolve(request: TenantRequestLike): Promise<string | null> {
    const raw = headerValue(request, this.header);
    if (!raw) return null;
    const token = raw.replace(/^Bearer\s+/i, '');
    try {
      let value: unknown = this.options.verify ? await this.options.verify(token) : decodePayload(token);
      for (const key of this.path) {
        if (!value || typeof value !== 'object') return null;
        value = (value as Record<string, unknown>)[key];
      }
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
}

function decodePayload(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
