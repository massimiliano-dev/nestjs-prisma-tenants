import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the shared test server, pointing at the `postgres` database. */
    pgAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** One PostgreSQL server for the whole integration run. Each test file creates its own databases. */
export default async function setup(project: TestProject) {
  if (process.env.TEST_PG_ADMIN_URL) {
    project.provide('pgAdminUrl', process.env.TEST_PG_ADMIN_URL);
    return;
  }
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('postgres')
    .withCommand(['postgres', '-c', 'max_connections=200', '-c', 'fsync=off'])
    .start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
