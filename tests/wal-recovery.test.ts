// Coverage 6: WAL recovery via spawnKernel (§3.4, §5.1). Spec story 22: "任务队列与每步
// 状态先落盘再执行（WAL）,断电/崩溃重启后任务从断点恢复、一个不丢". Ticket #11.
// Write-ahead rule: every state transition is appended (fsync) BEFORE the effect runs.
// Recovery of in-flight commands: re-issue if idempotent / query command.status if the
// capability is present / else suspend with recovery_verify.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnTestKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { waitForHealth } from './support/boot.js';
import { acquire, chain, flowDef, installRobotChannel, release, robot, seq } from './support/fixtures.js';
import { isStrictlyIncreasing, matchEventSubsequence } from './support/util.js';
import type { SpawnHandle } from './support/boot.js';

let kernel: TestKernel & { boot: SpawnHandle };

beforeAll(async () => {
  kernel = await spawnTestKernel({});
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('SIGKILL mid-task → restart → resume from checkpoint (§3.4)', () => {
  it('a task in flight when the process dies resumes and completes after restart', { timeout: 90_000 }, async () => {
    // Robot action long enough to SIGKILL mid-step, short enough for a snappy test.
    await installRobotChannel(kernel.api, {
      channel: 'walloc', device: 'wal_arm',
      config: { actions: { long_job: { durationMs: 4_000 } }, commandStatus: 'queryable' },
    });
    const acq = acquire('acq', 'wal_r');
    const job = robot('job', 'wal_r', 'long_job', {}, { timeoutMs: 60_000 });
    const after = seq('after', { kind: 'log', message: 'survived the crash' });
    const rel = release('rel', 'wal_r');
    const flow = await kernel.api.createFlow({
      name: 'wal_resume', spec: flowDef('wal_resume', [acq, job, after, rel], chain(acq, job, after, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });

    // Wait until the step is provably in flight (step.started observed via API),
    // i.e. the transition is already journaled, then pull the power.
    await waitForTaskStatus(kernel.api, task.id, ['running'], 15_000);
    const eventsBefore = await kernel.api.allEvents(task.id);
    expect(eventsBefore.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'job')).toBe(true);

    await kernel.boot.kill('SIGKILL');
    const handle2 = await kernel.boot.restart();
    await waitForHealth(handle2.baseUrl, 30_000);

    // The same kernel state (configDir/data preserved): the task must NOT be lost.
    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 60_000);
    expect(done.status).toBe('completed');

    const events = await kernel.api.allEvents(task.id);
    // Resume-from-checkpoint, not restart-from-scratch: exactly ONE task.started ever.
    expect(events.filter((e) => e.type === 'task.started').length).toBe(1);
    expect(isStrictlyIncreasing(events.map((e) => e.seq))).toBe(true);
    expect(matchEventSubsequence(events, [
      { type: 'task.enqueued' },
      { type: 'task.started' },
      { type: 'step.started', payloadSub: { nodeId: 'job' } },
      { type: 'step.completed', payloadSub: { nodeId: 'job' } },
      { type: 'task.completed' },
    ]).ok).toBe(true);
    // §3.4 in-flight command recovery with command_status capability: query, not
    // duplicate-complete — at most one command.completed for the commandId.
    const issued = events.filter((e) => e.type === 'command.issued');
    const completed = events.filter((e) => e.type === 'command.completed');
    expect(issued.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBe(1);
  });

  it('tasks completed BEFORE the crash are excluded from replay: no new events, no rerun', { timeout: 90_000 }, async () => {
    const a = seq('quick', { kind: 'log', message: 'done before crash' });
    const flow = await kernel.api.createFlow({ name: 'wal_done', spec: flowDef('wal_done', [a], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 15_000);
    const eventsBefore = (await kernel.api.allEvents(task.id)).length;

    await kernel.boot.kill('SIGKILL');
    const handle2 = await kernel.boot.restart();
    await waitForHealth(handle2.baseUrl, 30_000);

    const after = await kernel.api.getTask(task.id);
    expect(after.status).toBe('completed'); // archived, not resurrected
    const eventsAfter = await kernel.api.allEvents(task.id);
    expect(eventsAfter.length).toBe(eventsBefore); // replay appended nothing
    expect(eventsAfter.filter((e) => e.type === 'task.completed').length).toBe(1);
  });
});

describe('in-flight command recovery policy (§3.4)', () => {
  it('without command_status capability the task suspends with recovery_verify', { timeout: 90_000 }, async () => {
    // Fresh robot channel with NO commandStatus key (A-COMMAND-RECOVERY: capability off).
    await installRobotChannel(kernel.api, {
      channel: 'noverify', device: 'nv_arm',
      config: { actions: { mystery_job: { durationMs: 6_000 } } },
    });
    const acq = acquire('acq', 'nv_r');
    const job = robot('job', 'nv_r', 'mystery_job', {}, { timeoutMs: 60_000 });
    const rel = release('rel', 'nv_r');
    const flow = await kernel.api.createFlow({
      name: 'wal_verify', spec: flowDef('wal_verify', [acq, job, rel], chain(acq, job, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['running'], 15_000);
    await kernel.api.allEvents(task.id).then((ev) =>
      expect(ev.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'job')).toBe(true),
    );

    await kernel.boot.kill('SIGKILL');
    const handle2 = await kernel.boot.restart();
    await waitForHealth(handle2.baseUrl, 30_000);

    const suspended = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 60_000);
    expect(suspended.suspendReason).toBe('recovery_verify');
  });

  it('a task enqueued but not yet started survives the crash and still runs (queue durability)', { timeout: 90_000 }, async () => {
    const a = seq('later', { kind: 'log', message: 'queued across a crash' });
    const flow = await kernel.api.createFlow({ name: 'wal_queue', spec: flowDef('wal_queue', [a], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });

    await kernel.boot.kill('SIGKILL');
    const handle2 = await kernel.boot.restart();
    await waitForHealth(handle2.baseUrl, 30_000);

    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 60_000);
    expect(done.status).toBe('completed'); // "一个不丢"
  });
});
