export { TenantsModule } from './tenants.module.js';
export type { TenantsModuleOptions, TenantsModuleAsyncOptions } from './tenants.options.js';
export { TENANTS_MODULE_OPTIONS, TENANTS_RUNTIME, PUBLIC_TENANT_KEY } from './tenants.constants.js';
export { TenantClientService } from './tenant-client.service.js';
export { TenantContextMiddleware, toTenantRequest } from './tenant-context.middleware.js';
export { TenantRequiredGuard } from './tenant-required.guard.js';
export { TenantExceptionFilter } from './tenant-exception.filter.js';
export { PublicTenant, InjectTenantClient, CurrentTenant } from './public-tenant.decorator.js';
export { registerFastifyTenantHook } from './fastify-hook.js';
// Re-export the core so apps only need one import.
export * from '@massimiliano-dev/nestjs-prisma-tenants-core';
