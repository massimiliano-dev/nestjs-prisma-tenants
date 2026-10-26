import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  TenantAccessDeniedError,
  TenantContext,
  TenantRegistry,
  TenantResolutionFailedError,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { PUBLIC_TENANT_KEY, TENANTS_MODULE_OPTIONS } from './tenants.constants.js';
import type { TenantsModuleOptions } from './tenants.options.js';

/**
 * Global guard. On tenant routes it checks that the tenant exists and is active (cached registry
 * lookup), runs `authorizeTenant`, and stores the record in the request context. It does not open
 * a database connection.
 */
@Injectable()
export class TenantRequiredGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TenantRegistry) private readonly registry: TenantRegistry,
    @Inject(TENANTS_MODULE_OPTIONS) private readonly options: TenantsModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const store = TenantContext.currentOrNull();
    if (!store) {
      if (isPublic || this.options.requireTenant === false) return true;
      throw new TenantResolutionFailedError();
    }
    if (isPublic) return true;
    const tenant = await this.registry.getActive(store.slug);
    if (this.options.authorizeTenant && !(await this.options.authorizeTenant(tenant, context))) {
      throw new TenantAccessDeniedError(tenant.slug);
    }
    store.tenant = tenant;
    return true;
  }
}
