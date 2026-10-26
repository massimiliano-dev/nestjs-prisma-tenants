import { describe, expect, it } from 'vitest';
import {
  EnvSecretProvider,
  runMigrations,
  SecretResolver,
  TenantMigrationError,
  type MigrationRegistry,
  type Migrator,
  type TenantRecord,
} from '../src/index.js';
import { envFor, tenant } from './helpers.js';

function world(tenants: TenantRecord[], opts: { failing?: Set<string>; delayMs?: number } = {}) {
  const records = new Map(tenants.map((t) => [t.slug, { ...t }]));
  const applied = new Map(tenants.map((t) => [t.slug, t.schemaVersion]));
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const slugOf = (url: string) => new URL(url).pathname.replace('/tenant_', '');

  const registry: MigrationRegistry = {
    async list(filter) {
      return [...records.values()].filter((t) => !filter?.status || filter.status.includes(t.status));
    },
    async setSchemaVersion(slug, version) {
      records.get(slug)!.schemaVersion = version;
    },
  };
  const migrator: Migrator = {
    async targetVersion() {
      return '0002_add_notes';
    },
    async appliedVersion(url) {
      return applied.get(slugOf(url)) ?? null;
    },
    async pendingMigrations(url) {
      return applied.get(slugOf(url)) === '0002_add_notes' ? [] : ['0002_add_notes'];
    },
    async deploy(url) {
      const slug = slugOf(url);
      order.push(slug);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      active -= 1;
      if (opts.failing?.has(slug)) throw new TenantMigrationError(slug, 'syntax error', 'ERROR: boom');
      applied.set(slug, '0002_add_notes');
      return { applied: ['0002_add_notes'], version: '0002_add_notes' };
    },
  };
  const secrets = new SecretResolver([new EnvSecretProvider(envFor(tenants.map((t) => t.slug)))]);
  return { registry, migrator, secrets, records, order, peak: () => peak };
}

const v1 = { schemaVersion: '0001_init' };

describe('runMigrations', () => {
  it('migrates active tenants with bounded concurrency and records versions', async () => {
    const tenants = Array.from({ length: 12 }, (_, i) => tenant(`t${i}`, v1));
    const w = world(tenants, { delayMs: 10 });
    const report = await runMigrations({ ...w, concurrency: 3 });
    expect(report.results.every((r) => r.status === 'migrated')).toBe(true);
    expect(w.peak()).toBeLessThanOrEqual(3);
    expect(report.behind).toEqual([]);
    expect(w.records.get('t0')?.schemaVersion).toBe('0002_add_notes');
  });

  it('skips archived and suspended tenants on --all, and reports them if behind', async () => {
    const w = world([
      tenant('a', v1),
      tenant('s', { ...v1, status: 'suspended' }),
      tenant('z', { ...v1, status: 'archived' }),
    ]);
    const report = await runMigrations({ ...w });
    expect(report.results.map((r) => r.slug)).toEqual(['a']);
    expect(report.behind).toEqual([{ slug: 's', status: 'suspended', version: '0001_init' }]);
  });

  it('dry run changes nothing and lists pending migrations', async () => {
    const w = world([tenant('a', v1), tenant('b', { schemaVersion: '0002_add_notes' })]);
    const report = await runMigrations({ ...w, dryRun: true });
    expect(report.results.map((r) => [r.slug, r.status])).toEqual([
      ['a', 'would-migrate'],
      ['b', 'up-to-date'],
    ]);
    expect(w.order).toEqual([]);
    expect(w.records.get('a')?.schemaVersion).toBe('0001_init');
  });

  it('aborts after a failing canary and skips everyone else', async () => {
    const w = world([tenant('a', v1), tenant('b', v1), tenant('c', v1)], { failing: new Set(['b']) });
    const report = await runMigrations({ ...w, canary: 'b' });
    expect(report.aborted).toBe(true);
    expect(w.order).toEqual(['b']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.output).toBe('ERROR: boom');
    expect(report.results.filter((r) => r.status === 'skipped')).toHaveLength(2);
    expect(report.behind.map((b) => b.slug)).toEqual(['a', 'b', 'c']);
  });

  it('continues past individual failures without a canary and reports them', async () => {
    const w = world([tenant('a', v1), tenant('b', v1), tenant('c', v1)], { failing: new Set(['b']) });
    const report = await runMigrations({ ...w, canary: true });
    expect(report.canary).toBe('a');
    expect(report.failed.map((f) => f.slug)).toEqual(['b']);
    expect(report.behind.map((b) => b.slug)).toEqual(['b']);
  });

  it('handles explicit tenant lists with unknown and archived slugs', async () => {
    const w = world([tenant('a', v1), tenant('z', { ...v1, status: 'archived' })]);
    const report = await runMigrations({ ...w, tenants: ['a', 'nope', 'z'] });
    expect(report.results.map((r) => [r.slug, r.status])).toEqual([
      ['a', 'migrated'],
      ['nope', 'failed'],
      ['z', 'skipped'],
    ]);
  });
});
