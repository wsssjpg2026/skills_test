// Coverage 4: flow deployment/versioning (§2.4 binding rules): new version per deploy,
// immutable versions, running instances pinned to (flowId, version), canonical export/import.
// Tickets #10/#14; spec stories 16 (可视化画布 + 导出 JSON 入 Git).
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { chain, flowDef, human, seq, stripServerAssigned } from './support/fixtures.js';
import { ApiError } from './support/rest.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startKernel();
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

function twoLogSteps(id: string) {
  return flowDef(id, [seq('a', { kind: 'log', message: 'first' }), seq('b', { kind: 'log', message: 'second' })], chain(
    seq('a', { kind: 'log', message: 'first' }),
    seq('b', { kind: 'log', message: 'second' }),
  ));
}

describe('POST /flows + versioning (§2.4)', () => {
  it('first deploy returns version 1 with server-assigned flowId', async () => {
    const v = await kernel.api.createFlow({ name: 'two_log', spec: twoLogSteps('two_log') });
    expect(v.version).toBe(1);
    expect(typeof v.flowId).toBe('string');
    expect(v.flowId.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(v.createdAt))).toBe(false);
    expect(typeof v.createdBy).toBe('string');
  });

  it('deploying again creates a NEW version; versions are monotonic and immutable', async () => {
    const first = await kernel.api.createFlow({ name: 'evolve', spec: twoLogSteps('evolve') });
    const specV2 = twoLogSteps('evolve');
    specV2.nodes.push(seq('c', { kind: 'log', message: 'third' }));
    specV2.edges.push({ from: 'b', port: 'then', to: 'c' });
    const second = await kernel.api.publishVersion(first.flowId, { spec: specV2 });
    expect(second.version).toBe(2);

    const versions = await kernel.api.listVersions(first.flowId);
    const nums = versions.items.map((m) => m.version).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2]);

    // Immutability: v1 spec is unchanged after v2 exists.
    const v1 = await kernel.api.getVersion(first.flowId, 1);
    expect(stripServerAssigned(v1.spec as never)).toEqual(stripServerAssigned(twoLogSteps('evolve')));
    await kernel.api.expectError('GET', `/flows/${first.flowId}/versions/3`, undefined, 'NOT_FOUND', 404);
  });

  it('rejects an invalid flow spec with VALIDATION_ERROR (unknown node type, dangling edge)', async () => {
    const badType = flowDef('bad_type', [{ type: 'quantum-teleport', id: 'q' } as never], []);
    await kernel.api.expectError('POST', '/flows', { name: 'bad_type', spec: badType }, 'VALIDATION_ERROR', 400);

    const dangling = flowDef('dangling', [seq('a'), seq('b')], [{ from: 'a', port: 'then', to: 'missing-node' }]);
    await kernel.api.expectError('POST', '/flows', { name: 'dangling', spec: dangling }, 'VALIDATION_ERROR', 400);
  });

  it('concurrent version publishes never produce duplicate version numbers (A-VERSION-RACE)', async () => {
    const base = await kernel.api.createFlow({ name: 'race', spec: twoLogSteps('race') });
    const results = await Promise.allSettled([
      kernel.api.publishVersion(base.flowId, { spec: twoLogSteps('race') }),
      kernel.api.publishVersion(base.flowId, { spec: twoLogSteps('race') }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeLessThanOrEqual(2);
    // Any rejection must be a proper envelope CONFLICT (version race), never a crash.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ApiError);
      expect((r.reason as ApiError).code).toBe('CONFLICT');
    }
    const nums = (await kernel.api.listVersions(base.flowId)).items.map((m) => m.version).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(nums.length);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1);
  });
});

describe('running instances stay pinned (§2.4 binding rule)', () => {
  it('a task started on v1 keeps version 1 semantics after v2 is deployed', async () => {
    const v1Spec = flowDef('pinned', [human('h1', 'v1 prompt: confirm to finish')], []);
    const v1 = await kernel.api.createFlow({ name: 'pinned', spec: v1Spec });

    // Start a task on v1; it suspends at the human-intervention node.
    const task = await kernel.api.createTask({ flowId: v1.flowId, version: 1 });
    const suspended = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 10_000);
    expect(suspended.version).toBe(1);
    expect(suspended.suspendReason).toBe('human_intervention');

    // Deploy v2 with completely different content.
    await kernel.api.publishVersion(v1.flowId, { spec: twoLogSteps('pinned') });

    // The pinned task still behaves per v1: it finishes via continue on the SAME node.
    await kernel.api.taskCommand(task.id, { type: 'continue' });
    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(done.version).toBe(1);
    const events = await kernel.api.allEvents(task.id);
    expect(events.some((e) => e.type === 'step.suspended' && (e.payload as { nodeId?: string })?.nodeId === 'h1')).toBe(true);

    // A NEW task after the v2 deploy runs version 2 (no human-intervention step).
    const t2 = await kernel.api.createTask({ flowId: v1.flowId });
    const done2 = await waitForTaskStatus(kernel.api, t2.id, ['completed'], 10_000);
    expect(done2.version).toBe(2);
  });
});

describe('canonical export / import (§2.4)', () => {
  it('export is canonical JSON: sorted keys, LF endings, trailing newline, stable bytes', async () => {
    const spec = flowDef('canon', [
      seq('zeta', { kind: 'log', message: 'z' }),
      seq('alpha', { kind: 'delay', ms: 10 }, { retry: { maxAttempts: 2, backoffMs: 50 } }),
    ], [ { from: 'zeta', port: 'then', to: 'alpha' } ]);
    const v = await kernel.api.createFlow({ name: 'canon', spec });

    const text1 = await exportText(kernel, v.flowId, 1);
    const text2 = await exportText(kernel, v.flowId, 1);
    expect(text1).toBe(text2); // deterministic bytes
    expect(text1.endsWith('\n')).toBe(true); // trailing newline
    expect(text1.includes('\r')).toBe(false); // LF only
    const parsed = JSON.parse(text1);
    expect(stripServerAssigned(parsed as never)).toEqual(stripServerAssigned(spec));
    // Key-sorted canonical form, verified recursively.
    expect(text1.trim()).toBe(JSON.stringify(sortedClone(parsed)));
  });

  it('import round-trips a canonical export into an executable flow', async () => {
    const spec = flowDef('roundtrip', [seq('only', { kind: 'log', message: 'hi' })], []);
    const v = await kernel.api.createFlow({ name: 'roundtrip', spec });
    const text = await exportText(kernel, v.flowId, 1);
    const imported = await kernel.api.importFlow(JSON.parse(text));
    expect(stripServerAssigned(imported.spec as never)).toEqual(stripServerAssigned(spec));

    // The imported flow executes through the public API.
    const task = await kernel.api.createTask({ flowId: imported.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
  });
});

/** Export returns canonical JSON TEXT (§2.4); normalize client-side defensively. */
async function exportText(kernel: TestKernel, flowId: string, version: number): Promise<string> {
  const res = await kernel.api.raw('GET', `/flows/${flowId}/versions/${version}/export`);
  if (res.status !== 200) throw new Error(`export failed: ${res.status} ${res.text.slice(0, 200)}`);
  if (typeof res.body === 'string') return res.body as unknown as string;
  return res.text; // raw body text even when JSON-parsable
}

function sortedClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortedClone(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortedClone((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}
