import { PrismaPg } from '@prisma/adapter-pg';
import {
  stripPoolParams,
  type ClientFactoryContext,
  type DbAdapter,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';
import type pg from 'pg';

/** The parts of a generated PrismaClient the toolkit needs. */
export interface PrismaClientLike {
  $disconnect(): Promise<void>;
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface PrismaAdapterOptions {
  /** Extra `pg` pool settings. `max` always comes from the tenant's connection limit. */
  pool?: Omit<pg.PoolConfig, 'connectionString' | 'max'>;
  /** Postgres schema used by Prisma queries, if not `public`. */
  schema?: string;
}

/**
 * Builds a `DbAdapter` for your generated Prisma 7 client. You keep ownership of the schema and
 * the client class; the toolkit only decides when to create and close one per tenant.
 *
 * ```ts
 * import { PrismaClient } from './generated/prisma/client.js';
 * const adapter = createPrismaAdapter((driver) => new PrismaClient({ adapter: driver }));
 * ```
 */
export function createPrismaAdapter<TClient extends PrismaClientLike>(
  factory: (driverAdapter: PrismaPg, ctx: ClientFactoryContext) => TClient,
  options: PrismaAdapterOptions = {},
): DbAdapter<TClient> {
  return {
    create(ctx) {
      const driver = new PrismaPg(
        {
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          ...options.pool,
          connectionString: stripPoolParams(ctx.url),
          max: ctx.connectionLimit,
        },
        options.schema ? { schema: options.schema } : undefined,
      );
      return factory(driver, ctx);
    },
    async ping(client) {
      await client.$queryRawUnsafe('SELECT 1');
    },
    async disconnect(client) {
      await client.$disconnect();
    },
  };
}
