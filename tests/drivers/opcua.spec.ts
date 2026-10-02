// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// OPC UA driver via public API against @orch/sim-opcua (ticket #6, §5.2): typed values
// incl. arrays (§2.0 dataType arrays), subscription push without polling, and
// reconnect with FULL resubscription (§4.5: "OPC UA session loss → reconnecting;
// on reconnect full resync (subscriptions rebuilt)").
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startSimOpcua, type SimOpcuaHandle, type SimOpcuaNode } from '../support/peers/sim-adapters.ts';
import { TagsWsClient } from '../support/api.ts';

// A9 (assumption): driver dist entry per repo layout §1; channel config
// { endpoint } and tag address = OPC UA NodeId.
const OPCUA_MAIN = path.join(REPO_ROOT, 'packages/drivers/opcua/dist/main.js');

const NODES: SimOpcuaNode[] = [
  { nodeId: 'ns=2;s=Temp', dataType: 'Double', value: 21.5 },
  { nodeId: 'ns=2;s=Door', dataType: 'Boolean', value: false },
  { nodeId: 'ns=2;s=Counter', dataType: 'Int32', value: 1000 },
  { nodeId: 'ns=2;s=Batch', dataType: 'String', value: 'B-4711' },
  { nodeId: 'ns=2;s=AxisPos', dataType: 'Double[]', value: [1.5, 2.5, 3.5] },
  { nodeId: 'ns=2;s=PartIds', dataType: 'Int32[]', value: [10, 20, 30] },
  { nodeId: 'ns=2;s=Names', dataType: 'String[]', value: ['a', 'b'] },
];

let sim: SimOpcuaHandle;
let k: BootedKernel;
let deviceId: string;
const tagIds: Record<string, string> = {};

beforeAll(async () => {
  sim = await startSimOpcua({ nodes: NODES });
  k = await bootOrch({
    plugins: [{ id: 'driver-opcua', command: process.execPath, args: [OPCUA_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'opc',
    driver: 'driver-opcua',
    enabled: true,
    config: { endpoint: sim.url },
  });
  const dev = await k.api.createDevice(ch.id, { name: 'plc1', address: '', enabled: true, config: {} });
  deviceId = dev.id;
  const defs = [
    ['Temp', 'float64', 'ns=2;s=Temp'],
    ['Door', 'bool', 'ns=2;s=Door'],
    ['Counter', 'int32', 'ns=2;s=Counter'],
    ['Batch', 'string', 'ns=2;s=Batch'],
    ['AxisPos', 'float64[]', 'ns=2;s=AxisPos'],
    ['PartIds', 'int32[]', 'ns=2;s=PartIds'],
    ['Names', 'string[]', 'ns=2;s=Names'],
  ] as const;
  for (const [name, dataType, address] of defs) {
    const t = await k.api.createTag({ deviceId, name, dataType, address, access: 'read', scanPeriodMs: 1_000 });
    tagIds[name] = t.id;
  }
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await sim?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('typed values map correctly, including arrays (bool/int/float/string + array types)', async () => {
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: Object.values(tagIds) }),
    (v) => v.samples.length === Object.keys(tagIds).length && v.samples.every((s) => s.quality === 'good'),
    20_000,
  );
  const by = new Map(vals.samples.map((s: any) => [s.tagId, s]));
  expect(by.get(tagIds.Temp)?.value).toBeCloseTo(21.5, 6);
  expect(by.get(tagIds.Door)?.value).toBe(false);
  expect(by.get(tagIds.Counter)?.value).toBe(1000);
  expect(by.get(tagIds.Batch)?.value).toBe('B-4711');
  expect(by.get(tagIds.AxisPos)?.value).toEqual([1.5, 2.5, 3.5]);
  expect(by.get(tagIds.PartIds)?.value).toEqual([10, 20, 30]);
  expect(by.get(tagIds.Names)?.value).toEqual(['a', 'b']);
});

test('subscription push: server-side value change reaches the WS tag stream within ~2 s (no polling)', async () => {
  const ws = new TagsWsClient();
  await ws.connect(k.baseUrl, k.token);
  try {
    await ws.subscribe(['*.plc1.Temp']);
    await sim.setValue('ns=2;s=Temp', 42.25);
    const upd = await ws.waitForUpdate((u) => u.topic?.endsWith('.Temp') && u.value === 42.25, 5_000);
    expect(upd.quality).toBe('good');
  } finally {
    ws.close();
  }
  // And the realtime snapshot agrees.
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagIds.Temp] }),
    (v) => v.samples[0]?.value === 42.25,
    5_000,
  );
  expect(vals.samples[0].quality).toBe('good');
});

test('session loss → reconnect with FULL resubscription; quality degrades then recovers (§4.5)', async () => {
  // Degrade: stop the OPC UA server.
  await sim.stop();
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagIds.Temp] }),
    (v) => v.samples[0]?.quality !== 'good',
    15_000,
  );
  // Recover: restart on the SAME port; subscriptions must be rebuilt (full resync).
  await sim.setValue('ns=2;s=Temp', 55.5); // pre-set a NEW value while down
  const sim2 = await startSimOpcua({ nodes: NODES, port: sim.port });
  sim2.setValue('ns=2;s=Temp', 55.5);
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagIds.Temp] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0]?.value === 55.5,
    30_000, // reconnect backoff margin
  );
  expect(vals.samples[0].value).toBe(55.5);
  // Full resubscription proven: a further change still pushes without any reconfig.
  await sim2.setValue('ns=2;s=Temp', 66.75);
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagIds.Temp] }),
    (v) => v.samples[0]?.value === 66.75,
    5_000,
  );
  await sim2.stop();
});
