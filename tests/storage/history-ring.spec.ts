// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Embedded history ring-buffer semantics (§3.1): per-tag bound (default 10 000 samples/tag,
// §3.1/§7-Q2), eviction of OLDEST samples on overflow. Data enters through the public API
// seam: the product @orch/mock-driver script (§5.2 config contract) emits timed value sets.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';

// A9: simulator dist entry per repo layout §1.
const MOCK_DRIVER_MAIN = path.join(REPO_ROOT, 'packages/simulators/mock-driver/dist/main.js');

const TOTAL = 10_050; // exceed the documented default ring bound of 10 000
const BOUND = 10_000;

let k: BootedKernel;
let tagId: string;

function mockScript(n: number): unknown {
  // §5.2: {script:[{afterMs:0,set:{"t1":42}}, ...]} — values are all distinct so
  // every emission is change-detected (no deadband configured).
  return {
    script: Array.from({ length: n }, (_, i) => ({ afterMs: i * 1, set: { t1: i } })),
  };
}

beforeAll(async () => {
  k = await bootOrch({
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'mock',
    driver: 'mock-driver',
    enabled: true,
    config: mockScript(TOTAL) as any,
  });
  const dev = await k.api.createDevice(ch.id, { name: 'd1', address: '', enabled: true, config: {} });
  const t = await k.api.createTag({
    deviceId: dev.id,
    name: 't1',
    dataType: 'int32',
    address: 'sim:t1',
    access: 'read',
    scanPeriodMs: 10,
    historyEnabled: true,
  });
  tagId = t.id;
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('ring buffer evicts oldest samples beyond the 10 000/tag bound and keeps the newest window', async () => {
  // Wait until the LAST scripted value has landed in the realtime store — the mock
  // emits in FIFO order, so all earlier values have landed by then too.
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagId] }),
    (v) => v.samples[0]?.value === TOTAL - 1 && v.samples[0]?.quality === 'good',
    Math.ceil(TOTAL * 3 / 1000) + 20_000, // generous: 1ms cadence script + flush margins
  );
  // Positive wait for the batched history append (§3.2: batched 250 ms / 5 000
  // samples): the ring settles at exactly its bound once every append flushed.
  const { samples } = await k.api.waitFor(
    () => k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&limit=100000&order=asc`),
    (r) => r.samples.length === BOUND,
    20_000,
    250,
  );
  expect(samples.length).toBe(BOUND);
  expect((samples[0] as any).value).toBe(TOTAL - BOUND); // oldest survivor = value 50
  expect((samples[BOUND - 1] as any).value).toBe(TOTAL - 1); // newest retained
  // Strictly time-ordered, no duplicates of the same value.
  const values = samples.map((s: any) => s.value as number);
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBe(values[i - 1] + 1);
  }
  for (const s of samples) {
    expect(s.quality).toBe('good');
    expect(typeof s.ts).toBe('string');
  }
});
