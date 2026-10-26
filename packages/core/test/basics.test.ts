import { describe, expect, it } from 'vitest';
import {
  buildTenantUrl,
  defaultDbName,
  defaultSecretRef,
  EnvSecretProvider,
  isValidSlug,
  redactSecrets,
  SecretResolver,
  stripPoolParams,
  TenantContext,
  TenantResolutionFailedError,
  TenantSecretUnavailableError,
  withDatabase,
} from '../src/index.js';

describe('slugs', () => {
  it('accepts lowercase, digits and inner hyphens up to 48 chars', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('acme-2')).toBe(true);
    expect(isValidSlug('-acme')).toBe(false);
    expect(isValidSlug('acme-')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('a'.repeat(48))).toBe(true);
    expect(isValidSlug('a'.repeat(49))).toBe(false);
    expect(defaultDbName('big-co')).toBe('tenant_big_co');
    expect(defaultSecretRef('big-co')).toBe('env:TENANT_BIG_CO_DATABASE_URL');
  });
});

describe('URLs', () => {
  it('sets pool params, swaps databases and strips params', () => {
    const url = buildTenantUrl('postgresql://u:p@db:5432/x?sslmode=require', {
      connectionLimit: 3,
      poolTimeoutSeconds: 5,
    });
    expect(url).toBe('postgresql://u:p@db:5432/x?sslmode=require&connection_limit=3&pool_timeout=5');
    expect(stripPoolParams(url)).toBe('postgresql://u:p@db:5432/x?sslmode=require');
    expect(withDatabase('postgresql://u:p@db:5432/x', 'tenant_acme')).toBe(
      'postgresql://u:p@db:5432/tenant_acme',
    );
  });

  it('redacts passwords', () => {
    expect(redactSecrets('error at postgresql://user:s3cr3t@db:5432/x')).toBe(
      'error at postgresql://user:***@db:5432/x',
    );
  });
});

describe('secrets', () => {
  it('resolves env references and reports missing ones', async () => {
    const resolver = new SecretResolver([new EnvSecretProvider({ A: 'postgresql://a' })]);
    await expect(resolver.resolve('env:A')).resolves.toBe('postgresql://a');
    await expect(resolver.resolve('env:B')).rejects.toBeInstanceOf(TenantSecretUnavailableError);
    await expect(resolver.resolve('akv://vault/x')).rejects.toThrow(/no secret provider/);
  });
});

describe('TenantContext', () => {
  it('propagates across awaits and isolates concurrent runs', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((slug) =>
        TenantContext.run({ slug }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return TenantContext.currentSlug();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('throws outside a context', () => {
    expect(TenantContext.currentOrNull()).toBeNull();
    expect(() => TenantContext.current()).toThrow(TenantResolutionFailedError);
  });
});
