import { TenantSecretUnavailableError } from '../errors.js';

/**
 * Resolves a secret reference stored in the registry (e.g. `env:TENANT_ACME_DATABASE_URL`)
 * into a connection URL. Implement it for Azure Key Vault, AWS Secrets Manager, Vault, etc.
 */
export interface SecretProvider {
  supports(secretRef: string): boolean;
  resolve(secretRef: string): Promise<string>;
}

/** Reads `env:NAME` references from environment variables. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  supports(secretRef: string): boolean {
    return secretRef.startsWith('env:');
  }

  async resolve(secretRef: string): Promise<string> {
    const name = secretRef.slice('env:'.length);
    const value = this.env[name];
    if (!value) throw new TenantSecretUnavailableError(secretRef, `environment variable ${name} is not set`);
    return value;
  }
}

/** Picks the first provider that supports a reference. */
export class SecretResolver {
  private readonly providers: SecretProvider[];

  constructor(providers: SecretProvider[] = [new EnvSecretProvider()]) {
    this.providers = providers;
  }

  async resolve(secretRef: string): Promise<string> {
    const provider = this.providers.find((p) => p.supports(secretRef));
    if (!provider)
      throw new TenantSecretUnavailableError(secretRef, 'no secret provider supports this reference');
    return provider.resolve(secretRef);
  }
}
