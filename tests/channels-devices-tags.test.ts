// Coverage 2: channels/devices/tags CRUD + validation flow + batch import;
// tag values endpoint; channel test endpoint. Spec stories 1, 11, 12.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, waitForTagValue, type TestKernel } from './support/harness.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  // §5.2 mock driver: script is the whole channel config.
  mock = await installMockChannel(kernel.api, {
    tags: [
      { name: 't1', dataType: 'float64' },
      { name: 't2', dataType: 'bool' },
      { name: 't_hist', dataType: 'float64', historyEnabled: true },
    ],
    script: {
      script: [
        { afterMs: 0, set: { t1: 42, t2: true, t_hist: 1 } },
        { afterMs: 400, set: { t_hist: 2 } },
        { afterMs: 800, set: { t_hist: 3 } },
      ],
    },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('channels CRUD (§2.1)', () => {
  it('creates a channel against the mock driver plugin and echoes server fields', async () => {
    const ch = await kernel.api.createChannel({
      name: 'aux',
      driver: 'mock-driver',
      enabled: true,
      config: { script: [] },
    });
    expect(ch.id).toBeTruthy();
    expect(ch.driver).toBe('mock-driver');
    expect(ch.enabled).toBe(true);
    expect(Number.isNaN(Date.parse(ch.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(ch.updatedAt))).toBe(false);
  });

  it('rejects missing required fields with VALIDATION_ERROR', async () => {
    await kernel.api.expectError('POST', '/channels', { driver: 'mock-driver' }, 'VALIDATION_ERROR', 400);
    await kernel.api.expectError('POST', '/channels', { name: 'no-driver' }, 'VALIDATION_ERROR', 400);
  });

  it('rejects duplicate channel names with CONFLICT (names unique per parent)', async () => {
    await kernel.api.createChannel({ name: 'dup-name', driver: 'mock-driver', enabled: true, config: { script: [] } });
    await kernel.api.expectError(
      'POST', '/channels',
      { name: 'dup-name', driver: 'mock-driver', enabled: true, config: { script: [] } },
      'CONFLICT', 409,
    );
  });

  it('PATCH /channels/{id} updates fields and GET reflects them; DELETE then 404s', async () => {
    const ch = await kernel.api.createChannel({ name: 'patch-me', driver: 'mock-driver', enabled: true, config: { script: [] } });
    const patched = await kernel.api.patchChannel(ch.id, { enabled: false });
    expect(patched.enabled).toBe(false);
    expect((await kernel.api.getChannel(ch.id)).enabled).toBe(false);
    await kernel.api.deleteChannel(ch.id);
    await kernel.api.expectError('GET', `/channels/${ch.id}`, undefined, 'NOT_FOUND', 404);
  });

  it('POST /channels/{id}/test performs a one-shot connect with shape {ok, latencyMs?, detail?}', async () => {
    const result = await kernel.api.testChannel((await kernel.api.listChannels()).find((c) => c.name === 'factory')!.id);
    expect(typeof result.ok).toBe('boolean');
    if (result.ok) {
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('devices CRUD (§2.1)', () => {
  it('creates devices under a channel and filters list by channelId', async () => {
    const dev = await kernel.api.createDevice({ channelId: await channelFactoryId(), name: 'scale', address: 'mock:9', enabled: true });
    expect(dev.name).toBe('scale');
    const mine = await kernel.api.listDevices(await channelFactoryId());
    expect(mine.some((d) => d.name === 'plc')).toBe(true);
    expect(mine.some((d) => d.name === 'scale')).toBe(true);
    const patched = await kernel.api.patchDevice(dev.id, { enabled: false });
    expect(patched.enabled).toBe(false);
    await kernel.api.deleteDevice(dev.id);
    await kernel.api.expectError('GET', `/devices/${dev.id}`, undefined, 'NOT_FOUND', 404);
  });
});

describe('tags CRUD + validation (§2.0/§2.1)', () => {
  it('enforces the tag contract: name grammar, no dots, scanPeriod bounds, access enum', async () => {
    const base = { deviceId: mock.deviceId, dataType: 'float64' as const, address: 'mock:x', access: 'readwrite' as const, historyEnabled: false };
    await kernel.api.expectError('POST', '/tags', { ...base, name: 'has.dots' }, 'VALIDATION_ERROR', 400);
    await kernel.api.expectError('POST', '/tags', { ...base, name: 'bad name!' }, 'VALIDATION_ERROR', 400);
    await kernel.api.expectError('POST', '/tags', { ...base, name: 'ok_name', scanPeriodMs: 5 }, 'VALIDATION_ERROR', 400); // min 10ms
    await kernel.api.expectError('POST', '/tags', { ...base, name: 'ok_name2', scanPeriodMs: 3_600_001 }, 'VALIDATION_ERROR', 400);
    await kernel.api.expectError('POST', '/tags', { ...base, name: 'ok_name3' /* access missing */ }, 'VALIDATION_ERROR', 400);
    const ok = await kernel.api.createTag({ ...base, name: 'scan_ok', scanPeriodMs: 100 });
    expect(ok.scanPeriodMs).toBe(100);
  });

  it('roundtrips tag configuration including byteOrder and scaling', async () => {
    const tag = await kernel.api.createTag({
      deviceId: mock.deviceId,
      name: 'scaled',
      dataType: 'float32',
      address: '4x:FLOAT32:10',
      byteOrder: 'CDAB',
      scaling: { slope: 0.1, offset: 2 },
      deadband: { abs: 0.5 },
      access: 'read',
      historyEnabled: false,
    });
    const fetched = await kernel.api.getTag(tag.id);
    expect(fetched.byteOrder).toBe('CDAB');
    expect(fetched.scaling).toEqual({ slope: 0.1, offset: 2 });
    expect(fetched.deadband).toEqual({ abs: 0.5 });
    await kernel.api.patchTag(tag.id, { deadband: { pct: 1 } });
    expect((await kernel.api.getTag(tag.id)).deadband).toEqual({ pct: 1 });
    await kernel.api.deleteTag(tag.id);
  });

  it('POST /tags:batch imports a set of tags transactionally', async () => {
    await kernel.api.batchTags([
      { deviceId: mock.deviceId, name: 'batch_a', dataType: 'int16', address: 'mock:ba', access: 'read', historyEnabled: false },
      { deviceId: mock.deviceId, name: 'batch_b', dataType: 'bool', address: 'mock:bb', access: 'read', historyEnabled: false },
    ]);
    const names = (await kernel.api.listTags({ deviceId: mock.deviceId })).items.map((t) => t.name);
    expect(names).toContain('batch_a');
    expect(names).toContain('batch_b');
  });

  it('lists tags with deviceId filter and Page shape', async () => {
    const page = await kernel.api.listTags({ deviceId: mock.deviceId });
    expect(Array.isArray(page.items)).toBe(true);
    expect(typeof page.total).toBe('number');
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    for (const t of page.items) expect(t.deviceId).toBe(mock.deviceId);
  });
});

describe('GET /tags/values (§2.1 realtime seam, story 12)', () => {
  it('returns current value + quality + ts per tag id', async () => {
    const s = await waitForTagValue(kernel.api, mock.tagIds.t1, 42, 10_000);
    expect(s.quality).toBe('good');
    expect(Number.isNaN(Date.parse(s.ts))).toBe(false);

    const { samples } = await kernel.api.tagValues({ ids: [mock.tagIds.t1, mock.tagIds.t2] });
    expect(samples.find((x) => x.tagId === mock.tagIds.t2)?.value).toBe(true);
  });

  it('supports wildcard path filter ch.dev.*', async () => {
    const { samples } = await kernel.api.tagValues({ filter: 'factory.plc.*' });
    const ids = samples.map((s) => s.tagId);
    expect(ids).toContain(mock.tagIds.t1);
    expect(ids).toContain(mock.tagIds.t2);
    expect(ids).toContain(mock.tagIds.t_hist);
  });

  it('quality goes bad with reason (last good value retained) when the mock script says so', async () => {
    // §5.2 script entry: quality flip on the device with reason device_offline.
    const ch = await kernel.api.createChannel({
      name: 'flaky', driver: 'mock-driver', enabled: true,
      config: { script: [
        { afterMs: 0, set: { f1: 7 } },
        { afterMs: 700, quality: 'bad', reason: 'device_offline', devices: ['flakydev'] },
      ] } as object,
    });
    const dev = await kernel.api.createDevice({ channelId: ch.id, name: 'flakydev', address: 'mock:2', enabled: true });
    const tag = await kernel.api.createTag({ deviceId: dev.id, name: 'f1', dataType: 'float64', address: 'mock:f1', access: 'read', historyEnabled: false });
    await waitForTagValue(kernel.api, tag.id, 7, 10_000);
    const degraded = await waitForDegraded(kernel, tag.id);
    expect(degraded.quality).toBe('bad');
    expect(degraded.reason).toBe('device_offline');
    expect(degraded.value).toBe(7); // §3.2: value retained (last good)
  });
});

async function waitForDegraded(k: TestKernel, tagId: string) {
  const { waitUntil } = await import('./support/util.js');
  return waitUntil(
    async () => {
      const { samples } = await k.api.tagValues({ ids: [tagId] });
      const s = samples.find((x) => x.tagId === tagId);
      return s && s.quality === 'bad' ? s : undefined;
    },
    { timeoutMs: 10_000, label: `tag ${tagId} to go bad/device_offline` },
  );
}

async function channelFactoryId(): Promise<string> {
  return (await kernel.api.listChannels()).find((c) => c.name === 'factory')!.id;
}
