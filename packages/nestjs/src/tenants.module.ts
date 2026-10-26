import {
  DynamicModule,
  Global,
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  createTenantsRuntime,
  TenantClientManager,
  TenantProvisioner,
  TenantRegistry,
  type TenantsRuntime,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { TenantClientService } from './tenant-client.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantExceptionFilter } from './tenant-exception.filter.js';
import { TenantRequiredGuard } from './tenant-required.guard.js';
import { TENANTS_MODULE_OPTIONS, TENANTS_RUNTIME } from './tenants.constants.js';
import type { TenantsModuleAsyncOptions, TenantsModuleOptions } from './tenants.options.js';

const sharedProviders: Provider[] = [
  {
    provide: TENANTS_RUNTIME,
    useFactory: (options: TenantsModuleOptions) => createTenantsRuntime(options),
    inject: [TENANTS_MODULE_OPTIONS],
  },
  {
    provide: TenantRegistry,
    useFactory: (r: TenantsRuntime<unknown>) => r.registry,
    inject: [TENANTS_RUNTIME],
  },
  {
    provide: TenantClientManager,
    useFactory: (r: TenantsRuntime<unknown>) => r.manager,
    inject: [TENANTS_RUNTIME],
  },
  {
    provide: TenantProvisioner,
    useFactory: (r: TenantsRuntime<unknown>) => r.provisioner,
    inject: [TENANTS_RUNTIME],
  },
  TenantClientService,
  TenantContextMiddleware,
  { provide: APP_GUARD, useClass: TenantRequiredGuard },
  { provide: APP_FILTER, useClass: TenantExceptionFilter },
];

const exported = [
  TENANTS_RUNTIME,
  TenantRegistry,
  TenantClientManager,
  TenantProvisioner,
  TenantClientService,
];

/**
 * Database-per-tenant support. Global: import it once in the root module.
 *
 * ```ts
 * TenantsModule.forRootAsync({
 *   inject: [ConfigService],
 *   useFactory: (config) => ({
 *     controlDatabaseUrl: config.getOrThrow('CONTROL_DATABASE_URL'),
 *     adapter: createPrismaAdapter((driver) => new PrismaClient({ adapter: driver })),
 *     strategies: [new SubdomainStrategy({ baseDomain: 'example.com' })],
 *   }),
 * })
 * ```
 */
@Global()
@Module({})
export class TenantsModule implements NestModule, OnApplicationShutdown {
  constructor(
    @Inject(TENANTS_MODULE_OPTIONS) private readonly options: TenantsModuleOptions,
    @Inject(TENANTS_RUNTIME) private readonly runtime: TenantsRuntime<unknown>,
  ) {}

  static forRoot<TClient>(options: TenantsModuleOptions<TClient>): DynamicModule {
    return {
      module: TenantsModule,
      providers: [{ provide: TENANTS_MODULE_OPTIONS, useValue: options }, ...sharedProviders],
      exports: exported,
    };
  }

  static forRootAsync<TClient>(options: TenantsModuleAsyncOptions<TClient>): DynamicModule {
    return {
      module: TenantsModule,
      imports: options.imports ?? [],
      providers: [
        { provide: TENANTS_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...sharedProviders,
      ],
      exports: exported,
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    if (this.options.registerMiddleware === false) return;
    consumer.apply(TenantContextMiddleware).forRoutes('{*splat}');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
  }
}
