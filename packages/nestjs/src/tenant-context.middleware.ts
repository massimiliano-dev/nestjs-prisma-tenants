import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import {
  resolveTenantSlug,
  TenantContext,
  type TenantRequestLike,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { TENANTS_MODULE_OPTIONS } from './tenants.constants.js';
import type { TenantsModuleOptions } from './tenants.options.js';

interface RawRequest {
  headers: TenantRequestLike['headers'];
  hostname?: unknown;
  originalUrl?: string;
  url?: string;
}

export function toTenantRequest(req: RawRequest): TenantRequestLike {
  return {
    headers: req.headers,
    hostname: typeof req.hostname === 'string' ? req.hostname : undefined,
    url: req.originalUrl ?? req.url,
  };
}

/**
 * Resolves the tenant slug and runs the rest of the request inside an AsyncLocalStorage context.
 * It never fails a request: the guard decides whether a tenant is required.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(@Inject(TENANTS_MODULE_OPTIONS) private readonly options: TenantsModuleOptions) {}

  async use(req: RawRequest, _res: unknown, next: (error?: unknown) => void): Promise<void> {
    let slug: string | null;
    try {
      slug = await resolveTenantSlug(this.options.strategies, toTenantRequest(req));
    } catch (error) {
      next(error);
      return;
    }
    if (!slug) {
      next();
      return;
    }
    TenantContext.run({ slug }, () => next());
  }
}
