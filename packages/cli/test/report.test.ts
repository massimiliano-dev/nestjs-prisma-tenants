import { describe, expect, it } from 'vitest';
import type { MigrationReport } from '@massimiliano-dev/nestjs-prisma-tenants-core';
import { formatMigrationReport, formatTable, runCli } from '../src/index.js';

describe('report formatting', () => {
  it('aligns tables', () => {
    expect(formatTable(['A', 'LONG'], [['xxx', 'y']])).toBe('A    LONG\nxxx  y');
  });

  it('summarises failures with output tail and tenants behind', () => {
    const report: MigrationReport = {
      target: 'v2',
      dryRun: false,
      canary: 'a',
      aborted: false,
      results: [
        { slug: 'a', status: 'migrated', from: 'v1', to: 'v2', applied: ['v2'], durationMs: 10 },
        {
          slug: 'b',
          status: 'failed',
          from: 'v1',
          to: 'v1',
          applied: [],
          durationMs: 5,
          error: 'boom',
          output: 'line1\nERROR: column exists',
        },
      ],
      failed: [],
      behind: [{ slug: 'b', status: 'active', version: 'v1' }],
    };
    report.failed = report.results.filter((r) => r.status === 'failed');
    const text = formatMigrationReport(report);
    expect(text).toContain('Target: v2. Canary: a');
    expect(text).toContain('Migrated: 1, up to date: 0, failed: 1, skipped: 0');
    expect(text).toContain('    | ERROR: column exists');
    expect(text).toContain('  b (active): v1');
  });
});

describe('argument validation', () => {
  it('prints help and rejects unknown commands without touching a database', async () => {
    const out: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
    expect(await runCli(['--help'], { io })).toBe(0);
    expect(out.join('\n')).toContain('migrate');
    expect(await runCli(['explode'], { io })).toBe(1);
  });
});
