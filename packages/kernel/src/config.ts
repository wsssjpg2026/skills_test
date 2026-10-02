/**
 * Kernel configuration (architecture doc §6.1): loaded from `orch.config.json`,
 * path overridable via `ORCH_CONFIG` (default `./orch.config.json`).
 * Every section is optional; the kernel boots with embedded storage defaults,
 * so local development needs zero external processes.
 */
import { readFile } from 'node:fs/promises';

export interface TlsConfig {
  cert?: string;
  key?: string;
}

export interface ServerConfig {
  host?: string;
  port?: number;
  /** Optional in v1. */
  tls?: TlsConfig;
}

export interface PostgresConfig {
  dsn?: string;
  poolMax?: number;
}

export interface StorageConfig {
  mode?: 'embedded' | 'postgres';
  dataDir?: string;
  postgres?: PostgresConfig;
}

export interface PluginRestartConfig {
  initialMs?: number;
  maxMs?: number;
  maxRestarts?: number;
  windowMs?: number;
}

export interface PluginsConfig {
  dir?: string;
  restart?: PluginRestartConfig;
}

export interface EngineConfig {
  wal?: { fsync?: 'always' | 'none' };
  snapshot?: { intervalMs?: number; minEvents?: number };
}

export interface NorthboundConfig {
  mes?: { url?: string; requestTimeoutMs?: number; maxRetries?: number };
  mqttBridge?: { url?: string; qos?: 0 | 1 | 2 };
}

export interface KernelConfig {
  server?: ServerConfig;
  storage?: StorageConfig;
  plugins?: PluginsConfig;
  engine?: EngineConfig;
  northbound?: NorthboundConfig;
  auth?: { bootstrapAdmin?: boolean };
  /**
   * Directory of the built web assets. Optional; when absent the kernel
   * auto-detects `packages/web/dist` (repo checkout and container layouts).
   */
  web?: { dir?: string };
}

export const DEFAULT_CONFIG_PATH = 'orch.config.json';

export class ConfigError extends Error {}

export function resolveConfigPath(): string {
  return process.env.ORCH_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export async function loadConfig(path: string): Promise<KernelConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // Missing file is not an error here — the caller decides whether defaults apply.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw err;
    }
    throw new ConfigError(`cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`config ${path} must be a JSON object`);
  }

  const cfg = parsed as KernelConfig;
  const mode = cfg.storage?.mode;
  if (mode !== undefined && mode !== 'embedded' && mode !== 'postgres') {
    throw new ConfigError(`storage.mode must be "embedded" or "postgres" (got ${JSON.stringify(mode)})`);
  }
  return cfg;
}
