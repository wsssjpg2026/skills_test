// Coverage 5f: resource mutex (§3.5): acquire/release, FIFO waiters, holder-terminal
// releases, lexicographic multi-acquire (deadlock avoidance). Spec story 28; ticket #13.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { acquire, chain, flowDef, human, release, seq } from './support/fixtures.js';
import { waitUntil } from './support/util.js';

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

/** A flow that acquires `key`, suspends at a human gate (holding the lock), then releases. */
async function holderFlow(key: string, name: string) {
  const acq = acquire('acq', key);
  const gate = human('gate', `holding ${key}`);
  const rel = release('rel', key);
  const flow = await kernel.api.createFlow({
    name, spec: flowDef(name, [acq, gate, rel], chain(acq, gate, rel)),
  });
  return flow;
}

/** A flow that acquires `key`, delays `holdMs` (observable occupancy), releases. */
async function workerFlow(key: string, name: string, holdMs: number, onTimeout?: 'fail' | 'suspend', timeoutMs?: number) {
  const acq = acquire('acq', key, onTimeout, timeoutMs);
  const work = seq('work', { kind: 'delay', ms: holdMs });
  const rel = release('rel', key);
  const flow = await kernel.api.createFlow({
    name, spec: flowDef(name, [acq, work, rel], chain(acq, work, rel)),
  });
  return flow;
}

describe('acquire / release & lock endpoint (§3.5, §2.1 GET /resources/{key}/lock)', () => {
  it('holder is visible; waiters count; release happens on flow completion', async () => {
    const holder = await holderFlow('mutex_vis', 'mutex_vis');
    const h = await kernel.api.createTask({ flowId: holder.flowId });
    await waitForTaskStatus(kernel.api, h.id, ['suspended'], 10_000); // parked at gate, holding lock

    const locked = await kernel.api.resourceLock('mutex_vis');
    expect(locked.holder).toBeDefined();
    expect(locked.holder!.taskId).toBe(h.id);
    expect(locked.waiters).toBe(0);

    const worker = await workerFlow('mutex_vis', 'mutex_vis_worker', 200);
    const w = await kernel.api.createTask({ flowId: worker.flowId });
    await waitUntil(
      async () => (await kernel.api.resourceLock('mutex_vis')).waiters,
      { timeoutMs: 10_000, label: 'waiter to register' },
    ).then((n) => expect(n).toBe(1));

    await kernel.api.taskCommand(h.id, { type: 'continue' });
    await waitForTaskStatus(kernel.api, h.id, ['completed'], 15_000);
    await waitForTaskStatus(kernel.api, w.id, ['completed'], 15_000);
    const free = await waitUntil(
      async () => {
        const info = await kernel.api.resourceLock('mutex_vis');
        return info.holder === undefined ? info : undefined;
      },
      { timeoutMs: 10_000, label: 'lock released after both tasks finished' },
    );
    expect(free.waiters).toBe(0);
  });

  it('resource.acquired / resource.released land in the holding task event history (§2.5)', async () => {
    const worker = await workerFlow('mutex_events', 'mutex_events', 50);
    const t = await kernel.api.createTask({ flowId: worker.flowId });
    await waitForTaskStatus(kernel.api, t.id, ['completed'], 15_000);
    const events = await kernel.api.allEvents(t.id);
    const acquired = events.find((e) => e.type === 'resource.acquired');
    const released = events.find((e) => e.type === 'resource.released');
    expect(acquired?.payload).toMatchObject({ key: 'mutex_events' });
    expect(released?.payload).toMatchObject({ key: 'mutex_events' });
    expect(acquired!.seq).toBeLessThan(released!.seq);
  });
});

describe('FIFO waiters (§3.5 waiters:FIFO<TaskId>)', () => {
  it('waiters acquire in arrival order', async () => {
    const holder = await holderFlow('mutex_fifo', 'fifo_holder');
    const h = await kernel.api.createTask({ flowId: holder.flowId });
    await waitForTaskStatus(kernel.api, h.id, ['suspended'], 10_000);

    const w1 = await workerFlow('mutex_fifo', 'fifo_w1', 600);
    const w2 = await workerFlow('mutex_fifo', 'fifo_w2', 600);
    const t1 = await kernel.api.createTask({ flowId: w1.flowId });
    const t2 = await kernel.api.createTask({ flowId: w2.flowId });
    await waitUntil(
      async () => ((await kernel.api.resourceLock('mutex_fifo')).waiters === 2 ? true : undefined),
      { timeoutMs: 15_000, label: 'both waiters registered' },
    );

    await kernel.api.taskCommand(h.id, { type: 'continue' });

    // Sample holder identity over time: after the holder leaves, W1 must own it before W2.
    const holders: string[] = [];
    const sampler = (async () => {
      while (holders.length < 400) {
        const info = await kernel.api.resourceLock('mutex_fifo').catch(() => undefined);
        if (info?.holder && !holders.includes(info.holder.taskId)) holders.push(info.holder.taskId);
        if (info && info.holder === undefined && holders.includes(t2.id)) break;
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
    await waitForTaskStatus(kernel.api, t1.id, ['completed'], 25_000);
    await waitForTaskStatus(kernel.api, t2.id, ['completed'], 25_000);
    await Promise.race([sampler, new Promise((r) => setTimeout(r, 2_000))]);
    const order = holders.filter((id) => id === t1.id || id === t2.id);
    expect(order).toEqual([t1.id, t2.id]);
  });
});

describe('holder reaching a terminal state releases its locks (§3.5)', () => {
  it('an aborted holder frees the resource; a waiter proceeds', async () => {
    const holder = await holderFlow('mutex_abort', 'abort_holder');
    const h = await kernel.api.createTask({ flowId: holder.flowId });
    await waitForTaskStatus(kernel.api, h.id, ['suspended'], 10_000);

    const worker = await workerFlow('mutex_abort', 'abort_worker', 100);
    const w = await kernel.api.createTask({ flowId: worker.flowId });
    await waitUntil(
      async () => ((await kernel.api.resourceLock('mutex_abort')).waiters === 1 ? true : undefined),
      { timeoutMs: 10_000, label: 'waiter registered' },
    );

    await kernel.api.taskCommand(h.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, h.id, ['aborted'], 10_000);
    await waitForTaskStatus(kernel.api, w.id, ['completed'], 20_000); // lock was freed
    expect((await kernel.api.resourceLock('mutex_abort')).holder).toBeUndefined();
  });
});

describe('acquire timeout policy (§2.4 resource-acquire onTimeout)', () => {
  it('onTimeout fail → resource.waitTimeout event and task failed', async () => {
    const holder = await holderFlow('mutex_t1', 't1_holder');
    const h = await kernel.api.createTask({ flowId: holder.flowId });
    await waitForTaskStatus(kernel.api, h.id, ['suspended'], 10_000);

    const worker = await workerFlow('mutex_t1', 't1_worker_fail', 50, 'fail', 800);
    const w = await kernel.api.createTask({ flowId: worker.flowId });
    const done = await waitForTaskStatus(kernel.api, w.id, ['failed'], 15_000);
    expect(done.status).toBe('failed');
    const events = await kernel.api.allEvents(w.id);
    const waitTimeout = events.find((e) => e.type === 'resource.waitTimeout');
    expect(waitTimeout?.payload).toMatchObject({ key: 'mutex_t1' });

    await kernel.api.taskCommand(h.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, h.id, ['aborted'], 10_000);
  });

  it('onTimeout suspend → task suspended with reason resource_timeout (§2.5)', async () => {
    const holder = await holderFlow('mutex_t2', 't2_holder');
    const h = await kernel.api.createTask({ flowId: holder.flowId });
    await waitForTaskStatus(kernel.api, h.id, ['suspended'], 10_000);

    const worker = await workerFlow('mutex_t2', 't2_worker_suspend', 50, 'suspend', 800);
    const w = await kernel.api.createTask({ flowId: worker.flowId });
    const done = await waitForTaskStatus(kernel.api, w.id, ['suspended'], 15_000);
    expect(done.suspendReason).toBe('resource_timeout');

    await kernel.api.taskCommand(h.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, h.id, ['aborted'], 10_000);
    await kernel.api.taskCommand(w.id, { type: 'abort' });
    await waitForTaskStatus(kernel.api, w.id, ['aborted'], 10_000);
  });
});

describe('lexicographic multi-acquire (§3.5 deadlock avoidance)', () => {
  it('two tasks acquiring the same two resources in OPPOSITE orders both complete', async () => {
    // Task A: res-x → res-y. Task B: res-y → res-x. Without lock-order normalization
    // these deadlock; §3.5 says multi-acquire normalizes to lexicographic key order.
    const buildOrder = async (name: string, first: string, second: string) => {
      const a1 = acquire('a1', first);
      const mid = seq('mid', { kind: 'delay', ms: 300 }); // hold first while wanting second
      const a2 = acquire('a2', second);
      const work = seq('work', { kind: 'log', message: name });
      const r2 = release('r2', second);
      const r1 = release('r1', first);
      return kernel.api.createFlow({
        name, spec: flowDef(name, [a1, mid, a2, work, r2, r1], chain(a1, mid, a2, work, r2, r1)),
      });
    };
    const flowXFirst = await buildOrder('deadlock_x_first', 'mutex-x', 'mutex-y');
    const flowYFirst = await buildOrder('deadlock_y_first', 'mutex-y', 'mutex-x');
    const ta = await kernel.api.createTask({ flowId: flowXFirst.flowId });
    const tb = await kernel.api.createTask({ flowId: flowYFirst.flowId });
    await waitForTaskStatus(kernel.api, ta.id, ['completed'], 25_000);
    await waitForTaskStatus(kernel.api, tb.id, ['completed'], 25_000);
    expect((await kernel.api.resourceLock('mutex-x')).holder).toBeUndefined();
    expect((await kernel.api.resourceLock('mutex-y')).holder).toBeUndefined();
  });
});
