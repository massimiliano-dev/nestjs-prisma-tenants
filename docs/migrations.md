# Migrations

`PrismaMigrator` runs `prisma migrate deploy` for one tenant at a time, with that tenant's `DATABASE_URL`. It uses
only Prisma's public CLI, so Prisma's own advisory lock and `_prisma_migrations` table apply as usual.

- **Target version**: the newest folder in `prisma/migrations`. Folder names start with a timestamp.
- **Applied version**: the newest finished, not rolled back, row in the tenant's `_prisma_migrations`.
- After a run, the registry's `schema_version` is updated from the database, not from assumptions.

## Rolling out

```bash
tenants migrate --all --dry-run                      # pending migrations per tenant, nothing changes
tenants migrate --all --canary acme --concurrency 5  # acme first; abort if it fails
tenants migrate --tenant acme --tenant globex        # specific tenants
tenants status                                       # who is behind
```

- Only `active` tenants are migrated by `--all`; add `--include-suspended` for suspended ones. Archived tenants
  are never migrated.
- One failing tenant does not stop the others (except the canary). The report lists each failure with the tail
  of Prisma's output (passwords redacted) and every tenant still behind the target.
- The command exits with code 1 if anything failed.

## Writing migrations for many databases

Every migration runs N times, possibly while old application code still serves traffic. Prefer
expand-and-contract changes: add nullable columns first, backfill, then make them required in a later release.
Never put tenant-specific data changes in a schema migration.

## Programmatic use

```ts
const report = await runMigrations({ registry, migrator, secrets, concurrency: 5, canary: true });
if (report.failed.length) process.exitCode = 1;
```
