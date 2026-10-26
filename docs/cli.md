# CLI reference

The `tenants` binary reads `tenants.config.{ts,mts,mjs,js}` from the working directory, or the file given with
`--config`. See [getting started](getting-started.md#3-cli-configuration) for the config shape.

| Command                                                                                                                                   | Description                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tenants list [--status active,suspended] [--json]`                                                                                       | Tenants with status, schema version, whether they are behind, pool size, database.                     |
| `tenants create <slug> [--connection-limit n] [--secret-ref ref] [--db-name name] [--template db] [--metadata json] [--no-seed] [--json]` | Provision a tenant. Resumable after a failure.                                                         |
| `tenants archive <slug> [--dump dir]`                                                                                                     | Optional `pg_dump`, then status `archived`, role `NOLOGIN`, sessions terminated. The database is kept. |
| `tenants migrate (--all \| -t <slug>...) [--concurrency 5] [--dry-run] [--canary [slug]] [--include-suspended] [--json]`                  | Apply pending migrations. Exit code 1 on any failure.                                                  |
| `tenants status [--json]`                                                                                                                 | Control database reachability, target schema, counts per status, tenants behind.                       |

`pg_dump` receives credentials through `PG*` environment variables, never on its command line, so they do not
show up in process listings.
