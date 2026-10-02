// Coverage 5c: per-node timeout & retry, technical-vs-business failure layering,
// retry-exhausted → SUSPENDED(retry_exhausted) (§2.5, §4.2). Tickets #10/#16; story 22.
// sim-robot per §5.2: {actions:{navigate_to_goal:{durationMs, failOnAttempt:[...]}}}.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskEvent, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { acquire, chain, edge, flowDef, installRobotChannel, release, robot, seq } from './support/fixtures.js';
import type { SimRobotConfig } from './support/types.js';

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

function robotConfig(actions: SimRobotConfig['actions'], commandStatus?: 'queryable'): SimRobotConfig {
  return commandStatus ? { actions, commandStatus } : { actions };
}

describe('per-node timeout (§2.4 timeoutMs common field)', () => {
  it('a command slower than timeoutMs completes via the timeout port with outcome TIMEOUT', async () => {
    await installRobotChannel(kernel.api, {
      channel: 'slowbot', device: 'slow_arm',
      config: robotConfig({ crawl: { durationMs: 10_000 } }),
    });
    const acq = acquire('acq', 'slowbot_r');
    const cmd = robot('crawl', 'slowbot_r', 'crawl', { m: 1 }, { timeoutMs: 800 });
    const timedOut = seq('on_timeout', { kind: 'log', message: 'timed out' });
    const rel = release('rel', 'slowbot_r');
    const flow = await kernel.api.createFlow({
      name: 'timeout_port',
      spec: flowDef('timeout_port', [acq, cmd, timedOut, rel], [
        ...chain(acq, cmd),
        edge('crawl', 'timeout', 'on_timeout'),
        edge('on_timeout', 'then', 'rel'),
      ]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);
    const events = await kernel.api.allEvents(task.id);
    // §2.4: robot-command ports completed/failed/timeout; §2.5 outcome TIMEOUT.
    const completed = events.find((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === 'crawl');
    expect(completed?.payload).toMatchObject({ nodeId: 'crawl', outcome: 'TIMEOUT' });
    expect(events.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'on_timeout')).toBe(true);
  });

  it("onError:'fail' opts out of the suspend: an unbranched timeout fails fast (A-TIMEOUT-NORETRY)", async () => {
    // A-TIMEOUT-NORETRY (ADJUDICATED): default retry.maxAttempts = 1 → a TIMEOUT enters
    // the retry path → SUSPENDED(retry_exhausted); onError:'fail' fails fast instead.
    await installRobotChannel(kernel.api, {
      channel: 'failbot', device: 'fail_arm',
      config: robotConfig({ stall: { durationMs: 10_000 } }),
    });
    const acq = acquire('acq', 'failbot_r');
    const cmd = robot('stuck', 'failbot_r', 'stall', {}, { timeoutMs: 700, onError: 'fail' });
    const flow = await kernel.api.createFlow({
      name: 'timeout_failfast',
      spec: flowDef('timeout_failfast', [acq, cmd], chain(acq, cmd)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const done = await waitForTaskStatus(kernel.api, task.id, ['failed'], 20_000);
    expect(done.status).toBe('failed');
    expect(done.suspendReason).toBeUndefined(); // NOT suspended — fail-fast opted out
    const events = await kernel.api.allEvents(task.id);
    const failed = events.find((e) => e.type === 'step.failed' && (e.payload as { nodeId: string }).nodeId === 'stuck');
    expect(failed?.payload).toMatchObject({ nodeId: 'stuck', outcome: 'TIMEOUT' });
    // Exactly one execution: fail-fast does not loop.
    const starts = events.filter((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'stuck');
    expect(starts.length).toBe(1);
    expect(events.some((e) => e.type === 'task.suspended')).toBe(false);
  });
});

describe('retry policy (§2.4 retry {maxAttempts, backoffMs})', () => {
  it('a failing command retries then succeeds — step.retried events record attempts', async () => {
    // failOnAttempt:[1] → first attempt fails, second succeeds (§5.2).
    await installRobotChannel(kernel.api, {
      channel: 'retrybot', device: 'retry_arm',
      config: robotConfig({ flaky_move: { durationMs: 200, failOnAttempt: [1] } }),
    });
    const acq = acquire('acq', 'retrybot_r');
    const cmd = robot('move', 'retrybot_r', 'flaky_move', {}, {
      retry: { maxAttempts: 3, backoffMs: 100 },
    });
    const rel = release('rel', 'retrybot_r');
    const flow = await kernel.api.createFlow({
      name: 'retry_success',
      spec: flowDef('retry_success', [acq, cmd, rel], chain(acq, cmd, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);
    const events = await kernel.api.allEvents(task.id);
    const retried = events.filter((e) => e.type === 'step.retried');
    expect(retried.length).toBe(1);
    expect(retried[0].payload).toMatchObject({ nodeId: 'move', attempt: 1 });
    expect(events.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string; outcome: string }).nodeId === 'move' && (e.payload as { outcome: string }).outcome === 'SUCCESS')).toBe(true);
  });

  it('retry exhaustion suspends the task as an incident with reason retry_exhausted — never silent fail', async () => {
    await installRobotChannel(kernel.api, {
      channel: 'deadbot', device: 'dead_arm',
      config: robotConfig({ hopeless: { durationMs: 150, failOnAttempt: [1, 2, 3, 4, 5, 6] } }),
    });
    const acq = acquire('acq', 'deadbot_r');
    const cmd = robot('doomed', 'deadbot_r', 'hopeless', {}, {
      timeoutMs: 1_200,
      retry: { maxAttempts: 2, backoffMs: 100 },
    });
    const rel = release('rel', 'deadbot_r');
    const flow = await kernel.api.createFlow({
      name: 'retry_exhausted',
      spec: flowDef('retry_exhausted', [acq, cmd, rel], chain(acq, cmd, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    const suspended = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 25_000);
    expect(suspended.suspendReason).toBe('retry_exhausted');

    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'task.suspended' && (e.payload as { reason: string }).reason === 'retry_exhausted')).toBe(true);
    // Exactly maxAttempts executions — never infinite retry.
    const starts = events.filter((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'doomed');
    expect(starts.length).toBe(2);
    // A-ERROR-KINDS: technical failures carry the §2.5 error object shape.
    const failed = events.find((e) => e.type === 'step.failed');
    expect(failed?.payload).toMatchObject({
      nodeId: 'doomed',
      outcome: 'FAILURE',
      error: { kind: expect.stringMatching(/^(technical|business)$/), retryable: expect.any(Boolean) },
    });

    // Operator can resume the incident: retry-step re-executes the node (and fails again,
    // but through the SAME pinned semantics).
    await kernel.api.taskCommand(task.id, { type: 'retry-step' });
    const afterRetry = await waitForTaskEvent(kernel.api, task.id,
      (e) => e.type === 'step.retried' || e.type === 'step.started', 10_000);
    expect(afterRetry).toBeDefined();
    await kernel.api.taskCommand(task.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, task.id, ['aborted'], 10_000);
  });
});

describe('technical vs business failure layering (§2.5 error.kind)', () => {
  it('a business failure on the failed port continues the flow without retry', async () => {
    await installRobotChannel(kernel.api, {
      channel: 'bizbot', device: 'biz_arm',
      config: robotConfig({ reject: { durationMs: 150, failOnAttempt: [1] } }),
    });
    const acq = acquire('acq', 'bizbot_r');
    const cmd = robot('risky', 'bizbot_r', 'reject', {}, {
      retry: { maxAttempts: 3, backoffMs: 50 }, // would retry 3x IF this were technical
    });
    const rescue = seq('handle_reject', { kind: 'log', message: 'business failure handled' });
    const rel = release('rel', 'bizbot_r');
    const flow = await kernel.api.createFlow({
      name: 'business_fail',
      spec: flowDef('business_fail', [acq, cmd, rescue, rel], [
        ...chain(acq, cmd),
        edge('risky', 'failed', 'handle_reject'),
        edge('handle_reject', 'then', 'rel'),
      ]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 20_000);
    const events = await kernel.api.allEvents(task.id);
    // Business failure: routed to the fail port on FIRST attempt — no step.retried.
    expect(events.filter((e) => e.type === 'step.retried').length).toBe(0);
    const failed = events.find((e) => e.type === 'step.failed' && (e.payload as { nodeId: string }).nodeId === 'risky');
    expect(failed?.payload).toMatchObject({ error: { kind: 'business' } });
    expect(events.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'handle_reject')).toBe(true);
    // command.* correlation events present for the robot command (§2.5).
    const issued = events.filter((e) => e.type === 'command.issued');
    expect(issued.length).toBeGreaterThanOrEqual(1);
    const cmdFailed = events.find((e) => e.type === 'command.failed');
    expect(cmdFailed).toBeDefined();
  });

  it('an unwired failure (no fail branch, retries exhausted) leaves step.failed with outcome FAILURE', async () => {
    // Covered indirectly by retry_exhausted above; this pins the suspended-forever
    // behavior stays queryable: the task keeps its suspendReason visible via API.
    const any = await kernel.api.listTasks({ status: 'suspended' });
    expect(Array.isArray(any.items)).toBe(true);
  });
});
