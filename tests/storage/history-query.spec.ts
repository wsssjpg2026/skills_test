// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// History query & downsample correctness (§2.1 history API, §3.1 HistoryStore) plus
// restart survival of embedded history (ticket #9 "重启后历史数据完好"). Observable
// only via the public API.
import { test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';

const MOCK_DRIVER_MAIN = path.join(REPO_ROOT, 'packages/simulators/mock-driver/dist/main.js');

// 12 samples, values 1..12, 400 ms apart (~4.8 s span) — crosses several 1 s buckets.
const N = 12;
const STEP_MS = 400;

let k: BootedKernel;
let channelId: string;
let tagId: string;
let rawFirst: { samples: any[] };

beforeAll(async () => {
  k = await bootOrch({
    plugins: [
      {
        id: 'mock-driver',
        command: process.execPath,
        args: [MOCK_DRIVER_MAIN],
      },
    ],
  });
  const ch = await k.api.createChannel({
    name: 'mockq',
    driver: 'mock-driver',
    enabled: true,
    config: {
      script: Array.from({ length: N }, (_, i) => ({ afterMs: 200 + i * STEP_MS, set: { t1: i + 1 } })),
    },
  });
  channelId = ch.id;
  const dev = await k.api.createDevice(ch.id, { name: 'd1', address: '', enabled: true, config: {} });
  const t = await k.api.createTag({
    deviceId: dev.id,
    name: 't1',
    dataType: 'int32',
    address: 'sim:t1',
    access: 'read',
    scanPeriodMs: 100,
    historyEnabled: true,
  });
  tagId = t.id;
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [tagId] }),
    (v) => v.samples[0]?.value === N,
    (N * STEP_MS) / 1000 + 20_000,
  );
  // Positive wait for the batched history flush: all N distinct values recorded.
  rawFirst = await k.api.waitFor(
    () => k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&limit=100000&order=asc`),
    (r) => r.samples.length === N,
    20_000,
    250,
  );
  expect(rawFirst.samples.length).toBe(N);
}, 90_000);

afterAll(async () => {
  await k?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('raw query returns all samples ordered ascending; order=desc inverts', async () => {
  const vals = rawFirst.samples.map((s: any) => s.value);
  expect(vals).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  let prevTs = 0;
  for (const s of rawFirst.samples) {
    expect(Date.parse(s.ts)).toBeGreaterThanOrEqual(prevTs);
    prevTs = Date.parse(s.ts);
  }
  const desc = await k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&order=desc`);
  const descVals = desc.samples.map((s: any) => s.value);
  expect(descVals[0]).toBe(N);
  expect(descVals[descVals.length - 1]).toBe(1);
});

test('from/to window filters samples inclusively', async () => {
  const ts = rawFirst.samples.map((s) => s.ts);
  const from = ts[2];
  const to = ts[9];
  const win = await k.api.history(tagId, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&order=asc&limit=1000`);
  const vals = win.samples.map((s: any) => s.value);
  expect(vals[0]).toBe(3);
  expect(vals[vals.length - 1]).toBe(10);
  expect(vals.length).toBe(8);
});

test('limit truncates (asc returns the OLDEST limit samples)', async () => {
  const lim = await k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&order=asc&limit=5`);
  expect(lim.samples.map((s: any) => s.value)).toEqual([1, 2, 3, 4, 5]);
});

test('server-side downsample interval=1s: bucket count collapses, fn=last/min/max/avg verified against raw data', async () => {
  const raw = rawFirst.samples;
  const intervalMs = 1_000;
  // Self-consistent expectation: bucket by absolute epoch time (server bucketing),
  // which is phase-independent — we recompute membership from the raw rows we got.
  const buckets = new Map<number, { ts: number; values: number[] }>();
  for (const s of raw) {
    const b = Math.floor(Date.parse(s.ts) / intervalMs);
    if (!buckets.has(b)) buckets.set(b, { ts: b * intervalMs, values: [] });
    buckets.get(b)!.values.push(s.value as number);
  }
  const inOrder = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  expect(inOrder.length).toBeLessThan(raw.length); // downsampling actually collapsed
  expect(inOrder.length).toBeGreaterThanOrEqual(3); // 4.8 s span crosses ≥ 3 buckets

  const expectFn = async (fn: 'last' | 'min' | 'max' | 'avg') => {
    const { samples } = await k.api.history(
      tagId,
      `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&interval=1s&fn=${fn}&limit=1000`,
    );
    expect(samples.length).toBe(inOrder.length);
    for (let i = 0; i < inOrder.length; i++) {
      const values = inOrder[i][1].values;
      const expected =
        fn === 'last' ? values[values.length - 1]
        : fn === 'min' ? Math.min(...values)
        : fn === 'max' ? Math.max(...values)
        : values.reduce((a, b) => a + b, 0) / values.length;
      if (fn === 'avg') {
        expect(samples[i].value as number).toBeCloseTo(expected, 6);
      } else {
        expect(samples[i].value).toBe(expected);
      }
    }
    // Downsampled rows remain time-ordered.
    let prev = 0;
    for (const s of samples) {
      expect(Date.parse(s.ts)).toBeGreaterThanOrEqual(prev);
      prev = Date.parse(s.ts);
    }
  };
  await expectFn('last');
  await expectFn('min');
  await expectFn('max');
  await expectFn('avg');
});

test('deadband/change-detection: unchanged re-emissions do not create history rows (§3.2 single choke point)', async () => {
  // The mock script above emitted 12 DISTINCT values; assert no extra rows beyond
  // those (equal-value re-reads would have produced none anyway by construction).
  const { samples } = await k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&limit=100000&order=asc`);
  expect(samples.length).toBe(N);
  const uniq = new Set(samples.map((s: any) => s.value));
  expect(uniq.size).toBe(N);
});

test('history survives a kernel restart (embedded storage persists)', async () => {
  const before = await k.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&limit=100000&order=asc`);
  // Disable the channel first so the finite mock script does not replay (and append
  // equal values) after restart — we want to observe storage, not re-emission.
  await k.api.patchChannel(channelId, { enabled: false });
  await new Promise((r) => setTimeout(r, 500));
  await k.stop();
  const k2 = await bootOrch({
    plugins: [{ id: 'mock-driver', command: process.execPath, args: [MOCK_DRIVER_MAIN] }],
    dataDir: k.dataDir, // SAME dataDir → same embedded storage
  });
  try {
    const after = await k2.api.history(tagId, `?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&limit=100000&order=asc`);
    expect(after.samples.map((s: any) => s.value)).toEqual(before.samples.map((s: any) => s.value));
  } finally {
    await k2.stop();
  }
});
