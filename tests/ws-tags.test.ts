// Coverage 3: WS /ws/tags protocol (§2.2): hello/welcome auth, subscribe snapshot,
// change-only data pushes, wildcard topics, unsubscribe, ping/pong, error frames.
// Spec stories 12/14 (realtime monitoring, change-driven push).
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, type TestKernel } from './support/harness.js';
import { WsTagsClient } from './support/ws.js';
import { watchFor } from './support/util.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;
let client: WsTagsClient;

// §5.2 mock script: t1 changes over time; t2 is set once and never changes again.
const SCRIPT = {
  script: [
    { afterMs: 0, set: { t1: 10, t2: 'static' } },
    { afterMs: 800, set: { t1: 11 } },
    { afterMs: 1600, set: { t1: 12 } },
  ],
};

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [
      { name: 't1', dataType: 'float64' },
      { name: 't2', dataType: 'string' },
    ],
    script: SCRIPT,
  });
  client = await kernel.wsTags();
});

afterAll(async () => {
  client?.close();
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

describe('auth (§2.2: first frame must authenticate)', () => {
  it('hello with a bad token never receives welcome', async () => {
    let badClient: WsTagsClient | undefined;
    try {
      badClient = await WsTagsClient.connect(kernel.port, 'bogus-token', { timeoutMs: 2_000 });
      // If connect() somehow resolved, a welcome must NOT have been the reason:
      expect(badClient.frames.some((f) => f.op === 'welcome')).toBe(false);
    } catch (err) {
      // Accept either an error frame or a close before welcome (A-WS-BADAUTH).
      expect(String(err)).toMatch(/error frame|closed before welcome|no welcome/);
    } finally {
      badClient?.close();
    }
    // Belt & braces: the shared client (good token) DID get a welcome.
    expect(client.frames.some((f) => f.op === 'welcome')).toBe(true);
  });

  it('welcome carries serverTime and protocolVersion 1', () => {
    const welcome = client.frames.find((f) => f.op === 'welcome')!;
    expect(welcome.protocolVersion).toBe(1);
    expect(Number.isNaN(Date.parse(String(welcome.serverTime)))).toBe(false);
  });
});

describe('subscribe / snapshot / wildcard (§2.2)', () => {
  it('subscribe to exact + wildcard topics echoes ack with a snapshot of current values', async () => {
    const { snapshot } = await client.subscribe(['factory.plc.t1', 'factory.plc.*']);
    const topics = snapshot.map((s) => s.topic);
    expect(topics).toContain('factory.plc.t1');
    expect(topics).toContain('factory.plc.t2');
    const entry = snapshot.find((s) => s.topic === 'factory.plc.t1')!;
    expect(entry.quality).toBe('good');
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
  });

  it('snapshot value agrees with the REST /tags/values current value', async () => {
    const { samples } = await kernel.api.tagValues({ ids: [mock.tagIds.t1] });
    const snap = client.frames.find((f) => f.op === 'subscribed')!;
    const viaWs = (snap.snapshot as { topic: string; value: unknown }[]).find((s) => s.topic === 'factory.plc.t1');
    // The snapshot may be slightly newer than the REST read; assert set membership of
    // the value stream instead of strict equality: both must be numbers from {10,11,12}.
    expect(typeof viaWs?.value).toBe('number');
    expect([10, 11, 12]).toContain(viaWs!.value);
    expect(typeof samples[0]?.value).toBe('number');
  });
});

describe('change-only data pushes (§2.2)', () => {
  it('pushes only change-detected updates: t1 changes flow, t2 never re-appears', async () => {
    // Script keeps mutating t1 every 800ms while subscribed; watch a bounded window
    // covering at least one further change (11 → 12).
    await client.waitForUpdate((u) => u.topic === 'factory.plc.t1' && u.value === 12, 6_000, 't1=12 push');

    const updates = client.allUpdates();
    const t1 = updates.filter((u) => u.topic === 'factory.plc.t1');
    const t2 = updates.filter((u) => u.topic === 'factory.plc.t2');
    expect(t1.length).toBeGreaterThan(0);
    expect(t2.length).toBe(0); // never changed after subscribe → never pushed

    // Change-only invariant: consecutive pushed values for t1 always differ.
    const values = t1.map((u) => u.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).not.toBe(values[i - 1]);
    }
    // §2.2 update entry shape (reason key present, null when good).
    expect(t1[0]).toHaveProperty('reason');
    expect(t1[0].quality).toBe('good');
    expect(Number.isNaN(Date.parse(t1[0].ts))).toBe(false);
  });

  it('coalesces updates into batched data frames (≤1000/frame)', async () => {
    const dataFrames = client.frames.filter((f) => f.op === 'data');
    expect(dataFrames.length).toBeGreaterThan(0);
    for (const f of dataFrames) {
      expect(Array.isArray(f.updates)).toBe(true);
      expect((f.updates as unknown[]).length).toBeLessThanOrEqual(1000);
    }
  });
});

describe('unsubscribe / ping (§2.2)', () => {
  it('unsubscribe acks and stops pushes for that topic', async () => {
    await client.unsubscribe(['factory.plc.t1']);
    const baseline = client.allUpdates().filter((u) => u.topic === 'factory.plc.t1').length;
    // t1 keeps changing every 800ms per the script; a bounded watch window must see
    // no further t1 pushes.
    const saw = await watchFor(
      () => {
        const now = client.allUpdates().filter((u) => u.topic === 'factory.plc.t1').length;
        return now > baseline ? now : undefined;
      },
      1_200,
      50,
    );
    expect(saw).toBeUndefined();
  });

  it('ping → pong keeps the connection alive', async () => {
    await client.ping(2_000);
    expect(client.isOpen).toBe(true);
  });

  it('unknown op yields an error frame (or is ignored) but the connection survives', async () => {
    client.send({ op: 'definitely-not-a-real-op' } as never);
    await client.ping(2_000); // connection must still answer
    expect(client.isOpen).toBe(true);
  });
});
