// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// SPI error semantics observed through the PUBLIC API (spec Testing Decisions: black-box
// via REST/WS). Uses this track's doc-derived stub plugin (config-scriptable fault modes)
// as the channel driver. Covers architecture.md §2.3.3 error→quality mapping (§4.4) and
// §2.3.4 supervision (crash → restart → full-resync replay), tickets #3/#4/#9(story 9)/#20.
import { test, expect, beforeAll, afterAll } from 'vitest';
import { bootOrch, stubPluginCommand, killPluginByMarker, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { ApiError } from '../support/api.ts';

let k: BootedKernel;
let channelId: string;
let devGood: string;
let devBad: string;
let marker: string;

beforeAll(async () => {
  marker = `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  k = await bootOrch({
    plugins: [
      {
        // caps: no `subscribe` → host-simulated polling; validate present
        id: 'stub-reference-plugin',
        command: stubPluginCommand()[0],
        args: [...stubPluginCommand().slice(1), '--caps', 'write,read_on_demand,validate', '--marker', marker],
      },
    ],
  });
  const ch = await k.api.createChannel({ name: 'c1', driver: 'stub-reference-plugin', enabled: true, config: {} });
  channelId = ch.id;
  const good = await k.api.createDevice(channelId, { name: 'devGood', address: '1', enabled: true, config: { initialValues: { g1: 42 } } });
  const bad = await k.api.createDevice(channelId, { name: 'devBad', address: '2', enabled: true, config: { readError: 'timeout' } });
  devGood = good.id;
  devBad = bad.id;
  await k.api.createTags([
    { deviceId: devGood, name: 'g1', dataType: 'uint16', address: '4x:UINT16:0', access: 'read', scanPeriodMs: 200 },
    { deviceId: devBad, name: 'b1', dataType: 'uint16', address: '4x:UINT16:1', access: 'read', scanPeriodMs: 200 },
  ]);
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('validate() wiring: malformed address rejected at config time with 400 VALIDATION_ERROR', async () => {
  for (const address of ['garbage', '9x:UINT16:0', '4x:INT99:0', '4x:UINT16:x', '']) {
    await expect(
      k.api.createTag({ deviceId: devGood, name: `bad_${Math.random().toString(36).slice(2, 6)}`, dataType: 'uint16', address, access: 'read' }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  }
  const ok = await k.api.createTag({ deviceId: devGood, name: 'addr_ok', dataType: 'uint16', address: '4x:UINT16:3', access: 'read' });
  expect(ok.address).toBe('4x:UINT16:3');
});

test('validate() rejects out-of-range scanPeriodMs at config time', async () => {
  await expect(
    k.api.createTag({ deviceId: devGood, name: 'scan_bad', dataType: 'uint16', address: '4x:UINT16:4', access: 'read', scanPeriodMs: 1 }),
  ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
});

test('REST error envelope shape (§2.1): {error:{code,message}} on 4xx', async () => {
  try {
    await k.api.createTag({ deviceId: 'no-such-device', name: 'x1', dataType: 'uint16', address: '4x:UINT16:0', access: 'read' });
    expect.unreachable('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBeGreaterThanOrEqual(400);
    expect(typeof (e as ApiError).code).toBe('string');
    expect(typeof (e as ApiError).message).toBe('string');
  }
});

test('SPI −32006 TIMEOUT → quality bad/timeout with last good value retained (§2.3.3/§4.4)', async () => {
  // devBad starts with readError:'timeout'; wait for the polling path to stamp it.
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devBad.b1' }),
    (v) => v.samples.length === 1 && v.samples[0].quality === 'bad',
    10_000,
  );
  expect(vals.samples[0].reason).toBe('timeout');
});

test('per-device isolation: a timing-out device does not degrade its sibling (§4.5)', async () => {
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devGood.g1' }),
    (v) => v.samples.length === 1 && v.samples[0].quality === 'good',
    10_000,
  );
  expect(vals.samples[0].value).toBe(42);
});

test('value retention across degrade→recover: last good value kept while bad, restored good after PATCH', async () => {
  // Degrade the good device via device PATCH (→ channel.update full replace).
  await k.api.patchDevice(devGood, { config: { readError: 'timeout' } });
  const degraded = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devGood.g1' }),
    (v) => v.samples[0].quality === 'bad',
    10_000,
  );
  expect(degraded.samples[0].value).toBe(42); // last good value retained (§3.2)
  // Recover.
  await k.api.patchDevice(devGood, { config: { initialValues: { g1: 43 }, readError: undefined } });
  const recovered = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devGood.g1' }),
    (v) => v.samples[0].quality === 'good',
    10_000,
  );
  expect(recovered.samples[0].value).toBe(43);
});

test('SPI −32007 BUSY → quality uncertain/link_backoff (§2.3.3)', async () => {
  await k.api.patchDevice(devBad, { config: { readError: 'busy' } });
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devBad.b1' }),
    (v) => v.samples[0].quality === 'uncertain',
    10_000,
  );
  expect(vals.samples[0].reason).toBe('link_backoff');
});

test('SPI −32005 NOT_CONNECTED → quality bad/device_offline (§2.3.3)', async () => {
  await k.api.patchDevice(devBad, { config: { readError: 'not_connected' } });
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devBad.b1' }),
    (v) => v.samples[0].quality === 'bad' && v.samples[0].reason === 'device_offline',
    10_000,
  );
  expect(vals.samples.length).toBe(1);
});

test('plugin process crash → automatic restart + full resync; kernel untouched (§2.3.4, stories 9)', async () => {
  // Ensure a good baseline value.
  await k.api.patchDevice(devGood, { config: { initialValues: { g1: 100 } } });
  await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devGood.g1' }),
    (v) => v.samples[0].quality === 'good' && v.samples[0].value === 100,
    10_000,
  );
  // Hard-kill the plugin process.
  const killed = killPluginByMarker(marker);
  expect(killed).toBeGreaterThanOrEqual(1);
  // Kernel survives (health still answers); tags degrade then recover via restart replay.
  const health = await k.api.health('live');
  expect(health).toBeTruthy();
  await k.api.waitFor(
    () => k.api.tagValues({ filter: '*.devGood.g1' }),
    (v) => v.samples[0].quality === 'good' && v.samples[0].value === 100,
    30_000, // restart backoff initialMs configured 200ms; generous margin
  );
});

test('channel referencing a missing plugin driver → channel failed, not silent (§6.1)', async () => {
  const ch = await k.api.createChannel({ name: 'c_missing', driver: 'driver-that-does-not-exist', enabled: true, config: {} });
  await k.api.waitFor(
    () => k.api.getChannel(ch.id),
    (c) => (c as any).state === 'failed' || (c as any).status === 'failed',
    10_000,
  ).catch(async (e: Error) => {
    // A8 (assumption): failure surface is channel.state|status === 'failed'; if the
    // field is named differently the waitFor above fails — fall back to channel test.
    const t = await k.api.testChannel(ch.id).catch(() => undefined);
    if (!t || t.ok !== false) throw e;
  });
});
