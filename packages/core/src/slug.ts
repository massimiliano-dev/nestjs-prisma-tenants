/** Lowercase letters, digits and inner hyphens, 1 to 48 characters. Same rule as the control DB check constraint. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function assertValidSlug(value: string): string {
  if (!isValidSlug(value)) {
    throw new TypeError(
      `Invalid tenant slug "${value}": use 1-48 lowercase letters, digits or inner hyphens`,
    );
  }
  return value;
}

/** Default database name for a tenant: `tenant_<slug>` with hyphens turned into underscores. */
export function defaultDbName(slug: string): string {
  return `tenant_${slug.replaceAll('-', '_')}`;
}

/** Default secret reference: `env:TENANT_<SLUG>_DATABASE_URL`. */
export function defaultSecretRef(slug: string): string {
  return `env:TENANT_${slug.replaceAll('-', '_').toUpperCase()}_DATABASE_URL`;
}
