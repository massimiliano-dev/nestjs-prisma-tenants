import type { CliContext } from '../context.js';
import { formatCounts } from '../report.js';

export async function statusCommand(ctx: CliContext, opts: { json?: boolean }): Promise<number> {
  await ctx.db.ping();
  const counts = await ctx.registry.countByStatus();
  const target = ctx.config.migrator ? await ctx.config.migrator.targetVersion() : null;
  const tenants = await ctx.registry.list({ status: ['active', 'suspended'] });
  const behind = target ? tenants.filter((t) => t.schemaVersion !== target).map((t) => t.slug) : [];
  if (opts.json) {
    ctx.io.out(JSON.stringify({ controlDb: 'ok', target, counts, behind }, null, 2));
  } else {
    ctx.io.out(
      [
        'Control database: reachable',
        `Target schema: ${target ?? '(no migrator configured)'}`,
        `Tenants: ${formatCounts(counts)}`,
        `Behind target: ${behind.length ? behind.join(', ') : 'none'}`,
      ].join('\n'),
    );
  }
  return 0;
}
