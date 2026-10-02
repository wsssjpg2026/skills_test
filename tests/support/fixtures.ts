// doc-derived test stub — rewired to @orch/* at merge.
// Flow-definition builders (§2.4 verbatim node set), simulator channel installers (§5.2),
// and the scenario loader/installer (§5.3: seed/simulators/faults/expect applied through
// the public REST API only).

import { RestClient } from './rest.js';
import {
  readJson, scenariosDir,
} from './util.js';
import type {
  Action, Condition, DeviceCommandWrite, FlowDefinition, FlowEdge, FlowNode, FlowVersion,
  MockDriverConfig, SimMesConfig, SimRobotConfig,
} from './types.js';

// ---------------------------------------------------------------- flow builders

let flowCounter = 0;

export function flowDef(name: string, nodes: FlowNode[], edges: FlowEdge[]): FlowDefinition {
  flowCounter += 1;
  return {
    specVersion: '1.0',
    // spec.id omitted: server assigns the logical flow id on first deploy (ASSUMPTION).
    name,
    nodes,
    edges,
  };
}

export function edge(from: string, port: string, to: string): FlowEdge {
  return { from, port, to };
}

/** §2.4 default success port per node type (robot-command has NO 'then' port). */
export function happyPort(n: FlowNode): string {
  return n.type === 'robot-command' ? 'completed' : 'then';
}

/** Linear chain of nodes wired on each node's default success port. */
export function chain(...nodes: FlowNode[]): FlowEdge[] {
  return nodes.slice(0, -1).map((n, i) => edge(n.id, happyPort(n), nodes[i + 1].id));
}

export function seq(id: string, action?: Action, extra: Partial<Extract<FlowNode, { type: 'sequence-step' }>> = {}): FlowNode {
  return { type: 'sequence-step', id, ...(action ? { action } : {}), ...extra };
}

export function cond(
  id: string,
  branches: { when: Condition; port: string }[],
  elsePort?: string,
): FlowNode {
  return { type: 'condition-branch', id, branches, ...(elsePort ? { elsePort } : {}) };
}

export function svc(
  id: string,
  operation: string,
  payloadTemplate: object,
  extra: Partial<Extract<FlowNode, { type: 'service-call' }>> = {},
): FlowNode {
  // service 'echo' = in-kernel loopback northbound provider, test-only (§10 #10 note).
  return {
    type: 'service-call',
    id,
    service: 'echo',
    operation,
    payloadTemplate,
    ...extra,
  } as FlowNode;
}

export function robot(
  id: string,
  resourceKey: string,
  command: string,
  paramsTemplate: object,
  extra: Partial<Extract<FlowNode, { type: 'robot-command' }>> = {},
): FlowNode {
  return { type: 'robot-command', id, resourceKey, command, paramsTemplate, ...extra };
}

export function human(id: string, prompt: string, options?: string[]): FlowNode {
  return { type: 'human-intervention', id, prompt, ...(options ? { options } : {}) };
}

export function acquire(id: string, resourceKey: string, onTimeout?: 'fail' | 'suspend', timeoutMs?: number): FlowNode {
  return { type: 'resource-acquire', id, resourceKey, ...(onTimeout ? { onTimeout } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}

export function release(id: string, resourceKey: string): FlowNode {
  return { type: 'resource-release', id, resourceKey };
}

export function deviceCmd(id: string, writes: DeviceCommandWrite[], waitFor?: Condition, timeoutMs?: number): FlowNode {
  return { type: 'device-command', id, writes, ...(waitFor ? { waitFor } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}

export function fork(id: string, branchCount: number): FlowNode & { ports: string[] } {
  const ports = Array.from({ length: branchCount }, (_, i) => `branch-${i}`);
  return { type: 'parallel-fork', id, ports } as FlowNode & { ports: string[] };
}

export function join(id: string): FlowNode {
  return { type: 'parallel-join', id };
}

/** Tag condition on a TagPath (structured conditions only — no string DSL in v1). */
export function tagIs(
  tagPath: string,
  op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le',
  value: number | boolean | string | null,
): Condition {
  return { tag: tagPath, op, value };
}

export function varIs(varPath: string, op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le', value: unknown): Condition {
  return { var: varPath, op, value } as Condition;
}

// ---------------------------------------------------------------- simulator channels

export async function installRobotChannel(
  api: RestClient,
  opts: {
    channel?: string;
    device?: string;
    config: SimRobotConfig;
    tags?: Array<{ name: string; dataType?: 'float64' | 'bool' | 'string' }>;
  },
): Promise<{ deviceId: string; tagIds: Record<string, string> }> {
  const channelName = opts.channel ?? 'robots';
  const deviceName = opts.device ?? 'arm1';
  const ch = await api.createChannel({
    name: channelName,
    driver: 'sim-robot',
    enabled: true,
    config: opts.config as unknown as object,
  });
  const dev = await api.createDevice({ channelId: ch.id, name: deviceName, address: 'sim:1', enabled: true });
  const specs = opts.tags ?? [{ name: 'battery' }];
  const tagIds: Record<string, string> = {};
  for (const t of specs) {
    const tag = await api.createTag({
      deviceId: dev.id,
      name: t.name,
      dataType: t.dataType ?? 'float64',
      address: `sim:${t.name}`,
      access: 'readwrite',
      historyEnabled: false,
    });
    tagIds[t.name] = tag.id;
  }
  return { deviceId: dev.id, tagIds };
}

// ---------------------------------------------------------------- scenario fixtures (§5.3)

export interface ScenarioSeedTag {
  name: string;
  dataType?: string;
  address?: string;
  access?: 'read' | 'write' | 'readwrite';
  historyEnabled?: boolean;
}

export interface ScenarioSeedDevice {
  name: string;
  address: string;
  enabled?: boolean;
  tags: ScenarioSeedTag[];
}

export interface ScenarioSeedChannel {
  name: string;
  driver: string;
  enabled: boolean;
  config: MockDriverConfig | SimRobotConfig | object;
  devices: ScenarioSeedDevice[];
}

export interface ScenarioSeedFlow {
  name: string;
  spec: FlowDefinition;
  /** ASSUMPTION: webhook binding surface — see ASSUMPTIONS.md A-WEBHOOK. */
  triggers?: { webhook?: { token: string } };
}

export interface ScenarioFault {
  name: string;
  type: 'kill-plugin' | 'kill-kernel' | 'socket-cut' | 'sim_error_injection';
  target?: string; // plugin id / device / channel / sim op
  at?: string; // e.g. "node:<nodeId>:started" — timed injection anchor
  durationMs?: number;
  responses?: Record<string, unknown>; // for sim_error_injection
}

export interface ScenarioExpectEntry {
  type: string;
  payloadSub?: Record<string, unknown>;
  optional?: boolean;
}

export interface Scenario {
  name: string;
  seed: { channels: ScenarioSeedChannel[]; flows: ScenarioSeedFlow[] };
  simulators: { mes?: SimMesConfig; robot?: SimRobotConfig; mock?: MockDriverConfig };
  faults: ScenarioFault[];
  expect: { taskEventSequence: ScenarioExpectEntry[] };
}

/** Load scenarios/<name>/{seed,simulators,faults,expect}.json (§5.3 product fixtures). */
export async function loadScenario(name: string): Promise<Scenario> {
  const dir = scenariosDir(name);
  const seed = await readJson(`${dir}/seed.json`) as Scenario['seed'];
  const simulators = await readJson(`${dir}/simulators.json`) as Scenario['simulators'];
  const faults = await readJson(`${dir}/faults.json`) as ScenarioFault[];
  const expect = await readJson(`${dir}/expect.json`) as Scenario['expect'];
  return { name, seed, simulators, faults, expect };
}

export interface InstalledScenario {
  channels: Record<string, string>;
  devices: Record<string, string>;
  tags: Record<string, string>;
  flows: Record<string, FlowVersion>;
  webhookTokens: Record<string, string>;
}

/** Apply a scenario seed through the public REST API (the only path tests may use). */
export async function installScenario(api: RestClient, scenario: Scenario): Promise<InstalledScenario> {
  const out: InstalledScenario = { channels: {}, devices: {}, tags: {}, flows: {}, webhookTokens: {} };
  for (const ch of scenario.seed.channels) {
    const channel = await api.createChannel({ name: ch.name, driver: ch.driver, enabled: ch.enabled, config: ch.config });
    out.channels[ch.name] = channel.id;
    for (const dev of ch.devices) {
      const device = await api.createDevice({ channelId: channel.id, name: dev.name, address: dev.address, enabled: dev.enabled ?? true });
      out.devices[dev.name] = device.id;
      for (const t of dev.tags) {
        const tag = await api.createTag({
          deviceId: device.id,
          name: t.name,
          dataType: (t.dataType ?? 'float64') as never,
          address: t.address ?? `sim:${t.name}`,
          access: t.access ?? 'readwrite',
          historyEnabled: t.historyEnabled ?? false,
        });
        out.tags[t.name] = tag.id;
      }
    }
  }
  for (const f of scenario.seed.flows) {
    const created = await api.createFlow({ name: f.name, spec: f.spec });
    out.flows[f.name] = created;
    const token = (created as unknown as { webhookToken?: string }).webhookToken
      ?? f.spec.triggers?.webhook?.token
      ?? f.triggers?.webhook?.token;
    if (token) out.webhookTokens[f.name] = token;
  }
  return out;
}

/**
 * Apply a scenario's sim_error_injection faults to the MES simulator config:
 * the fault's scripted response sequence replaces the op's default response.
 * (§5.3 faults.json: timed injections incl "sim error injection".)
 */
export function applyScenarioFault(base: SimMesConfig, faults: ScenarioFault[]): SimMesConfig {
  const cfg: SimMesConfig = { responses: { ...base.responses } };
  for (const f of faults) {
    if (f.type !== 'sim_error_injection') continue;
    if (!f.target || !f.target.startsWith('mes.')) continue;
    const op = f.target.slice('mes.'.length);
    const seq = Array.isArray(f.responses) ? f.responses : f.responses?.[op];
    if (seq) cfg.responses[op] = seq as never;
  }
  return cfg;
}

/** Normalize a spec for value comparison (ignore server-assigned id/version). */
export function stripServerAssigned(spec: FlowDefinition): FlowDefinition {
  const { id: _id, version: _v, ...rest } = spec;
  return rest as FlowDefinition;
}
