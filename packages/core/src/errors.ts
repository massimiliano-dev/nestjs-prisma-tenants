import type { TenantStatus } from './types.js';

export type TenantErrorCode =
  | 'TENANT_NOT_FOUND'
  | 'TENANT_INACTIVE'
  | 'TENANT_DB_UNAVAILABLE'
  | 'TENANT_RESOLUTION_FAILED'
  | 'TENANT_ACCESS_DENIED'
  | 'TENANT_PROVISIONING_FAILED'
  | 'TENANT_MIGRATION_FAILED'
  | 'TENANT_SECRET_UNAVAILABLE';

export abstract class TenantError extends Error {
  abstract readonly code: TenantErrorCode;
  /** Suggested HTTP status, used by the NestJS exception filter. */
  abstract readonly httpStatus: number;
  readonly tenantSlug: string | undefined;

  protected constructor(message: string, tenantSlug?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.tenantSlug = tenantSlug;
  }
}

export class TenantNotFoundError extends TenantError {
  readonly code = 'TENANT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(slug: string) {
    super(`Tenant "${slug}" does not exist`, slug);
  }
}

export class TenantInactiveError extends TenantError {
  readonly code = 'TENANT_INACTIVE';
  readonly httpStatus = 403;
  constructor(
    slug: string,
    readonly status: TenantStatus,
  ) {
    super(`Tenant "${slug}" is not active (status: ${status})`, slug);
  }
}

export class TenantDbUnavailableError extends TenantError {
  readonly code = 'TENANT_DB_UNAVAILABLE';
  readonly httpStatus = 503;
  constructor(
    slug: string,
    readonly circuitState: 'closed' | 'open' | 'half-open',
    options?: { cause?: unknown },
  ) {
    super(
      circuitState === 'open'
        ? `Database of tenant "${slug}" is unavailable (circuit open, failing fast)`
        : `Database of tenant "${slug}" is unavailable`,
      slug,
      options,
    );
  }
}

export class TenantResolutionFailedError extends TenantError {
  readonly code = 'TENANT_RESOLUTION_FAILED';
  readonly httpStatus = 400;
  constructor(message = 'No tenant could be resolved for this request') {
    super(message);
  }
}

/** The caller is not allowed to act on the resolved tenant (see `authorizeTenant`). */
export class TenantAccessDeniedError extends TenantError {
  readonly code = 'TENANT_ACCESS_DENIED';
  readonly httpStatus = 403;
  constructor(slug: string) {
    super(`Access to tenant "${slug}" is denied`, slug);
  }
}

export class TenantProvisioningError extends TenantError {
  readonly code = 'TENANT_PROVISIONING_FAILED';
  readonly httpStatus = 500;
  constructor(slug: string, message: string, options?: { cause?: unknown }) {
    super(`Provisioning of tenant "${slug}" failed: ${message}`, slug, options);
  }
}

export class TenantMigrationError extends TenantError {
  readonly code = 'TENANT_MIGRATION_FAILED';
  readonly httpStatus = 500;
  constructor(
    slug: string | undefined,
    message: string,
    /** Tail of the migration tool output, with credentials redacted. */
    readonly output?: string,
    options?: { cause?: unknown },
  ) {
    super(
      slug ? `Migration of tenant "${slug}" failed: ${message}` : `Migration failed: ${message}`,
      slug,
      options,
    );
  }
}

export class TenantSecretUnavailableError extends TenantError {
  readonly code = 'TENANT_SECRET_UNAVAILABLE';
  readonly httpStatus = 500;
  constructor(secretRef: string, reason: string) {
    super(`Secret "${secretRef}" cannot be resolved: ${reason}`);
  }
}

export function isTenantError(error: unknown): error is TenantError {
  return error instanceof TenantError;
}
