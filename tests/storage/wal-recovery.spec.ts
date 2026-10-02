// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Journal durability observed through WAL recovery (§3.4, tickets #11/#22-story22):
// append-before-effect — after SIGKILL mid-run and restart, the task resumes from the
// last checkpoint, the event history shows strictly monotonic per-task seq, no step
// executes twice, and completed tasks are never re-executed on further restarts.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { spawnOrch, tempDir, cleanupDir, REPO_ROOT, type BootedKernel } from '../support/boot.ts';
import { delayChainFlow } from '../support/flows.ts';

const MOCK_DRIVER_MAIN = path.join(REPO_ROOT, 'packages/simulators/mock-driver/dist/main.js');
const STEPS = 8;
const STEP_MS = 400;

let configDir: string;
let kernel: (BootedKernel & { process: any; killHard: () => void }) | null = null;
let flowId: string;

beforeAll(async () => {
  configDir = await tempDir('orch-wal-');
}, 10_000);

afterAll(async () => {
  await kernel?.stop?.().catch(() => {});
  await cleanupDir(configDir);
});

async function startKernel() {
  kernel = await spawnOrch({
    configDir,
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
  });
  return kernel;
}

test('power-loss mid-flow: SIGKILL → restart → task resumes from checkpoint, exactly-once steps, monotonic seq', async () => {
  // Boot 1: deploy flow, enqueue task.
  let k = await startKernel();
  const flow = await k.api.createFlow({ name: 'wal-chain', spec: delayChainFlow('wal-chain', STEPS, STEP_MS) });
  flowId = flow.flowId;
  const task = await k.api.createTask({ flowId });
  expect(task.status).toBe('queued');

  // Wait until at least two steps have STARTED (checkpoint material in the WAL).
  await k.api.waitFor(
    async () => (await k.api.allTaskEvents(task.id)).filter((e) => e.type === 'step.started').length,
    (n) => n >= 2,
    30_000,
    100,
  );

  // Power loss: SIGKILL the kernel process (no graceful flush).
  k.killHard();
  await new Promise((r) => setTimeout(r, 1_000));

  // Boot 2: replay from snapshot + WAL tail; the task must complete.
  k = await startKernel();
  const finalTask = await k.api.waitFor(
    () => k.api.getTask(task.id),
    (t) => t.status === 'completed',
    120_000,
    300,
  );
  expect(finalTask.status).toBe('completed');

  // Journal consistency (append-before-effect observable):
  const events = await k.api.allTaskEvents(task.id);
  expect(events.length).toBeGreaterThan(STEPS); // started+completed per step at minimum
  // seq strictly monotonic (per-task, §2.5).
  for (let i = 1; i < events.length; i++) {
    expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
  }
  // Exactly-once per node across the crash boundary.
  for (let s = 1; s <= STEPS; s++) {
    const nodeId = `n${s}`;
    const started = events.filter((e) => e.type === 'step.started' && (e.payload as any)?.nodeId === nodeId);
    const completed = events.filter((e) => e.type === 'step.completed' && (e.payload as any)?.nodeId === nodeId);
    expect(started.length, `${nodeId} started exactly once`).toBe(1);
    expect(completed.length, `${nodeId} completed exactly once`).toBe(1);
    expect(completed[0].seq).toBeGreaterThan(started[0].seq); // effect only after its record
  }
  // Terminal bookkeeping exactly once.
  expect(events.filter((e) => e.type === 'task.completed').length).toBe(1);
  expect(events.filter((e) => e.type === 'task.started').length).toBe(1);

  // Boot 3: a COMPLETED task must not re-execute on another restart (archive excludes
  // it from replay, §3.4) — event history is unchanged.
  const eventsBefore = events.length;
  k.killHard();
  await new Promise((r) => setTimeout(r, 1_000));
  k = await startKernel();
  await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 30_000);
  await new Promise((r) => setTimeout(r, 2_000)); // give any wrongful re-execution time to misbehave
  const eventsAfter = await k.api.allTaskEvents(task.id);
  expect(eventsAfter.length).toBe(eventsBefore);
  expect((await k.api.getTask(task.id)).status).toBe('completed');
}, 300_000);

test('tasks enqueued but not started before a crash still run after recovery (断电不丢)', async () => {
  const k = await startKernel();
  const flow = await k.api.createFlow({ name: 'wal-queued', spec: delayChainFlow('wal-queued', 3, 200) });
  // Two tasks; the first occupies execution, the second must survive as queued.
  const t1 = await k.api.createTask({ flowId: flow.flowId });
  const t2 = await k.api.createTask({ flowId: flow.flowId });
  await k.api.waitFor(() => k.api.getTask(t1.id), (t) => t.status === 'running' || t.status === 'completed', 30_000);
  k.killHard();
  await new Promise((r) => setTimeout(r, 1_000));
  const k2 = await startKernel();
  for (const t of [t1, t2]) {
    await k2.api.waitFor(() => k2.api.getTask(t.id), (x) => x.status === 'completed', 120_000);
  }
});
