// Coverage 5h: human-intervention suspend → continue (§2.4 human-intervention node,
// §2.5 suspend reasons). Spec story 26: "挂起的流程等待我确认后续跑".
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { chain, flowDef, human, seq } from './support/fixtures.js';
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

describe('human-intervention node (§2.4)', () => {
  it('suspends with reason human_intervention; operator continue resumes to completion', async () => {
    const before = seq('before', { kind: 'log', message: 'work done' });
    const gate = human('qa_gate', '请确认抓取质量后继续', ['ok', 'redo']);
    const after = seq('after', { kind: 'log', message: 'confirmed' });
    const flow = await kernel.api.createFlow({
      name: 'human_gate', spec: flowDef('human_gate', [before, gate, after], chain(before, gate, after)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const suspended = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 15_000);
    expect(suspended.suspendReason).toBe('human_intervention');
    expect(suspended.currentNodeIds).toContain('qa_gate');

    await kernel.api.taskCommand(task.id, { type: 'continue' });
    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');

    const events = await kernel.api.allEvents(task.id);
    expect(matchEventSubsequence(events, [
      { type: 'step.started', payloadSub: { nodeId: 'before' } },
      { type: 'step.suspended', payloadSub: { nodeId: 'qa_gate' } },
      { type: 'task.suspended', payloadSub: { reason: 'human_intervention' } },
      { type: 'task.resumed' },
      { type: 'step.completed', payloadSub: { nodeId: 'qa_gate' } },
      { type: 'step.started', payloadSub: { nodeId: 'after' } },
      { type: 'task.completed' },
    ]).ok).toBe(true);
  });

  it('multiple gated tasks stay independently suspended and resumable', async () => {
    const gate = human('g', 'confirm');
    const flow = await kernel.api.createFlow({ name: 'multi_gate', spec: flowDef('multi_gate', [gate], []) });
    const t1 = await kernel.api.createTask({ flowId: flow.flowId });
    const t2 = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, t1.id, ['suspended'], 15_000);
    await waitForTaskStatus(kernel.api, t2.id, ['suspended'], 15_000);

    await kernel.api.taskCommand(t1.id, { type: 'continue' });
    await waitForTaskStatus(kernel.api, t1.id, ['completed'], 15_000);
    // t2 untouched: still suspended.
    expect((await kernel.api.getTask(t2.id)).status).toBe('suspended');
    await kernel.api.taskCommand(t2.id, { type: 'continue' });
    await waitForTaskStatus(kernel.api, t2.id, ['completed'], 15_000);
  });

  it('continue on a RUNNING task is TASK_STATE_INVALID (no suspend to resume from)', async () => {
    const slow = seq('slow', { kind: 'delay', ms: 4_000 });
    const flow = await kernel.api.createFlow({ name: 'running_gate', spec: flowDef('running_gate', [slow], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['running'], 10_000);
    await kernel.api.expectError('POST', `/tasks/${task.id}/commands`, { type: 'continue' }, 'TASK_STATE_INVALID', 409);
    await kernel.api.taskCommand(task.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, task.id, ['aborted'], 10_000);
  });
});
