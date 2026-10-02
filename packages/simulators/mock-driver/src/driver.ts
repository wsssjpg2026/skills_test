/**
 * MockDriver — the reference driver plugin (architecture doc §5.2, §2.3).
 * Scriptable value/quality emitter driven purely by its channel config.
 *
 * Capabilities: `write`, `read_on_demand`, `validate` — deliberately NOT
 * `subscribe` (the host must simulate-by-polling against it) and NOT
 * `command`. The SPI contract suite stays green against this plugin (§2.3.6).
 */
import type { Channel, Device, QualityReason, Sample, Tag, TagValue } from '@orch/contracts';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  SPI_ERROR,
  SPI_PROTOCOL_VERSION,
  type ChannelStartParams,
  type DeviceStatusNotification,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcErrorObject,
  type PluginLogNotification,
  type ReadParams,
  type ReadResult,
  type TagUpdateNotification,
  type ValidateParams,
  type ValidateResult,
  type WriteParams,
  type WriteResult,
} from '@orch/contracts/spi';
import { type MockChannelConfig, type MockScriptStep, parseScriptConfig, validateChannelConfig } from './script.js';

export const MOCK_DRIVER_ID = 'mock-driver';
export const MOCK_DRIVER_VERSION = '0.1.0';

/** mock tag address grammar: `mock:<slot>` with slot a non-negative integer. */
const ADDRESS_RE = /^mock:[0-9]+$/;

/** JSON-Schema-ish description of the channel config (reported at initialize). */
export const MOCK_DRIVER_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'array',
      description: 'timed steps relative to channel.start (§5.2)',
      items: {
        type: 'object',
        required: ['afterMs'],
        properties: {
          afterMs: { type: 'number', minimum: 0 },
          set: { type: 'object', description: 'tag name-or-id → value' },
          quality: { type: 'string', enum: ['good', 'bad', 'uncertain'] },
          reason: { type: 'string' },
          devices: { type: 'array', items: { type: 'string' } },
          deviceStatus: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['connected', 'reconnecting', 'degraded', 'failed', 'disabled'] },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    flushMs: { type: 'number', minimum: 5, default: 25, description: 'tag_update coalescing window' },
  },
} as const;

export class SpiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'SpiError';
  }

  toJsonObject(): JsonRpcErrorObject {
    return { code: this.code, message: this.message, data: this.data };
  }
}

interface StoredSample {
  value: TagValue;
  quality: Sample['quality'];
  reason?: QualityReason;
  tsMs: number;
}

export type OutboundNotification =
  | { method: 'tag_update'; params: TagUpdateNotification }
  | { method: 'device_status'; params: DeviceStatusNotification }
  | { method: 'log'; params: PluginLogNotification };

/** Delegates raw script steps; exported for reuse by later simulators. */
export class MockDriver {
  private initialized = false;
  private shuttingDown = false;
  private channel: Channel | null = null;
  private readonly devices = new Map<string, Device>();
  private readonly tags = new Map<string, Tag>();
  private readonly values = new Map<string, StoredSample>();
  private scriptTimers: NodeJS.Timeout[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Sample>(); // tagId → staged sample (coalescing)
  private flushMs = 25;

  constructor(
    private readonly emit: (n: OutboundNotification) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Dispatch one host → plugin request. Throws SpiError / JSON-RPC errors. */
  handle(method: string, params: unknown): unknown {
    if (method === 'initialize') return this.initialize(params as InitializeParams);
    if (!this.initialized) {
      throw new SpiError(SPI_ERROR.NOT_INITIALIZED, 'initialize must complete first');
    }
    switch (method) {
      case 'channel.start':
        return this.channelStart(params as ChannelStartParams);
      case 'channel.update':
        return this.channelStart(params as ChannelStartParams);
      case 'read':
        return this.read(params as ReadParams);
      case 'write':
        return this.write(params as WriteParams);
      case 'subscribe':
      case 'unsubscribe':
        throw new SpiError(
          SPI_ERROR.DRIVER_INTERNAL,
          'mock-driver does not declare the subscribe capability; the host must poll read',
        );
      case 'command':
      case 'command.status':
        throw new SpiError(SPI_ERROR.DRIVER_INTERNAL, 'mock-driver does not declare the command capability');
      case 'validate':
        return this.validate(params as ValidateParams);
      case 'shutdown':
        this.shuttingDown = true;
        this.clearScript();
        this.emit({ method: 'log', params: { level: 'info', message: 'mock-driver shutting down' } });
        return {};
      default:
        throw new SpiError(JSON_RPC_METHOD_NOT_FOUND, `unknown method "${method}"`);
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // --- lifecycle -----------------------------------------------------------

  private initialize(params: InitializeParams): InitializeResult {
    if (params === null || typeof params !== 'object') {
      throw new SpiError(JSON_RPC_INVALID_PARAMS, 'initialize params must be an object');
    }
    if (params.protocolVersion !== SPI_PROTOCOL_VERSION) {
      throw new SpiError(
        JSON_RPC_INVALID_PARAMS,
        `protocolVersion ${params.protocolVersion} not supported (host speaks ${SPI_PROTOCOL_VERSION})`,
      );
    }
    // Idempotent: a heartbeat or resync re-initialize keeps channel state.
    this.initialized = true;
    return {
      pluginInfo: { id: MOCK_DRIVER_ID, version: MOCK_DRIVER_VERSION },
      capabilities: ['write', 'read_on_demand', 'validate'],
      configSchema: MOCK_DRIVER_CONFIG_SCHEMA as unknown as object,
    };
  }

  private channelStart(params: ChannelStartParams): Record<string, never> {
    const issues = validateChannelConfig((params?.channel?.config ?? {}) as Record<string, unknown>);
    if (issues.length > 0) {
      throw new SpiError(SPI_ERROR.ADDRESS_INVALID, 'channel config rejected', { issues });
    }
    // Full replace: the driver diffs internally (§2.3).
    this.clearScript();
    this.channel = params.channel as unknown as Channel;
    this.devices.clear();
    this.tags.clear();
    const keep = new Set<string>();
    for (const device of params.devices ?? []) {
      this.devices.set(device.id, device);
    }
    for (const tag of params.tags ?? []) {
      this.tags.set(tag.id, tag);
      keep.add(tag.id);
      if (!this.values.has(tag.id)) {
        this.values.set(tag.id, { value: null, quality: 'uncertain', reason: 'stale', tsMs: this.now() });
      }
    }
    for (const tagId of [...this.values.keys()]) {
      if (!keep.has(tagId)) this.values.delete(tagId);
    }

    const config = parseScriptConfig((params.channel?.config ?? {}) as Record<string, unknown> | undefined);
    this.flushMs = config.flushMs ?? 25;
    this.armScript(config);

    for (const device of this.devices.values()) {
      if (device.enabled) {
        this.emit({ method: 'device_status', params: { deviceId: device.id, state: 'connected' } });
      }
    }
    this.emit({
      method: 'log',
      params: {
        level: 'info',
        message: 'channel started',
        fields: { channel: this.channel.id, devices: this.devices.size, tags: this.tags.size },
      },
    });
    return {};
  }

  // --- data plane ----------------------------------------------------------

  private read(params: ReadParams): ReadResult {
    this.requireParams(params?.deviceId !== undefined, 'deviceId');
    const device = this.devices.get(params.deviceId);
    if (!device) throw new SpiError(SPI_ERROR.DEVICE_NOT_FOUND, `unknown device "${params.deviceId}"`);
    if (!Array.isArray(params.tagIds)) throw new SpiError(JSON_RPC_INVALID_PARAMS, 'tagIds must be an array');
    const samples: Sample[] = params.tagIds.map((tagId) => {
      const tag = this.tags.get(tagId);
      if (!tag || tag.deviceId !== device.id) {
        throw new SpiError(SPI_ERROR.TAG_NOT_FOUND, `unknown tag "${tagId}" on device "${params.deviceId}"`);
      }
      return this.sampleOf(tagId);
    });
    return { samples };
  }

  private write(params: WriteParams): WriteResult {
    this.requireParams(params?.deviceId !== undefined, 'deviceId');
    const device = this.devices.get(params.deviceId);
    if (!device) throw new SpiError(SPI_ERROR.DEVICE_NOT_FOUND, `unknown device "${params.deviceId}"`);
    if (!Array.isArray(params.writes)) throw new SpiError(JSON_RPC_INVALID_PARAMS, 'writes must be an array');

    for (const w of params.writes) {
      const tag = this.tags.get(w?.tagId ?? '');
      if (!tag || tag.deviceId !== device.id) {
        throw new SpiError(SPI_ERROR.TAG_NOT_FOUND, `unknown tag "${w?.tagId}" on device "${params.deviceId}"`);
      }
      if (tag.access === 'read') {
        throw new SpiError(SPI_ERROR.WRITE_REJECTED, `tag "${tag.name}" is read-only`);
      }
    }

    const results = params.writes.map((w) => {
      this.setValue(w.tagId, w.value);
      let ok = true;
      if (w.verify) {
        const readBack = this.values.get(w.tagId)?.value;
        ok = JSON.stringify(readBack) === JSON.stringify(w.value);
      }
      return { tagId: w.tagId, ok };
    });
    return { results };
  }

  private validate(params: ValidateParams): ValidateResult {
    if (params?.kind === undefined || !['channel', 'device', 'tag'].includes(params.kind)) {
      throw new SpiError(JSON_RPC_INVALID_PARAMS, 'kind must be channel|device|tag');
    }
    const config = (params.config ?? {}) as Record<string, unknown>;
    if (params.kind === 'channel') {
      return { errors: validateChannelConfig(config) };
    }
    if (params.kind === 'device') {
      if (typeof config.address !== 'string' || config.address.length === 0) {
        return { errors: [{ path: 'address', code: 'ADDRESS_INVALID', message: 'address must be a non-empty string' }] };
      }
      return { errors: [] };
    }
    // kind === 'tag'
    const errors: ValidateResult['errors'] = [];
    if (typeof config.address !== 'string' || !ADDRESS_RE.test(config.address)) {
      errors.push({
        path: 'address',
        code: 'ADDRESS_INVALID',
        message: `mock-driver address must match ${ADDRESS_RE.toString()} (e.g. "mock:0")`,
      });
    }
    return { errors };
  }

  // --- script execution ----------------------------------------------------

  private armScript(config: MockChannelConfig): void {
    for (const step of config.script ?? []) {
      const timer = setTimeout(() => this.runStep(step), step.afterMs);
      this.scriptTimers.push(timer);
    }
  }

  private clearScript(): void {
    for (const t of this.scriptTimers) clearTimeout(t);
    this.scriptTimers = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private runStep(step: MockScriptStep): void {
    if (step.set) {
      for (const [key, value] of Object.entries(step.set)) {
        const tag = this.findTag(key);
        if (tag) this.setValue(tag.id, value, 'good');
      }
    }
    if (step.quality) {
      for (const tag of this.tags.values()) {
        if (this.stepTargetsDevice(step, tag.deviceId)) {
          // Quality change retains the last value (§2.3.2 / §4.1).
          this.setValue(tag.id, this.values.get(tag.id)?.value ?? null, step.quality, step.reason);
        }
      }
    }
    if (step.deviceStatus) {
      for (const device of this.devices.values()) {
        if (this.stepTargetsDevice(step, device.id)) {
          this.emit({
            method: 'device_status',
            params: {
              deviceId: device.id,
              state: step.deviceStatus.state,
              ...(step.deviceStatus.reason !== undefined ? { reason: step.deviceStatus.reason } : {}),
              ...(step.deviceStatus.detail !== undefined ? { detail: step.deviceStatus.detail } : {}),
            },
          });
        }
      }
    }
  }

  private stepTargetsDevice(step: MockScriptStep, deviceId: string): boolean {
    if (!step.devices || step.devices.length === 0) return true;
    return step.devices.some((d) => d === deviceId || d === this.devices.get(deviceId)?.name);
  }

  private findTag(key: string): Tag | undefined {
    return this.tags.get(key) ?? [...this.tags.values()].find((t) => t.name === key);
  }

  // --- value store + coalesced tag_update ---------------------------------

  private setValue(tagId: string, value: TagValue, quality: Sample['quality'] = 'good', reason?: QualityReason): void {
    const prev = this.values.get(tagId);
    const tsMs = Math.max(this.now(), (prev?.tsMs ?? 0) + 1); // ts monotonic per tag
    const stored: StoredSample = {
      value,
      quality,
      reason: reason ?? (quality === 'good' ? 'ok' : prev?.reason),
      tsMs,
    };
    this.values.set(tagId, stored);
    this.stage(tagId, { tagId, value, quality, reason: stored.reason, ts: new Date(tsMs).toISOString() });
  }

  private sampleOf(tagId: string): Sample {
    const s = this.values.get(tagId) ?? { value: null, quality: 'uncertain' as const, reason: 'stale' as const, tsMs: this.now() };
    return {
      tagId,
      value: s.value,
      quality: s.quality,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      ts: new Date(s.tsMs).toISOString(),
    };
  }

  /** Coalesce: stage the latest sample per tag, flush on the window. */
  private stage(tagId: string, sample: Sample): void {
    this.pending.set(tagId, sample);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const byDevice = new Map<string, Sample[]>();
    for (const [tagId, sample] of this.pending) {
      const deviceId = this.tags.get(tagId)?.deviceId;
      if (!deviceId) continue;
      const list = byDevice.get(deviceId) ?? [];
      list.push(sample);
      byDevice.set(deviceId, list);
    }
    this.pending.clear();
    for (const [deviceId, samples] of byDevice) {
      this.emit({ method: 'tag_update', params: { deviceId, samples } });
    }
  }

  private requireParams(cond: boolean, field: string): void {
    if (!cond) throw new SpiError(JSON_RPC_INVALID_PARAMS, `missing required param "${field}"`);
  }
}
