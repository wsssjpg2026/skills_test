// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// HTTP driver via public API against a stub REST device (ticket #8): period polling per
// scan group, JSON path → tag mapping, and degraded behavior on HTTP faults with
// last-good-value retention.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startHttpDevice, type HttpDeviceStub } from '../support/peers/http-device.ts';
import { TagsWsClient } from '../support/api.ts';

// A13 (assumption): driver dist entry per repo layout §1; channel config
// { baseUrl, path } and tag address = JSON path ('$.a.b' / '$.a[0]').
const HTTP_MAIN = path.join(REPO_ROOT, 'packages/drivers/http/dist/main.js');
const SCAN_MS = 300;

let stub: HttpDeviceStub;
let k: BootedKernel;
let channelId: string;
let deviceId: string;
let tTemp: string;
let tDoor: string;
let tPart: string;

beforeAll(async () => {
  stub = await startHttpDevice();
  stub.setJson('/status', {
    payload: { temperature: 21.5, door: 'closed', parts: [7, 8, 9] },
  });
  k = await bootOrch({
    plugins: [{ id: 'driver-http', command: process.execPath, args: [HTTP_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'http',
    driver: 'driver-http',
    enabled: true,
    config: { baseUrl: stub.baseUrl, path: '/status', method: 'GET' },
  });
  channelId = ch.id;
  const dev = await k.api.createDevice(ch.id, { name: 'restdev', address: '/status', enabled: true, config: {} });
  deviceId = dev.id;
  tTemp = (await k.api.createTag({ deviceId, name: 'temperature', dataType: 'float64', address: '$.payload.temperature', access: 'read', scanPeriodMs: SCAN_MS })).id;
  tDoor = (await k.api.createTag({ deviceId, name: 'door', dataType: 'string', address: '$.payload.door', access: 'read', scanPeriodMs: SCAN_MS })).id;
  tPart = (await k.api.createTag({ deviceId, name: 'part0', dataType: 'int32', address: '$.payload.parts[0]', access: 'read', scanPeriodMs: SCAN_MS })).id;
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await stub?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('JSON path → tag mapping: nested fields and array elements map to typed tag values', async () => {
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp, tDoor, tPart] }),
    (v) => v.samples.length === 3 && v.samples.every((s) => s.quality === 'good'),
    15_000,
  );
  const by = new Map(vals.samples.map((s: any) => [s.tagId, s.value]));
  expect(by.get(tTemp)).toBe(21.5);
  expect(by.get(tDoor)).toBe('closed');
  expect(by.get(tPart)).toBe(7);
});

test('period polling: response changes are picked up within ~2 scan periods', async () => {
  stub.setJson('/status', { payload: { temperature: 30.25, door: 'open', parts: [7, 8, 9] } });
  const t0 = Date.now();
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp, tDoor] }),
    (v) => v.samples.find((s: any) => s.tagId === tTemp)?.value === 30.25,
    2 * SCAN_MS + 3_000,
  );
  expect(Date.now() - t0).toBeLessThan(2 * SCAN_MS + 3_000);
  const by = new Map(vals.samples.map((s: any) => [s.tagId, s.value]));
  expect(by.get(tDoor)).toBe('open');
});

test('polling cadence: requests actually arrive at (at least) the configured period', async () => {
  const before = stub.requestCount('/status');
  await new Promise((r) => setTimeout(r, 3 * SCAN_MS + 400));
  const after = stub.requestCount('/status');
  expect(after - before).toBeGreaterThanOrEqual(3); // ~3 polls in 3 periods
  expect(after - before).toBeLessThanOrEqual(20); // but not a hot loop
});

test('change-detected WS push: only changed values are pushed (§2.2 same stream as history)', async () => {
  const ws = new TagsWsClient();
  await ws.connect(k.baseUrl, k.token);
  try {
    await ws.subscribe(['*.restdev.temperature']);
    stub.setJson('/status', { payload: { temperature: 44.75, door: 'open', parts: [7, 8, 9] } });
    const upd = await ws.waitForUpdate((u) => u.topic?.endsWith('.temperature') && u.value === 44.75, 5_000);
    expect(upd.quality).toBe('good');
  } finally {
    ws.close();
  }
});

test('HTTP fault → quality degrades (not good) with last good value retained; recovers on 200', async () => {
  stub.setFault('/status', 500);
  const degraded = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp] }),
    (v) => v.samples[0]?.quality !== 'good',
    3 * SCAN_MS + 5_000,
  );
  expect(degraded.samples[0].value).toBe(44.75); // last good retained
  stub.clearFault('/status');
  stub.setJson('/status', { payload: { temperature: 51.0, door: 'open', parts: [7, 8, 9] } });
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0]?.value === 51.0,
    3 * SCAN_MS + 5_000,
  );
});

test('channel config validation: missing baseUrl rejected at config time', async () => {
  await expect(
    k.api.createChannel({ name: 'http_bad', driver: 'driver-http', enabled: true, config: { path: '/x' } }),
  ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
});
