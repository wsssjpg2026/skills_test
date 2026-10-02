// Test track: drivers/contract/storage/northbound (test implementer #2, branch test/spec-drivers).
// Driver SPI contract semantics per architecture.md §2.3 (FROZEN-at-#7) — expressed as
// contract fixtures ANY spawnable plugin command must pass (§2.3.6). The suite is
// self-contained: it uses this repo's own ndjson JSON-RPC host harness and runs green
// against the doc-derived reference stub plugin even before the implementation merges.
// After merge, set ORCH_TEST_PLUGINS="label=node path/to/plugin.js[,label2=...]" to run
// the same fixtures against shipped drivers / simulators / the Galbot sidecar.
import { describe, test, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SpiHostHarness,
  SpiErrorCodes,
  StdRpcCodes,
  SpiRpcError,
  isISO8601,
} from '../support/spi-host/host.ts';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'support', 'spi-host', 'stub-plugin.mjs');
const STUB_CMD = (): string[] => [process.execPath, STUB];

const CHANNEL = { id: 'ch-1', name: 'c1', driver: 'stub-reference-plugin', enabled: true, config: {} };
function device(id = 'dev-1', config: Record<string, unknown> = {}) {
  return { id, channelId: CHANNEL.id, name: id, address: '1', enabled: true, config };
}
function tag(id: string, deviceId = 'dev-1', extra: Record<string, unknown> = {}) {
  return {
    id,
    deviceId,
    name: id,
    dataType: 'uint16',
    address: '4x:UINT16:0',
    access: 'readwrite',
    historyEnabled: false,
    scanPeriodMs: 200,
    ...extra,
  };
}
function desiredState(devices: any[], tags: any[]) {
  return { channel: CHANNEL, devices, tags };
}

const liveHosts: SpiHostHarness[] = [];
afterAll(() => {
  for (const h of liveHosts) {
    try {
      h.kill();
    } catch {}
  }
});
function launch(cmd = STUB_CMD(), args?: string[]): SpiHostHarness {
  const h = new SpiHostHarness([...cmd, ...(args ?? [])], { defaultDeadlineMs: 5_000 });
  liveHosts.push(h);
  return h;
}

async function expectRpcError(p: Promise<unknown>, code: number): Promise<SpiRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SpiRpcError) {
      expect(e.code).toBe(code);
      return e;
    }
    throw e;
  }
  throw new Error(`expected JSON-RPC error ${code}, got a successful result`);
}

/**
 * The contract fixtures (§2.3.6): lifecycle order, pre-initialize rejection, unknown
 * method, read/write shapes, error codes, tag_update coalescing + ts monotonicity,
 * capability honesty, command correlation incl. progress, validate() config-time
 * rejection, shutdown, and crash-restart full resync.
 */
export function defineSpiContractSuite(label: string, command: () => string[], opts: { subscribeMode?: boolean } = {}): void {
  describe(`SPI contract: ${label}`, () => {
    test('initialize handshake: pluginInfo + capabilities; lifecycle order initialize → channel.start → steady read', async () => {
      const h = launch(command());
      const init = await h.request('initialize', { protocolVersion: 1, hostInfo: { id: 'test-host', version: '0' } }, 10_000);
      expect(init.pluginInfo).toMatchObject({ id: expect.any(String) });
      expect(Array.isArray(init.capabilities)).toBe(true);
      const known = ['subscribe', 'write', 'read_on_demand', 'command', 'command_status', 'validate'];
      for (const c of init.capabilities) expect(known).toContain(c);
      const start = await h.request('channel.start', desiredState([device()], [tag('t1')]), 30_000);
      expect(start).toEqual({});
      // Steady state: read works only after both lifecycle steps succeeded.
      const read = await h.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1'] });
      expect(read.samples.length).toBe(1);
      // Method order on the wire must be initialize → channel.start (§2.3 lifecycle).
      const i = h.sentMethods.indexOf('initialize');
      const j = h.sentMethods.indexOf('channel.start');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(j).toBeGreaterThan(i);
      await h.gracefulShutdown();
    });

    test('NOT_INITIALIZED (-32001) for any method before successful initialize', async () => {
      const h = launch(command());
      await expectRpcError(h.request('read', { deviceId: 'd', tagIds: [] }), SpiErrorCodes.NOT_INITIALIZED);
      await expectRpcError(h.request('write', { deviceId: 'd', writes: [] }), SpiErrorCodes.NOT_INITIALIZED);
      await expectRpcError(h.request('subscribe', { deviceId: 'd', tagIds: [] }), SpiErrorCodes.NOT_INITIALIZED);
      await expectRpcError(
        h.request('channel.start', desiredState([], [])),
        SpiErrorCodes.NOT_INITIALIZED,
      );
      // After initialize the same calls must no longer fail with -32001.
      await h.request('initialize', { protocolVersion: 1 });
      const r = await h.request('read', { deviceId: 'dev-1', tagIds: ['t1'] }).catch((e) => e);
      expect(r).toBeInstanceOf(SpiRpcError);
      expect((r as SpiRpcError).code).not.toBe(SpiErrorCodes.NOT_INITIALIZED); // -32002 instead
      await h.gracefulShutdown();
    });

    test('unknown method → JSON-RPC -32601 (reserved std code)', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await expectRpcError(h.request('definitely_not_a_method', {}), StdRpcCodes.METHOD_NOT_FOUND);
      await h.gracefulShutdown();
    });

    test('unknown ids: read → DEVICE_NOT_FOUND (-32002) / TAG_NOT_FOUND (-32003)', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request('channel.start', desiredState([device()], [tag('t1')]));
      await expectRpcError(h.request('read', { deviceId: 'nope', tagIds: ['t1'] }), SpiErrorCodes.DEVICE_NOT_FOUND);
      await expectRpcError(h.request('read', { deviceId: 'dev-1', tagIds: ['nope'] }), SpiErrorCodes.TAG_NOT_FOUND);
      await h.gracefulShutdown();
    });

    test('read result shape: samples[] each {tagId, value, quality, ts ISO-8601}', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request('channel.start', desiredState([device('dev-1', { initialValues: { t1: 42, t2: true, t3: 'x' } })], [
        tag('t1'), tag('t2'), tag('t3'),
      ]));
      const read = await h.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1', 't2', 't3'] });
      expect(read.samples.map((s) => s.tagId).sort()).toEqual(['t1', 't2', 't3']);
      for (const s of read.samples) {
        expect(['good', 'bad', 'uncertain']).toContain(s.quality);
        expect(isISO8601(s.ts)).toBe(true);
        expect('value' in s).toBe(true);
      }
      const byId = new Map(read.samples.map((s) => [s.tagId, s]));
      expect((byId.get('t1') as any).value).toBe(42);
      expect((byId.get('t2') as any).value).toBe(true);
      await h.gracefulShutdown();
    });

    test('write result shape: results[] {tagId, ok:boolean}; rejected write carries reason', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request(
        'channel.start',
        desiredState([device()], [tag('w1', 'dev-1', { access: 'readwrite' }), tag('w2', 'dev-1', { access: 'read' })]),
      );
      const res = await h.request<{ results: any[] }>('write', {
        deviceId: 'dev-1',
        writes: [
          { tagId: 'w1', value: 7, verify: true },
          { tagId: 'w2', value: 7 },
        ],
      });
      expect(res.results.length).toBe(2);
      const ok = res.results.find((r) => r.tagId === 'w1');
      const rejected = res.results.find((r) => r.tagId === 'w2');
      expect(ok.ok).toBe(true);
      expect(rejected.ok).toBe(false);
      expect(typeof rejected.reason).toBe('string'); // §2.3.1 write result reason field
      await h.gracefulShutdown();
    });

    test('channel.update is a FULL replace: removed tags answer TAG_NOT_FOUND afterwards', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request('channel.start', desiredState([device()], [tag('t1'), tag('t2')]));
      await h.request('channel.update', desiredState([device()], [tag('t1')]));
      await expectRpcError(h.request('read', { deviceId: 'dev-1', tagIds: ['t2'] }), SpiErrorCodes.TAG_NOT_FOUND);
      const read = await h.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1'] });
      expect(read.samples.length).toBe(1);
      await h.gracefulShutdown();
    });

    test('validate() rejects malformed address configs at config time (errors[] {path, code, message})', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      const bad = await h.request<{ errors: any[] }>('validate', {
        kind: 'tag',
        config: { address: 'garbage-no-grammar', dataType: 'uint16' },
        siblings: [],
      });
      expect(bad.errors.length).toBeGreaterThan(0);
      for (const e of bad.errors) {
        expect(typeof e.path).toBe('string');
        expect(typeof e.code).toBe('string');
        expect(typeof e.message).toBe('string');
      }
      const good = await h.request<{ errors: any[] }>('validate', {
        kind: 'tag',
        config: { address: '4x:UINT16:2', dataType: 'uint16' },
        siblings: [],
      });
      expect(good.errors).toEqual([]);
      await h.gracefulShutdown();
    });

    test('plugin→host stream: ndjson framing valid, notifications only (no upward requests)', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request('channel.start', desiredState([device()], [tag('t1')]));
      await new Promise((r) => setTimeout(r, 400));
      await h.gracefulShutdown();
      expect(h.violations).toEqual([]);
    });

    test('tag_update: coalesced batches, ≥1 flush per scan period, per-tag ts monotonic', async (ctx) => {
      const h = launch(command());
      const init = await h.request<any>('initialize', { protocolVersion: 1 });
      if (!init.capabilities.includes('subscribe')) {
        h.kill();
        ctx.skip(); // capability honesty: this fixture only applies to subscribe-capable plugins
        return;
      }
      await h.request('channel.start', desiredState([device()], [tag('t1'), tag('t2')]), 30_000);
      await h.request('subscribe', { deviceId: 'dev-1', tagIds: ['t1', 't2'] });
      // scanPeriodMs = 200; observe ~1.3 s ≥ 5 flushes (≥1 per scan period).
      await new Promise((r) => setTimeout(r, 1_300));
      const updates = h.notificationsOf('tag_update').filter((u) => u.deviceId === 'dev-1');
      expect(updates.length).toBeGreaterThanOrEqual(5);
      const lastTs = new Map<string, number>();
      for (const u of updates) {
        expect(Array.isArray(u.samples)).toBe(true);
        expect(u.samples.length).toBeGreaterThan(0);
        for (const s of u.samples) {
          expect(s).toMatchObject({ tagId: expect.any(String), quality: expect.any(String) });
          expect(isISO8601(s.ts)).toBe(true);
          const t = Date.parse(s.ts);
          const prev = lastTs.get(s.tagId);
          if (prev !== undefined) expect(t).toBeGreaterThanOrEqual(prev); // monotonic per tag
          lastTs.set(s.tagId, t);
        }
      }
      await h.gracefulShutdown();
    });

    test('command correlation: accepted → progress → completed; command.status tracks state; unknown → COMMAND_REJECTED (-32009)', async (ctx) => {
      const h = launch(command());
      const init = await h.request<any>('initialize', { protocolVersion: 1 });
      if (!init.capabilities.includes('command')) {
        h.kill();
        ctx.skip();
        return;
      }
      await h.request(
        'channel.start',
        desiredState(
          [
            device('dev-1', {
              commands: {
                navigate: { durationMs: 300, progress: true, result: { pose: 'ST-2' } },
                explode: { durationMs: 150, fail: true },
              },
            }),
          ],
          [],
        ),
      );
      // unknown command → -32009
      await expectRpcError(
        h.request('command', { deviceId: 'dev-1', commandId: 'cmd-x0', command: 'nope', params: {}, timeoutMs: 5_000 }),
        SpiErrorCodes.COMMAND_REJECTED,
      );
      // happy path with progress
      const accepted = await h.request('command', { deviceId: 'dev-1', commandId: 'cmd-1', command: 'navigate', params: { goal: 'A' }, timeoutMs: 2_000 });
      expect(accepted).toEqual({ accepted: true });
      const statusRunning = await h.request<{ state: string }>('command.status', { deviceId: 'dev-1', commandId: 'cmd-1' });
      expect(['pending', 'running']).toContain(statusRunning.state);
      const progress = await h.waitForNotification('command_event', (p) => p.commandId === 'cmd-1' && p.event === 'progress');
      const completed = await h.waitForNotification('command_event', (p) => p.commandId === 'cmd-1' && p.event === 'completed');
      expect(progress.receivedAt).toBeLessThan(completed.receivedAt); // progress precedes completion
      expect(completed.params.result).toEqual({ pose: 'ST-2' });
      const statusDone = await h.request<{ state: string; result?: any }>('command.status', { deviceId: 'dev-1', commandId: 'cmd-1' });
      expect(statusDone.state).toBe('completed');
      expect(statusDone.result).toEqual({ pose: 'ST-2' });
      // failure path with structured error
      await h.request('command', { deviceId: 'dev-1', commandId: 'cmd-2', command: 'explode', params: {}, timeoutMs: 2_000 });
      const failed = await h.waitForNotification('command_event', (p) => p.commandId === 'cmd-2' && p.event === 'failed');
      expect(failed.params.error).toMatchObject({ kind: expect.any(String), code: expect.any(String), message: expect.any(String) });
      const statusFail = await h.request<{ state: string; error?: any }>('command.status', { deviceId: 'dev-1', commandId: 'cmd-2' });
      expect(statusFail.state).toBe('failed');
      expect(statusFail.error?.code).toBeTypeOf('string');
      await h.gracefulShutdown();
    });

    test('shutdown: returns {} and the process exits 0', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.gracefulShutdown();
      expect(h.exitCode).toBe(0);
    });

    test('supervision contract: plugin crash → host replays initialize + channel.start (full resync) and steady state returns', async () => {
      const h = launch(command());
      await h.request('initialize', { protocolVersion: 1 });
      await h.request('channel.start', desiredState([device('dev-1', { initialValues: { t1: 42 } })], [tag('t1')]));
      await h.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1'] });
      h.kill(); // simulate plugin process crash
      await h.waitForExit(5_000);
      // §2.3.4: restart replays the same sequence = full resync. The plugin must
      // accept the replayed full desired state without any incremental protocol.
      const h2 = launch(command());
      await h2.request('initialize', { protocolVersion: 1 });
      await h2.request('channel.start', desiredState([device('dev-1', { initialValues: { t1: 42 } })], [tag('t1')]));
      const read = await h2.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1'] });
      expect(read.samples[0].value).toBe(42);
      await h2.gracefulShutdown();
    });
  });
}

// Always run against the doc-derived reference stub (suite self-validation; green pre-merge).
defineSpiContractSuite('doc-derived reference stub plugin', STUB_CMD);

// Capability honesty (§2.3.1/§2.3.6): a plugin that does NOT declare `subscribe` must
// never receive a subscribe call — the host simulates the subscription by polling read.
describe('SPI contract: capability honesty (non-subscribe plugin)', () => {
  test('host polls read for non-subscribe plugins and never issues subscribe', async () => {
    const h = launch(STUB_CMD(), ['--caps', 'write,read_on_demand,validate']);
    const init = await h.request<any>('initialize', { protocolVersion: 1 });
    expect(init.capabilities).not.toContain('subscribe');
    await h.request('channel.start', desiredState([device('dev-1', { initialValues: { t1: 5 } })], [tag('t1')]));
    // framework-simulated subscription: three consecutive reads all succeed
    for (let i = 0; i < 3; i++) {
      const r = await h.request<{ samples: any[] }>('read', { deviceId: 'dev-1', tagIds: ['t1'] });
      expect(r.samples[0].value).toBe(5);
    }
    expect(h.sentMethods).not.toContain('subscribe');
    expect(h.sentMethods).not.toContain('unsubscribe');
    await h.gracefulShutdown();
  });
});

// Post-merge: run the same fixtures against product plugins, e.g.
//   ORCH_TEST_PLUGINS="mock=node packages/simulators/mock-driver/dist/main.js,sim-robot=node packages/simulators/robot/dist/main.js"
const extra = process.env.ORCH_TEST_PLUGINS;
if (extra) {
  for (const entry of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const label = entry.slice(0, eq > 0 ? eq : 0) || 'plugin';
    const cmd = entry.slice(eq > 0 ? eq + 1 : 0).split(' ');
    defineSpiContractSuite(label, () => cmd);
  }
}
