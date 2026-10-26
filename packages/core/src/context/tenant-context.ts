import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantResolutionFailedError } from '../errors.js';
import type { TenantRecord } from '../types.js';

export interface TenantContextValue {
  slug: string;
  /** Filled lazily once the tenant has been looked up in the registry. */
  tenant?: TenantRecord;
}

// One storage per process, even if the package is loaded twice (e.g. two copies in node_modules).
const STORAGE_KEY = Symbol.for('@massimiliano-dev/nestjs-prisma-tenants/context');
type GlobalWithStorage = typeof globalThis & { [STORAGE_KEY]?: AsyncLocalStorage<TenantContextValue> };
const holder = globalThis as GlobalWithStorage;
const storage = (holder[STORAGE_KEY] ??= new AsyncLocalStorage<TenantContextValue>());

/**
 * Request-scoped tenant context built on AsyncLocalStorage.
 * Lets singleton providers know the current tenant without request-scoped DI.
 */
export const TenantContext = {
  run<T>(value: TenantContextValue, fn: () => T): T {
    return storage.run(value, fn);
  },
  /** Current context. Throws `TenantResolutionFailedError` outside a tenant-aware request. */
  current(): TenantContextValue {
    const value = storage.getStore();
    if (!value) throw new TenantResolutionFailedError();
    return value;
  },
  currentOrNull(): TenantContextValue | null {
    return storage.getStore() ?? null;
  },
  currentSlug(): string {
    return TenantContext.current().slug;
  },
  storage,
};
