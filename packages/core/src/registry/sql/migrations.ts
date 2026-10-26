export interface ControlMigration {
  version: number;
  name: string;
  sql: string;
}

/** Control database migrations, applied in order by `ControlDb.migrate()`. Never edit a released entry. */
export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TYPE tenant_status AS ENUM ('provisioning', 'active', 'suspended', 'archived', 'failed');

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  status           tenant_status NOT NULL DEFAULT 'provisioning',
  db_name          text NOT NULL UNIQUE,
  secret_ref       text NOT NULL,
  schema_version   text,
  connection_limit integer NOT NULL DEFAULT 3 CHECK (connection_limit BETWEEN 1 AND 100),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

CREATE INDEX tenants_status_idx ON tenants (status);
`,
  },
];
