import { createParamDecorator, Inject, SetMetadata } from '@nestjs/common';
import { TenantContext } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { PUBLIC_TENANT_KEY } from './tenants.constants.js';
import { TenantClientService } from './tenant-client.service.js';

/** Route or controller that works without a tenant (health checks, signup, landing pages). */
export const PublicTenant = () => SetMetadata(PUBLIC_TENANT_KEY, true);

/** Injects `TenantClientService`. Type it with your client: `TenantClientService<PrismaClient>`. */
export const InjectTenantClient = () => Inject(TenantClientService);

/** Handler parameter with the current `TenantRecord` (undefined on public routes without a tenant). */
export const CurrentTenant = createParamDecorator(() => TenantContext.currentOrNull()?.tenant);
