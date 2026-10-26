# Connection budget

PostgreSQL's default `max_connections` is 100, and a few are reserved for superusers. Every application instance
opens:

```
control pool (default 3) + cache.max × connectionLimit
```

The defaults are 20 clients × 3 connections + 3 = 63 per instance. With two instances, that is 126, which is
already too many for a default server.

## How to size

1. Decide the budget per instance: `(max_connections − reserved − other services) / instances`.
2. Pick `connectionLimit` from the concurrency one tenant needs. 2 or 3 is enough for most request workloads.
3. Set `cache.max = floor((budget − control pool) / connectionLimit)`.
4. Set `cache.maxConnectionsBudget` to the budget so a warning is logged if you exceed it.

`worstCaseConnections({ cacheMax, connectionLimit, reservedConnections })` computes the same number in code.

## When tenants outnumber cache slots

That is the point of the LRU: a cold tenant costs one client creation (tens of milliseconds) on its first
request after eviction. Watch `manager.stats()`: a high `evictions / misses` ratio means `cache.max` is too low
for your traffic. Then raise the server's `max_connections`, add PgBouncer in transaction mode in front of the
tenant databases, or shard tenants across servers.
