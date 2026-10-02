// Coverage 2b: byteorder diagnostics endpoint contract (§2.1, spec story 11:
// "写 100 读回 25600 即字节序反了" config-time self-check) and channel test endpoint error path.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, type TestKernel } from './support/harness.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [{ name: 'reg0', dataType: 'uint16', address: '4x:UINT16:0' }],
    script: { script: [{ afterMs: 0, set: { reg0: 0 } }] },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('POST /devices/{id}/diagnostics/byteorder (§2.1, story 11)', () => {
  it('write 100 → read back through the driver; returns {ok, readBack, diagnosis}', async () => {
    // With the honest mock driver the readback matches (A-BYTEORDER-MOCK). The 25600
    // mismatch case is Modbus-specific (ticket #5) and is asserted there, not here.
    const result = await kernel.api.byteorderDiagnostic(mock.deviceId, { tagId: mock.tagIds.reg0, testValue: 100 });
    expect(Object.keys(result).sort()).toEqual(['diagnosis', 'ok', 'readBack']);
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe(100);
    expect(result.diagnosis !== undefined).toBe(true);
  });

  it('rejects a tagId that does not belong to the device', async () => {
    await kernel.api.expectError(
      'POST', `/devices/${mock.deviceId}/diagnostics/byteorder`,
      { tagId: '00000000-0000-7000-8000-00000000dead', testValue: 100 },
      'NOT_FOUND', 404,
    );
  });
});

describe('POST /channels/{id}/test (§2.1)', () => {
  it('reports ok:false (not a crash) for a channel whose driver plugin is unknown', async () => {
    // §6.1: channel referencing a missing plugin → channel failed. The one-shot test
    // endpoint must surface a structured negative result.
    const ch = await kernel.api.createChannel({
      name: 'ghost-driver', driver: 'no-such-plugin', enabled: true, config: {},
    });
    const result = await kernel.api.testChannel(ch.id);
    expect(result.ok).toBe(false);
    expect(typeof (result.detail ?? '')).toBe('string');
  });
});
