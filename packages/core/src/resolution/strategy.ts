import { isValidSlug } from '../slug.js';
import type { TenantRequestLike } from '../types.js';

/** Extracts a tenant slug from a request. Return `null` when this strategy does not apply. */
export interface TenantResolutionStrategy {
  readonly name: string;
  resolve(request: TenantRequestLike): string | null | Promise<string | null>;
}

export function headerValue(request: TenantRequestLike, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Runs strategies in order and returns the first valid slug. Invalid values (wrong charset,
 * too long) are ignored rather than trusted, so a hostile header cannot reach the registry query.
 */
export async function resolveTenantSlug(
  strategies: readonly TenantResolutionStrategy[],
  request: TenantRequestLike,
): Promise<string | null> {
  for (const strategy of strategies) {
    const raw = await strategy.resolve(request);
    if (raw === null || raw === undefined) continue;
    const slug = raw.trim().toLowerCase();
    if (isValidSlug(slug)) return slug;
  }
  return null;
}
