/**
 * Kernel composition root (architecture doc §1): `createKernel(config)` boots
 * storage → (pluginHost #3) → (tagcore/engine/… #4+) → api/web, in that order.
 *
 * Walking skeleton (ticket #2): pino logging, embedded storage (default),
 * `GET /health/live` + `GET /health/ready` (§2.1 shape), and serving of the
 * built web status page. Everything else is a stub that later tickets fill in.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import fastifyStatic from '@fastify/static';
import pino, { type Logger } from 'pino';
import { openEmbeddedStorage, type StorageHandle } from '@orch/storage';
import type { KernelConfig } from './config.js';

/** The fastify instance shape produced by `createKernel` (pino logger wired in). */
export type KernelFastifyInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

/** §2.1 health payload. `plugins` fills with real plugin-host states at #3. */
export interface PluginState {
  id: string;
  state: string;
}

export interface HealthResponse {
  status: 'ok' | 'unavailable';
  version: string;
  uptimeSec: number;
  storage: { mode: 'embedded' | 'postgres'; ok: boolean };
  plugins: PluginState[];
}

export interface Kernel {
  readonly fastify: KernelFastifyInstance;
  readonly port: number;
  readonly log: Logger;
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function readKernelVersion(): Promise<string> {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve the built web assets directory: explicit config wins, then
 * `<cwd>/packages/web/dist` (repo root / container workdir), then the path
 * relative to this module (monorepo layout). Returns null when not built yet.
 */
function resolveWebDir(config: KernelConfig): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    config.web?.dir,
    join(process.cwd(), 'packages/web/dist'),
    resolve(here, '../../web/dist'),
  ].filter((p): p is string => typeof p === 'string');
  for (const dir of candidates) {
    if (isAbsolute(dir) ? existsSync(dir) : existsSync(resolve(process.cwd(), dir))) {
      return resolve(process.cwd(), dir);
    }
  }
  return null;
}

export async function createKernel(config: KernelConfig = {}): Promise<Kernel> {
  const log = pino({ level: process.env.ORCH_LOG_LEVEL ?? 'info' });
  const version = await readKernelVersion();
  const bootedAt = Date.now();

  // --- storage (boot step 1; arch §1 boot order) ---------------------------
  const storageConfig = config.storage ?? {};
  const mode = storageConfig.mode ?? 'embedded';
  let storage: StorageHandle;
  if (mode === 'postgres') {
    // §1: storage-timescale is reached through dynamic import ONLY.
    const timescale = await import('@orch/storage-timescale');
    storage = await timescale.openTimescaleStorage(storageConfig);
  } else {
    storage = await openEmbeddedStorage({ dataDir: storageConfig.dataDir });
  }
  log.info({ mode }, 'storage opened');

  // TODO(#3): plugin-host — scan `config.plugins.dir` manifests, spawn, supervise;
  // health `plugins` comes from it. Until then the array is empty.
  const plugins: PluginState[] = [];

  // --- http api + web (boot step: api/web last) ----------------------------
  const app = Fastify({ loggerInstance: log });

  /** Last storage ping result — /health/live reports it without re-pinging. */
  let lastStorageOk = true;

  const health = (status: HealthResponse['status'], storageOk: boolean): HealthResponse => ({
    status,
    version,
    uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
    storage: { mode, ok: storageOk },
    plugins,
  });

  app.get('/health/live', async (): Promise<HealthResponse> => health('ok', lastStorageOk));

  app.get('/health/ready', async (_request, reply): Promise<HealthResponse> => {
    lastStorageOk = await storage.ping();
    const status: HealthResponse['status'] = lastStorageOk ? 'ok' : 'unavailable';
    if (!lastStorageOk) {
      reply.code(503);
    }
    return health(status, lastStorageOk);
  });

  const webDir = resolveWebDir(config);
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir });
    log.info({ dir: webDir }, 'serving web assets');
  } else {
    log.warn('web assets not found — run `npm run build --workspace @orch/web` for the status page; API-only mode until then');
  }

  const host = config.server?.host ?? '0.0.0.0';
  const port = config.server?.port ?? 8080;

  return {
    fastify: app,
    port,
    log,
    async start(): Promise<void> {
      await app.listen({ host, port });
    },
    async stop(): Promise<void> {
      await app.close();
      await storage.stop();
    },
  };
}
