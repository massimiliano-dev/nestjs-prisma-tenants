import type { ExecutionContext, ModuleMetadata } from '@nestjs/common';
import type {
  TenantRecord,
  TenantResolutionStrategy,
  TenantsCoreOptions,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

export interface TenantsModuleOptions<TClient = unknown> extends TenantsCoreOptions<TClient> {
  /** Tried in order; the first valid slug wins. */
  strategies: TenantResolutionStrategy[];
  /** Reject requests without a tenant unless the route is marked `@PublicTenant()`. Default true. */
  requireTenant?: boolean;
  /**
   * Register the resolution middleware on every route. Default true. Set it to false only if you
   * resolve tenants yourself, e.g. with `registerFastifyTenantHook`.
   */
  registerMiddleware?: boolean;
  /**
   * Resolving a tenant is not authorizing it. Return true only if the caller may act on `tenant`
   * (e.g. the authenticated user is a member). Runs after the registry check on every tenant route.
   * Without it, any client can address any active tenant by changing the subdomain or header.
   */
  authorizeTenant?: (tenant: TenantRecord, context: ExecutionContext) => boolean | Promise<boolean>;
  /**
   * Answer 403 with the tenant status for suspended or archived tenants. Default false: unknown and
   * inactive tenants both get the same 404, so responses do not reveal which tenants exist.
   */
  revealTenantStatus?: boolean;
}

export interface TenantsModuleAsyncOptions<TClient = unknown> extends Pick<ModuleMetadata, 'imports'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => TenantsModuleOptions<TClient> | Promise<TenantsModuleOptions<TClient>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
}
