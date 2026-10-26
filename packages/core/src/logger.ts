import type { Logger } from './types.js';

const PREFIX = '[tenants]';

export const consoleLogger: Logger = {
  debug: (message, meta) => {
    if (process.env.TENANTS_DEBUG) console.debug(PREFIX, message, meta ?? '');
  },
  info: (message, meta) => console.info(PREFIX, message, meta ?? ''),
  warn: (message, meta) => console.warn(PREFIX, message, meta ?? ''),
  error: (message, meta) => console.error(PREFIX, message, meta ?? ''),
};

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
