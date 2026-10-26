import type { TenantRequestLike } from '../types.js';
import { headerValue, type TenantResolutionStrategy } from './strategy.js';

/** Reads the tenant slug from a header, `X-Tenant-Id` by default. Meant for service-to-service calls. */
export class HeaderStrategy implements TenantResolutionStrategy {
  readonly name = 'header';
  private readonly header: string;

  constructor(options: { header?: string } = {}) {
    this.header = (options.header ?? 'x-tenant-id').toLowerCase();
  }

  resolve(request: TenantRequestLike): string | null {
    return headerValue(request, this.header) ?? null;
  }
}
