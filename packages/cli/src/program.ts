import { Command, Option } from 'commander';
import type { TenantsCliConfig } from './config.js';
import { openContext, type CliContext, type CliIo } from './context.js';
import { archiveCommand } from './commands/archive.js';
import { createCommand } from './commands/create.js';
import { listCommand } from './commands/list.js';
import { migrateCommand } from './commands/migrate.js';
import { statusCommand } from './commands/status.js';
import { loadConfig } from './load-config.js';

export interface RunCliOptions {
  io?: CliIo;
  /** Inject a config instead of loading tenants.config.* (used by tests and wrappers). */
  config?: TenantsCliConfig;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Runs the CLI and resolves with the exit code. */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io: CliIo = options.io ?? {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
  };
  let exitCode = 0;

  const program = new Command('tenants')
    .description('Manage database-per-tenant PostgreSQL deployments')
    .option('-c, --config <path>', 'config file (default: tenants.config.{ts,mts,mjs,js})')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  const withContext =
    <A extends unknown[]>(fn: (ctx: CliContext, ...args: A) => Promise<number>) =>
    async (...args: A) => {
      const config = options.config ?? (await loadConfig(program.opts<{ config?: string }>().config));
      const ctx = await openContext(config, io);
      try {
        exitCode = await fn(ctx, ...args);
      } finally {
        await ctx.db.close();
      }
    };

  program
    .command('list')
    .description('List tenants with status and schema version')
    .option('--status <statuses>', 'comma-separated filter, e.g. active,suspended')
    .option('--json', 'machine-readable output')
    .action(withContext((ctx, opts: { status?: string; json?: boolean }) => listCommand(ctx, opts)));

  program
    .command('create <slug>')
    .description('Create the database, migrate, seed and register a tenant')
    .option('--connection-limit <n>', 'pool size for this tenant')
    .option('--secret-ref <ref>', 'secret reference, default env:TENANT_<SLUG>_DATABASE_URL')
    .option('--db-name <name>', 'database name, default tenant_<slug>')
    .option('--template <db>', 'clone this database instead of an empty one')
    .option('--metadata <json>', 'JSON object stored with the tenant')
    .option('--no-seed', 'skip the seed function from the config')
    .option('--json', 'machine-readable output')
    .action(withContext((ctx, slug: string, opts) => createCommand(ctx, slug, opts)));

  program
    .command('archive <slug>')
    .description('Mark a tenant archived and close its connections. The database is never dropped')
    .option('--dump <dir>', 'run pg_dump into this directory first')
    .action(withContext((ctx, slug: string, opts: { dump?: string }) => archiveCommand(ctx, slug, opts)));

  program
    .command('migrate')
    .description('Apply pending migrations to tenant databases')
    .option('--all', 'every active tenant')
    .option('-t, --tenant <slug>', 'a tenant to migrate (repeatable)', collect)
    .option('--concurrency <n>', 'tenants migrated in parallel', '5')
    .option('--dry-run', 'show what would be applied, change nothing')
    .addOption(new Option('--canary [slug]', 'migrate one tenant first and stop if it fails'))
    .option('--include-suspended', 'with --all, also migrate suspended tenants')
    .option('--json', 'machine-readable report')
    .action(withContext((ctx, opts) => migrateCommand(ctx, opts)));

  program
    .command('status')
    .description('Check the control database and report tenants behind the target schema')
    .option('--json', 'machine-readable output')
    .action(withContext((ctx, opts: { json?: boolean }) => statusCommand(ctx, opts)));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    const e = error as { code?: string; exitCode?: number; message?: string };
    if (e.code?.startsWith('commander.')) {
      return e.code === 'commander.helpDisplayed' || e.code === 'commander.version' ? 0 : (e.exitCode ?? 1);
    }
    io.err(`Error: ${e.message ?? String(error)}`);
    return 1;
  }
  return exitCode;
}
