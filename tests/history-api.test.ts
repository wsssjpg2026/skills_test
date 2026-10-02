// Coverage 9: History API shape (§2.1 /history/tags/{tagId}, §3.1 HistoryStore.query):
// from/to window, ordering asc/desc, limit paging, server-side downsample
// interval+fn(last|min|max|avg). Spec stories 13/14; ticket #9.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, waitForTagValue, type TestKernel } from './support/harness.js';
import type { Sample } from './support/types.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

// Deterministic ladder 1..10 recorded every 150ms on t_hist (historyEnabled).
const LADDER = Array.from({ length: 10 }, (_, i) => ({
  afterMs: i * 150,
  set: { t_hist: i + 1 },
}));

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [{ name: 't_hist', dataType: 'float64', historyEnabled: true }, { name: 't_nohist' }],
    script: { script: [{ afterMs: 0, set: { t_hist: 0, t_nohist: 5 } }, ...LADDER] },
  });
  await waitForTagValue(kernel.api, mock.tagIds.t_hist, 10, 20_000);
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

const WINDOW = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 120_000); // generous: covers boot-to-now
  return { from: from.toISOString(), to: to.toISOString() };
};

describe('raw history query (§2.1)', () => {
  it('returns the recorded ladder with quality+ts, ascending by default', async () => {
    const { samples } = await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'asc' });
    expect(samples.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < samples.length; i++) {
      expect(Date.parse(samples[i].ts)).toBeGreaterThanOrEqual(Date.parse(samples[i - 1].ts));
    }
    const values = samples.map((s) => s.value);
    expect(values).toContain(1);
    expect(values).toContain(10);
    for (const s of samples) {
      expect(s.tagId).toBe(mock.tagIds.t_hist);
      expect(s.quality).toBe('good');
    }
  });

  it('order=desc returns newest first', async () => {
    const { samples } = await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'desc' });
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(Date.parse(samples[0].ts)).toBeGreaterThanOrEqual(Date.parse(samples[samples.length - 1].ts));
  });

  it('limit caps the returned sample count (paging)', async () => {
    const { samples } = await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'desc', limit: '3' });
    expect(samples.length).toBeLessThanOrEqual(3);
    // desc = newest first: first item must be the max ts of the whole raw set.
    const raw = await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'desc' });
    expect(Date.parse(samples[0].ts)).toBe(Date.parse(raw.samples[0].ts));
  });

  it('a window that excludes everything returns an empty set', async () => {
    const past = { from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' };
    const { samples } = await kernel.api.history(mock.tagIds.t_hist, past);
    expect(samples).toEqual([]);
  });

  it('unknown tagId is NOT_FOUND; historyEnabled=false tag yields no samples (A-HISTORY-DISABLED-TAG)', async () => {
    await kernel.api.expectError('GET', `/history/tags/00000000-0000-7000-8000-00000000face?${new URLSearchParams({ ...WINDOW() })}`, undefined, 'NOT_FOUND', 404);
    const res = await kernel.api.raw('GET', `/history/tags/${mock.tagIds.t_nohist}?${new URLSearchParams({ ...WINDOW() })}`);
    expect(res.status === 200 || res.status === 503).toBe(true);
    if (res.status === 200) {
      expect((res.body as { samples: unknown[] }).samples).toEqual([]);
    } else {
      expect((res.body as { error: { code: string } }).error.code).toBe('HISTORY_UNAVAILABLE');
    }
  });
});

describe('server-side downsampling (§2.1 interval + fn)', () => {
  const INTERVAL_MS = 10 * 60_000; // 10m — the 1.5s ladder is one bucket with near-certainty

  /** Epoch-aligned bucketing assumption (A-HISTORY-BUCKETS). */
  function bucketTsOf(ts: string): number {
    return Math.floor(Date.parse(ts) / INTERVAL_MS) * INTERVAL_MS;
  }

  async function fetchDownsampled(fn: 'last' | 'min' | 'max' | 'avg'): Promise<Sample[]> {
    const { samples } = await kernel.api.history(mock.tagIds.t_hist, {
      ...WINDOW(), order: 'asc', interval: '10m', fn,
    });
    return samples;
  }

  it('reduces the sample count vs raw', async () => {
    const raw = await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'asc' });
    const down = await fetchDownsampled('last');
    expect(down.length).toBeLessThanOrEqual(raw.samples.length);
  });

  it.each([['last'], ['min'], ['max'], ['avg']] as const)('fn=%s matches the bucket aggregate of raw samples', async (fn) => {
    const raw = (await kernel.api.history(mock.tagIds.t_hist, { ...WINDOW(), order: 'asc' })).samples;
    const down = await fetchDownsampled(fn);
    expect(down.length).toBeGreaterThan(0);

    // Group raw samples by the same bucket rule the server is assumed to use.
    const buckets = new Map<number, number[]>();
    for (const s of raw) {
      const b = bucketTsOf(s.ts);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b)!.push(Number(s.value));
    }
    for (const s of down) {
      const b = bucketTsOf(s.ts);
      const raws = buckets.get(b);
      expect(raws).toBeDefined();
      if (!raws) continue;
      const expected =
        fn === 'last' ? raws[raws.length - 1]
        : fn === 'min' ? Math.min(...raws)
        : fn === 'max' ? Math.max(...raws)
        : raws.reduce((a, x) => a + x, 0) / raws.length;
      expect(Number(s.value)).toBeCloseTo(expected, 6);
    }
  });

  it('every downsampled ts lies inside the queried window and is ordered', async () => {
    const w = WINDOW();
    const down = await fetchDownsampled('max');
    for (const s of down) {
      expect(Date.parse(s.ts)).toBeGreaterThanOrEqual(Date.parse(w.from));
      expect(Date.parse(s.ts)).toBeLessThanOrEqual(Date.parse(w.to));
    }
    for (let i = 1; i < down.length; i++) {
      expect(Date.parse(down[i].ts)).toBeGreaterThanOrEqual(Date.parse(down[i - 1].ts));
    }
  });
});
