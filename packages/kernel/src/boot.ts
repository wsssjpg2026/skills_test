/**
 * Kernel composition root (architecture doc §1): `createKernel(config)` boots
 * storage → pluginHost → (tagcore/engine/… #4+) → api/web, in that order.
 *
 * Ticket #3 adds the plugin plane: manifest scan of `plugins.dir`, supervised
 * spawn, plugin lifecycle states in /health, the channel↔plugin
 * reconciliation stub (channel referencing a missing plugin → channel
 * `failed`; full wiring lands with #4), and the tag_update seam event the
 * testing harness asserts on (tagcore consumes it from #4).
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import fastifyStatic from '@fastify/static';
import pino, { type Logger } from 'pino';
import type { Channel } from '@orch/contracts';
import type { TagUpdateNotification, DeviceStatusNotification } from '@orch/contracts/spi';
import { PluginHost, type PluginLogger } from '@orch/plugin-host';
import { openEmbeddedStorage, type StorageHandle } from '@orch/storage';
import type { KernelConfig } from './config.js';

export type { KernelConfig } from './config.js';

/** The fastify instance shape produced by `createKernel` (pino logger wired in). */
export type KernelFastifyInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

/** §2.1 health payload: plugin lifecycle from the plugin-host. */
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

/**
 * Reconciliation stub state for a channel (#4 replaces this with the real
 * channel state machine: connected/reconnecting/degraded/failed/disabled).
 */
export type ChannelRuntimeState = 'active' | 'failed' | 'disabled';

/** Kernel-internal event bus (§1): the ONLY cross-module coupling. */
export interface KernelEvents extends EventEmitter {
  emit(tag_update: 'tag_update', update: TagUpdateNotification & { pluginId: string }): boolean;
  emit(event: 'device_status', status: DeviceStatusNotification & { pluginId: string }): boolean;
}

export interface Kernel {
  readonly fastify: KernelFastifyInstance;
  readonly port: number;
  readonly log: Logger;
  readonly events: KernelEvents;
  /** Storage port handle (§3.1) — the testing seed writes through it. */
  readonly storage: StorageHandle;
  readonly pluginHost: PluginHost;
  /** channel id → reconciliation stub state. */
  channelStates(): Map<string, ChannelRuntimeState>;
  /**
   * Re-run the channel↔plugin reconciliation (boot, and after the testing
   * harness seeds channels through the storage port). #4 wires this into the
   * channels CRUD lifecycle.
   */
  reconcileChannels(): Promise<void>;
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

  // --- plugin host (boot step 2; arch §1) ----------------------------------
  const pluginLogger: PluginLogger = {
    debug: (obj, msg) => log.debug(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
  const pluginsDir = config.plugins?.dir ?? './plugins';
  const pluginHost = await PluginHost.start({
    pluginsDir,
    logger: pluginLogger,
    restart: config.plugins?.restart,
    hostInfo: { name: '@orch/kernel', version },
  });
  log.info({ pluginsDir, plugins: pluginHost.pluginStates() }, 'plugin host started');

  // stderr belongs to the plugin's logs: forward prefixed (§2.3).
  pluginHost.on('plugin_stderr', ({ pluginId, line }) => {
    log.info({ plugin: pluginId }, line);
  });

  // Internal event bus — the only cross-module coupling (§1). tagcore.apply()
  // consumes 'tag_update' from #4; until then it is the testing seam (§5).
  const events = new EventEmitter() as KernelEvents;
  pluginHost.on('tag_update', (update) => events.emit('tag_update', update));
  pluginHost.on('device_status', (status) => events.emit('device_status', status));

  // --- channel ↔ plugin reconciliation stub (§6.1) -------------------------
  const channelRuntimeStates = new Map<string, ChannelRuntimeState>();

  const reconcileChannels = async (): Promise<void> => {
    const channels = await storage.config.listChannels();
    for (const channel of channels) {
      try {
        await reconcileChannel(channel);
      } catch (err) {
        channelRuntimeStates.set(channel.id, 'failed');
        log.error({ channel: channel.id, err: err instanceof Error ? err.message : String(err) }, 'channel reconciliation failed');
      }
    }
  };

  const reconcileChannel = async (channel: Channel): Promise<void> => {
    if (!channel.enabled) {
      channelRuntimeStates.set(channel.id, 'disabled');
      await pluginHost.stopChannel(channel.id);
      return;
    }
    if (!pluginHost.has(channel.driver)) {
      // §6.1: channel referencing a missing plugin → channel failed (+ alarm at #4).
      channelRuntimeStates.set(channel.id, 'failed');
      log.warn({ channel: channel.id, driver: channel.driver }, 'channel references a missing plugin — channel failed');
      return;
    }
    const devices = (await storage.config.listDevices({ channelId: channel.id })).filter((d) => d.enabled);
    const tags = await storage.config.listTags({ channelId: channel.id });
    await pluginHost.startChannel(channel, devices, tags);
    channelRuntimeStates.set(channel.id, 'active');
    log.info({ channel: channel.id, driver: channel.driver, devices: devices.length, tags: tags.length }, 'channel started');
  };

  // Plugin lifecycle moves channels with it (supervision resyncs the plugin
  // side itself; this keeps the reconciliation view honest).
  pluginHost.on('plugin_state', ({ id, state }) => {
    if (state === 'running') return; // resync replay already handled by the host
    for (const desired of pluginHost.desiredChannels()) {
      if (desired.channel.driver === id) {
        channelRuntimeStates.set(desired.channel.id, state === 'failed' ? 'failed' : 'active');
      }
    }
  });

  await reconcileChannels();

  // --- http api + web (boot step: api/web last) ----------------------------
  const app = Fastify({ loggerInstance: log });

  /** Last storage ping result — /health/live reports it without re-pinging. */
  let lastStorageOk = true;

  const health = (status: HealthResponse['status'], storageOk: boolean): HealthResponse => ({
    status,
    version,
    uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
    storage: { mode, ok: storageOk },
    plugins: pluginHost.pluginStates().map((p) => ({ id: p.id, state: p.state })),
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
    events,
    storage,
    pluginHost,
    channelStates: () => channelRuntimeStates,
    reconcileChannels,
    async start(): Promise<void> {
      await app.listen({ host, port });
    },
    async stop(): Promise<void> {
      await app.close();
      await pluginHost.stop();
      await storage.stop();
    },
  };
}
