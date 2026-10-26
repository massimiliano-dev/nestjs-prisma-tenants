import { TENANT_STATUSES, type TenantStatus } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import type { CliContext } from '../context.js';
import { formatTenants } from '../report.js';

export function parseStatuses(value: string | undefined): TenantStatus[] | undefined {
  if (!value) return undefined;
  const statuses = value.split(',').map((s) => s.trim()) as TenantStatus[];
  const invalid = statuses.filter((s) => !TENANT_STATUSES.includes(s));
  if (invalid.length)
    throw new Error(`Unknown status: ${invalid.join(', ')}. Use: ${TENANT_STATUSES.join(', ')}`);
  return statuses;
}

export async function listCommand(
  ctx: CliContext,
  opts: { status?: string; json?: boolean },
): Promise<number> {
  const status = parseStatuses(opts.status);
  const tenants = await ctx.registry.list(status ? { status } : {});
  const target = ctx.config.migrator ? await ctx.config.migrator.targetVersion() : undefined;
  ctx.io.out(
    opts.json ? JSON.stringify({ target: target ?? null, tenants }, null, 2) : formatTenants(tenants, target),
  );
  return 0;
}
