# Contributing

Thanks for helping. Issues and pull requests are welcome.

1. `pnpm install`, then `pnpm test` (unit) and `pnpm test:int` (integration, needs Docker).
2. Keep changes focused and covered by tests. Security-relevant behaviour needs an integration test against a
   real PostgreSQL, like the ones in `packages/core/test/registry.int.test.ts`.
3. Add a changeset for any change to a published package: `pnpm changeset`.
4. Never commit credentials, real connection strings, dumps or tenant data. Report vulnerabilities privately,
   see [SECURITY.md](SECURITY.md).

Code style is enforced by ESLint and Prettier (`pnpm lint`, `pnpm format`). Public APIs need TSDoc comments.
