// [test-support] Doc-derived stub — REWIRED AT MERGE.
// FlowDefinition builders per architecture.md §2.4 (frozen at #7: node-type set,
// versioning semantics). Used by storage/northbound suites; engine-track suites
// on the test/spec branch cover flow semantics more broadly.
export interface FlowNodeBase {
  id: string;
  name?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; backoffMs?: number; jitter?: boolean };
  onError?: 'fail' | 'suspend' | 'branch';
  safeAction?: 'hold' | 'safe_position' | 'drain' | 'none';
  position?: { x: number; y: number };
  [k: string]: unknown;
}

export interface FlowSpec {
  specVersion: '1.0';
  id?: string;
  name: string;
  version?: number;
  nodes: FlowNodeBase[];
  edges: { from: string; port: string; to: string }[];
  // A5 (ADJUDICATED, adjudications.md): flow-level trigger bindings —
  // [{kind:'webhook'} | {kind:'mes', op}]. A matching inbound MES event enqueues a
  // task with input = payload; webhook tokens live on the Flow resource, not here.
  triggers?: Array<{ kind: 'webhook' } | { kind: 'mes'; op: string }>;
}

let seq = 0;
function nid(prefix: string): string {
  return `${prefix}-${++seq}`;
}

export interface ServiceCallOpts {
  op: string;
  idempotent?: boolean;
  onFailure?: 'branch' | 'suspend' | 'fail';
  timeoutMs?: number;
  retry?: { maxAttempts: number; backoffMs?: number };
  payload?: object;
}

export function serviceCallNode(id = nid('svc'), opts: ServiceCallOpts): FlowNodeBase {
  return {
    id,
    type: 'service-call',
    service: 'mes',
    operation: opts.op,
    payloadTemplate: opts.payload ?? {},
    ...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
    ...(opts.onFailure !== undefined ? { onFailure: opts.onFailure } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
  };
}

export function delayStep(id = nid('step'), ms = 300): FlowNodeBase {
  return { id, type: 'sequence-step', action: { kind: 'delay', ms } };
}

export function conditionBranch(
  id = nid('branch'),
  branches: { when: unknown; port: string }[],
  elsePort?: string,
): FlowNodeBase {
  return { id, type: 'condition-branch', branches, ...(elsePort !== undefined ? { elsePort } : {}) };
}

/** Linear delay chain n1→n2→…→nk — the canonical WAL-recovery flow. */
export function delayChainFlow(name: string, steps: number, ms = 400): FlowSpec {
  const nodes = Array.from({ length: steps }, (_, i) => delayStep(`n${i + 1}`, ms));
  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, port: 'then', to: nodes[i + 1].id }));
  return { specVersion: '1.0', name, nodes, edges };
}

/**
 * service-call(op) → condition-branch on response → [ok-step | fail-step].
 * Branch predicate follows §2.4 Condition var form: "nodes.<id>.response.<field>".
 */
export function mesServiceFlow(name: string, opts: ServiceCallOpts & { responseField: string; failStepMs?: number }): {
  spec: FlowSpec;
  svcId: string;
  okStepId: string;
  failStepId: string;
} {
  const svc = serviceCallNode(undefined, { ...opts, onFailure: 'branch' });
  const branch = conditionBranch(undefined, [{ when: { var: `nodes.${svc.id}.response.${opts.responseField}`, op: 'eq', value: 'ST-2' }, port: 'toStation2' }], 'else');
  const ok = delayStep(undefined, 100);
  const fail = delayStep(undefined, opts.failStepMs ?? 100);
  const spec: FlowSpec = {
    specVersion: '1.0',
    name,
    nodes: [svc, branch, ok, fail],
    edges: [
      { from: svc.id, port: 'then', to: branch.id },
      { from: branch.id, port: 'toStation2', to: ok.id },
      { from: branch.id, port: 'else', to: fail.id },
    ],
  };
  return { spec, svcId: svc.id, okStepId: ok.id, failStepId: fail.id };
}
