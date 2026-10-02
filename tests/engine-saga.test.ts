// Coverage 5e: saga compensation in reverse order (§4.2, §3.4 sagaLog). Spec story 25:
// "为每一步登记补偿动作并在失败时逆序执行（放回/回位）". Ticket #16.
// Compensation observability: tag-write Actions leave values queryable via /tags/values.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, waitForTagValue, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { acquire, chain, flowDef, installRobotChannel, release, robot, seq } from './support/fixtures.js';
import { matchEventSubsequence } from './support/util.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [{ name: 'slotA' }, { name: 'slotB' }, { name: 'slotC' }],
    script: { script: [{ afterMs: 0, set: { slotA: 0, slotB: 0, slotC: 0 } }] },
  });
  await installRobotChannel(kernel.api, {
    channel: 'sagabot',
    device: 'saga_arm',
    config: { actions: { kaboom: { durationMs: 200, failOnAttempt: [1, 2, 3, 4] } } },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('saga compensation runs in REVERSE order on failure (§3.4 sagaLog)', () => {
  it('compensations for executed steps unwind newest-first, leaving marker values', async () => {
    const acq = acquire('acq', 'saga_r');
    const stepA = seq('stepA', { kind: 'tag-write', writes: [{ tag: mock.tagPath('slotA'), valueTemplate: 11 }] }, {
      compensation: { kind: 'tag-write', writes: [{ tag: mock.tagPath('slotA'), valueTemplate: -11 }] },
    });
    const stepB = seq('stepB', { kind: 'tag-write', writes: [{ tag: mock.tagPath('slotB'), valueTemplate: 22 }] }, {
      compensation: { kind: 'tag-write', writes: [{ tag: mock.tagPath('slotB'), valueTemplate: -22 }] },
    });
    // Terminal failure with no fail-branch and no retry: triggers the saga unwind.
    const boom = robot('boom', 'saga_r', 'kaboom', {}, { timeoutMs: 5_000 });
    const rel = release('rel', 'saga_r');
    const flow = await kernel.api.createFlow({
      name: 'saga_order',
      spec: flowDef('saga_order', [acq, stepA, stepB, boom, rel], chain(acq, stepA, stepB, boom, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const done = await waitForTaskStatus(kernel.api, task.id, ['failed'], 25_000);
    expect(done.status).toBe('failed');

    // Forward effects happened...
    await waitForTagValue(kernel.api, mock.tagIds.slotA, -11, 10_000); // compensated
    await waitForTagValue(kernel.api, mock.tagIds.slotB, -22, 10_000); // compensated

    const events = await kernel.api.allEvents(task.id);
    // The step that failed never registered a compensation, so the unwind is B then A.
    expect(matchEventSubsequence(events, [
      { type: 'step.completed', payloadSub: { nodeId: 'stepA' } },
      { type: 'step.completed', payloadSub: { nodeId: 'stepB' } },
      { type: 'step.failed', payloadSub: { nodeId: 'boom' } },
      { type: 'compensation.started', payloadSub: { nodeId: 'stepB' } },   // newest first
      { type: 'compensation.completed', payloadSub: { nodeId: 'stepB' } },
      { type: 'compensation.started', payloadSub: { nodeId: 'stepA' } },   // then older
      { type: 'compensation.completed', payloadSub: { nodeId: 'stepA' } },
      { type: 'task.failed' },
    ]).ok).toBe(true);
    // Compensation events strictly ordered B-before-A by seq.
    const seqB = events.find((e) => e.type === 'compensation.started' && (e.payload as { nodeId: string }).nodeId === 'stepB')!.seq;
    const seqA = events.find((e) => e.type === 'compensation.started' && (e.payload as { nodeId: string }).nodeId === 'stepA')!.seq;
    expect(seqB).toBeLessThan(seqA);
  });

  it('a failing compensation emits compensation.failed without swallowing the task failure', async () => {
    // A-COMP-FAIL: writes to an unknown TagPath fail at RUNTIME (deploy validation
    // does not resolve tag paths in compensation writes).
    const stepOk = seq('okStep', { kind: 'log', message: 'did a thing' }, {
      compensation: { kind: 'tag-write', writes: [{ tag: 'factory.plc.does_not_exist', valueTemplate: 1 }] },
    });
    const boom = robot('boom2', 'saga_r', 'kaboom', {}, { timeoutMs: 5_000 });
    const flow = await kernel.api.createFlow({
      name: 'saga_comp_fail',
      spec: flowDef('saga_comp_fail', [stepOk, boom], chain(stepOk, boom)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const done = await waitForTaskStatus(kernel.api, task.id, ['failed'], 25_000);
    expect(done.status).toBe('failed');
    const events = await kernel.api.allEvents(task.id);
    const compFail = events.find((e) => e.type === 'compensation.failed');
    expect(compFail).toBeDefined();
    expect(compFail!.payload).toMatchObject({ nodeId: 'okStep' });
  });

  it('successful flows never run compensations', async () => {
    const happy = seq('happy', { kind: 'log', message: 'all good' }, {
      compensation: { kind: 'log', message: 'never' },
    });
    const flow = await kernel.api.createFlow({ name: 'saga_happy', spec: flowDef('saga_happy', [happy], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    const events = await kernel.api.allEvents(task.id);
    expect(events.filter((e) => e.type.startsWith('compensation.')).length).toBe(0);
  });
});
