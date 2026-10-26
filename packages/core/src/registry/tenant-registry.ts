import { LRUCache } from 'lru-cache';
import { TenantInactiveError, TenantNotFoundError } from '../errors.js';
import { assertValidSlug, defaultDbName, defaultSecretRef } from '../slug.js';
import type { TenantRecord, TenantStatus } from '../types.js';
import type { ControlDb } from './control-db.js';

interface TenantRow {
  id: string;
  slug: string;
  status: TenantStatus;
  db_name: string;
  secret_ref: string;
  schema_version: string | null;
  connection_limit: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

const COLUMNS =
  'id, slug, status, db_name, secret_ref, schema_version, connection_limit, metadata, created_at, updated_at, archived_at';

function toRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    dbName: row.db_name,
    secretRef: row.secret_ref,
    schemaVersion: row.schema_version,
    connectionLimit: row.connection_limit,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface CreateTenantInput {
  slug: string;
  dbName?: string;
  secretRef?: string;
  status?: TenantStatus;
  connectionLimit?: number;
  metadata?: Record<string, unknown>;
}

export interface TenantRegistryOptions {
  /** How long a lookup stays cached in memory. Lookups happen on every request. Default 30 s. */
  cacheTtlMs?: number;
  cacheMax?: number;
}

/** Read side used on the request path. Implemented by `TenantRegistry`; easy to fake in tests. */
export interface TenantLookup {
  getActive(slug: string): Promise<TenantRecord>;
}

/** CRUD over the control database `tenants` table, with a short in-memory cache for request lookups. */
export class TenantRegistry implements TenantLookup {
  private readonly cache: LRUCache<string, { record: TenantRecord | null }>;

  constructor(
    private readonly db: ControlDb,
    options: TenantRegistryOptions = {},
  ) {
    this.cache = new LRUCache({ max: options.cacheMax ?? 1000, ttl: options.cacheTtlMs ?? 30_000 });
  }

  async list(filter: { status?: TenantStatus[] } = {}): Promise<TenantRecord[]> {
    const { rows } = filter.status?.length
      ? await this.db.query<TenantRow>(
          `SELECT ${COLUMNS} FROM tenants WHERE status = ANY($1::tenant_status[]) ORDER BY slug`,
          [filter.status],
        )
      : await this.db.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants ORDER BY slug`);
    return rows.map(toRecord);
  }

  /** Uncached lookup. */
  async findBySlug(slug: string): Promise<TenantRecord | null> {
    const { rows } = await this.db.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE slug = $1`, [slug]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<TenantRecord> {
    const record = await this.findBySlug(slug);
    if (!record) throw new TenantNotFoundError(slug);
    return record;
  }

  /**
   * Cached lookup used on every request. Unknown slugs are cached too, so random subdomains
   * cannot hammer the control database.
   */
  async getActive(slug: string): Promise<TenantRecord> {
    let entry = this.cache.get(slug);
    if (!entry) {
      entry = { record: await this.findBySlug(slug) };
      this.cache.set(slug, entry);
    }
    if (!entry.record) throw new TenantNotFoundError(slug);
    if (entry.record.status !== 'active') throw new TenantInactiveError(slug, entry.record.status);
    return entry.record;
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const slug = assertValidSlug(input.slug);
    const { rows } = await this.db.query<TenantRow>(
      `INSERT INTO tenants (slug, status, db_name, secret_ref, connection_limit, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [
        slug,
        input.status ?? 'provisioning',
        input.dbName ?? defaultDbName(slug),
        input.secretRef ?? defaultSecretRef(slug),
        input.connectionLimit ?? 3,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    this.invalidate(slug);
    return toRecord(rows[0]!);
  }

  async setStatus(slug: string, status: TenantStatus): Promise<TenantRecord> {
    const { rows } = await this.db.query<TenantRow>(
      `UPDATE tenants SET status = $2, updated_at = now(),
         archived_at = CASE WHEN $2::tenant_status = 'archived' THEN now() ELSE NULL END
       WHERE slug = $1 RETURNING ${COLUMNS}`,
      [slug, status],
    );
    this.invalidate(slug);
    if (!rows[0]) throw new TenantNotFoundError(slug);
    return toRecord(rows[0]);
  }

  async setSchemaVersion(slug: string, version: string | null): Promise<void> {
    const result = await this.db.query(
      'UPDATE tenants SET schema_version = $2, updated_at = now() WHERE slug = $1',
      [slug, version],
    );
    this.invalidate(slug);
    if (result.rowCount === 0) throw new TenantNotFoundError(slug);
  }

  async countByStatus(): Promise<Record<TenantStatus, number>> {
    const { rows } = await this.db.query<{ status: TenantStatus; count: string }>(
      'SELECT status, count(*) AS count FROM tenants GROUP BY status',
    );
    const counts: Record<TenantStatus, number> = {
      provisioning: 0,
      active: 0,
      suspended: 0,
      archived: 0,
      failed: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** Drops cached lookups for one tenant, or for all of them. */
  invalidate(slug?: string): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }
}
