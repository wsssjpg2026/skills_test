#!/usr/bin/env node
// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with @orch/mock-driver;
// this file exists so the contract suite has a reference target before merge and so
// kernel-level tests get a config-scriptable plugin with deterministic fault modes).
// Implements the driver SPI of architecture.md §2.3: JSON-RPC 2.0 over ndjson on stdio,
// plugin→host notifications only, protocolVersion 1. PLAIN JAVASCRIPT (spawned by node).
//
// CLI:
//   node stub-plugin.mjs [--caps subscribe,write,read_on_demand,command,command_status,validate]
//                        [--marker <unique-string>]   (pgrep handle for kill tests)
//                        [--fail-initialize N]        (first N initialize calls fail -32000)
//
// Behavior is driven entirely by the desired state delivered via channel.start/update
// (§2.3.1): device.config and tag.config fields below.
//   device.config: { initialValues?: {tag: value}, readError?: 'timeout'|'not_connected'|'busy'|'internal',
//                    commands?: { [name]: { durationMs, fail?, progress?, result? } } }
//   tag.config:    { initialValue?: value }   (absent → monotonically ticking counter)
//   tag.address:   'AREA:TYPE:offset' with AREA ∈ 0x|1x|3x|4x; readonly tags have access:'read'.
import * as readline from 'node:readline';

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const CAPS_ALL = ['subscribe', 'write', 'read_on_demand', 'command', 'command_status', 'validate'];
const caps = (argOf('caps') ?? CAPS_ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const failInitialize = Number(argOf('fail-initialize') ?? 0);
let initializeAttempts = 0;

const PLUGIN_ID = 'stub-reference-plugin';
const TAG_ADDRESS_RE = /^(0x|1x|3x|4x):(BOOL|INT16|UINT16|INT32|UINT32|INT64|FLOAT32|FLOAT64|STRING|JSON|INT16\[\]|UINT16\[\]|INT32\[\]|UINT32\[\]|FLOAT32\[\]|FLOAT64\[\]|STRING\[\]):\d+$/;

const state = { initialized: false, devices: new Map(), tags: new Map(), channel: null };
const commandRuns = new Map();
const flushTimers = new Map();
const tickCounters = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}
function log(level, message, fields) {
  notify('log', { level, message, ...(fields ?? {}) });
}

function nowIso() {
  return new Date().toISOString();
}

function valueForTag(tag) {
  const dev = state.devices.get(tag.deviceId);
  const init =
    tag?.config?.initialValue ??
    dev?.config?.initialValues?.[tag.id] ??
    dev?.config?.initialValues?.[tag.name];
  if (init !== undefined) return init;
  const k = tickCounters.get(tag.id) ?? 0;
  tickCounters.set(tag.id, k + 1);
  return k;
}

function sampleOf(tag, ts) {
  return { tagId: tag.id, value: valueForTag(tag), quality: 'good', ts };
}

// §2.3.2: tag_update coalescing — one flush at least once per scan period.
function startSubscription(deviceId) {
  stopSubscription(deviceId);
  const tags = [...state.tags.values()].filter((t) => t.deviceId === deviceId);
  if (tags.length === 0) return;
  const period = Math.max(10, Math.min(...tags.map((t) => t.scanPeriodMs ?? 200)));
  const timer = setInterval(() => {
    const ts = nowIso();
    const byTag = new Map();
    for (const tag of tags) byTag.set(tag.id, sampleOf(tag, ts)); // coalesce → last per tag
    notify('tag_update', { deviceId, samples: [...byTag.values()] });
  }, period);
  flushTimers.set(deviceId, timer);
}
function stopSubscription(deviceId) {
  const t = flushTimers.get(deviceId);
  if (t) clearInterval(t);
  flushTimers.delete(deviceId);
}
function stopAllSubscriptions() {
  for (const t of flushTimers.values()) clearInterval(t);
  flushTimers.clear();
}

function applyDesiredState(params) {
  state.channel = params.channel ?? {};
  state.devices = new Map((params.devices ?? []).map((d) => [d.id, d]));
  state.tags = new Map((params.tags ?? []).map((t) => [t.id, t]));
  for (const id of state.devices.keys()) {
    notify('device_status', { deviceId: id, state: 'connected' });
    if (caps.includes('subscribe') && (state.channel?.config?.mode ?? 'subscribe') === 'subscribe') {
      startSubscription(id);
    }
  }
}

async function handle(method, params, id) {
  if (method === 'initialize') {
    if (params?.protocolVersion !== 1) {
      error(id, -32602, `unsupported protocolVersion ${params?.protocolVersion}, host must send 1`);
      return;
    }
    initializeAttempts += 1;
    if (initializeAttempts <= failInitialize) {
      error(id, -32000, 'scripted initialize failure');
      return;
    }
    state.initialized = true;
    result(id, {
      pluginInfo: { id: PLUGIN_ID, version: '1.0.0-test' },
      capabilities: caps,
      configSchema: { type: 'object', additionalProperties: true },
    });
    return;
  }
  if (!state.initialized) {
    // §2.3.3: NOT_INITIALIZED for any method before successful initialize.
    error(id, -32001, `method '${method}' called before initialize`);
    return;
  }
  switch (method) {
    case 'channel.start':
    case 'channel.update': {
      // Full-replace desired state (§2.3 lifecycle); driver diffs internally.
      stopAllSubscriptions();
      applyDesiredState(params);
      result(id, {});
      return;
    }
    case 'read': {
      const dev = state.devices.get(params?.deviceId);
      if (!dev) {
        error(id, -32002, `unknown deviceId ${params?.deviceId}`);
        return;
      }
      const tagIds = params?.tagIds ?? [];
      for (const tid of tagIds) {
        if (!state.tags.has(tid)) {
          error(id, -32003, `unknown tagId ${tid}`);
          return;
        }
      }
      switch (dev.config?.readError) {
        case 'timeout':
          error(id, -32006, 'scripted read timeout');
          return;
        case 'not_connected':
          error(id, -32005, 'device scripted not_connected');
          return;
        case 'busy':
          error(id, -32007, 'scripted link busy');
          return;
        case 'internal':
          error(id, -32000, 'scripted internal fault');
          return;
        default:
          break;
      }
      const ts = nowIso();
      result(id, { samples: tagIds.map((tid) => sampleOf(state.tags.get(tid), ts)) });
      return;
    }
    case 'write': {
      const dev = state.devices.get(params?.deviceId);
      if (!dev) {
        error(id, -32002, `unknown deviceId ${params?.deviceId}`);
        return;
      }
      const results = (params?.writes ?? []).map((w) => {
        const tag = state.tags.get(w.tagId);
        if (!tag) {
          return { tagId: w.tagId, ok: false, quality: 'bad', reason: 'config_error', error: { code: -32003, message: `unknown tagId ${w.tagId}` } };
        }
        if (tag.access === 'read') {
          // §2.3.3 −32008 semantics surfaced as a per-item result.
          return { tagId: w.tagId, ok: false, quality: 'bad', reason: 'write_rejected', error: { code: -32008, message: 'tag is read-only' } };
        }
        tag.config = { ...(tag.config ?? {}), initialValue: w.value };
        if (w.verify && JSON.stringify(tag.config.initialValue) !== JSON.stringify(w.value)) {
          return { tagId: w.tagId, ok: false, quality: 'bad', reason: 'write_rejected', error: { code: -32008, message: 'verify mismatch' } };
        }
        return { tagId: w.tagId, ok: true };
      });
      result(id, { results });
      return;
    }
    case 'subscribe': {
      if (!caps.includes('subscribe')) {
        error(id, -32000, 'subscribe called but plugin did not declare the subscribe capability');
        return;
      }
      for (const tid of params?.tagIds ?? []) {
        if (!state.tags.has(tid)) {
          error(id, -32003, `unknown tagId ${tid}`);
          return;
        }
      }
      startSubscription(params.deviceId);
      result(id, {});
      return;
    }
    case 'unsubscribe': {
      stopSubscription(params?.deviceId);
      result(id, {});
      return;
    }
    case 'command': {
      if (!caps.includes('command')) {
        error(id, -32000, 'command called but plugin did not declare the command capability');
        return;
      }
      const dev = state.devices.get(params?.deviceId);
      if (!dev) {
        error(id, -32002, `unknown deviceId ${params?.deviceId}`);
        return;
      }
      const script = dev.config?.commands?.[params.command];
      if (!script) {
        error(id, -32009, `device refused unknown command '${params.command}'`);
        return;
      }
      const run = { state: 'running' };
      commandRuns.set(params.commandId, run);
      result(id, { accepted: true });
      const duration = script.durationMs ?? 200;
      if (script.progress) {
        setTimeout(() => {
          notify('command_event', {
            deviceId: params.deviceId,
            commandId: params.commandId,
            event: 'progress',
            result: { pct: 50 },
          });
        }, Math.max(1, Math.floor(duration / 2)));
      }
      setTimeout(() => {
        if (script.fail) {
          run.state = 'failed';
          run.error = { kind: script.failKind ?? 'technical', code: 'SIM_FAIL', message: `scripted failure of ${params.command}` };
          notify('command_event', {
            deviceId: params.deviceId,
            commandId: params.commandId,
            event: 'failed',
            error: run.error,
          });
        } else {
          run.state = 'completed';
          run.result = script.result ?? { done: true };
          notify('command_event', {
            deviceId: params.deviceId,
            commandId: params.commandId,
            event: 'completed',
            result: run.result,
          });
        }
      }, duration);
      return;
    }
    case 'command.status': {
      if (!caps.includes('command_status')) {
        error(id, -32000, 'command.status called but plugin did not declare the command_status capability');
        return;
      }
      const run = commandRuns.get(params?.commandId);
      if (!run) {
        error(id, -32009, `unknown commandId ${params?.commandId}`);
        return;
      }
      const body = { state: run.state };
      if (run.state === 'completed') body.result = run.result;
      if (run.state === 'failed') body.error = run.error;
      result(id, body);
      return;
    }
    case 'validate': {
      if (!caps.includes('validate')) {
        error(id, -32000, 'validate called but plugin did not declare the validate capability');
        return;
      }
      const errors = [];
      const cfg = params?.config ?? {};
      if (params?.kind === 'tag') {
        if (typeof cfg.address !== 'string' || !TAG_ADDRESS_RE.test(cfg.address)) {
          errors.push({
            path: 'address',
            code: 'ADDRESS_INVALID',
            message: `address '${cfg.address}' does not match grammar AREA:TYPE:offset (AREA ∈ 0x|1x|3x|4x)`,
          });
        }
        if (cfg.scanPeriodMs !== undefined && (cfg.scanPeriodMs < 10 || cfg.scanPeriodMs > 3_600_000)) {
          errors.push({ path: 'scanPeriodMs', code: 'RANGE', message: 'scanPeriodMs must be within 10..3600000' });
        }
      }
      result(id, { errors });
      return;
    }
    case 'shutdown': {
      result(id, {});
      log('info', 'stub-plugin shutting down', { reason: params?.reason });
      stopAllSubscriptions();
      setImmediate(() => process.exit(0));
      return;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
      return;
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  handle(msg.method, msg.params ?? {}, typeof msg.id === 'number' ? msg.id : null).catch((e) => {
    send({ jsonrpc: '2.0', id: typeof msg.id === 'number' ? msg.id : null, error: { code: -32000, message: String(e) } });
  });
});

if (argOf('marker')) {
  // touch marker on stderr for pgrep-based supervision tests (stderr = plugin logs, §2.3)
  process.stderr.write(`[${PLUGIN_ID}] marker=${argOf('marker')}\n`);
}
process.on('SIGTERM', () => {
  stopAllSubscriptions();
  process.exit(0);
});
