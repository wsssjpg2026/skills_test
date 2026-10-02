// Coverage 11: global system commands endpoint semantics (§2.1 POST /system/commands):
// {type:'pause'|'resume'|'stop'|'abort'} applies the ISA-88 command to ALL running tasks.
// Spec story 24 (全局暂停/恢复/终止按钮); tickets #10/#16.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { acquire, chain, flowDef, installRobotChannel, release, robot, seq } from './support/fixtures.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startKernel();
  await installRobotChannel(kernel.api, {
    channel: 'sysbot', device: 'sys_arm',
    config: { actions: { long_job: { durationMs: 5_000 }, mid_job: { durationMs: 2_500 } } },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

async function longTask(name: string, resource: string, action = 'long_job') {
  const acq = acquire('acq', resource);
  const cmd = robot('job', resource, action, {}, { timeoutMs: 60_000 });
  const rel = release('rel', resource);
  const flow = await kernel.api.createFlow({
    name, spec: flowDef(name, [acq, cmd, rel], chain(acq, cmd, rel)),
  });
  const task = await kernel.api.createTask({ flowId: flow.flowId });
  await waitForTaskStatus(kernel.api, task.id, ['running'], 15_000);
  return task;
}

describe('POST /system/commands (§2.1)', () => {
  it('pause parks every running task; resume lets them all finish', { timeout: 60_000 }, async () => {
    const t1 = await longTask('sys_pause_a', 'sys_r1');
    const t2 = await longTask('sys_pause_b', 'sys_r2', 'mid_job');

    await kernel.api.systemCommand({ type: 'pause' });
    await waitForTaskStatus(kernel.api, t1.id, ['paused'], 15_000);
    await waitForTaskStatus(kernel.api, t2.id, ['paused'], 15_000);

    await kernel.api.systemCommand({ type: 'resume' });
    await waitForTaskStatus(kernel.api, t1.id, ['completed'], 60_000);
    await waitForTaskStatus(kernel.api, t2.id, ['completed'], 60_000);

    for (const t of [t1, t2]) {
      const events = await kernel.api.allEvents(t.id);
      expect(events.some((e) => e.type === 'task.paused')).toBe(true);
      expect(events.some((e) => e.type === 'task.resumed')).toBe(true);
      expect(events.some((e) => e.type === 'task.completed')).toBe(true);
    }
  });

  it('stop is a controlled global wind-down: compensations run, tasks end stopped', { timeout: 60_000 }, async () => {
    const acq = acquire('acq', 'sys_r3');
    const prep = seq('prep', { kind: 'log', message: 'setup' }, {
      compensation: { kind: 'log', message: 'teardown' },
    });
    const cmd = robot('job', 'sys_r3', 'long_job', {}, { timeoutMs: 60_000 });
    const rel = release('rel', 'sys_r3');
    const flow = await kernel.api.createFlow({
      name: 'sys_stop', spec: flowDef('sys_stop', [acq, prep, cmd, rel], chain(acq, prep, cmd, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['running'], 15_000);

    await kernel.api.systemCommand({ type: 'stop' });
    const stopped = await waitForTaskStatus(kernel.api, task.id, ['stopped'], 30_000);
    expect(stopped.status).toBe('stopped');
    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'task.stopped')).toBe(true);
    expect(events.some((e) => e.type === 'compensation.completed' && (e.payload as { nodeId: string }).nodeId === 'prep')).toBe(true);
  });

  it('abort is immediate and global: terminal aborted, NO compensations anywhere', { timeout: 60_000 }, async () => {
    const acq = acquire('acq', 'sys_r4');
    const prep = seq('prep', { kind: 'log', message: 'setup' }, {
      compensation: { kind: 'log', message: 'must not run on abort' },
    });
    const cmd = robot('job', 'sys_r4', 'long_job', {}, { timeoutMs: 60_000 });
    const rel = release('rel', 'sys_r4');
    const flow = await kernel.api.createFlow({
      name: 'sys_abort', spec: flowDef('sys_abort', [acq, prep, cmd, rel], chain(acq, prep, cmd, rel)),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['running'], 15_000);

    await kernel.api.systemCommand({ type: 'abort' });
    const aborted = await waitForTaskStatus(kernel.api, task.id, ['aborted'], 30_000);
    expect(aborted.status).toBe('aborted');
    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'task.aborted')).toBe(true);
    expect(events.filter((e) => e.type.startsWith('compensation.'))).toEqual([]);
    // Terminal — no resume possible.
    await kernel.api.expectError('POST', `/tasks/${task.id}/commands`, { type: 'resume' }, 'TASK_STATE_INVALID', 409);
  });

  it('an invalid command type is VALIDATION_ERROR', async () => {
    await kernel.api.expectError('POST', '/system/commands', { type: 'explode' }, 'VALIDATION_ERROR', 400);
  });

  it('system commands leave no stray locks (§3.5 holder-terminal release)', { timeout: 60_000 }, async () => {
    const t = await longTask('sys_locks', 'sys_r5');
    await kernel.api.systemCommand({ type: 'abort' });
    await waitForTaskStatus(kernel.api, t.id, ['aborted'], 30_000);
    const lock = await kernel.api.resourceLock('sys_r5');
    expect(lock.holder).toBeUndefined();
    expect(lock.waiters).toBe(0);
  });
});
