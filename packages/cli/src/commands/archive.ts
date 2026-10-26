import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { CliContext } from '../context.js';

/** Runs pg_dump with credentials in the environment, never on the command line. */
export async function pgDump(url: string, file: string): Promise<void> {
  const u = new URL(url);
  await execa('pg_dump', ['--format=custom', `--file=${file}`], {
    env: {
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
      ...(u.searchParams.get('sslmode') ? { PGSSLMODE: u.searchParams.get('sslmode')! } : {}),
    },
  });
}

export async function archiveCommand(
  ctx: CliContext,
  slug: string,
  opts: { dump?: string },
): Promise<number> {
  let dumpedTo: string | undefined;
  const tenant = await ctx.provisioner.archive(slug, {
    ...(opts.dump
      ? {
          dump: async ({ url }) => {
            await mkdir(opts.dump!, { recursive: true });
            dumpedTo = path.resolve(
              opts.dump!,
              `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`,
            );
            await pgDump(url, dumpedTo);
          },
        }
      : {}),
  });
  ctx.io.out(
    `Archived tenant ${tenant.slug}. Database ${tenant.dbName} was kept` +
      (dumpedTo ? `; dump written to ${dumpedTo}.` : '.'),
  );
  return 0;
}
