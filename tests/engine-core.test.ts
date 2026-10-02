// Coverage 5a: engine core semantics (§2.4–§2.5, §2.1 tasks): task lifecycle statuses,
// event history sequence + closed event set, manual + webhook task creation, task query
// surface, device-command node with waitFor. Tickets #10; stories 20/21/22/27.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, waitForTagValue, waitForTaskEvent, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { chain, deviceCmd, flowDef, seq, tagIs } from './support/fixtures.js';
import { TASK_EVENT_TYPES } from './support/types.js';
import { assertClosedEventSet, isStrictlyIncreasing, matchEventSubsequence } from './support/util.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [
      { name: 'cmd_out', dataType: 'float64' },
      { name: 'cmd_done', dataType: 'bool' },
      { name: 'gate', dataType: 'bool' },
    ],
    script: { script: [{ afterMs: 0, set: { cmd_out: 0, cmd_done: false, gate: false } }] },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('manual task creation & lifecycle (§2.1 POST /tasks, story 21)', () => {
  it('queued → running → completed with the full §2.5 event sequence', async () => {
    const a = seq('a', { kind: 'log', message: 'one' });
    const b = seq('b', { kind: 'log', message: 'two' });
    const flow = await kernel.api.createFlow({ name: 'two_steps', spec: flowDef('two_steps', [a, b], chain(a, b)) });

    const task = await kernel.api.createTask({ flowId: flow.flowId, input: { order: 'A-001' } });
    expect(['queued', 'running']).toContain(task.status);
    expect(task.flowId).toBe(flow.flowId);
    expect(task.version).toBe(1);

    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(done.input).toEqual({ order: 'A-001' });
    expect(Number.isNaN(Date.parse(done.startedAt ?? ''))).toBe(false);

    const events = await kernel.api.allEvents(task.id);
    // §2.5 order for a straight-line flow.
    const result = matchEventSubsequence(events, [
      { type: 'task.enqueued' },
      { type: 'task.started' },
      { type: 'step.started', payloadSub: { nodeId: 'a' } },
      { type: 'step.completed', payloadSub: { nodeId: 'a', outcome: 'SUCCESS' } },
      { type: 'step.started', payloadSub: { nodeId: 'b' } },
      { type: 'step.completed', payloadSub: { nodeId: 'b', outcome: 'SUCCESS' } },
      { type: 'task.completed' },
    ]);
    expect(result.detail).toBe('matched');

    // seq strictly monotonic per task; ts ISO-8601; closed event set.
    expect(isStrictlyIncreasing(events.map((e) => e.seq))).toBe(true);
    for (const e of events) expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    expect(assertClosedEventSet(events, TASK_EVENT_TYPES)).toEqual([]);
  });

  it('step.completed payloads carry nodeId + outcome (exactly five outcomes exist)', async () => {
    const a = seq('only', { kind: 'delay', ms: 10 });
    const flow = await kernel.api.createFlow({ name: 'one_step', spec: flowDef('one_step', [a], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    const events = await kernel.api.allEvents(task.id);
    const completed = events.filter((e) => e.type === 'step.completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const c of completed) {
      expect((c.payload as { outcome: string }).outcome).toMatch(/^(SUCCESS|FAILURE|TIMEOUT|SUSPENDED|ABORTED)$/);
      expect(typeof (c.payload as { nodeId: string }).nodeId).toBe('string');
    }
  });

  it('POST /tasks with an unknown flow is NOT_FOUND', async () => {
    await kernel.api.expectError('POST', '/tasks', { flowId: '00000000-0000-7000-8000-000000000000' }, 'NOT_FOUND', 404);
  });
});

describe('webhook trigger (§2.1 POST /triggers/webhook/{token}, story 20)', () => {
  it('passes the request body through as task input; wrong token is UNAUTHORIZED', async () => {
    const only = seq('wh', { kind: 'log', message: 'hooked' });
    const flow = await kernel.api.createFlow({ name: 'hooked', spec: flowDef('hooked', [only], []) });
    // A-WEBHOOK (ADJUDICATED): token belongs to the Flow resource — GET /flows/{flowId}
    // returns {id, name, webhookToken, currentVersion}.
    const resource = await kernel.api.getFlow(flow.flowId);
    const token = resource.webhookToken;
    expect(token).toBeTruthy();
    expect(resource.id).toBe(flow.flowId);
    expect(resource.currentVersion).toBe(1);

    const task = await kernel.api.triggerWebhook(token!, { order: 'W-77', qty: 3 });
    expect(task.input).toEqual({ order: 'W-77', qty: 3 });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);

    await kernel.api.expectError(
      'POST', '/triggers/webhook/wrong-token-value', { order: 'x' }, 'UNAUTHORIZED', 401,
    );
  });

  it('rotating the webhook token invalidates the old one (A-WEBHOOK: POST /flows/{id}/webhook-token)', async () => {
    const only = seq('wh2', { kind: 'log', message: 'rotated' });
    const flow = await kernel.api.createFlow({ name: 'rotated', spec: flowDef('rotated', [only], []) });
    const before = await kernel.api.getFlow(flow.flowId);

    const after = await kernel.api.rotateWebhookToken(flow.flowId);
    expect(after.webhookToken).toBeTruthy();
    expect(after.webhookToken).not.toBe(before.webhookToken); // rotation minted a new token

    // The OLD token is dead; the NEW one enqueues a task.
    await kernel.api.expectError(
      'POST', `/triggers/webhook/${before.webhookToken}`, { order: 'stale' }, 'UNAUTHORIZED', 401,
    );
    const task = await kernel.api.triggerWebhook(after.webhookToken, { order: 'fresh' });
    expect(task.input).toEqual({ order: 'fresh' });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
  });
});

describe('task query surface (§2.1 GET /tasks)', () => {
  it('filters by status and flowId with Page shape', async () => {
    const a = seq('q', { kind: 'log', message: 'q' });
    const flow = await kernel.api.createFlow({ name: 'queryable', spec: flowDef('queryable', [a], []) });
    const t1 = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, t1.id, ['completed'], 10_000);

    const byStatus = await kernel.api.listTasks({ status: 'completed' });
    expect(byStatus.items.some((t) => t.id === t1.id)).toBe(true);
    for (const t of byStatus.items) expect(t.status).toBe('completed');

    const byFlow = await kernel.api.listTasks({ flowId: flow.flowId });
    expect(byFlow.items.every((t) => t.flowId === flow.flowId)).toBe(true);
    expect(typeof byFlow.total).toBe('number');
    expect(byFlow.total).toBeGreaterThanOrEqual(byFlow.items.length);
  });
});

describe('device-command node (§2.4: writes + optional waitFor condition)', () => {
  it('writes tags through the driver and waits for the post-write condition', async () => {
    const write = deviceCmd('w', [
      { tag: mock.tagPath('cmd_out'), valueTemplate: 5 },
      { tag: mock.tagPath('cmd_done'), valueTemplate: true },
    ], tagIs(mock.tagPath('cmd_done'), 'eq', true));
    const flow = await kernel.api.createFlow({
      name: 'dev_cmd', spec: flowDef('dev_cmd', [write], []),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 15_000);

    await waitForTagValue(kernel.api, mock.tagIds.cmd_out, 5, 5_000);
    await waitForTagValue(kernel.api, mock.tagIds.cmd_done, true, 5_000);
    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === 'w')).toBe(true);
  });

  it('waitFor that never becomes true times out → retry path → SUSPENDED(retry_exhausted)', async () => {
    // 'gate' is set false once and never written again → the condition can never hold.
    // A-TIMEOUT-NORETRY (ADJUDICATED): default retry.maxAttempts = 1; a TIMEOUT enters
    // the retry path and exhausted retries escalate to SUSPENDED(retry_exhausted) —
    // never an immediate silent fail (onError:'fail' is the only opt-out).
    const write = deviceCmd('w', [
      { tag: mock.tagPath('cmd_out'), valueTemplate: 6 },
    ], tagIs(mock.tagPath('gate'), 'eq', true), 1_500);
    const flow = await kernel.api.createFlow({
      name: 'dev_cmd_timeout', spec: flowDef('dev_cmd_timeout', [write], []),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const done = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 15_000);
    expect(done.suspendReason).toBe('retry_exhausted');
    const events = await kernel.api.allEvents(task.id);
    const failed = events.find((e) => e.type === 'step.failed');
    expect(failed?.payload).toMatchObject({ nodeId: 'w', outcome: 'TIMEOUT' });
    // Default retry.maxAttempts = 1 → exactly ONE execution of the node.
    const starts = events.filter((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'w');
    expect(starts.length).toBe(1);
  });
});

describe('task commands validation (§2.1 TASK_STATE_INVALID)', () => {
  it('commanding a terminal task is rejected with 409 TASK_STATE_INVALID', async () => {
    const a = seq('gone', { kind: 'log', message: 'done already' });
    const flow = await kernel.api.createFlow({ name: 'terminal', spec: flowDef('terminal', [a], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    await kernel.api.expectError('POST', `/tasks/${task.id}/commands`, { type: 'pause' }, 'TASK_STATE_INVALID', 409);
  });

  it('an unknown command type is VALIDATION_ERROR', async () => {
    const a = seq('x', { kind: 'delay', ms: 3_000 });
    const flow = await kernel.api.createFlow({ name: 'cmdtype', spec: flowDef('cmdtype', [a], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskEvent(kernel.api, task.id, (e) => e.type === 'step.started', 10_000);
    await kernel.api.expectError('POST', `/tasks/${task.id}/commands`, { type: 'teleport' }, 'VALIDATION_ERROR', 400);
    await kernel.api.taskCommand(task.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, task.id, ['aborted'], 10_000);
  });
});
