// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// MQTT + Sparkplug B driver via public API (ticket #8, §4.5, Q8 consumer/host role only):
// DBIRTH→device online, DDEATH/LWT→device offline in the tag model; other devices
// unaffected; and the platform itself NEVER publishes Sparkplug (no edge-node emulation).
// Sparkplug NBIRTH/NDEATH of the *edge node* (which carry the LWT semantics for all its
// devices per the Sparkplug spec) are exercised via the node-level birth/death topics.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startMqttBroker, connectEdgeNode, type MqttBrokerStub, type EdgeNodeHandle } from '../support/peers/mqtt-broker.ts';

// A12 (assumption): driver dist entry per repo layout §1; channel config grammar
// { url, sparkplug: { group } } and tag address = 'sp/<deviceId>/<metricName>'.
// Device name is matched against the Sparkplug device id in DBIRTH topics.
const MQTT_MAIN = path.join(REPO_ROOT, 'packages/drivers/mqtt/dist/main.js');
const GROUP = 'orchline';
const EDGE = 'edge01';

let broker: MqttBrokerStub;
let edge: EdgeNodeHandle;
let k: BootedKernel;
let channelId: string;
let devA: string;
let devB: string;
let tagA: string;
let tagB: string;

beforeAll(async () => {
  broker = await startMqttBroker();
  edge = await connectEdgeNode(broker.url, GROUP, EDGE);
  k = await bootOrch({
    plugins: [{ id: 'driver-mqtt', command: process.execPath, args: [MQTT_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'mq',
    driver: 'driver-mqtt',
    enabled: true,
    config: { url: broker.url, sparkplug: { group: GROUP } },
  });
  channelId = ch.id;
  const a = await k.api.createDevice(channelId, { name: 'robotA', address: EDGE, enabled: true, config: {} });
  const b = await k.api.createDevice(channelId, { name: 'scannerB', address: EDGE, enabled: true, config: {} });
  devA = a.id;
  devB = b.id;
  const tA = await k.api.createTag({ deviceId: devA, name: 'speed', dataType: 'float64', address: 'sp/robotA/speed', access: 'read', scanPeriodMs: 1_000 });
  const tB = await k.api.createTag({ deviceId: devB, name: 'code', dataType: 'string', address: 'sp/scannerB/code', access: 'read', scanPeriodMs: 1_000 });
  tagA = tA.id;
  tagB = tB.id;
}, 60_000);

afterAll(async () => {
  await edge?.end?.();
  await k?.stop?.();
  await broker?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('DBIRTH brings devices online with birth metric values in the tag model', async () => {
  edge.publishBirth('robotA', [
    { name: 'speed', type: 'double', value: 1.25 },
  ]);
  edge.publishBirth('scannerB', [
    { name: 'code', type: 'string', value: 'SN-0042' },
  ]);
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA, tagB] }),
    (v) => v.samples.length === 2 && v.samples.every((s) => s.quality === 'good'),
    15_000,
  );
  const by = new Map(vals.samples.map((s: any) => [s.tagId, s.value]));
  expect(by.get(tagA)).toBe(1.25);
  expect(by.get(tagB)).toBe('SN-0042');
});

test('DDATA updates metric values after birth', async () => {
  edge.publishData('robotA', [{ name: 'speed', type: 'double', value: 2.5 }]);
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA] }),
    (v) => v.samples[0]?.value === 2.5,
    5_000,
  );
});

test('DDEATH marks only that device offline: tags bad/device_offline, last good retained, siblings unaffected (§4.5)', async () => {
  edge.publishDeath('scannerB');
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA, tagB] }),
    (v) => v.samples.find((s: any) => s.tagId === tagB)?.quality === 'bad',
    15_000,
  );
  const dead = vals.samples.find((s: any) => s.tagId === tagB)!;
  expect(dead.reason).toBe('device_offline');
  expect(dead.value).toBe('SN-0042'); // last good value retained (§3.2)
  const alive = vals.samples.find((s: any) => s.tagId === tagA)!;
  expect(alive.quality).toBe('good');
  expect(alive.value).toBe(2.5);
});

test('LWT (ungraceful edge-node socket loss) drives devices offline via NDEATH will', async () => {
  // Rebirth first so everything is online again.
  edge.publishBirth('robotA', [{ name: 'speed', type: 'double', value: 3.75 }]);
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0]?.value === 3.75,
    15_000,
  );
  edge.destroySocket(); // no DISCONNECT packet → broker fires the NDEATH will
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA] }),
    (v) => v.samples[0]?.quality === 'bad' && v.samples[0]?.reason === 'device_offline',
    15_000,
  );
  // last good value still retained
  const v = await k.api.tagValues({ ids: [tagA] });
  expect(v.samples[0].value).toBe(3.75);
});

test('recovery: a new edge session (NBIRTH/DBIRTH) brings the device back online', async () => {
  edge = await connectEdgeNode(broker.url, GROUP, EDGE);
  edge.publishBirth('robotA', [{ name: 'speed', type: 'double', value: 4.5 }]);
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagA] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0]?.value === 4.5,
    15_000,
  );
  expect(vals.samples[0].value).toBe(4.5);
});

test('consumer role only: the platform never publishes Sparkplug topics (Q8, no edge-node emulation)', async () => {
  await new Promise((r) => setTimeout(r, 1_500));
  const sparkplugPublishes = broker.platformPublishes().filter((p) => p.topic.startsWith('spBv1.0/'));
  expect(sparkplugPublishes).toEqual([]);
});

test('channel test endpoint reports MQTT connectivity', async () => {
  const res = await k.api.testChannel(channelId, 15_000);
  expect(res.ok).toBe(true);
});
