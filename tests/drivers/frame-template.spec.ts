// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Frame-template driver (ticket #7) — config-only parsing of a private TCP protocol:
// start delimiter / length field / checksum / escape are all described by channel
// CONFIG (no code). Bad-checksum and truncated frames are discarded and counted
// WITHOUT disconnecting. The frame grammar is assumption A6 (doc gives the feature
// set, not the config schema); fixtures live in support/peers/frame-device.ts.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startFrameDevice, frameFixture, buildFrame, buildBadChecksumFrame, buildTruncatedFrame, type FrameDeviceStub } from '../support/peers/frame-device.ts';

// A6/A9: driver dist entry per repo layout §1; channel config = template fixture;
// tag address maps payload byte offsets: 'u16@<off>' | 'u8@<off>'.
const FRAME_MAIN = path.join(REPO_ROOT, 'packages/drivers/frame-template/dist/main.js');

let stub: FrameDeviceStub;
let k: BootedKernel;
let channelId: string;
let deviceId: string;
let tTemp: string;
let tPress: string;
let tState: string;

beforeAll(async () => {
  stub = await startFrameDevice();
  k = await bootOrch({
    plugins: [{ id: 'driver-frametemplate', command: process.execPath, args: [FRAME_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'frame',
    driver: 'driver-frametemplate',
    enabled: true,
    config: { ...frameFixture(), host: '127.0.0.1', port: stub.port },
  });
  channelId = ch.id;
  const dev = await k.api.createDevice(ch.id, { name: 'privdev', address: '', enabled: true, config: {} });
  deviceId = dev.id;
  tTemp = (await k.api.createTag({ deviceId, name: 'temp', dataType: 'uint16', address: 'u16@0', access: 'read', scanPeriodMs: 1_000 })).id;
  tPress = (await k.api.createTag({ deviceId, name: 'pressure', dataType: 'uint16', address: 'u16@2', access: 'read', scanPeriodMs: 1_000 })).id;
  tState = (await k.api.createTag({ deviceId, name: 'state', dataType: 'uint16', address: 'u8@4', access: 'read', scanPeriodMs: 1_000 })).id;
  // Wait for the driver to connect to the device.
  await new Promise((r) => setTimeout(r, 1_500));
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await stub?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('config-only parse: good frames update tags (start delimiter + length + crc16 checks pass)', async () => {
  stub.send(buildFrame(250, 1013, 1));
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp, tPress, tState] }),
    (v) => v.samples.length === 3 &&
      v.samples.find((s: any) => s.tagId === tTemp)?.value === 250 &&
      v.samples.find((s: any) => s.tagId === tPress)?.value === 1013 &&
      v.samples.find((s: any) => s.tagId === tState)?.value === 1,
    10_000,
  );
  expect(vals.samples.every((s) => s.quality === 'good')).toBe(true);
});

test('frame stream continues: subsequent frames update values', async () => {
  stub.send(buildFrame(251, 1014, 2));
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp, tState] }),
    (v) => v.samples.find((s: any) => s.tagId === tTemp)?.value === 251 &&
      v.samples.find((s: any) => s.tagId === tState)?.value === 2,
    10_000,
  );
});

test('bad-checksum and truncated frames are discarded WITHOUT disconnect (ticket #7 AC)', async () => {
  const connectsBefore = stub.connectedCount();
  const disconnectsBefore = stub.connectionEvents.filter((e) => e === 'disconnect').length;
  // Interleave: bad, good, truncated, bad, good — only good frames may move values.
  stub.send(
    buildBadChecksumFrame(999, 1, 1),
    buildFrame(300, 2000, 3),
    buildTruncatedFrame(),
    buildBadChecksumFrame(888, 2, 2),
    buildFrame(301, 2001, 4),
  );
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp] }),
    (v) => v.samples[0]?.value === 301,
    10_000,
  );
  // The bad frames' values (999/888) must never appear — they were discarded.
  expect([999, 888]).not.toContain(vals.samples[0].value);
  // No reconnect happened: the same connection stayed up.
  const disconnectsAfter = stub.connectionEvents.filter((e) => e === 'disconnect').length;
  expect(disconnectsAfter).toBe(disconnectsBefore);
  expect(stub.connectedCount()).toBeGreaterThanOrEqual(connectsBefore);
  // Continues healthy afterwards.
  stub.send(buildFrame(302, 2002, 5));
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp] }),
    (v) => v.samples[0]?.value === 302,
    10_000,
  );
});

test('A14 (assumption-soft): if the channel object exposes a bad-frame counter, it counts the discards', async () => {
  // The doc requires "校验错误的帧被丢弃并计数" (discarded AND counted) but does not
  // specify the observation surface. If any counter-ish field is exposed on the
  // channel or its diagnostics, assert it is positive; else this stays soft and the
  // surface needs adjudication (see test-map A14).
  const ch: any = await k.api.getChannel(channelId);
  const counters = Object.entries(ch ?? {})
    .filter(([key, v]) => /discard|bad.?frame|frame.?error|crc/i.test(key) && typeof v === 'number')
    .map(([, v]) => v as number);
  if (counters.length > 0) {
    for (const c of counters) expect(c).toBeGreaterThan(0);
  }
  const test = await k.api.testChannel(channelId, 10_000);
  expect(test.ok).toBe(true); // channel still healthy after bad frames
});
