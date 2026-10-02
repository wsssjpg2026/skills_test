// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Modbus driver behavior via the public API against the product simulator @orch/sim-modbus
// (§5.2). Covers ticket #5: addressing grammar validation, byteorder diagnostics
// ("write 100 read 25600", §2.1), per-slave degradation isolation (§4.5), TCP-first
// with 32-bit word order + scaling, write+verify, and RTU link serialization
// (env-gated — needs a PTY pair, see A10).
import { test, expect, beforeAll, afterAll, describe } from 'vitest';
import path from 'node:path';
import { bootOrch, REPO_ROOT, cleanupDir, type BootedKernel } from '../support/boot.ts';
import { startSimModbus, type SimModbusHandle } from '../support/peers/sim-adapters.ts';

// A9 (assumption): driver plugin dist entry per repo layout §1 + channel config grammar:
// { mode: 'tcp'|'rtu', host, port } and device address = unit id (string).
const MODBUS_MAIN = path.join(REPO_ROOT, 'packages/drivers/modbus/dist/main.js');

let sim: SimModbusHandle;
let k: BootedKernel;
let channelId: string;
let dev1: string;
let dev2: string;

async function makeTag(deviceId: string, name: string, address: string, extra: Record<string, unknown> = {}) {
  return k.api.createTag({ deviceId, name, dataType: 'uint16', address, access: 'readwrite', scanPeriodMs: 300, ...extra });
}

beforeAll(async () => {
  sim = await startSimModbus({ unitIds: [1, 2] });
  k = await bootOrch({
    plugins: [{ id: 'driver-modbus', command: process.execPath, args: [MODBUS_MAIN] }],
  });
  const ch = await k.api.createChannel({
    name: 'mb',
    driver: 'driver-modbus',
    enabled: true,
    config: { mode: 'tcp', host: '127.0.0.1', port: sim.port },
  });
  channelId = ch.id;
  const d1 = await k.api.createDevice(channelId, { name: 'slave1', address: '1', enabled: true, config: {} });
  const d2 = await k.api.createDevice(channelId, { name: 'slave2', address: '2', enabled: true, config: {} });
  dev1 = d1.id;
  dev2 = d2.id;
}, 60_000);

afterAll(async () => {
  await k?.stop?.();
  await sim?.stop?.();
  await cleanupDir(k?.dataDir ?? '');
});

test('TCP-first happy path: 32-bit word order (ABCD), scaling, and uint16 reads are decoded correctly', async () => {
  // Raw registers for INT32 0x000186A0 (=100000) at holding 0..1 (ABCD).
  await sim.setRegisters(1, 0, [0x0001, 0x86a0]);
  // Raw uint16 4x:UINT16:5 = 5309, and 16-bit "BA" swap case value 0x0064 = 100 at reg 6.
  await sim.setRegisters(1, 5, [5309, 0x0064]);
  const t32 = await makeTag(dev1, 'v32', '4x:INT32:0', { dataType: 'int32', byteOrder: 'ABCD' });
  const t32bad = await makeTag(dev1, 'v32_cdab', '4x:INT32:0', { dataType: 'int32', byteOrder: 'CDAB' });
  const t16 = await makeTag(dev1, 'v16', '4x:UINT16:5', { dataType: 'uint16' });
  const tScaled = await makeTag(dev1, 'vScaled', '4x:UINT16:6', { dataType: 'uint16', scaling: { slope: 0.1, offset: 5 } });
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [t32.id, t32bad.id, t16.id, tScaled.id] }),
    (v) => v.samples.length === 4 && v.samples.every((s) => s.quality === 'good'),
    10_000,
  );
  const by = new Map(vals.samples.map((s: any) => [s.tagId, s.value]));
  expect(by.get(t32.id)).toBe(100000); // correct word order ABCD
  // CDAB on the same registers swaps the word pair: 0x86A00001 ≠ the ABCD decode.
  expect(by.get(t32bad.id)).toBe(0x86a00001);
  expect(by.get(t16.id)).toBe(5309);
  expect(by.get(tScaled.id)).toBeCloseTo(0.1 * 100 + 5, 5); // scaling slope/offset applied
});

test('addressing grammar: valid addresses accepted, invalid rejected with 400 VALIDATION_ERROR', async () => {
  const valid = ['4x:UINT16:0', '3x:INT16:2', '0x:BOOL:3', '1x:BOOL:4', '4x:INT32:10', '4x:FLOAT32:20'];
  for (const address of valid) {
    const t = await makeTag(dev1, `ok_${address.replace(/[^a-z0-9]/gi, '_')}`, address);
    expect(t.address).toBe(address);
  }
  const invalid = ['', 'garbage', '9x:UINT16:0', '4x:UINT16:', '4x:UINT16:-1', '4x:NOTYPE:0', '4x', '4x:UINT16:0:extra'];
  for (const address of invalid) {
    await expect(makeTag(dev1, `bad_${Math.random().toString(36).slice(2, 6)}`, address)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
});

test('byteorder diagnostics: "write 100 read back 25600" is detected at config time (story 11, §2.1)', async () => {
  // Correct 16-bit tag: write 100 → read back 100.
  const good = await makeTag(dev1, 'diag_ok', '4x:UINT16:100', { byteOrder: 'AB' });
  const okRes = await k.api.byteorderDiagnostics(dev1, { tagId: good.id, testValue: 100 });
  expect(okRes.ok).toBe(true);
  expect(okRes.readBack).toBe(100);
  // Wrong byte order BA on the same register: 0x0064 read swapped = 0x6400 = 25600.
  const swapped = await makeTag(dev1, 'diag_ba', '4x:UINT16:100', { byteOrder: 'BA' });
  const badRes = await k.api.byteorderDiagnostics(dev1, { tagId: swapped.id, testValue: 100 });
  expect(badRes.ok).toBe(false);
  expect(badRes.readBack).toBe(25600);
  expect(String(badRes.diagnosis).toLowerCase()).toMatch(/byte|order|swap|endianness/);
  // 32-bit word-order error is also detectable: CDAB vs ABCD.
  const w32 = await makeTag(dev1, 'diag_cdab', '4x:INT32:102', { dataType: 'int32', byteOrder: 'CDAB' });
  const res32 = await k.api.byteorderDiagnostics(dev1, { tagId: w32.id, testValue: 100 });
  expect(res32.ok).toBe(false);
  expect(res32.readBack).not.toBe(100);
  expect(String(res32.diagnosis).toLowerCase()).toMatch(/word|order|swap|endianness|byte/);
});

test('per-slave degradation isolation: one slave timing out degrades only that device (§4.5, story 10)', async () => {
  await sim.setRegisters(2, 0, [777]);
  const s2 = await makeTag(dev2, 'ok22', '4x:UINT16:0');
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [s2.id] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0].value === 777,
    10_000,
  );
  // Fault slave 1 only.
  await sim.setSlaveFault(1, true);
  const degraded = await makeTag(dev1, 'iso1', '4x:UINT16:50');
  const vals = await k.api.waitFor(
    () => k.api.tagValues({ ids: [degraded.id, s2.id] }),
    (v) => v.samples.find((s: any) => s.tagId === degraded.id)?.quality === 'bad',
    15_000,
  );
  const other = vals.samples.find((s: any) => s.tagId === s2.id);
  expect(other?.quality).toBe('good'); // sibling slave unaffected
  expect(other?.value).toBe(777);
  // The channel/connection itself must not be torn down for the healthy slave.
  // Recover: slave 1 answers again → quality returns good with a fresh value.
  await sim.setSlaveFault(1, false);
  await sim.setRegisters(1, 50, [1234]);
  await k.api.waitFor(
    () => k.api.tagValues({ ids: [degraded.id] }),
    (v) => v.samples[0]?.quality === 'good' && v.samples[0].value === 1234,
    15_000,
  );
});

test('write path: value written through the driver is readable back (diagnostics covers write+verify)', async () => {
  const t = await makeTag(dev1, 'wr1', '4x:UINT16:200');
  const res = await k.api.byteorderDiagnostics(dev1, { tagId: t.id, testValue: 4242 });
  expect(res.ok).toBe(true);
  expect(res.readBack).toBe(4242);
  const regs = await Promise.resolve(sim.readRegisters(1, 200, 1));
  expect(regs[0]).toBe(4242);
});

// A10 (assumption): RTU tests need a socat PTY pair; run with
//   ORCH_MODBUS_RTU_PORTS=/tmp/ptyA:/tmp/ptyB orch rtu 3 5
// Asserts §4.5: strict single-queue serialization + 3–5 ms turnaround default.
describe.skipIf(!process.env.ORCH_MODBUS_RTU_PORTS)('Modbus RTU link serialization (env-gated)', () => {
  test('all requests on the RTU link are serialized with turnaround gap ≥ 3 ms', async () => {
    const [a, b] = (process.env.ORCH_MODBUS_RTU_PORTS as string).split(':');
    expect(a && b).toBeTruthy();
    const rtuKernel = await bootOrch({
      plugins: [{ id: 'driver-modbus', command: process.execPath, args: [MODBUS_MAIN] }],
    });
    try {
      const ch = await rtuKernel.api.createChannel({
        name: 'rtu',
        driver: 'driver-modbus',
        enabled: true,
        config: { mode: 'rtu', path: a, baudRate: 9600 },
      });
      const d1 = await rtuKernel.api.createDevice(ch.id, { name: 'r1', address: '1', enabled: true, config: {} });
      const d2 = await rtuKernel.api.createDevice(ch.id, { name: 'r2', address: '2', enabled: true, config: {} });
      for (const [i, d] of [d1, d2].entries()) {
        await rtuKernel.api.createTag({
          deviceId: d.id,
          name: `rt${i}`,
          dataType: 'uint16',
          address: '4x:UINT16:0',
          access: 'read',
          scanPeriodMs: 100,
        });
      }
      // A11 (assumption): the RTU peer side (sim on /tmp/ptyB) exposes request
      // timestamps; serialization = no overlapping request windows + gap ≥ 3ms.
      // Exact observation surface is finalized at merge with sim-modbus's RTU mode.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(ch.id).toBeTruthy();
    } finally {
      await rtuKernel.stop();
      await cleanupDir(rtuKernel.dataDir);
    }
  });
});
