// doc-derived test stub — rewired to @orch/* at merge.
// Source of truth (NORMATIVE): /tmp/spec-impl-notes/architecture.md
//   §2.0 common types, §2.1 REST DTOs, §2.2 WS frames, §2.4 flow definition,
//   §2.5 task & event types, §3.6 alarm states, §6.1 kernel config + plugin manifest.
// Transcribed verbatim; DO NOT improvise fields here — anything not in the doc is
// recorded in the ASSUMPTIONS list of tests/support/ASSUMPTIONS.md instead.
// At merge: replace bodies with `export type { ... } from '@orch/contracts'`.

// ---------------------------------------------------------------- §2.0 common

export type Quality = 'good' | 'bad' | 'uncertain';
export type QualityReason =
  | 'ok' | 'timeout' | 'comm_error' | 'config_error' | 'device_offline'
  | 'address_invalid' | 'write_rejected' | 'overrange' | 'stale' | 'link_backoff'
  | 'recovering' | 'substituted' | 'unknown';

export type TagValue = number | boolean | string | number[] | string[] | null;

export interface Sample {
  tagId: string;
  value: TagValue;
  quality: Quality;
  reason?: QualityReason;
  ts: string; // ISO-8601 UTC on the wire
}

/** "{channelName}.{deviceName}.{tagName}" — names contain no dots. */
export type TagPath = string;

export interface Page<T> {
  items: T[];
  total: number;
  cursor?: string;
}

// ---------------------------------------------------------------- §2.0 Tag

export type TagDataType =
  | 'bool' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64'
  | 'float32' | 'float64' | 'string' | 'json'
  | 'int16[]' | 'uint16[]' | 'int32[]' | 'uint32[]' | 'float32[]' | 'float64[]' | 'string[]';

export type ByteOrder = 'AB' | 'BA' | 'ABCD' | 'DCBA' | 'BADC' | 'CDAB';

export interface Tag {
  id: string;
  deviceId: string;
  name: string; // required; unique per parent; ^[A-Za-z0-9_-]{1,64}$; contains no dots
  dataType: TagDataType;
  address: string; // driver-private grammar, e.g. Modbus "4x:INT32:0"
  byteOrder?: ByteOrder;
  scaling?: { slope?: number; offset?: number; enumMap?: Record<string, number> };
  scanPeriodMs?: number; // 10..3_600_000; scan group = (deviceId, scanPeriodMs)
  deadband?: { abs?: number; pct?: number };
  access: 'read' | 'write' | 'readwrite';
  historyEnabled: boolean;
  config?: object; // driver-private extras (validated by driver)
}

// ---------------------------------------------------------------- §2.1 DTOs

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: object;
    requestId: string; // "req_..."
  };
}

export interface HealthStatus {
  status: string; // ASSUMPTION: literal 'ok' when healthy
  version: string;
  uptimeSec: number;
  storage: { mode: 'embedded' | 'postgres'; ok: boolean };
  plugins: Array<{ id: string; state: string }>;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: User;
}

export const PERMISSIONS = [
  'config:write',
  'flows:write',
  'tasks:create',
  'tasks:command',
  'alarms:ack',
  'users:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface User {
  id: string;
  username: string;
  roles: string[]; // ASSUMPTION: role names or ids — see ASSUMPTIONS.md
  permissions?: Permission[]; // present on /auth/me (§2.1)
  disabled?: boolean;
}

export interface Role {
  id: string;
  name: string;
  permissions: Permission[];
}

export interface Channel {
  id: string;
  name: string;
  driver: string; // plugin id
  enabled: boolean;
  config: object; // validated against the driver's reported schema
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  channelId: string;
  name: string;
  address: string;
  enabled: boolean;
  config?: object;
}

export interface ChannelTestResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

/** POST /devices/{id}/diagnostics/byteorder — story 11 "write 100 read 25600" self-check. */
export interface ByteorderDiagnosticResult {
  ok: boolean;
  readBack: TagValue;
  diagnosis: string | object;
}

export interface FlowDefinition {
  specVersion: '1.0';
  id?: string; // logical flow id — server-assigned on first deploy (ASSUMPTION: client omits)
  name: string;
  version?: number; // server-assigned, monotonic per flow
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** ASSUMPTION (A-WEBHOOK): the doc says "token bound at flow level" (§2.1) but does not
   *  define the binding surface; tests accept token from FlowVersion.webhookToken OR
   *  spec.triggers.webhook.token — whichever the implementation provides. */
  triggers?: { webhook?: { token: string } };
}

export interface FlowEdge {
  from: string;
  port: string;
  to: string;
}

export interface FlowVersion {
  flowId: string;
  version: number;
  spec: FlowDefinition;
  createdAt: string;
  createdBy: string;
}

export interface FlowVersionMeta {
  flowId: string;
  version: number;
  createdAt: string;
  createdBy: string;
}

export type TaskStatus =
  | 'queued' | 'running' | 'suspended' | 'paused' | 'held'
  | 'completed' | 'failed' | 'aborted' | 'stopped' | 'compensating';

export const TERMINAL_TASK_STATUSES: TaskStatus[] =
  ['completed', 'failed', 'aborted', 'stopped'];

export type SuspendReason =
  | 'device_offline' | 'retry_exhausted' | 'human_intervention' | 'northbound_unavailable'
  | 'resource_timeout' | 'recovery_verify' | 'operator_command';

export interface Task {
  id: string;
  flowId: string;
  version: number;
  status: TaskStatus;
  currentNodeIds: string[];
  input?: object;
  vars?: Record<string, unknown>;
  suspendReason?: SuspendReason;
  startedAt?: string;
  updatedAt: string;
}

export type TaskCommandType =
  | 'pause' | 'hold' | 'resume' | 'stop' | 'abort' | 'continue' | 'retry-step';

export interface TaskCommand {
  type: TaskCommandType;
  option?: string; // ASSUMPTION: option pick for human-intervention nodes (unspecified in doc)
}

export type SystemCommandType = 'pause' | 'resume' | 'stop' | 'abort';

export interface SystemCommand {
  type: SystemCommandType;
}

// §2.5 — event history row = WAL journal record
export interface TaskEvent {
  seq: number; // per-task strictly monotonic
  ts: string;
  taskId: string;
  type: string;
  payload?: object;
  actor?: string;
}

/** §2.5 closed set (additive changes need an ADR). */
export const TASK_EVENT_TYPES = [
  'task.enqueued', 'task.started', 'task.completed', 'task.failed', 'task.aborted',
  'task.stopped', 'task.suspended', 'task.resumed', 'task.paused', 'task.held',
  'step.started', 'step.completed', 'step.failed', 'step.retried', 'step.suspended',
  'step.resumed',
  'command.issued', 'command.completed', 'command.failed',
  'service.called', 'service.responded',
  'compensation.started', 'compensation.completed', 'compensation.failed',
  'resource.acquired', 'resource.released', 'resource.waitTimeout',
  'alarm.raised', 'alarm.cleared', 'alarm.acked', 'alarm.shelved', 'alarm.unshelved',
  'system.snapshot',
] as const;

/** §2.5 — exactly five step outcomes. */
export type StepOutcome = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'SUSPENDED' | 'ABORTED';

export interface StepError {
  kind: 'business' | 'technical';
  code: string;
  message: string;
  retryable: boolean;
}

export interface Resource {
  key: string;
  deviceId?: string;
  robotId?: string; // optional alias field (v2 fleet reservation)
}

export interface ResourceLockInfo {
  holder?: { taskId: string; nodeId?: string };
  waiters: number;
}

// §3.6 ISA-18.2 states
export type AlarmState = 'Normal' | 'UnackedActive' | 'AckedActive' | 'RtnUnacked' | 'Shelved';
// ASSUMPTION: closed instances are not listed by GET /alarms (state=Normal = no instance row).

export type AlarmRuleKind = 'hi' | 'lo' | 'hihi' | 'lolo' | 'eq' | 'ne';
export type AlarmPriority = 'critical' | 'high' | 'low' | 'audit';

export interface AlarmRule {
  id: string;
  tagId: string;
  kind: AlarmRuleKind;
  threshold: number;
  onDelayMs: number;
  offDelayMs: number;
  priority: AlarmPriority;
  message: string;
}

export interface AlarmInstance {
  id: string;
  ruleId: string;
  tagId: string;
  state: AlarmState;
  activeSince: string;
  ackedBy?: string;
  ackedAt?: string;
  shelvedUntil?: string;
  value?: TagValue;
}

// ASSUMPTION: field names beyond the §2.1 query params are guessed minimally.
export interface AuditRecord {
  ts: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
}

// ---------------------------------------------------------------- §2.2 WS frames

export interface WsSnapshotEntry {
  topic: string;
  value: TagValue;
  quality: Quality;
  ts: string;
}

export interface WsUpdate {
  topic: string;
  value: TagValue;
  quality: Quality;
  reason: QualityReason | null;
  ts: string;
}

export type WsFrame =
  | { op: 'welcome'; serverTime: string; protocolVersion: number }
  | { op: 'subscribed'; topics: string[]; snapshot: WsSnapshotEntry[] }
  | { op: 'unsubscribed'; topics: string[] }
  | { op: 'data'; updates: WsUpdate[] }
  | { op: 'pong' }
  | { op: 'error'; code: string; message: string }
  | { op: 'event'; event: TaskEvent } // /ws/tasks only
  | Record<string, never>;

export type WsClientFrame =
  | { op: 'hello'; token: string }
  | { op: 'subscribe'; topics: string[] }
  | { op: 'unsubscribe'; topics: string[] }
  | { op: 'ping' };

// ---------------------------------------------------------------- §2.4 flow nodes

export interface CommonNodeFields {
  id: string;
  name?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; backoffMs: number; jitter?: number };
  onError?: 'fail' | 'suspend' | 'branch';
  safeAction?: 'hold' | 'safe_position' | 'drain' | 'none';
  compensation?: Action;
  position?: { x: number; y: number };
}

export type Scalar = number | boolean | string | null;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { tag: TagPath; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; value: Scalar }
  | { var: string; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; value: Scalar };

export type Action =
  | { kind: 'delay'; ms: number }
  | { kind: 'tag-write'; writes: DeviceCommandWrite[] }
  | { kind: 'log'; message: string };

export interface DeviceCommandWrite {
  tag: TagPath;
  valueTemplate: object | Scalar;
}

export type FlowNode =
  | ({ type: 'sequence-step'; action?: Action } & CommonNodeFields)
  | ({ type: 'condition-branch'; branches: { when: Condition; port: string }[]; elsePort?: string } & CommonNodeFields)
  | ({ type: 'service-call'; service: 'mes' | 'echo'; operation: string; payloadTemplate: object; idempotent?: boolean; onFailure?: 'branch' | 'suspend' | 'fail' } & CommonNodeFields)
  | ({ type: 'robot-command'; resourceKey: string; command: string; paramsTemplate: object } & CommonNodeFields)
  | ({ type: 'human-intervention'; prompt: string; options?: string[] } & CommonNodeFields)
  | ({ type: 'resource-acquire'; resourceKey: string; onTimeout?: 'fail' | 'suspend' } & CommonNodeFields)
  | ({ type: 'resource-release'; resourceKey: string } & CommonNodeFields)
  | ({ type: 'device-command'; writes: DeviceCommandWrite[]; waitFor?: Condition } & CommonNodeFields)
  | ({ type: 'parallel-fork' } & CommonNodeFields)
  | ({ type: 'parallel-join' } & CommonNodeFields);

// ---------------------------------------------------------------- §5.2 simulator configs

/** @orch/mock-driver channel config (scriptable value/quality emitter). */
export interface MockDriverScriptEntry {
  afterMs: number;
  set?: Record<string, TagValue>; // tag name -> value
  quality?: Quality;
  reason?: QualityReason;
  devices?: string[]; // device names for quality flips
}

export interface MockDriverConfig {
  script: MockDriverScriptEntry[];
}

/** @orch/sim-robot channel config (driver plugin with command capability). */
export interface SimRobotAction {
  durationMs: number;
  failOnAttempt?: number[];
  result?: object;
}

export interface SimRobotConfig {
  actions: Record<string, SimRobotAction>;
  commandStatus?: 'queryable' | string; // absent => command_status capability off (ASSUMPTION)
}

/** @orch/sim-mes config (scriptable northbound WS server peer). */
export interface SimMesResponseScript {
  payload?: object;
  delayMs?: number;
  drop?: boolean;
  error?: object;
}

export interface SimMesConfig {
  responses: Record<string, SimMesResponseScript | SimMesResponseScript[]>;
}

// ---------------------------------------------------------------- §2.6 MES envelope

export interface MesEnvelope {
  id: string;
  type: 'request' | 'response' | 'event';
  op: string;
  payload: object;
  ts: string;
}

// ---------------------------------------------------------------- §6.1 kernel config + manifest

export interface KernelConfig {
  server: { host: string; port: number; tls?: { cert: string; key: string } };
  storage: {
    mode: 'embedded' | 'postgres';
    dataDir: string;
    postgres?: { dsn: string; poolMax: number };
  };
  plugins: {
    dir: string;
    restart: { initialMs: number; maxMs: number; maxRestarts: number; windowMs: number };
  };
  engine: {
    wal: { fsync: 'always' | string };
    snapshot: { intervalMs: number; minEvents: number };
  };
  northbound?: {
    mes?: { url: string; requestTimeoutMs: number; maxRetries: number; reconnect?: { initialMs: number; maxMs: number } };
    mqttBridge?: { url: string; qos: number };
  };
  auth: { bootstrapAdmin: boolean | { username: string; password: string } }; // ASSUMPTION: object form for deterministic tests
}

export interface PluginManifest {
  id: string;
  language: 'node' | 'python';
  command: string;
  args: string[];
}

// Plugin ids assumed for the shipped simulators (manifest ids, §6.1 pattern "driver-modbus").
export const MOCK_DRIVER_ID = 'mock-driver';
export const SIM_ROBOT_ID = 'sim-robot';
