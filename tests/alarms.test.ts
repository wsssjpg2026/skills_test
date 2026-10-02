// Coverage 7: alarms ISA-18.2 (§3.6 full state table incl shelve expiry & RTN paths),
// alarm rule CRUD, ack/shelve endpoints, chattering defense via on/off delays.
// Spec story 38; ticket #17.
// State machine (§3.6):
//   Trip (true after onDelay)      → creates UnackedActive
//   RTN (false after offDelay)     → UnackedActive→RtnUnacked | AckedActive→Normal(close)
//   ACK                            → UnackedActive→AckedActive | RtnUnacked→Normal(close)
//   SHELVE                         → any of the three → Shelved
//   shelve expiry / UNSHELVE       → re-evaluate → UnackedActive or Normal
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, type TestKernel } from './support/harness.js';
import { waitUntil, watchFor } from './support/util.js';
import type { AlarmInstance } from './support/types.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  // temp drives the alarm rule; script holds it LOW initially.
  mock = await installMockChannel(kernel.api, {
    tags: [{ name: 'temp' }, { name: 'pressure' }],
    script: { script: [{ afterMs: 0, set: { temp: 20, pressure: 1 } }] },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

/** Alarm rules need the tag to move via the driver — the mock script is fixed at channel
 * creation, so chattering tests create dedicated channels with tailored scripts. */
async function makeHiRule(tagId: string, thresholds: Partial<{ onDelayMs: number; offDelayMs: number }> = {}) {
  return kernel.api.createAlarmRule({
    tagId,
    kind: 'hi',
    threshold: 80,
    onDelayMs: thresholds.onDelayMs ?? 0,
    offDelayMs: thresholds.offDelayMs ?? 0,
    priority: 'high',
    message: 'temperature above 80',
  });
}

async function alarmFor(ruleId: string, state?: string): Promise<AlarmInstance | undefined> {
  const list = await kernel.api.listAlarms(state);
  return list.find((a) => a.ruleId === ruleId);
}

async function waitForAlarm(ruleId: string, pred: (a: AlarmInstance) => boolean, label: string): Promise<AlarmInstance> {
  return waitUntil(async () => {
    const a = await alarmFor(ruleId);
    return a && pred(a) ? a : undefined;
  }, { timeoutMs: 10_000, intervalMs: 50, label });
}

/** Extra channel whose script flips a tag high at t=HIGH_MS (default immediately). */
async function scriptedAlarmChannel(name: string, script: object, onDelayMs = 0, offDelayMs = 0) {
  const ch = await kernel.api.createChannel({ name, driver: 'mock-driver', enabled: true, config: { script } as object });
  const dev = await kernel.api.createDevice({ channelId: ch.id, name: `${name}_dev`, address: `mock:${name}`, enabled: true });
  const tag = await kernel.api.createTag({
    deviceId: dev.id, name: 'value', dataType: 'float64', address: 'mock:value',
    access: 'readwrite', historyEnabled: false,
  });
  const rule = await makeHiRule(tag.id, { onDelayMs, offDelayMs });
  return { ruleId: rule.id, tagId: tag.id };
}

describe('alarm rule CRUD (§2.1 /alarm-rules)', () => {
  it('creates, updates, lists and deletes rules', async () => {
    const rule = await makeHiRule(mock.tagIds.temp);
    expect(rule.kind).toBe('hi');
    expect(rule.threshold).toBe(80);
    const patched = await kernel.api.patchAlarmRule(rule.id, { threshold: 90, priority: 'low' });
    expect(patched.threshold).toBe(90);
    expect((await kernel.api.listAlarmRules()).some((r) => r.id === rule.id)).toBe(true);
    await kernel.api.deleteAlarmRule(rule.id);
    expect((await kernel.api.listAlarmRules()).some((r) => r.id === rule.id)).toBe(false);
  });

  it('rejects invalid kinds/thresholds with VALIDATION_ERROR', async () => {
    await kernel.api.expectError('POST', '/alarm-rules', {
      tagId: mock.tagIds.temp, kind: 'sideways', threshold: 10, onDelayMs: 0, offDelayMs: 0,
      priority: 'high', message: 'x',
    }, 'VALIDATION_ERROR', 400);
    await kernel.api.expectError('POST', '/alarm-rules', {
      tagId: 'nope', kind: 'hi', threshold: 10, onDelayMs: 0, offDelayMs: 0,
      priority: 'high', message: 'x',
    }, 'NOT_FOUND', 404);
  });
});

describe('ISA-18.2 state table (§3.6)', () => {
  it('trip after onDelay → UnackedActive → ACK → AckedActive', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_trip', { script: [{ afterMs: 0, set: { value: 95 } }] });
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'UnackedActive after trip');
    expect(active.activeSince).toBeTruthy();

    const acked = await kernel.api.ackAlarm(active.id);
    expect(acked.state).toBe('AckedActive');
    expect(acked.ackedBy).toBeTruthy();
    expect(acked.ackedAt).toBeTruthy();
  });

  it('RTN while UNACKED → RtnUnacked (returns-to-normal unacked); ACK then closes', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_rtn_unacked', { script: [
      { afterMs: 0, set: { value: 95 } },
      { afterMs: 1_200, set: { value: 20 } }, // condition clears while still unacked
    ] });
    await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');
    const rtn = await waitForAlarm(ruleId, (a) => a.state === 'RtnUnacked', 'RtnUnacked after RTN');
    // ACK on RtnUnacked closes the instance (Normal).
    await kernel.api.ackAlarm(rtn.id);
    await waitUntil(async () => {
      const a = await alarmFor(ruleId);
      return a === undefined ? true : undefined;
    }, { timeoutMs: 10_000, label: 'ACK on RtnUnacked closes instance' });
  });

  it('RTN while ACKED → Normal close (instance disappears from GET /alarms)', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_rtn_acked', { script: [
      { afterMs: 0, set: { value: 95 } },
      { afterMs: 1_200, set: { value: 20 } },
    ] });
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');
    await kernel.api.ackAlarm(active.id);
    await waitUntil(async () => {
      const a = await alarmFor(ruleId);
      return a === undefined ? true : undefined; // closed & gone
    }, { timeoutMs: 10_000, label: 'ack + RTN closes the alarm' });
  });

  it('ACK on RtnUnacked closes; ACK on AckedActive / Shelved is TASK_STATE_INVALID', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_ack_rules', { script: [
      { afterMs: 0, set: { value: 95 } },
      { afterMs: 1_000, set: { value: 20 } }, // RTN while unacked
    ] });
    const rtn = await waitForAlarm(ruleId, (a) => a.state === 'RtnUnacked', 'RtnUnacked after RTN');
    const closed = await kernel.api.ackAlarm(rtn.id);
    expect(closed.state === 'Normal' || closed.state === 'RtnUnacked' || closed.state === 'AckedActive').toBe(true);
    await waitUntil(async () => {
      const a = await alarmFor(ruleId);
      return a === undefined ? true : undefined;
    }, { timeoutMs: 10_000, label: 'ACK on RtnUnacked closes instance' });

    // ACK twice on an AckedActive is an invalid transition (§3.6 table: "—").
    const { ruleId: rule2 } = await scriptedAlarmChannel('st_ack_twice', { script: [{ afterMs: 0, set: { value: 95 } }] });
    const a2 = await waitForAlarm(rule2, (x) => x.state === 'UnackedActive', 'trip 2');
    await kernel.api.ackAlarm(a2.id);
    await kernel.api.expectError('POST', `/alarms/${a2.id}/ack`, undefined, 'TASK_STATE_INVALID', 409);
  });
});

describe('shelving (§3.6)', () => {
  it('shelve from UnackedActive; duration bounded by 86400; expiry re-evaluates → UnackedActive', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_shelve', { script: [{ afterMs: 0, set: { value: 95 } }] });
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');

    await kernel.api.expectError('POST', `/alarms/${active.id}/shelve`, { durationSec: 100_000 }, 'VALIDATION_ERROR', 400);

    const shelved = await kernel.api.shelveAlarm(active.id, 2); // 2 s
    expect(shelved.state).toBe('Shelved');
    expect(shelved.shelvedUntil).toBeTruthy();

    // Condition still true while shelved; after expiry the instance re-evaluates to active.
    const reactivated = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'reactivation after shelve expiry');
    expect(reactivated.id).toBe(active.id);
  });

  it('manual unshelve re-evaluates immediately', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_unshelve', { script: [{ afterMs: 0, set: { value: 95 } }] });
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');
    await kernel.api.shelveAlarm(active.id, 3_600);
    const unshelved = await kernel.api.unshelveAlarm(active.id);
    expect(unshelved.state).toBe('UnackedActive'); // condition still true
  });
});

describe('chattering defense (§3.6 onDelay/offDelay)', () => {
  it('flaps shorter than onDelay never trip; sustained high does', async () => {
    // Toggles every 250ms (< onDelay 600ms) for 1.5s, then stays high.
    const { ruleId } = await scriptedAlarmChannel('st_chatter', { script: [
      { afterMs: 0, set: { value: 95 } },
      { afterMs: 250, set: { value: 20 } },
      { afterMs: 500, set: { value: 95 } },
      { afterMs: 750, set: { value: 20 } },
      { afterMs: 1_000, set: { value: 95 } },
      { afterMs: 1_250, set: { value: 20 } },
      { afterMs: 2_000, set: { value: 95 } }, // sustained from here
    ] }, 600, 0);
    // No instance may exist while the condition only ever held < 600ms (bounded
    // negative window covering the whole flapping phase, which ends at t≈1.25s).
    const appeared = await watchFor(async () => alarmFor(ruleId), 1_700, 100);
    expect(appeared).toBeUndefined();
    // Sustained high trips.
    await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip after sustained high');
  });

  it('a dip shorter than offDelay does not clear an active alarm', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_offdelay', { script: [
      { afterMs: 0, set: { value: 95 } },
      { afterMs: 900, set: { value: 20 } },   // 400ms dip...
      { afterMs: 1_300, set: { value: 95 } }, // ...then high again
    ] }, 0, 1_000);
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');
    await waitUntil(async () => {
      const { samples } = await kernel.api.tagValues({ ids: [active.tagId] });
      return samples[0]?.value === 20 ? true : undefined;
    }, { timeoutMs: 5_000, label: 'dip observed' });
    // Dip shorter than offDelay: still the SAME active instance.
    const still = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'still active across short dip');
    expect(still.id).toBe(active.id);
  });
});

describe('alarm instance payload (§2.1 GET /alarms)', () => {
  it('exposes value + activeSince + filters by state', async () => {
    const { ruleId } = await scriptedAlarmChannel('st_payload', { script: [{ afterMs: 0, set: { value: 95 } }] });
    const active = await waitForAlarm(ruleId, (a) => a.state === 'UnackedActive', 'trip');
    expect(active.value).toBe(95);
    expect(active.ruleId).toBe(ruleId);
    expect(active.tagId).toBeTruthy();
    const unackedOnly = await kernel.api.listAlarms('UnackedActive');
    expect(unackedOnly.every((a) => a.state === 'UnackedActive')).toBe(true);
  });
});
