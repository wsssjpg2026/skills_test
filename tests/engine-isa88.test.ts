// Coverage 5d: ISA-88 commands pause/hold/resume/stop/abort with per-step safeAction
// semantics (§4.2 PINNED definitions — also GLOSSARY material, ticket #16; story 24):
//   Paused  = stop issuing new commands; in-flight step interrupted at its next safe
//             point (its safeAction runs); resume continues the SAME step.
//   Held    = current step runs to completion, then park; resume continues at next step.
//   Stopped = controlled wind-down after current step; registered compensations run.
//   Aborted = immediate safeAction for all active steps, NO compensation, terminal.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskEvent, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { acquire, chain, flowDef, installRobotChannel, release, robot, seq } from './support/fixtures.js';
import { matchEventSubsequence, watchFor } from './support/util.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startKernel();
  // One robot channel reused by every ISA-88 test; distinct resources avoid contention.
  await installRobotChannel(kernel.api, {
    channel: 'isabot',
    device: 'isa_arm',
    config: {
      actions: {
        short_move: { durationMs: 700 },
        long_move: { durationMs: 4_000 },
        doomed: { durationMs: 500, failOnAttempt: [1, 2, 3, 4] },
      },
    },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

async function startedTask(flowName: string, spec: ReturnType<typeof flowDef>): Promise<string> {
  const flow = await kernel.api.createFlow({ name: flowName, spec });
  const task = await kernel.api.createTask({ flowId: flow.flowId });
  await waitForTaskEvent(kernel.api, task.id, (e) => e.type === 'step.started', 10_000);
  return task.id;
}

describe('PAUSE (§4.2: no new commands; in-flight step interrupted at safe point; resume continues SAME step)', () => {
  it('pause → task.paused status & event; resume completes the SAME step (single step.started)', async () => {
    const acq = acquire('acq', 'isa_p1');
    const cmd = robot('step1', 'isa_p1', 'long_move', {}, { safeAction: 'hold' });
    const rel = release('rel', 'isa_p1');
    const taskId = await startedTask('pause_flow', flowDef('pause_flow', [acq, cmd, rel], chain(acq, cmd, rel)));

    await kernel.api.taskCommand(taskId, { type: 'pause' });
    const paused = await waitForTaskStatus(kernel.api, taskId, ['paused'], 10_000);
    expect(paused.status).toBe('paused');

    // While paused, the in-flight step must NOT complete (bounded negative window).
    const completedWhilePaused = await watchFor(
      async () => {
        const ev = await kernel.api.allEvents(taskId);
        return ev.some((e) => e.type === 'step.completed' && (e.payload as { nodeId: string }).nodeId === 'step1');
      },
      1_000,
      100,
    );
    expect(completedWhilePaused).toBeUndefined();

    await kernel.api.taskCommand(taskId, { type: 'resume' });
    await waitForTaskStatus(kernel.api, taskId, ['completed'], 25_000);

    const events = await kernel.api.allEvents(taskId);
    expect(matchEventSubsequence(events, [
      { type: 'task.paused' },
      { type: 'task.resumed' },
      { type: 'step.completed', payloadSub: { nodeId: 'step1' } },
      { type: 'task.completed' },
    ]).ok).toBe(true);
    // Resume continues the SAME step: exactly one step.started for the node.
    expect(events.filter((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'step1').length).toBe(1);
  });

  it('all four safeAction values are accepted by the flow schema', async () => {
    for (const safeAction of ['hold', 'safe_position', 'drain', 'none'] as const) {
      const acq = acquire(`acq_${safeAction}`, `isa_safe_${safeAction}`);
      const cmd = robot(`cmd_${safeAction}`, `isa_safe_${safeAction}`, 'short_move', {}, { safeAction });
      const rel = release(`rel_${safeAction}`, `isa_safe_${safeAction}`);
      const flow = await kernel.api.createFlow({
        name: `safe_${safeAction}`,
        spec: flowDef(`safe_${safeAction}`, [acq, cmd, rel], chain(acq, cmd, rel)),
      });
      expect(flow.version).toBe(1);
    }
  });
});

describe('HOLD (§4.2: current step runs to completion, then park)', () => {
  it('hold mid-step lets the step finish, parks before the next, resume continues', async () => {
    const acq = acquire('acq', 'isa_h1');
    const first = robot('first', 'isa_h1', 'short_move', {});
    const second = robot('second', 'isa_h1', 'short_move', {});
    const rel = release('rel', 'isa_h1');
    const taskId = await startedTask('hold_flow', flowDef('hold_flow', [acq, first, second, rel], chain(acq, first, second, rel)));

    await kernel.api.taskCommand(taskId, { type: 'hold' });
    const held = await waitForTaskStatus(kernel.api, taskId, ['held'], 15_000);
    expect(held.status).toBe('held');

    const events = await kernel.api.allEvents(taskId);
    expect(matchEventSubsequence(events, [
      { type: 'step.completed', payloadSub: { nodeId: 'first' } }, // ran to completion
      { type: 'task.held' },
    ]).ok).toBe(true);
    // Parked BEFORE the next step: no step.started for `second` while held.
    expect(events.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'second')).toBe(false);

    await kernel.api.taskCommand(taskId, { type: 'resume' });
    const done = await waitForTaskStatus(kernel.api, taskId, ['completed'], 25_000);
    expect(done.status).toBe('completed');
    const after = await kernel.api.allEvents(taskId);
    expect(matchEventSubsequence(after, [
      { type: 'task.resumed' },
      { type: 'step.started', payloadSub: { nodeId: 'second' } }, // continues at the NEXT step
      { type: 'task.completed' },
    ]).ok).toBe(true);
  });
});

describe('STOP (§4.2: controlled wind-down; registered compensations run)', () => {
  it('stop runs registered compensations and ends in terminal stopped', async () => {
    const acq = acquire('acq', 'isa_s1');
    const prep = seq('prep', { kind: 'log', message: 'prep' }, {
      compensation: { kind: 'log', message: 'unwind prep' },
    });
    const cmd = robot('work', 'isa_s1', 'long_move', {}, { safeAction: 'drain' });
    const rel = release('rel', 'isa_s1');
    const taskId = await startedTask('stop_flow', flowDef('stop_flow', [acq, prep, cmd, rel], chain(acq, prep, cmd, rel)));

    await kernel.api.taskCommand(taskId, { type: 'stop' });
    const stopped = await waitForTaskStatus(kernel.api, taskId, ['stopped'], 25_000);
    expect(stopped.status).toBe('stopped');

    const events = await kernel.api.allEvents(taskId);
    expect(matchEventSubsequence(events, [
      { type: 'task.stopped' },
    ]).ok).toBe(true);
    expect(events.some((e) => e.type === 'compensation.started' && (e.payload as { nodeId: string }).nodeId === 'prep')).toBe(true);
    expect(events.some((e) => e.type === 'compensation.completed' && (e.payload as { nodeId: string }).nodeId === 'prep')).toBe(true);
  });
});

describe('ABORT (§4.2: immediate safeAction for all active steps, NO compensation, terminal)', () => {
  it('abort skips compensations entirely and is terminal', async () => {
    const acq = acquire('acq', 'isa_a1');
    const prep = seq('prep2', { kind: 'log', message: 'prep' }, {
      compensation: { kind: 'log', message: 'must NOT run' },
    });
    const cmd = robot('work2', 'isa_a1', 'long_move', {}, { safeAction: 'safe_position' });
    const rel = release('rel', 'isa_a1');
    const taskId = await startedTask('abort_flow', flowDef('abort_flow', [acq, prep, cmd, rel], chain(acq, prep, cmd, rel)));

    await kernel.api.taskCommand(taskId, { type: 'abort' });
    const aborted = await waitForTaskStatus(kernel.api, taskId, ['aborted'], 25_000);
    expect(aborted.status).toBe('aborted');

    const events = await kernel.api.allEvents(taskId);
    expect(events.some((e) => e.type === 'task.aborted')).toBe(true);
    // NO compensation on abort — the defining property vs stop.
    expect(events.filter((e) => e.type.startsWith('compensation.')).length).toBe(0);
    // Terminal: no further command accepted.
    await kernel.api.expectError('POST', `/tasks/${taskId}/commands`, { type: 'resume' }, 'TASK_STATE_INVALID', 409);
  });
});

describe('invalid transitions (§2.1 TASK_STATE_INVALID)', () => {
  it('resume on a running (never paused/held) task is rejected', async () => {
    const acq = acquire('acq', 'isa_x1');
    const cmd = robot('busy', 'isa_x1', 'long_move', {});
    const rel = release('rel', 'isa_x1');
    const taskId = await startedTask('running_flow', flowDef('running_flow', [acq, cmd, rel], chain(acq, cmd, rel)));
    await kernel.api.expectError('POST', `/tasks/${taskId}/commands`, { type: 'resume' }, 'TASK_STATE_INVALID', 409);
    await kernel.api.taskCommand(taskId, { type: 'abort' });
    await waitForTaskStatus(kernel.api, taskId, ['aborted'], 10_000);
  });
});
