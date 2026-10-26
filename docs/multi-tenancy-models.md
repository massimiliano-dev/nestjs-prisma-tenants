# DB per tenant vs schema per tenant vs row-level security

There is no universally best model. This toolkit implements **database per tenant**. Here is when that is the
right call and when it is not.

|                                                      | Database per tenant                                         | Schema per tenant                                                                  | Shared tables + RLS                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Isolation                                            | Strongest. Separate catalog, role, `CONNECT` privilege.     | Medium. Same database, separate namespaces; one misconfigured `search_path` leaks. | Logical. Every query relies on the policy and on setting the tenant correctly. |
| Blast radius of a bug                                | One tenant                                                  | Usually one tenant                                                                 | Potentially all tenants                                                        |
| Per-tenant backup, restore, export, deletion         | Trivial (`pg_dump`, `DROP DATABASE`)                        | Possible, fiddly                                                                   | Hard                                                                           |
| Data residency / dedicated server for a big customer | Move the database                                           | Hard                                                                               | Very hard                                                                      |
| Connections                                          | One pool per active tenant: needs an LRU like this toolkit  | Can share a pool                                                                   | Shared pool                                                                    |
| Migrations                                           | N runs, need orchestration (canary, concurrency, reporting) | N runs                                                                             | One run                                                                        |
| Cross-tenant analytics                               | Needs ETL                                                   | Needs `UNION` across schemas                                                       | Plain SQL                                                                      |
| Comfortable scale                                    | Tens to low thousands of tenants per server                 | Hundreds to thousands                                                              | Unlimited                                                                      |

## Choose database per tenant when

- customers are businesses that ask about isolation, residency, or per-customer restore (healthcare, finance,
  public sector, B2B SaaS);
- tenants differ a lot in size, and you may move a large one to its own server;
- you need to delete or hand over a tenant's data completely and provably.

## Prefer something else when

- you have many thousands of small tenants (free plans, consumer apps): use shared tables with RLS;
- most features need cross-tenant queries;
- you cannot automate migrations across many databases.

A common hybrid: shared tables with RLS for the long tail, database per tenant for enterprise customers. The
`DbAdapter` boundary allows routing some tenants to a shared database if you need it.
