// doc-derived test stub — rewired to @orch/* at merge.
// §5.1 observability seam #1 (Boot), coded strictly against the doc's config shape (§6.1)
// and kernel CLI contract (bin `orch-kernel`, ORCH_CONFIG env). At merge this file should
// collapse to a re-export of @orch/testing's bootKernel/spawnKernel (same signatures).

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KernelConfig, HealthStatus } from './types.js';
import { defaultPluginsDir, freePort, repoRoot, tempDir, waitUntil } from './util.js';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** §6.1 default config, tuned for deterministic tests: ephemeral port, fast snapshots. */
export async function defaultTestConfig(
  overrides: DeepPartial<KernelConfig> = {},
): Promise<KernelConfig> {
  const port = overrides.server?.port ?? (await freePort());
  const dataDir = overrides.storage?.dataDir ?? (await tempDir('orch-data-'));
  const config: KernelConfig = {
    server: { host: '127.0.0.1', port, ...overrides.server } as KernelConfig['server'],
    storage: { mode: 'embedded', dataDir, ...overrides.storage } as KernelConfig['storage'],
    plugins: {
      dir: defaultPluginsDir(),
      restart: { initialMs: 500, maxMs: 5_000, maxRestarts: 5, windowMs: 600_000 },
      ...overrides.plugins,
    } as KernelConfig['plugins'],
    engine: {
      wal: { fsync: 'always' },
      snapshot: { intervalMs: 1_000, minEvents: 100 },
      ...overrides.engine,
    } as KernelConfig['engine'],
    auth: { bootstrapAdmin: true, ...overrides.auth } as KernelConfig['auth'],
  };
  if (overrides.northbound) config.northbound = overrides.northbound as KernelConfig['northbound'];
  return config;
}

export interface BootHandle {
  mode: 'in-process' | 'child';
  config: KernelConfig;
  port: number;
  baseUrl: string;
  /** Everything the child process wrote to stdout (in-process: empty string). */
  stdout: () => string;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------- in-process

/**
 * §5.1 bootKernel: in-process boot via `createKernel(config)` from @orch/kernel,
 * real listening socket (fastify reached only through real HTTP/WS).
 * Doc contract (§1 kernel/src/boot.ts): createKernel(config) -> { start, stop, fastify, port, ... }.
 */
export async function bootKernel(opts: { config?: DeepPartial<KernelConfig> } = {}): Promise<BootHandle> {
  const config = await defaultTestConfig(opts.config);
  const mod = (await dynamicImportKernel()) as {
    createKernel(cfg: KernelConfig): Promise<{
      start(): Promise<void>;
      stop(): Promise<void>;
      port: number;
    }>;
  };
  const kernel = await mod.createKernel(config);
  await kernel.start();
  const port = kernel.port; // §5.1: real socket on ephemeral port; handle exposes actual port
  return {
    mode: 'in-process',
    config,
    port,
    baseUrl: `http://${config.server.host}:${port}`,
    stdout: () => '',
    stop: () => kernel.stop(),
  };
}

async function dynamicImportKernel(): Promise<unknown> {
  // Non-literal specifier: the package does not exist until the implementation branch
  // merges — a literal import would fail compile/typecheck today (stub by design).
  const spec = '@orch/kernel';
  try {
    return await import(/* @vite-ignore */ spec);
  } catch (err) {
    throw new Error(
      'STUB: @orch/kernel is not merged yet — bootKernel() is a doc-derived stub that ' +
      'imports it at merge time (see tests/support/ASSUMPTIONS.md). ' +
      `Underlying import error: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------- child process

export interface SpawnHandle extends BootHandle {
  mode: 'child';
  proc: ChildProcess;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
  /** Respawn with the same configDir (power-loss recovery path). */
  restart: () => Promise<SpawnHandle>;
  configDir: string;
}

/**
 * §5.1 spawnKernel: real child process for power-loss/kill tests.
 * Contract per §6.1: bin `orch-kernel` reads orch.config.json (path via ORCH_CONFIG env).
 * Port determinism: we allocate a free port ourselves and pin it in the config
 * (least assumption — requires only "kernel listens on the configured port").
 */
export async function spawnKernel(opts: {
  configDir?: string;
  config?: DeepPartial<KernelConfig>;
  env?: Record<string, string>;
} = {}): Promise<SpawnHandle> {
  const configDir = opts.configDir ?? (await tempDir('orch-cfg-'));
  const dataDir = opts.config?.storage?.dataDir ?? path.join(configDir, 'data');
  const base = await defaultTestConfig({ ...opts.config, storage: { ...opts.config?.storage, dataDir } });
  const configPath = path.join(configDir, 'orch.config.json');
  await writeFile(configPath, JSON.stringify(base, null, 2), 'utf8');

  const startOnce = async (): Promise<{ proc: ChildProcess; stdout: string[] }> => {
    const bin = path.join(repoRoot(), 'node_modules', '.bin', 'orch-kernel');
    const stdout: string[] = [];
    const proc = spawn(bin, [], {
      env: { ...process.env, ORCH_CONFIG: configPath, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => stdout.push(String(d)));
    proc.stderr?.on('data', (d) => stdout.push(String(d)));
    return { proc, stdout };
  };

  const { proc, stdout } = await startOnce();
  const handle: SpawnHandle = {
    mode: 'child',
    config: base,
    configDir,
    port: base.server.port,
    baseUrl: `http://${base.server.host}:${base.server.port}`,
    proc,
    stdout: () => stdout.join(''),
    kill: async (signal = 'SIGKILL') => {
      if (proc.exitCode == null && !proc.killed) proc.kill(signal);
      await new Promise<void>((resolve) => {
        if (proc.exitCode != null) return resolve();
        proc.once('exit', () => resolve());
      });
    },
    stop: async () => {
      if (proc.exitCode == null && !proc.killed) proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (proc.exitCode != null) return resolve();
        proc.once('exit', () => resolve());
        setTimeout(() => {
          if (proc.exitCode == null) proc.kill('SIGKILL');
          resolve();
        }, 5_000).unref();
      });
    },
    restart: async () => {
      if (proc.exitCode == null && !proc.killed) proc.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (proc.exitCode != null) return resolve();
        proc.once('exit', () => resolve());
      });
      // Same configDir (data survives) AND same port — the outside world's REST/WS
      // clients keep working across the simulated power loss.
      return spawnKernel({
        configDir,
        config: { ...opts.config, server: { ...opts.config?.server, port: base.server.port } },
        env: opts.env,
      });
    },
  };
  await waitForHealth(handle.baseUrl, 30_000);
  return handle;
}

export async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<HealthStatus> {
  return waitUntil(
    async () => {
      try {
        const res = await fetch(`${baseUrl}/api/v1/health/live`);
        if (!res.ok) return undefined;
        return (await res.json()) as HealthStatus;
      } catch {
        return undefined;
      }
    },
    { timeoutMs, intervalMs: 100, label: `kernel health at ${baseUrl}` },
  );
}

// ---------------------------------------------------------------- admin bootstrap

export interface AdminCredentials {
  username: string;
  password: string;
}

/**
 * §2.1: "First boot seeds admin (random password printed to log once)".
 * Deterministic credential resolution, least-assumption order:
 *   1. explicit object form in config auth.bootstrapAdmin {username,password} (ASSUMPTION: supported)
 *   2. ORCH_TEST_ADMIN_PASSWORD env
 *   3. parse the seeded password out of kernel stdout (regex below — see ASSUMPTIONS.md)
 */
export function resolveAdminCredentials(
  config: KernelConfig,
  stdout: string,
): AdminCredentials {
  const ba = config.auth.bootstrapAdmin;
  if (typeof ba === 'object' && ba != null) return { username: ba.username, password: ba.password };
  if (process.env.ORCH_TEST_ADMIN_PASSWORD) {
    return { username: 'admin', password: process.env.ORCH_TEST_ADMIN_PASSWORD };
  }
  const m = stdout.match(/admin[^\n]{0,80}?password[^\w:]*["':\s]+([^\s"',}]+)/i);
  if (m) return { username: 'admin', password: m[1] };
  throw new Error(
    'cannot resolve bootstrap admin credentials: no explicit auth.bootstrapAdmin object, ' +
    'no ORCH_TEST_ADMIN_PASSWORD env, and no parsable seed line in kernel stdout ' +
    '(see tests/support/ASSUMPTIONS.md — needs coordinator adjudication)',
  );
}
