# Architecture

## Request lifecycle

1. **`TenantContextMiddleware`** runs on every route. It asks each strategy in order for a slug, validates it,
   and runs the rest of the request inside `TenantContext.run({ slug })` (AsyncLocalStorage). It never rejects a
   request.
2. **`TenantRequiredGuard`** (global) rejects requests without a tenant unless the route is `@PublicTenant()`.
   It loads the tenant from the registry through a short in-memory cache (30 s by default, unknown slugs
   included), rejects inactive tenants, and calls `authorizeTenant`.
3. **`TenantClientService.current()`** returns the tenant's client from the **client manager**. Nothing connects
   to a tenant database until a handler asks for a client.
4. **`TenantExceptionFilter`** maps toolkit errors to HTTP responses without leaking details.

All providers are singletons. The tenant travels with the async context, not with the DI scope, so there is no
per-request instantiation cost.

## Client manager

`TenantClientManager` holds at most `cache.max` clients in an LRU cache:

- **Eviction.** The least recently used client is closed (`$disconnect`) when a new tenant needs a slot.
- **Idle TTL.** A client unused for `cache.idleTtlMs` is closed, even if the cache is not full.
- **Single flight.** Concurrent requests for the same cold tenant share one client creation.
- **Pool size.** Each client's pool is capped at the tenant's `connectionLimit`, stored in the registry.
- **Budget warning.** If `max × connectionLimit + control pool` exceeds `maxConnectionsBudget`, a warning is logged.

## Circuit breaker

Every tenant has its own breaker. Only _connectivity_ errors count (connection refused, timeouts, auth failures,
missing database, PostgreSQL shutdown codes, Prisma `P1001`-style errors). After `failureThreshold` consecutive
failures the circuit opens: requests for that tenant fail immediately with 503 and its client is closed. After
`resetTimeoutMs` one trial request is allowed through. Query errors such as unique violations never open a
circuit.

Errors raised while using a client reach the breaker when you go through `TenantClientService.withClient()` or
call `manager.reportError(slug, error)`.

## Packages

```
core     registry (pg), secrets, client manager, strategies, migrations orchestration, provisioning
prisma   DbAdapter for Prisma 7 driver adapters, PrismaMigrator (spawns `prisma migrate deploy`)
nestjs   TenantsModule, middleware, guard, filter, decorators
cli      `tenants` command on top of core
```

The core does not depend on Prisma. A `DbAdapter<TClient>` has three functions (`create`, `ping`, `disconnect`),
which is all a Drizzle or raw `pg` integration needs.
