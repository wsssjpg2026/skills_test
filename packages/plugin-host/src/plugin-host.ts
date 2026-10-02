/**
 * PluginHost — manifest discovery + the registry of supervised plugins
 * (architecture doc §2.3, §6.1). Owns the desired channel state per plugin so
 * that a plugin crash/restart can replay `initialize` + `channel.start`
 * (full resync) without the kernel re-issuing anything.
 *
 * Notifications from plugins are re-emitted as typed events:
 *   'tag_update' | 'device_status' | 'command_event' | 'log'   (§2.3.2)
 * plus 'plugin_state' (lifecycle transitions) and 'plugin_stderr'.
 */
import { EventEmitter } from 'node:events';
import type {
  Channel,
  Device,
  Tag,
} from '@orch/contracts';
import {
  type CommandEventNotification,
  type DeviceStatusNotification,
  type HostInfo,
  type JsonRpcNotification,
  type PluginLogNotification,
  type TagUpdateNotification,
} from '@orch/contracts/spi';
import { discoverManifests, type PluginManifest } from './manifest.js';
import {
  consolePluginLogger,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type PluginLifecycleState,
  PluginUnavailableError,
  SupervisedPlugin,
  type PluginLogger,
  type RestartPolicy,
} from './supervised-plugin.js';

export interface PluginHostOptions {
  /** Directory scanned for `plugins/<id>/plugin.json` (§6.1). */
  pluginsDir: string;
  restart?: Partial<RestartPolicy>;
  heartbeatIntervalMs?: number;
  hostInfo?: HostInfo;
  logger?: PluginLogger;
}

/** Full desired state of one channel (the `channel.start` payload). */
export interface DesiredChannel {
  channel: Channel;
  devices: Device[];
  tags: Tag[];
}

export interface PluginStateSnapshot {
  id: string;
  state: PluginLifecycleState;
  pid?: number;
}

interface PluginHostEvents {
  tag_update: (update: TagUpdateNotification & { pluginId: string }) => void;
  device_status: (status: DeviceStatusNotification & { pluginId: string }) => void;
  command_event: (event: CommandEventNotification & { pluginId: string }) => void;
  log: (entry: PluginLogNotification & { pluginId: string }) => void;
  plugin_state: (snapshot: PluginStateSnapshot) => void;
  plugin_stderr: (info: { pluginId: string; line: string }) => void;
}

export class PluginHost extends EventEmitter {
  private readonly plugins = new Map<string, SupervisedPlugin>();
  private readonly manifestsById = new Map<string, PluginManifest>();
  private readonly desired = new Map<string, DesiredChannel>();
  private readonly logger: PluginLogger;
  private stopped = false;

  private constructor(
    readonly pluginsDir: string,
    private readonly opts: PluginHostOptions,
    logger: PluginLogger,
  ) {
    super();
    this.logger = logger;
  }

  /** Discover manifests, spawn every plugin, run the `initialize` handshake. */
  static async start(opts: PluginHostOptions): Promise<PluginHost> {
    const logger = opts.logger ?? consolePluginLogger;
    const host = new PluginHost(opts.pluginsDir, opts, logger);
    const manifests = await discoverManifests(opts.pluginsDir);
    for (const manifest of manifests) {
      host.mount(manifest);
    }
    await Promise.all([...host.plugins.values()].map((p) => p.start()));
    return host;
  }

  private mount(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.id)) {
      throw new Error(`duplicate plugin id "${manifest.id}" (manifest: ${manifest.manifestPath})`);
    }
    const plugin = new SupervisedPlugin({
      id: manifest.id,
      command: manifest.command,
      args: manifest.args,
      hostInfo: this.opts.hostInfo,
      restart: this.opts.restart,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      logger: this.logger,
      onReady: () => this.resync(manifest.id),
    });
    plugin.on('notification', (n: JsonRpcNotification) => this.routeNotification(manifest.id, n));
    plugin.on('state', () =>
      this.emitPluginState(manifest.id),
    );
    plugin.on('stderr', (line: string) => {
      this.emit('plugin_stderr', { pluginId: manifest.id, line });
    });
    this.plugins.set(manifest.id, plugin);
    this.manifestsById.set(manifest.id, manifest);
  }

  private routeNotification(pluginId: string, n: JsonRpcNotification): void {
    switch (n.method) {
      case 'tag_update':
        this.emit('tag_update', { pluginId, ...(n.params as object) } as TagUpdateNotification & { pluginId: string });
        return;
      case 'device_status':
        this.emit('device_status', { pluginId, ...(n.params as object) } as DeviceStatusNotification & { pluginId: string });
        return;
      case 'command_event':
        this.emit('command_event', { pluginId, ...(n.params as object) } as CommandEventNotification & { pluginId: string });
        return;
      case 'log':
        this.emit('log', { pluginId, ...(n.params as object) } as PluginLogNotification & { pluginId: string });
        return;
      default:
        this.logger.debug({ plugin: pluginId, method: n.method }, 'unknown notification from plugin (ignored)');
    }
  }

  private emitPluginState(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    this.emit('plugin_state', { id: pluginId, state: plugin.state, pid: plugin.pid });
    // A plugin that comes back (or dies) changes the reconciliation outcome of
    // its channels — the kernel listens to this and re-reconciles (#4 wires
    // the full channel state machine on top).
  }

  private async resync(pluginId: string): Promise<void> {
    if (this.stopped) return;
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.state !== 'running') return;
    for (const [channelId, desired] of this.desired) {
      if (desired.channel.driver !== pluginId) continue;
      try {
        await plugin.request('channel.start', desiredPayload(desired));
      } catch (err) {
        this.logger.error(
          { plugin: pluginId, channel: channelId, err: err instanceof Error ? err.message : String(err) },
          'channel.start replay failed during full resync',
        );
      }
    }
  }

  // --- registry ---------------------------------------------------------

  pluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  manifests(): PluginManifest[] {
    return [...this.manifestsById.values()];
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /** Health-facing snapshot: `plugins:[{id,state}]` (§2.1). */
  pluginStates(): PluginStateSnapshot[] {
    return [...this.plugins.entries()].map(([id, p]) => ({ id, state: p.state, pid: p.pid }));
  }

  getPluginState(pluginId: string): PluginLifecycleState | undefined {
    return this.plugins.get(pluginId)?.state;
  }

  /** Raw host → plugin request (kernel data-plane calls; testkit). */
  async call<T = unknown>(
    pluginId: string,
    method: string,
    params?: unknown,
    opts: { deadlineMs?: number } = {},
  ): Promise<T> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new PluginUnavailableError(pluginId, 'not-discovered');
    return plugin.request<T>(method, params, opts);
  }

  // --- desired channel state ---------------------------------------------

  /**
   * Record the channel as desired and (when the plugin runs) send
   * `channel.start`. After any plugin restart the supervisor replays it —
   * that replay IS the full resync (§2.3).
   */
  async startChannel(channel: Channel, devices: Device[], tags: Tag[]): Promise<void> {
    this.desired.set(channel.id, { channel, devices, tags });
    await this.pushChannel('channel.start', channel.id);
  }

  /** Config change: full replace; the driver diffs internally (§2.3). */
  async updateChannel(channel: Channel, devices: Device[], tags: Tag[]): Promise<void> {
    this.desired.set(channel.id, { channel, devices, tags });
    await this.pushChannel('channel.update', channel.id);
  }

  /**
   * Remove the channel from the desired state. The frozen SPI has no
   * `channel.stop`; #4 decides between `channel.update` with an empty state
   * and plugin shutdown — until then this only stops the replay.
   */
  async stopChannel(channelId: string): Promise<void> {
    this.desired.delete(channelId);
  }

  desiredChannels(): DesiredChannel[] {
    return [...this.desired.values()];
  }

  private async pushChannel(method: 'channel.start' | 'channel.update', channelId: string): Promise<void> {
    const desired = this.desired.get(channelId);
    if (!desired) return;
    const plugin = this.plugins.get(desired.channel.driver);
    if (!plugin) {
      throw new PluginUnavailableError(desired.channel.driver, 'not-discovered');
    }
    if (plugin.state !== 'running') return; // resync on ready covers it
    await plugin.request(method, desiredPayload(desired));
  }

  // --- shutdown ------------------------------------------------------------

  /** Graceful stop of every plugin (`shutdown` → SIGTERM → SIGKILL). */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.plugins.values()].map((p) => p.stop('host shutdown')));
  }

  override on<K extends keyof PluginHostEvents>(event: K, listener: PluginHostEvents[K]): this {
    return super.on(event, listener);
  }
}

function desiredPayload(d: DesiredChannel): { channel: object; devices: Device[]; tags: Tag[] } {
  return { channel: d.channel, devices: d.devices, tags: d.tags };
}
