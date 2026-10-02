// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Frame-template driver (ticket #7) — config-only parsing of a private TCP protocol:
// start delimiter / length field / checksum / escape are all described by channel
// CONFIG (no code). Bad-checksum and truncated frames are discarded and counted
// WITHOUT disconnecting. A6 (ADJUDICATED): the fixture grammar in
// support/peers/frame-device.ts is the NORMATIVE sample of the config grammar; A14
// (ADJUDICATED): the discard counter is the reserved system tag
// <channel>.<device>.__bad_frames (uint64, monotonic), visible like any tag.
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
  // Positive wait (no fixed sleep): all three tags are answerable via /tags/values
  // once the driver has connected to the device stub.
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp, tPress, tState] }),
    (v) => v.samples.length === 3 && v.samples.every((s: any) => s.ts),
    15_000,
    200,
  );
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

test('A14 (ADJUDICATED): discards are counted on the reserved system tag <channel>.<device>.__bad_frames', async () => {
  // A14 ruling: each frame-template device gets a reserved system tag
  // frame.privdev.__bad_frames (uint64, monotonically increasing count of discarded
  // frames), visible via /tags/values (and WS/history) like any tag. The driver owns
  // it — tests must not create it, only read it by path.
  const COUNTER_PATH = 'frame.privdev.__bad_frames';
  // Earlier tests discarded 3 frames (2 bad-checksum + 1 truncated): baseline >= 3.
  const baseline = await k.api.waitFor(
    () => k.api.tagValues({ filter: COUNTER_PATH }),
    (v) => v.samples.length >= 1 && typeof v.samples[0].value === 'number' && (v.samples[0].value as number) >= 3,
    15_000,
    200,
  );
  const base = baseline.samples[0].value as number;
  expect(Number.isInteger(base)).toBe(true); // uint64 counter surface

  // Exactly two more discards → counter advances by exactly 2 (monotonic, no drift).
  stub.send(buildBadChecksumFrame(777, 1, 1), buildTruncatedFrame());
  await k.api.waitFor(
    () => k.api.tagValues({ filter: COUNTER_PATH }),
    (v) => (v.samples[0]?.value as number) === base + 2,
    15_000,
    200,
  );

  // Good frames never bump the counter: send a valid frame, counter stays put.
  stub.send(buildFrame(310, 2010, 6));
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tTemp] }),
    (v) => v.samples[0]?.value === 310,
    10_000,
  );
  const counterNow = await k.api.tagValues({ filter: COUNTER_PATH });
  expect(counterNow.samples[0]?.value).toBe(base + 2);

  const test = await k.api.testChannel(channelId, 10_000);
  expect(test.ok).toBe(true); // channel still healthy after bad frames
});
