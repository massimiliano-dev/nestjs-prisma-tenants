import type { TenantRequestLike } from '../types.js';
import { resolveTenantSlug, type TenantResolutionStrategy } from './strategy.js';

/** First strategy that yields a valid slug wins. */
export class CompositeStrategy implements TenantResolutionStrategy {
  readonly name = 'composite';
  constructor(private readonly strategies: TenantResolutionStrategy[]) {}

  resolve(request: TenantRequestLike): Promise<string | null> {
    return resolveTenantSlug(this.strategies, request);
  }
}
