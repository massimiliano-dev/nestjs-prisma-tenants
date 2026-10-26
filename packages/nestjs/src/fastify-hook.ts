import {
  resolveTenantSlug,
  TenantContext,
  type TenantResolutionStrategy,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

interface FastifyLike {
  addHook(
    name: 'onRequest',
    hook: (
      request: { headers: Record<string, string | string[] | undefined>; hostname?: string; url?: string },
      reply: unknown,
      done: (error?: Error) => void,
    ) => void,
  ): unknown;
}

/**
 * Alternative to the Nest middleware for Fastify apps that register `registerMiddleware: false`.
 * Call it on `app.getHttpAdapter().getInstance()` before `app.listen()`.
 */
export function registerFastifyTenantHook(
  fastify: FastifyLike,
  strategies: TenantResolutionStrategy[],
): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    resolveTenantSlug(strategies, {
      headers: request.headers,
      hostname: request.hostname,
      url: request.url,
    }).then(
      (slug) => (slug ? TenantContext.run({ slug }, () => done()) : done()),
      (error: Error) => done(error),
    );
  });
}
