import { runMigrations } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import type { CliContext } from '../context.js';
import { formatMigrationReport, formatResultLine } from '../report.js';

export interface MigrateOptions {
  all?: boolean;
  tenant?: string[];
  concurrency?: string;
  dryRun?: boolean;
  canary?: string | boolean;
  includeSuspended?: boolean;
  json?: boolean;
}

export async function migrateCommand(ctx: CliContext, opts: MigrateOptions): Promise<number> {
  if (!ctx.config.migrator)
    throw new Error('No migrator in tenants.config: add `migrator: new PrismaMigrator({...})`');
  if (!opts.all && !opts.tenant?.length) throw new Error('Pass --all or at least one --tenant <slug>');
  if (opts.all && opts.tenant?.length) throw new Error('Use either --all or --tenant, not both');
  const concurrency = Number(opts.concurrency ?? 5);

  const report = await runMigrations({
    registry: ctx.registry,
    migrator: ctx.config.migrator,
    secrets: ctx.secrets,
    concurrency,
    dryRun: opts.dryRun ?? false,
    includeSuspended: opts.includeSuspended ?? false,
    ...(opts.tenant?.length ? { tenants: opts.tenant } : {}),
    ...(opts.canary !== undefined ? { canary: opts.canary } : {}),
    ...(opts.json ? {} : { onResult: (r) => ctx.io.out(formatResultLine(r)) }),
  });

  ctx.io.out(opts.json ? JSON.stringify(report, null, 2) : `\n${formatMigrationReport(report)}`);
  return report.failed.length || report.aborted ? 1 : 0;
}
