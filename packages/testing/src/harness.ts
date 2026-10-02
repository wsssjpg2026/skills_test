/**
 * Kernel boot harness (architecture doc §5.1).
 *
 * `bootKernel()` — in-process `createKernel` behind a REAL listening socket on
 * an ephemeral port (fastify reached only via real HTTP/WS, so the seam stays
 * honest). `spawnKernel()` — a real child process for kill/power-loss tests.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createKernel, type Kernel, type KernelConfig } from '@orch/kernel';
import type { TagUpdateNotification } from '@orch/contracts/spi';
import { OrchRestClient } from './clients.js';
import { type SeedResult, seedTopology, type SeedSpec } from './seed.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface BootKernelOptions {
  config?: KernelConfig;
  /** Overrides `config.plugins.dir`. Default: `<repo>/plugins`. */
  pluginsDir?: string;
  /**
   * Maps to env `ORCH_ADMIN_PASSWORD` (adjudication A-ADMIN-CREDS) — never
   * parse the log for the printed random password.
   */
  bootstrapAdminPassword?: string;
}

export interface KernelHandle {
  kernel: Kernel;
  port: number;
  baseUrl: string;
  rest: OrchRestClient;
  /** Seed channels/devices/tags through the storage port, then reconcile. */
  seed(spec: SeedSpec): Promise<SeedResult>;
  /** tag_update seam hook: resolve on the next matching update. */
  waitForTagUpdate(
    predicate?: (update: TagUpdateNotification & { pluginId: string }) => boolean,
    timeoutMs?: number,
  ): Promise<TagUpdateNotification & { pluginId: string }>;
  stop(): Promise<void>;
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no ephemeral port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolvePromise(port));
    });
    srv.once('error', reject);
  });
}

/** Boot the kernel in-process on an ephemeral port (§5.1). */
export async function bootKernel(opts: BootKernelOptions = {}): Promise<KernelHandle> {
  if (opts.bootstrapAdminPassword !== undefined) {
    process.env.ORCH_ADMIN_PASSWORD = opts.bootstrapAdminPassword;
  }
  const port = await ephemeralPort();
  const defaultDataDir = await mkdtemp(join(tmpdir(), 'orch-boot-'));
  const config: KernelConfig = {
    ...opts.config,
    server: { host: '127.0.0.1', port, ...opts.config?.server },
    storage: { dataDir: defaultDataDir, ...opts.config?.storage },
    plugins: {
      ...opts.config?.plugins,
      dir: opts.pluginsDir ?? opts.config?.plugins?.dir ?? join(repoRoot, 'plugins'),
    },
  };
  const kernel = await createKernel(config);
  await kernel.start();

  const addr = kernel.fastify.server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;
  return {
    kernel,
    port: boundPort,
    baseUrl,
    rest: new OrchRestClient(baseUrl),
    seed: (spec) => seedTopology(kernel, spec),
    waitForTagUpdate: (predicate, timeoutMs = 10_000) => waitForTagUpdate(kernel, predicate, timeoutMs),
    stop: async () => {
      await kernel.stop();
    },
  };
}

/** Wait for the next matching `tag_update` on the kernel event seam. */
export function waitForTagUpdate(
  kernel: Kernel,
  predicate?: (update: TagUpdateNotification & { pluginId: string }) => boolean,
  timeoutMs = 10_000,
): Promise<TagUpdateNotification & { pluginId: string }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      kernel.events.removeListener('tag_update', onUpdate);
      reject(new Error(`no matching tag_update within ${timeoutMs} ms`));
    }, timeoutMs);
    const onUpdate = (update: TagUpdateNotification & { pluginId: string }): void => {
      if (predicate && !predicate(update)) return;
      clearTimeout(timer);
      kernel.events.removeListener('tag_update', onUpdate);
      resolvePromise(update);
    };
    kernel.events.on('tag_update', onUpdate);
  });
}

// --- spawnKernel --------------------------------------------------------------

export interface SpawnKernelOptions {
  /** Written to `<configDir>/orch.config.json`. */
  config?: KernelConfig;
  /** Directory for the config file + data dir. Default: fresh temp dir. */
  configDir?: string;
  env?: Record<string, string | undefined>;
  bootstrapAdminPassword?: string;
  /** Working directory for the child. Default: repo root. */
  cwd?: string;
  readyTimeoutMs?: number;
}

export interface SpawnedKernel {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  rest: OrchRestClient;
  kill(signal?: NodeJS.Signals): void;
  /** SIGTERM + wait for exit. */
  stop(): Promise<void>;
}

/**
 * Spawn `orch-kernel` as a real child process (§5.1) — the entry point for
 * kill/restart/power-loss fault tests.
 */
export async function spawnKernel(opts: SpawnKernelOptions = {}): Promise<SpawnedKernel> {
  const configDir = opts.configDir ?? (await mkdtemp(join(tmpdir(), 'orch-spawn-')));
  const port = opts.config?.server?.port ?? (await ephemeralPort());
  const config: KernelConfig = {
    ...opts.config,
    server: { host: '127.0.0.1', port, ...opts.config?.server },
    storage: { mode: 'embedded', dataDir: join(configDir, 'data'), ...opts.config?.storage },
    plugins: { dir: join(repoRoot, 'plugins'), ...opts.config?.plugins },
  };
  const configPath = join(configDir, 'orch.config.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const binPath = join(repoRoot, 'packages/kernel/dist/bin.js');
  const child = spawn(process.execPath, [binPath], {
    cwd: opts.cwd ?? repoRoot,
    env: {
      ...process.env,
      ORCH_CONFIG: configPath,
      ...(opts.bootstrapAdminPassword !== undefined ? { ORCH_ADMIN_PASSWORD: opts.bootstrapAdminPassword } : {}),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port_ = await waitForReady(child, opts.readyTimeoutMs ?? 20_000);
  const baseUrl = `http://127.0.0.1:${port_}`;
  return {
    process: child,
    port: port_,
    baseUrl,
    rest: new OrchRestClient(baseUrl),
    kill: (signal = 'SIGKILL') => child.kill(signal),
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }),
  };
}

/** The kernel logs a pino JSON line `kernel started` carrying the bound port. */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`kernel child not ready within ${timeoutMs} ms; stdout so far: ${buffer.slice(-500)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        try {
          const rec = JSON.parse(line) as { msg?: string; port?: number };
          if (rec.msg === 'kernel started' && typeof rec.port === 'number') {
            clearTimeout(timer);
            child.stdout!.removeListener('data', onData);
            resolvePromise(rec.port);
            return;
          }
        } catch {
          /* partial line */
        }
      }
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`kernel child exited before ready (code=${code} signal=${signal}); stdout: ${buffer.slice(-500)}`));
    });
  });
}
