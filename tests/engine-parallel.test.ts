// Coverage 5g: parallel fork/join (§2.4 parallel-fork ports branch-N → parallel-join
// waits all incoming branches). Ticket #10.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { cond, edge, flowDef, fork, join, seq } from './support/fixtures.js';
import { matchEventSubsequence } from './support/util.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startKernel();
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

function fanOutFlow(name: string, branchDelays: number[], withCondition = false) {
  const start = seq('start', { kind: 'log', message: 'go' });
  const f = fork('fan', branchDelays.length);
  const branches = branchDelays.map((ms, i) => seq(`b${i}`, { kind: 'delay', ms }));
  const j = join('meet');
  const done = seq('after', { kind: 'log', message: 'joined' });
  const edges = [
    edge('start', 'then', 'fan'),
    ...branches.map((_, i) => edge('fan', `branch-${i}`, `b${i}`)),
    ...branches.map((_, i) => edge(`b${i}`, 'then', 'meet')),
    edge('meet', 'then', 'after'),
  ];
  if (!withCondition) {
    return flowDef(name, [start, f, ...branches, j, done], edges);
  }
  // A var condition inside branch 1; both ports route to the branch body so the join
  // still waits on all three branches regardless of the condition outcome.
  const gate = cond('b1gate', [{ when: { var: 'input.go', op: 'eq', value: true }, port: 'go' }], 'also_go');
  return flowDef(name, [start, f, ...branches, gate, j, done], [
    edge('start', 'then', 'fan'),
    edge('fan', 'branch-0', 'b0'),
    edge('fan', 'branch-1', 'b1gate'),
    edge('fan', 'branch-2', 'b2'),
    edge('b0', 'then', 'meet'),
    edge('b1gate', 'go', 'b1'),
    edge('b1gate', 'also_go', 'b1'),
    edge('b1', 'then', 'meet'),
    edge('b2', 'then', 'meet'),
    edge('meet', 'then', 'after'),
  ]);
}

describe('parallel-fork / parallel-join (§2.4)', () => {
  it('all branches run, join waits for EVERY branch, then the flow completes', async () => {
    const flow = await kernel.api.createFlow({
      name: 'fan3', spec: fanOutFlow('fan3', [150, 500, 300]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);

    const events = await kernel.api.allEvents(task.id);
    for (const b of ['b0', 'b1', 'b2']) {
      expect(events.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === b)).toBe(true);
    }
    // Join semantics: join's step.started must come AFTER every branch's step.completed.
    const seqOf = (type: string, nodeId: string) =>
      events.find((e) => e.type === type && (e.payload as { nodeId: string }).nodeId === nodeId)?.seq;
    const joinSeq = seqOf('step.started', 'meet');
    expect(joinSeq).toBeDefined();
    for (const b of ['b0', 'b1', 'b2']) {
      expect(seqOf('step.completed', b)!).toBeLessThan(joinSeq!);
    }
    // After the join the flow proceeds.
    expect(matchEventSubsequence(events, [
      { type: 'step.started', payloadSub: { nodeId: 'meet' } },
      { type: 'step.completed', payloadSub: { nodeId: 'meet' } },
      { type: 'step.started', payloadSub: { nodeId: 'after' } },
      { type: 'task.completed' },
    ]).ok).toBe(true);
  });

  it('the slowest branch gates the join (fast branches complete first)', async () => {
    const flow = await kernel.api.createFlow({
      name: 'fan_skew', spec: fanOutFlow('fan_skew', [100, 900, 100]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);
    const events = await kernel.api.allEvents(task.id);
    const seqOf = (type: string, nodeId: string) =>
      events.find((e) => e.type === type && (e.payload as { nodeId: string }).nodeId === nodeId)?.seq;
    expect(seqOf('step.completed', 'b0')!).toBeLessThan(seqOf('step.completed', 'b1')!);
    expect(seqOf('step.completed', 'b2')!).toBeLessThan(seqOf('step.completed', 'b1')!);
    expect(seqOf('step.completed', 'b1')!).toBeLessThan(seqOf('step.started', 'meet')!);
  });

  it('condition nodes work inside branches', async () => {
    const flow = await kernel.api.createFlow({
      name: 'fan_cond', spec: fanOutFlow('fan_cond', [100, 200, 100], true),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId, input: { go: true } });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);
    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === 'b1')).toBe(true);
    expect(events.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === 'after')).toBe(true);
  });
});
