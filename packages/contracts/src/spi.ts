/**
 * Driver SPI — JSON-RPC 2.0 over ndjson on stdio (architecture doc §2.3,
 * FROZEN-at-#7 surface; additive-only changes afterwards).
 *
 * Transport contract:
 *  - one JSON-RPC 2.0 message per `\n` on stdin/stdout of the plugin process;
 *  - stderr belongs to the plugin's logs (the host prefixes and forwards);
 *  - max message size 16 MiB per direction;
 *  - JSON-RPC `id` = per-direction increasing integer;
 *  - plugin → host direction uses NOTIFICATIONS ONLY (no upward requests in v1);
 *  - `protocolVersion` = 1 (constant below).
 *
 * Lifecycle: host spawns → `initialize` → `channel.start` (full desired state)
 * → steady state → `channel.update` on any config change (full replace) →
 * `shutdown`. Plugin crash/restart replays the same sequence (full resync).
 *
 * Types + JSON constants only — @orch/contracts contains zero logic.
 */
import type { Device } from './api.js';
import type { QualityReason, Sample, Tag, TagValue } from './common.js';

/** Driver SPI protocol version (§2.3). */
export const SPI_PROTOCOL_VERSION = 1;

/** Max size of one ndjson JSON-RPC message, per direction (§2.3). */
export const SPI_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string | null;

/** JSON-RPC 2.0 reserved error codes (§2.3.3). */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Host → plugin request. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** Plugin → host response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** Plugin → host notification (no id — the plugin direction never requests). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Capability registry (§2.3.1) — ALL bits reserved now; `command` /
// `command_status` are implemented at #13 but the registry never changes.
// ---------------------------------------------------------------------------

export type SpiCapability =
  | 'subscribe'
  | 'write'
  | 'read_on_demand'
  | 'command'
  | 'command_status'
  | 'validate';

/** The complete capability registry, frozen as part of the #7 freeze. */
export const ALL_SPI_CAPABILITIES: readonly SpiCapability[] = [
  'subscribe',
  'write',
  'read_on_demand',
  'command',
  'command_status',
  'validate',
];

// ---------------------------------------------------------------------------
// Host → plugin requests (§2.3.1)
// ---------------------------------------------------------------------------

export type SpiMethod =
  | 'initialize'
  | 'channel.start'
  | 'channel.update'
  | 'read'
  | 'write'
  | 'subscribe'
  | 'unsubscribe'
  | 'command'
  | 'command.status'
  | 'validate'
  | 'shutdown';

export interface HostInfo {
  name: string;
  version: string;
}

export interface InitializeParams {
  protocolVersion: number;
  hostInfo: HostInfo;
}

export interface PluginInfo {
  id: string;
  version: string;
}

export interface InitializeResult {
  pluginInfo: PluginInfo;
  capabilities: SpiCapability[];
  /** Optional JSON-Schema-ish description of the channel `config`. */
  configSchema?: object;
}

export interface ChannelStartParams {
  channel: {
    id: string;
    name: string;
    driver: string;
    enabled: boolean;
    config: object;
  };
  devices: Device[];
  tags: Tag[];
}

export type ChannelUpdateParams = ChannelStartParams;

export interface ReadParams {
  deviceId: string;
  tagIds: string[];
}

export interface ReadResult {
  samples: Sample[];
}

export interface WriteItem {
  tagId: string;
  value: TagValue;
  /** Write, then read the value back and verify. */
  verify?: boolean;
}

export interface WriteParams {
  deviceId: string;
  writes: WriteItem[];
}

export interface WriteResultItem {
  tagId: string;
  ok: boolean;
  quality?: Sample['quality'];
  reason?: QualityReason;
  error?: { code?: string; message?: string };
}

export interface WriteResult {
  results: WriteResultItem[];
}

export interface SubscribeParams {
  deviceId: string;
  tagIds: string[];
}

/** Same shape as `subscribe`. */
export type UnsubscribeParams = SubscribeParams;

export interface CommandParams {
  deviceId: string;
  commandId: string;
  command: string;
  params: object;
  timeoutMs: number;
}

export interface CommandResult {
  accepted: true;
}

export interface CommandStatusParams {
  deviceId: string;
  commandId: string;
}

export interface CommandStatusResult {
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: object;
  error?: JsonRpcErrorObject;
}

export type ValidateKind = 'channel' | 'device' | 'tag';

export interface ValidateParams {
  kind: ValidateKind;
  config: Record<string, unknown>;
  /** Existing siblings (name-uniqueness checks and the like). */
  siblings?: Record<string, unknown>[];
}

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ValidateResult {
  errors: ValidationError[];
}

export interface ShutdownParams {
  reason: string;
}

// ---------------------------------------------------------------------------
// Plugin → host notifications (§2.3.2)
// ---------------------------------------------------------------------------

export type DeviceState =
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'failed'
  | 'disabled';

export interface TagUpdateNotification {
  deviceId: string;
  /** Coalesced; the host must see >= 1 flush per scan period. */
  samples: Sample[];
}

export interface DeviceStatusNotification {
  deviceId: string;
  state: DeviceState;
  reason?: QualityReason;
  detail?: string;
}

export interface CommandError {
  kind: string;
  code: string;
  message: string;
}

export interface CommandEventNotification {
  deviceId: string;
  commandId: string;
  event: 'completed' | 'failed' | 'progress';
  result?: object;
  error?: CommandError;
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginLogNotification {
  level: PluginLogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Application error codes (§2.3.3) — stable, defined here.
// ---------------------------------------------------------------------------

export const SPI_ERROR = {
  DRIVER_INTERNAL: -32000,
  NOT_INITIALIZED: -32001,
  DEVICE_NOT_FOUND: -32002,
  TAG_NOT_FOUND: -32003,
  ADDRESS_INVALID: -32004,
  NOT_CONNECTED: -32005,
  TIMEOUT: -32006,
  BUSY: -32007,
  WRITE_REJECTED: -32008,
  COMMAND_REJECTED: -32009,
  SHUTTING_DOWN: -32010,
} as const;

export type SpiErrorCode = (typeof SPI_ERROR)[keyof typeof SPI_ERROR];

/** Error code → symbolic name (stable wire value ↔ name mapping). */
export const SPI_ERROR_NAME: Readonly<Record<number, string>> = {
  [SPI_ERROR.DRIVER_INTERNAL]: 'DRIVER_INTERNAL',
  [SPI_ERROR.NOT_INITIALIZED]: 'NOT_INITIALIZED',
  [SPI_ERROR.DEVICE_NOT_FOUND]: 'DEVICE_NOT_FOUND',
  [SPI_ERROR.TAG_NOT_FOUND]: 'TAG_NOT_FOUND',
  [SPI_ERROR.ADDRESS_INVALID]: 'ADDRESS_INVALID',
  [SPI_ERROR.NOT_CONNECTED]: 'NOT_CONNECTED',
  [SPI_ERROR.TIMEOUT]: 'TIMEOUT',
  [SPI_ERROR.BUSY]: 'BUSY',
  [SPI_ERROR.WRITE_REJECTED]: 'WRITE_REJECTED',
  [SPI_ERROR.COMMAND_REJECTED]: 'COMMAND_REJECTED',
  [SPI_ERROR.SHUTTING_DOWN]: 'SHUTTING_DOWN',
};

/** Default request deadlines per method (§2.3.1), in milliseconds. */
export const SPI_DEFAULT_DEADLINE_MS: Readonly<Record<SpiMethod, number>> = {
  initialize: 10_000,
  'channel.start': 30_000,
  'channel.update': 30_000,
  read: 5_000,
  write: 10_000,
  subscribe: 5_000,
  unsubscribe: 5_000,
  command: 2_000,
  'command.status': 5_000,
  validate: 5_000,
  shutdown: 5_000,
};
