# Security

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/massimiliano-dev/nestjs-prisma-tenants/security/advisories/new).
You will get an answer within 7 days. Fixes are released as patch versions with an advisory.

Supported versions: the latest minor release of 0.x.

## Threat model

The main risk in a multi-tenant system is **one tenant reading or changing another tenant's data**. The toolkit
defends against it in layers, so a single mistake does not expose everything.

| Layer         | Protection                                                                                                                                                                                     | Default        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Database      | One database and one login role per tenant. The role owns only its database.                                                                                                                   | on             |
| Database      | `CONNECT` and `TEMPORARY` revoked from `PUBLIC` on tenant databases and on the control database, so a leaked tenant credential cannot even open a session elsewhere.                           | on             |
| Database      | Tenant roles are created `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`. Tenant secrets that log in as a superuser, as a role with `CREATEDB`/`CREATEROLE`, or as the admin role are refused. | on             |
| Database      | Role passwords are sent as client-side SCRAM-SHA-256 verifiers, never in clear text, so they do not appear in server statement logs.                                                           | always         |
| Database      | Archiving a tenant sets its role to `NOLOGIN` and terminates its sessions.                                                                                                                     | on             |
| Registry      | The control database stores a secret _reference_ (`env:…`, `akv://…`), never a connection string or password.                                                                                  | always         |
| Resolution    | Slugs are validated against `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$` before any lookup. Invalid input is treated as "no tenant".                                                               | always         |
| Resolution    | `SubdomainStrategy` reads the `Host` header only. `X-Forwarded-Host` is used only with `trustForwardedHost: true`.                                                                             | off            |
| Resolution    | `JwtClaimStrategy` requires a `verify` function. Decoding without verification needs the explicit `unsafeDecodeWithoutVerification: true`.                                                     | required       |
| Authorization | `authorizeTenant(tenant, context)` runs on every tenant route after the registry check.                                                                                                        | you provide it |
| HTTP          | Unknown and inactive tenants return the same 404, so responses do not reveal which tenants exist. Error bodies never echo input or internal details.                                           | on             |
| Availability  | Per-tenant circuit breaker and connection caps; unknown slugs are cached negatively so random subdomains cannot flood the control database.                                                    | on             |
| Logs          | Passwords in PostgreSQL URLs are redacted from errors and migration output.                                                                                                                    | always         |

### What the toolkit does not do

- **Authenticate users.** Resolving a tenant only tells you which tenant a request _claims_. Without
  `authorizeTenant`, anyone can address any active tenant by changing the subdomain or header.
  `HeaderStrategy` in particular is meant for trusted service-to-service traffic.
- **Encrypt data or connections.** Use `sslmode=verify-full` in tenant URLs and encryption at rest on the server.
- **Store secrets.** Keep tenant connection strings in a secret manager, see [docs/secrets.md](docs/secrets.md).

## Hardening checklist for production

1. Use three separate roles: a **control role** that owns only the control database, an **admin role** with
   `CREATEDB CREATEROLE` but **not** `SUPERUSER` for provisioning, and one **role per tenant** created by the
   toolkit. Never run the application with the admin role.
2. Give the running application only the control role and the tenant secrets. Run provisioning and migrations
   from a separate job that holds the admin credentials.
3. On the PostgreSQL server: `REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;` and keep
   `password_encryption = scram-sha-256`. Restrict `pg_hba.conf` to your application network.
4. Require TLS: `sslmode=verify-full` with the server CA.
5. Generate a strong random password per tenant (for example `openssl rand -base64 32`) and store the full URL
   in your secret manager.
6. Implement `authorizeTenant`, and verify JWTs in the strategy or in a guard that runs first.
7. Do not expose the client manager's `stats()` publicly: it lists tenant slugs. The demo puts it behind a token.
8. Keep `trustForwardedHost` off unless a proxy you control overwrites `X-Forwarded-Host`.
9. Cloning with `--template` copies data and object ownership from the template: use a template that contains
   only schema, never a real tenant.

## Supply chain

- GitHub Actions are pinned to commit SHAs, workflows run with read-only permissions by default, and Dependabot
  updates both npm packages and actions.
- CI runs `pnpm audit` and CodeQL (`security-extended` queries).
- Packages are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- The repository never contains real credentials. Values in `examples/demo` are throwaway demo passwords.
