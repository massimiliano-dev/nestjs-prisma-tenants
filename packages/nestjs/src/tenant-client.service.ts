import { Inject, Injectable } from '@nestjs/common';
import {
  TenantClientManager,
  TenantContext,
  TenantRegistry,
  type TenantRecord,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

/**
 * Singleton that hands out the current tenant's client. It reads the tenant from AsyncLocalStorage,
 * so it can be injected anywhere without making providers request-scoped.
 */
@Injectable()
export class TenantClientService<TClient = unknown> {
  constructor(
    @Inject(TenantClientManager) private readonly manager: TenantClientManager<TClient>,
    @Inject(TenantRegistry) private readonly registry: TenantRegistry,
  ) {}

  /** Slug of the current request's tenant. Throws outside a tenant request. */
  get slug(): string {
    return TenantContext.current().slug;
  }

  async tenant(): Promise<TenantRecord> {
    const store = TenantContext.current();
    store.tenant ??= await this.registry.getActive(store.slug);
    return store.tenant;
  }

  /** Client of the current tenant, created on first use and then cached. */
  async current(): Promise<TClient> {
    return this.manager.getForRecord(await this.tenant());
  }

  /** Client of an explicit tenant, e.g. in background jobs. */
  forTenant(slug: string): Promise<TClient> {
    return this.manager.get(slug);
  }

  /**
   * Runs `fn` with the current tenant's client and reports connectivity errors to that tenant's
   * circuit breaker, so a database that dies mid-request starts failing fast.
   */
  async withClient<T>(fn: (client: TClient) => Promise<T>): Promise<T> {
    const tenant = await this.tenant();
    const client = await this.manager.getForRecord(tenant);
    try {
      return await fn(client);
    } catch (error) {
      this.manager.reportError(tenant.slug, error);
      throw error;
    }
  }
}
