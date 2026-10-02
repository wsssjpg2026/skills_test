// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// MES WebSocket northbound contract (§2.6, ticket #12) against this track's own
// scriptable WS peer implementing the §5.2 sim-mes config contract. The kernel is
// the dialing client (Q5). Asserts: envelope shape, id correlation, timeout→failure
// branch, retry counts, in-flight-on-reconnect policy (non-idempotent →
// NORTHBOUND_DISCONNECTED; idempotent → re-sent with the SAME id + peer dedupe),
// heartbeat, and MES event push → flow trigger binding (A5).
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startMesPeer, type MesPeer } from '../support/peers/mes-peer.ts';
import { mesServiceFlow, delayChainFlow } from '../support/flows.ts';

const MOCK_DRIVER_MAIN = path.join(REPO_ROOT, 'packages/simulators/mock-driver/dist/main.js');

let peer: MesPeer;
let k: BootedKernel;

beforeAll(async () => {
  peer = await startMesPeer({
    responses: {
      reportScan: { payload: { ok: true } },
      getDestination: { payload: { station: 'ST-2' } },
      rejectingOp: { payload: {}, error: { code: 'MES_REJECTED', message: 'order not routable' } },
      slowOp: { payload: { x: 1 }, delayMs: 3_000 }, // in-flight when the socket is cut
      idemOp: { payload: { x: 'ST-2' }, delayMs: 100 },
      neverAnswers: { payload: { x: 1 }, delayMs: 60_000, drop: true },
    },
  });
  k = await bootOrch({
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
    config: (base) => ({
      ...base,
      northbound: {
        mes: { url: peer.url, requestTimeoutMs: 3_000, maxRetries: 2, reconnect: { initialMs: 100, maxMs: 1_000 } },
      },
    }),
  });
  // Kernel dials out and reaches connected state.
  await k.api.waitFor(() => k.api.mesStatus(), (s) => s.state === 'connected', 15_000);
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await peer?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('envelope shape is valid on every kernel message (id/type/op/payload/ts) — peer-side validation clean', async () => {
  const flow = mesServiceFlow('mes-envelope', { op: 'reportScan', responseField: 'ok', payload: { code: 'X' } });
  const f = await k.api.createFlow({ name: 'mes-envelope', spec: flow.spec });
  await k.api.createTask({ flowId: f.flowId });
  await k.api.waitFor(async () => peer.requestsFor('reportScan').length, (n) => n >= 1, 15_000, 100);
  expect(peer.violations).toEqual([]);
  const req = peer.requestsFor('reportScan')[0];
  expect(req.id).toMatch(/^[A-Za-z0-9:_-]+$/);
  expect(req.type).toBe('request');
  expect(req.ts).toBeTruthy();
});

test('id correlation: service.called ↔ service.responded share messageId; response routes the flow branch', async () => {
  const flow = mesServiceFlow('mes-branch', { op: 'getDestination', responseField: 'station' });
  const f = await k.api.createFlow({ name: 'mes-branch', spec: flow.spec });
  const task = await k.api.createTask({ flowId: f.flowId });
  const done = await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 30_000);
  expect(done.status).toBe('completed');
  const events = await k.api.allTaskEvents(task.id);
  const called = events.find((e) => e.type === 'service.called');
  const responded = events.find((e) => e.type === 'service.responded');
  expect(called).toBeTruthy();
  expect(responded).toBeTruthy();
  expect((responded!.payload as any)?.messageId).toBe((called!.payload as any)?.messageId);
  // Branch followed the MES answer (station ST-2 → ok step, not the else step).
  const stepCompleted = events.filter((e) => e.type === 'step.completed').map((e) => (e.payload as any)?.nodeId);
  expect(stepCompleted).toContain(flow.okStepId);
  expect(stepCompleted).not.toContain(flow.failStepId);
});

test('timeout → failure branch; retry counts observed at the peer (node retry × timeoutMs)', async () => {
  // Peer stays silent for this op (drop) — every attempt times out.
  const flow = mesServiceFlow('mes-timeout', {
    op: 'neverAnswers',
    responseField: 'x',
    timeoutMs: 500,
    retry: { maxAttempts: 3, backoffMs: 100 },
  });
  const f = await k.api.createFlow({ name: 'mes-timeout', spec: flow.spec });
  const task = await k.api.createTask({ flowId: f.flowId });
  const done = await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 60_000);
  expect(done.status).toBe('completed'); // completed via the FAILURE branch (onFailure:'branch')
  const events = await k.api.allTaskEvents(task.id);
  const failed = events.find((e) => e.type === 'step.failed' && (e.payload as any)?.nodeId === flow.svcId);
  expect(failed).toBeTruthy();
  expect((failed!.payload as any)?.outcome).toBe('TIMEOUT');
  expect(events.find((e) => e.type === 'service.responded')).toBeFalsy(); // no response ever arrived
  // Exactly 3 attempts: node retry {maxAttempts:3} ≡ config maxRetries:2 + first attempt.
  await k.api.waitFor(() => Promise.resolve(peer.requestsFor('neverAnswers').length), (n) => n >= 3, 15_000, 100);
  expect(peer.requestsFor('neverAnswers').length).toBe(3);
  const stepCompleted = events.filter((e) => e.type === 'step.completed').map((e) => (e.payload as any)?.nodeId);
  expect(stepCompleted).toContain(flow.failStepId);
});

test('scripted MES business error routes the flow to its failure branch', async () => {
  const flow = mesServiceFlow('mes-err', { op: 'rejectingOp', responseField: 'station' });
  const f = await k.api.createFlow({ name: 'mes-err', spec: flow.spec });
  const task = await k.api.createTask({ flowId: f.flowId });
  await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 30_000);
  const events = await k.api.allTaskEvents(task.id);
  const failed = events.find((e) => e.type === 'step.failed' && (e.payload as any)?.nodeId === flow.svcId);
  expect(failed).toBeTruthy();
  expect((failed!.payload as any)?.outcome).toBe('FAILURE');
  expect((failed!.payload as any)?.error?.kind).toBe('business');
});

test('in-flight on reconnect — NON-idempotent fails immediately with NORTHBOUND_DISCONNECTED (no hang)', async () => {
  const flow = mesServiceFlow('mes-inflight-nonidem', {
    op: 'slowOp',
    responseField: 'x',
    timeoutMs: 8_000, // kernel timeout must NOT be what fires — the disconnect does
    retry: { maxAttempts: 1, backoffMs: 100 },
  });
  const f = await k.api.createFlow({ name: 'mes-inflight-nonidem', spec: flow.spec });
  const task = await k.api.createTask({ flowId: f.flowId });
  // Wait until the request is in flight, then cut the socket underneath it.
  await k.api.waitFor(() => Promise.resolve(peer.requestsFor('slowOp').length), (n) => n >= 1, 15_000, 50);
  peer.closeClient();
  const t0 = Date.now();
  const done = await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 30_000);
  expect(Date.now() - t0).toBeLessThan(8_000); // failed on disconnect, not on its own timeout
  const events = await k.api.allTaskEvents(task.id);
  const failed = events.find((e) => e.type === 'step.failed');
  expect(failed).toBeTruthy();
  const errJson = JSON.stringify(failed!.payload ?? {});
  expect(errJson).toContain('NORTHBOUND_DISCONNECTED');
  // Peer saw the request exactly once — no blind re-send of a non-idempotent call.
  expect(peer.requestsFor('slowOp').length).toBe(1);
});

test('in-flight on reconnect — idempotent re-sent with the SAME id; peer dedupes by id (§2.6)', async () => {
  const flow = mesServiceFlow('mes-inflight-idem', {
    op: 'idemOp',
    responseField: 'x',
    idempotent: true,
    timeoutMs: 8_000,
    retry: { maxAttempts: 1, backoffMs: 100 },
  });
  const f = await k.api.createFlow({ name: 'mes-inflight-idem', spec: flow.spec });
  const task = await k.api.createTask({ flowId: f.flowId });
  await k.api.waitFor(() => Promise.resolve(peer.requestsFor('idemOp').length), (n) => n >= 1, 15_000, 50);
  peer.closeClient(); // connection lost mid-flight
  const done = await k.api.waitFor(() => k.api.getTask(task.id), (t) => t.status === 'completed', 30_000);
  const events = await k.api.allTaskEvents(task.id);
  const responded = events.find((e) => e.type === 'service.responded');
  expect(responded).toBeTruthy(); // the re-sent request was answered → step SUCCESS
  const stepCompleted = events.filter((e) => e.type === 'step.completed').map((e) => (e.payload as any)?.nodeId);
  expect(stepCompleted).toContain(flow.okStepId);
  // Same id re-sent exactly: ≥2 receipts, all with the identical id.
  const reqs = peer.requestsFor('idemOp');
  expect(reqs.length).toBeGreaterThanOrEqual(2);
  expect(new Set(reqs.map((r) => r.id)).size).toBe(1);
}, 60_000);

test('MES event push triggers a bound flow with input = payload (A5 ADJUDICATED)', async () => {
  // A5 ruling: flow top-level triggers [{kind:'mes', op}] — an inbound MES
  // type:"event" whose op matches enqueues a task with input = payload.
  const spec = delayChainFlow('mes-trigger-flow', 2, 100);
  spec.triggers = [{ kind: 'mes', op: 'startPick' }];
  const f = await k.api.createFlow({ name: 'mes-trigger-flow', spec });
  const before = (await k.api.listTasks(`?flowId=${f.flowId}`)).total;
  peer.sendEvent('startPick', { order: 'WO-123' });
  const page = await k.api.waitFor(
    async () => await k.api.listTasks(`?flowId=${f.flowId}`),
    (p) => p.total === before + 1,
    15_000,
    200,
  );
  expect(page.items.at(-1)?.input).toEqual({ order: 'WO-123' }); // input = event payload
});

test('heartbeat: kernel pings the MES peer within the 30 s heartbeat interval', async () => {
  const t0 = Date.now();
  await k.api.waitFor(
    () => Promise.resolve(peer.heartbeats.filter((h) => h.at >= t0).length),
    (n) => n >= 1,
    40_000,
    500,
  );
}, 50_000);
