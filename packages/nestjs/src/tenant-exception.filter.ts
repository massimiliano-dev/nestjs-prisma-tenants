import { ArgumentsHost, Catch, ExceptionFilter, Inject } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { TenantError } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { TENANTS_MODULE_OPTIONS } from './tenants.constants.js';
import type { TenantsModuleOptions } from './tenants.options.js';

/**
 * Maps toolkit errors to HTTP: 400 resolution, 403 access denied, 404 unknown or inactive tenant,
 * 503 tenant database down, 500 otherwise. Messages never echo request input or internals.
 */
@Catch(TenantError)
export class TenantExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(TENANTS_MODULE_OPTIONS) private readonly options: TenantsModuleOptions,
  ) {}

  catch(error: TenantError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw error;
    const { status, code, message } = this.describe(error);
    this.adapterHost.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      { statusCode: status, error: code, message },
      status,
    );
  }

  private describe(error: TenantError): { status: number; code: string; message: string } {
    switch (error.code) {
      case 'TENANT_RESOLUTION_FAILED':
        return { status: 400, code: error.code, message: 'No tenant could be resolved for this request' };
      case 'TENANT_ACCESS_DENIED':
        return { status: 403, code: error.code, message: 'Access to this tenant is denied' };
      case 'TENANT_INACTIVE':
        if (this.options.revealTenantStatus) {
          return { status: 403, code: error.code, message: 'This tenant is not active' };
        }
        return { status: 404, code: 'TENANT_NOT_FOUND', message: 'Tenant not found' };
      case 'TENANT_NOT_FOUND':
        return { status: 404, code: error.code, message: 'Tenant not found' };
      case 'TENANT_DB_UNAVAILABLE':
        return { status: 503, code: error.code, message: 'Tenant temporarily unavailable' };
      default:
        return { status: 500, code: 'TENANT_ERROR', message: 'Internal tenant error' };
    }
  }
}
