import type {
  MigrationReport,
  TenantMigrationResult,
  TenantRecord,
  TenantStatus,
} from '@massimiliano-dev/nestjs-prisma-tenants-core';

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function formatTenants(tenants: TenantRecord[], target: string | null | undefined): string {
  if (!tenants.length) return 'No tenants.';
  const rows = tenants.map((t) => [
    t.slug,
    t.status,
    t.schemaVersion ?? '-',
    target === undefined ? '?' : t.status === 'archived' ? '-' : t.schemaVersion === target ? 'no' : 'yes',
    String(t.connectionLimit),
    t.dbName,
  ]);
  return formatTable(['SLUG', 'STATUS', 'SCHEMA', 'BEHIND', 'CONN', 'DATABASE'], rows);
}

const LABEL: Record<TenantMigrationResult['status'], string> = {
  migrated: 'migrated',
  'up-to-date': 'up to date',
  'would-migrate': 'would migrate',
  failed: 'FAILED',
  skipped: 'skipped',
};

export function formatResultLine(r: TenantMigrationResult): string {
  const versions =
    r.status === 'migrated' || r.status === 'would-migrate'
      ? `  ${r.from ?? '(empty)'} -> ${r.to ?? '(empty)'}`
      : '';
  const pending = r.status === 'would-migrate' && r.applied.length ? `  [${r.applied.join(', ')}]` : '';
  const error = r.error && r.status !== 'failed' ? `  (${r.error})` : '';
  return `${LABEL[r.status].padEnd(13)} ${r.slug}${versions}${pending}${error}  ${r.durationMs} ms`;
}

export function formatMigrationReport(report: MigrationReport): string {
  const count = (s: TenantMigrationResult['status']) => report.results.filter((r) => r.status === s).length;
  const out: string[] = [];
  out.push(
    `${report.dryRun ? 'Dry run. ' : ''}Target: ${report.target ?? '(no migrations)'}` +
      (report.canary ? `. Canary: ${report.canary}` : ''),
  );
  out.push(
    report.dryRun
      ? `Would migrate: ${count('would-migrate')}, up to date: ${count('up-to-date')}, failed: ${count('failed')}, skipped: ${count('skipped')}`
      : `Migrated: ${count('migrated')}, up to date: ${count('up-to-date')}, failed: ${count('failed')}, skipped: ${count('skipped')}`,
  );
  if (report.aborted) out.push('Canary failed: the other tenants were not migrated.');
  if (report.failed.length) {
    out.push('', 'Failed:');
    for (const f of report.failed) {
      out.push(`  ${f.slug}: ${f.error ?? 'unknown error'}`);
      if (f.output)
        out.push(
          ...f.output
            .trim()
            .split('\n')
            .slice(-8)
            .map((l) => `    | ${l}`),
        );
    }
  }
  if (!report.dryRun && report.behind.length) {
    out.push('', `Behind ${report.target ?? 'target'}:`);
    for (const b of report.behind) out.push(`  ${b.slug} (${b.status}): ${b.version ?? '(never migrated)'}`);
  }
  return out.join('\n');
}

export function formatCounts(counts: Record<TenantStatus, number>): string {
  return Object.entries(counts)
    .map(([status, n]) => `${status}: ${n}`)
    .join(', ');
}
