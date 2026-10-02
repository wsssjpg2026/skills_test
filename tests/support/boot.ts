// [test-support] Doc-derived stub — REWIRED AT MERGE.
// Kernel boot seams per architecture.md §5.1 (bootKernel / spawnKernel) and §6.1
// (orch.config.json + plugin manifests). All assumptions are numbered A-* in
// /tmp/spec-impl-notes/test-map-drivers.md.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { OrchApi } from './api.ts';

/**
 * A3 (ADJUDICATED, adjudications.md): the deterministic test-auth seam is env
 * ORCH_ADMIN_PASSWORD, exposed by @orch/testing's bootKernel/spawnKernel as a
 * `bootstrapAdminPassword` option that maps to it. The password is derived from the
 * storage location: the admin is seeded on FIRST boot only, so a restart on the same
 * dataDir (kernel SIGKILL tests) must present the same password, while a fresh temp
 * dataDir gets a fresh unique one. No password guessing, no log parsing.
 */
function adminPasswordFor(dataDir: string): string {
  return createHash('sha256').update(`orch-test-admin:${dataDir}`).digest('base64url');
}

async function loginAdmin(port: number, password: string): Promise<string> {
  const api = new OrchApi(`http://127.0.0.1:${port}`);
  const login = await api.login('admin', password);
  if (!login?.token) throw new Error('A3: login with the seeded admin password returned no token');
  return login.token;
}

export interface PluginSpec {
  /** manifest id, e.g. 'stub-reference-plugin' — channels reference it as `driver` */
  id: string;
  language?: 'node' | 'python';
  command: string;
  args: string[];
}

/**
 * A1 (assumption): manifest layout per §6.1 — plugins/<id>/plugin.json =
 * {id, language, command, args}. Args may contain the absolute stub-plugin path.
 */
export async function writePluginsDir(specs: PluginSpec[], dir?: string): Promise<string> {
  const root = dir ?? (await mkdtemp(path.join(tmpdir(), 'orch-plugins-')));
  for (const s of specs) {
    const p = path.join(root, s.id);
    await mkdir(p, { recursive: true });
    await writeFile(
      path.join(p, 'plugin.json'),
      JSON.stringify({ id: s.id, language: s.language ?? 'node', command: s.command, args: s.args }, null, 2),
    );
  }
  return root;
}

export function stubPluginCommand(extraArgs: string[] = []): string[] {
  return [process.execPath, path.resolve(import.meta.dirname, 'spi-host/stub-plugin.mjs'), ...extraArgs];
}

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface OrchConfig {
  server?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  northbound?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  [k: string]: unknown;
}

export function baseConfig(dataDir: string, pluginsDir: string): OrchConfig {
  return {
    // A2 (assumption): server.port 0 → ephemeral port for parallel tests.
    server: { host: '127.0.0.1', port: 0 },
    storage: { mode: 'embedded', dataDir },
    plugins: {
      dir: pluginsDir,
      // tightened for test latency (same shape as §6.1 defaults)
      restart: { initialMs: 200, maxMs: 2_000, maxRestarts: 5, windowMs: 600_000 },
    },
    engine: { wal: { fsync: 'always' }, snapshot: { intervalMs: 2_000, minEvents: 100 } },
    // A3 (ADJUDICATED): boolean only — the test password comes from env
    // ORCH_ADMIN_PASSWORD via the harness's bootstrapAdminPassword option.
    auth: { bootstrapAdmin: true },
  };
}

/**
 * A3 (ADJUDICATED): resolve an admin token through the ruled seam — the boot harness
 * seeded the admin password from our `bootstrapAdminPassword` option (mapped to env
 * ORCH_ADMIN_PASSWORD), so we log in with exactly that password.
 */
export async function resolveToken(harness: any, password: string): Promise<string> {
  for (const k of ['token', 'adminToken', 'bootstrapToken']) {
    if (typeof harness?.[k] === 'string' && harness[k]) return harness[k];
  }
  return loginAdmin(harnessPort(harness), password);
}

export function harnessPort(harness: any): number {
  const candidates = [harness?.port, harness?.address?.port];
  const fromUrl = typeof harness?.url === 'string' ? Number(harness.url.match(/:(\d+)/)?.[1]) : undefined;
  candidates.push(fromUrl);
  const port = candidates.find((p) => typeof p === 'number' && p > 0);
  if (port !== undefined) return port as number;
  throw new Error(`A2: cannot discover kernel port from boot harness (${JSON.stringify(Object.keys(harness ?? {}))})`);
}

export interface BootedKernel {
  harness: any;
  api: OrchApi;
  token: string;
  baseUrl: string;
  dataDir: string;
  pluginsDir: string;
  stop: () => Promise<void>;
}

/** Boot the kernel in-process via @orch/testing (§5.1 seam 1). */
export async function bootOrch(opts: {
  plugins: PluginSpec[];
  config?: (base: OrchConfig) => OrchConfig;
  dataDir?: string;
  pluginsDir?: string;
}): Promise<BootedKernel> {
  const { bootKernel } = await loadTesting();
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'orch-data-')));
  const pluginsDir = await writePluginsDir(opts.plugins, opts.pluginsDir);
  let config = baseConfig(dataDir, pluginsDir);
  if (opts.config) config = opts.config(config);
  const adminPassword = adminPasswordFor(dataDir);
  const harness = await bootKernel({ config, pluginsDir, bootstrapAdminPassword: adminPassword });
  await harness.start?.();
  const port = harnessPort(harness);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await resolveToken(harness, adminPassword);
  const api = new OrchApi(baseUrl, token);
  return {
    harness,
    api,
    token,
    baseUrl,
    dataDir,
    pluginsDir,
    stop: async () => {
      await harness.stop?.();
    },
  };
}

/**
 * Spawn the kernel as a real child process (§5.1) for power-loss tests.
 * A4 (assumption): spawnKernel({configDir}) reads <configDir>/orch.config.json and
 * returns a handle with the listening port and kill()/stop().
 * A3 (ADJUDICATED): admin password seeded via the bootstrapAdminPassword option.
 */
export async function spawnOrch(opts: {
  plugins: PluginSpec[];
  config?: (base: OrchConfig) => OrchConfig;
  configDir: string;
}): Promise<BootedKernel & { process: any; killHard: () => void }> {
  const { spawnKernel } = await loadTesting();
  const dataDir = path.join(opts.configDir, 'data');
  const pluginsDir = await writePluginsDir(opts.plugins, path.join(opts.configDir, 'plugins'));
  let config = baseConfig(dataDir, pluginsDir);
  if (opts.config) config = opts.config(config);
  await mkdir(path.dirname(path.join(opts.configDir, 'orch.config.json')), { recursive: true });
  await writeFile(path.join(opts.configDir, 'orch.config.json'), JSON.stringify(config, null, 2));
  const adminPassword = adminPasswordFor(dataDir);
  const handle = await spawnKernel({ configDir: opts.configDir, bootstrapAdminPassword: adminPassword });
  const port = harnessPort(handle);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await resolveToken(handle, adminPassword);
  const api = new OrchApi(baseUrl, token);
  return {
    harness: handle,
    process: handle,
    api,
    token,
    baseUrl,
    dataDir,
    pluginsDir,
    killHard: () => handle.kill?.('SIGKILL'),
    stop: async () => {
      await handle.stop?.();
    },
  };
}

/** Lazy loader with a clear pre-merge failure message. */
export async function loadTesting(): Promise<any> {
  try {
    return await import('@orch/testing' as any);
  } catch {
    throw new Error(
      'TEST-BRANCH: @orch/testing is not resolvable on the test branch. These suites activate ' +
        'once the implementation branch merges (expected behavior, see test-map-drivers.md).',
    );
  }
}

/** Find and SIGKILL a plugin process by a unique --marker argument (supervision tests). */
export function killPluginByMarker(marker: string): number {
  const out = execFileSync('pgrep', ['-f', `stub-plugin.mjs.*--marker ${marker}`], { encoding: 'utf8' });
  const pids = out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) throw new Error(`no plugin process found for marker ${marker}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
