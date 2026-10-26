# Secrets

The registry stores a **secret reference** per tenant. At runtime a `SecretProvider` turns it into a connection
URL. The URL's user and password are the tenant's dedicated role.

## Environment variables (default)

`env:TENANT_ACME_DATABASE_URL` reads `process.env.TENANT_ACME_DATABASE_URL`. Good for small deployments and
local development; inject the variables from your platform's secret store, never from committed files.

## Azure Key Vault (or any secret manager)

Implement the two-method interface:

```ts
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { SecretProvider } from '@massimiliano-dev/nestjs-prisma-tenants';

export class KeyVaultSecretProvider implements SecretProvider {
  private readonly cache = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly client = new SecretClient(process.env.KEY_VAULT_URL!, new DefaultAzureCredential()),
    private readonly ttlMs = 5 * 60_000,
  ) {}

  supports(ref: string) {
    return ref.startsWith('akv://');
  }

  async resolve(ref: string) {
    const name = ref.slice('akv://'.length);
    const hit = this.cache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    const { value } = await this.client.getSecret(name);
    if (!value) throw new Error(`Key Vault secret ${name} is empty`);
    this.cache.set(name, { value, expires: Date.now() + this.ttlMs });
    return value;
  }
}
```

Register it with `secretProviders: [new KeyVaultSecretProvider(), new EnvSecretProvider()]` and create tenants
with `--secret-ref akv://tenant-acme-db`. Use managed identity, grant the app only `get` on secrets, and give the
provisioning job `set` separately.

## Rotating a tenant password

1. Write the new URL to the secret store.
2. Change the role's password with `psql`'s `\password tenant_acme`, which hashes it on the client. A plain
   `ALTER ROLE ... PASSWORD 'clear text'` can end up in server logs. In code, `scramSha256Verifier(password)`
   from the core package builds the same verifier.
3. Call `manager.evict('acme')` on each instance, or wait for the idle TTL, so new clients use the new secret.
