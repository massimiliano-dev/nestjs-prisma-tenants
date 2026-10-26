import type { CliContext } from '../context.js';

export interface CreateOptions {
  connectionLimit?: string;
  secretRef?: string;
  dbName?: string;
  template?: string;
  metadata?: string;
  seed?: boolean;
  json?: boolean;
}

export async function createCommand(ctx: CliContext, slug: string, opts: CreateOptions): Promise<number> {
  const connectionLimit = opts.connectionLimit ?? ctx.config.defaultConnectionLimit;
  const tenant = await ctx.provisioner.create(slug, {
    ...(connectionLimit !== undefined ? { connectionLimit: Number(connectionLimit) } : {}),
    ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
    ...(opts.dbName ? { dbName: opts.dbName } : {}),
    ...(opts.template ? { template: opts.template } : {}),
    ...(opts.metadata ? { metadata: JSON.parse(opts.metadata) as Record<string, unknown> } : {}),
    ...(opts.seed !== false && ctx.config.seed ? { seed: ctx.config.seed } : {}),
  });
  ctx.io.out(
    opts.json
      ? JSON.stringify(tenant, null, 2)
      : `Created tenant ${tenant.slug} (database ${tenant.dbName}, schema ${tenant.schemaVersion ?? '-'}, secret ${tenant.secretRef}).`,
  );
  return 0;
}
