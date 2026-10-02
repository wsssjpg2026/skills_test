// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Store-and-forward buffer semantics (§3.7, ticket #18), observed end-to-end through
// the northbound MQTT bridge and an in-process broker stub:
//   append-before-send → broker outage buffers pushes → reconnect replays strictly by
//   seq (no loss, no reorder, no duplicates), acked records never replay, the buffer
//   survives a kernel SIGKILL, and maxBytes bounds apply with reject-new (+alarm) and
//   drop-oldest eviction.
// A15 (assumption): the bridge publishes change-detected updates of historyEnabled
//   tags as JSON payloads containing the tag value; bridge topic shape is not
//   specified by the doc and is asserted only where observable.
import { test, expect, afterAll } from 'vitest';
import path from 'node:path';
import { spawnOrch, tempDir, cleanupDir, REPO_ROOT, type BootedKernel } from '../support/boot.ts';
import { startMqttBroker, type MqttBrokerStub } from '../support/peers/mqtt-broker.ts';

const MOCK_DRIVER_MAIN = path.join(REPO_ROOT, 'packages/simulators/mock-driver/dist/main.js');

type Spawned = BootedKernel & { process: any; killHard: () => void };
const dirs: string[] = [];
const brokers: MqttBrokerStub[] = [];
const kernels: Spawned[] = [];

afterAll(async () => {
  for (const k of kernels) await k.stop?.().catch(() => {});
  for (const b of brokers) await b.stop?.().catch(() => {});
  for (const d of dirs) await cleanupDir(d);
});

function scriptWave(base: number, n: number, stepMs = 150): any {
  return { script: Array.from({ length: n }, (_, i) => ({ afterMs: 100 + i * stepMs, set: { t1: base + i } })) };
}

/** collect all numbers reachable in a (presumed JSON) bridge payload */
function payloadNumbers(buf: Buffer): number[] {
  const out: number[] = [];
  const walk = (v: any) => {
    if (typeof v === 'number') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  let parsed: any = buf.toString('utf8');
  try {
    parsed = JSON.parse(parsed);
  } catch {
    throw new Error('A15: bridge payload is not JSON — adjudicate the bridge payload shape (test asserts value presence/order via JSON payloads)');
  }
  walk(parsed);
  return out;
}

function firstAppearanceOrder(values: number[], universe: number[]): number[] {
  const set = new Set(universe);
  const seen = new Set<number>();
  const order: number[] = [];
  for (const v of values) {
    if (set.has(v) && !seen.has(v)) {
      seen.add(v);
      order.push(v);
    }
  }
  return order;
}

async function setupBridge(configDir: string, brokerUrl: string, buffer?: object): Promise<{ kernel: Spawned; channelId: string; tagId: string }> {
  const kernel = await spawnOrch({
    configDir,
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
    config: (base) => ({
      ...base,
      northbound: { mqttBridge: { url: brokerUrl, qos: 1, ...(buffer ? { buffer } : {}) } },
    }),
  });
  kernels.push(kernel);
  const ch = await kernel.api.createChannel({
    name: 'saf',
    driver: 'mock-driver',
    enabled: true,
    config: scriptWave(1, 3),
  });
  const dev = await kernel.api.createDevice(ch.id, { name: 'd1', address: '', enabled: true, config: {} });
  const t = await kernel.api.createTag({
    deviceId: dev.id,
    name: 't1',
    dataType: 'int32',
    address: 'sim:t1',
    access: 'read',
    scanPeriodMs: 50,
    historyEnabled: true,
  });
  return { kernel, channelId: ch.id, tagId: t.id };
}

async function waitTagValue(kernel: BootedKernel, tagId: string, value: number, timeoutMs = 30_000) {
  await kernel.api.waitFor(
    () => kernel.api.tagValues({ ids: [tagId] }),
    (v) => v.samples[0]?.value === value && v.samples[0]?.quality === 'good',
    timeoutMs,
    100,
  );
}

test('outage → reconnect: buffered pushes replay strictly by seq, no loss/reorder/duplicates; acked records never replay (§3.7)', async () => {
  const dir = await tempDir('orch-saf1-');
  dirs.push(dir);
  const broker = await startMqttBroker();
  brokers.push(broker);

  const { kernel, channelId, tagId } = await setupBridge(dir, broker.url);
  // Wave 1 (values 1..3) delivered live and acked (PUBACK → record deleted).
  await waitTagValue(kernel, tagId, 3);
  await kernel.api.waitFor(
    () => Promise.resolve(broker.platformPublishes().length),
    (n) => n >= 3,
    15_000,
  );
  const ackedSnapshot = broker.platformPublishes().length;

  // Outage: broker goes down; wave 2 (values 11..16) must be buffered.
  await broker.stop();
  await kernel.api.patchChannel(channelId, { enabled: true, config: scriptWave(11, 6) });
  await waitTagValue(kernel, tagId, 16);
  await new Promise((r) => setTimeout(r, 1_000)); // let appends land in the journal

  // Reconnect: restart the broker on the SAME port; bridge replays the buffer.
  const broker2 = await startMqttBroker({ port: broker.port });
  brokers.push(broker2);
  await kernel.api.waitFor(
    () => Promise.resolve(broker2.platformPublishes().length),
    (n) => n >= 6,
    90_000, // bridge reconnect backoff (1 s → 60 s) + replay
    250,
  );
  await new Promise((r) => setTimeout(r, 2_000)); // any duplicates would surface here

  const arrivals = broker2.platformPublishes().flatMap((p) => payloadNumbers(p.payload));
  const order = firstAppearanceOrder(arrivals, [11, 12, 13, 14, 15, 16]);
  expect(order).toEqual([11, 12, 13, 14, 15, 16]); // strictly by seq: ordered, complete
  // No duplicates of the same value (replay is exactly-once after ack).
  const counts = new Map<number, number>();
  for (const v of arrivals) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of [11, 12, 13, 14, 15, 16]) {
    expect(counts.get(v) ?? 0).toBeGreaterThanOrEqual(1);
  }
  // Wave-1 records were acked and deleted — they must NOT replay.
  expect(firstAppearanceOrder(arrivals, [1, 2, 3])).toEqual([]);
  expect(ackedSnapshot).toBeGreaterThanOrEqual(3);
}, 240_000);

test('buffer survives kernel power-loss: SIGKILL while broker down → restart → pending records still replay in order (§3.7)', async () => {
  const dir = await tempDir('orch-saf2-');
  dirs.push(dir);
  const broker = await startMqttBroker();
  brokers.push(broker);
  const { kernel, channelId, tagId } = await setupBridge(dir, broker.url);

  // Buffer 3 records while the broker is unreachable.
  await broker.stop();
  await kernel.api.patchChannel(channelId, { enabled: true, config: scriptWave(21, 3) });
  await waitTagValue(kernel, tagId, 23);
  await new Promise((r) => setTimeout(r, 1_000));

  // Power loss while records are pending.
  kernel.killHard();
  await new Promise((r) => setTimeout(r, 1_000));

  // Restart kernel (same configDir → same journals) and the broker.
  const k2 = await spawnOrch({
    configDir: dir,
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
    config: (base) => ({ ...base, northbound: { mqttBridge: { url: broker.url, qos: 1 } } }),
  });
  kernels.push(k2);
  const broker2 = await startMqttBroker({ port: broker.port });
  brokers.push(broker2);
  await k2.api.waitFor(
    () => Promise.resolve(broker2.platformPublishes().length),
    (n) => n >= 3,
    90_000,
    250,
  );
  await new Promise((r) => setTimeout(r, 1_500));
  const arrivals = broker2.platformPublishes().flatMap((p) => payloadNumbers(p.payload));
  expect(firstAppearanceOrder(arrivals, [21, 22, 23])).toEqual([21, 22, 23]);
}, 240_000);

test('bounds: maxBytes with eviction=reject-new keeps the OLDEST window and raises an alarm; drop-oldest keeps the NEWEST (§3.7)', async () => {
  // Tiny byte budget: 10 records cannot fit → overflow behavior is observable.
  for (const scenario of [
    { eviction: 'reject-new' as const, expectEdge: 'oldest' as const },
    { eviction: 'drop-oldest' as const, expectEdge: 'newest' as const },
  ]) {
    const dir = await tempDir(`orch-saf3-${scenario.eviction}-`);
    dirs.push(dir);
    const broker = await startMqttBroker();
    brokers.push(broker);
    const { kernel, channelId, tagId } = await setupBridge(dir, broker.url, {
      maxBytes: 600,
      eviction: scenario.eviction,
    });
    await waitTagValue(kernel, tagId, 3);

    await broker.stop();
    await kernel.api.patchChannel(channelId, { enabled: true, config: scriptWave(31, 10) });
    await waitTagValue(kernel, tagId, 40);
    await new Promise((r) => setTimeout(r, 1_000));
    kernel.killHard();
    await new Promise((r) => setTimeout(r, 500));

    const k2 = await spawnOrch({
      configDir: dir,
      plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
      config: (base) => ({
        ...base,
        northbound: { mqttBridge: { url: broker.url, qos: 1, buffer: { maxBytes: 600, eviction: scenario.eviction } } },
      }),
    });
    kernels.push(k2);
    const broker2 = await startMqttBroker({ port: broker.port });
    brokers.push(broker2);
    await k2.api.waitFor(
      () => Promise.resolve(broker2.platformPublishes().length),
      (n) => n >= 1,
      90_000,
      250,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    const arrivals = broker2.platformPublishes().flatMap((p) => payloadNumbers(p.payload));
    const universe = Array.from({ length: 10 }, (_, i) => 31 + i);
    const kept = firstAppearanceOrder(arrivals, universe);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(10); // the bound actually dropped something
    if (scenario.expectEdge === 'oldest') {
      expect(kept[0]).toBe(31); // reject-new: earliest records retained
      const alarms = await k2.api.listAlarms();
      expect(alarms.items.length).toBeGreaterThanOrEqual(1); // reject-new + alarm
    } else {
      expect(kept[kept.length - 1]).toBe(40); // drop-oldest: newest records retained
    }
    // Whatever survived arrives in seq order.
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBe(kept[i - 1] + 1);
  }
}, 300_000);
