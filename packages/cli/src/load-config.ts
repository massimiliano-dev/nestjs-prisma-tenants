import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TenantsCliConfig } from './config.js';

export const CONFIG_FILES = [
  'tenants.config.ts',
  'tenants.config.mts',
  'tenants.config.mjs',
  'tenants.config.js',
];

/**
 * Loads `tenants.config.*` from the working directory, or the file passed with `--config`.
 * TypeScript configs rely on Node's built-in type stripping (Node 22.18+).
 */
export async function loadConfig(explicitPath?: string, cwd = process.cwd()): Promise<TenantsCliConfig> {
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : CONFIG_FILES.map((f) => path.join(cwd, f));
  for (const file of candidates) {
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; config?: unknown };
    const config = (mod.default ?? mod.config) as TenantsCliConfig | undefined;
    if (!config?.controlDatabaseUrl) {
      throw new Error(
        `${path.basename(file)} must export a config with controlDatabaseUrl (use defineTenantsConfig)`,
      );
    }
    return config;
  }
  throw new Error(
    explicitPath
      ? `Config file not found: ${explicitPath}`
      : `No config found. Create one of: ${CONFIG_FILES.join(', ')}`,
  );
}
