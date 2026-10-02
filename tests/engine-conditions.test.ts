// Coverage 5b: condition branches (§2.4 structured conditions incl var refs), template
// interpolation. Spec story 18 (扫码结果/MES 返回/点位阈值分支); ticket #10.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installMockChannel, startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { chain, cond, edge, flowDef, seq, svc, tagIs, varIs } from './support/fixtures.js';

let kernel: TestKernel;
let mock: Awaited<ReturnType<typeof installMockChannel>>;

beforeAll(async () => {
  kernel = await startKernel();
  mock = await installMockChannel(kernel.api, {
    tags: [{ name: 'temp', dataType: 'float64' }, { name: 'mode', dataType: 'string' }],
    script: { script: [{ afterMs: 0, set: { temp: 42, mode: 'auto' } }] },
  });
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

function branchFlow(name: string, when: ReturnType<typeof tagIs>, thenTag: string, elseTag: string) {
  const start = seq('start', { kind: 'log', message: 'go' });
  const gate = cond('gate', [{ when, port: 'then' }], 'else');
  const hot = seq(thenTag, { kind: 'log', message: thenTag });
  const cold = seq(elseTag, { kind: 'log', message: elseTag });
  return flowDef(name, [start, gate, hot, cold], [
    ...chain(start, gate),
    edge('gate', 'then', thenTag),
    edge('gate', 'else', elseTag),
  ]);
}

async function ranNode(taskId: string, nodeId: string): Promise<boolean> {
  const events = await kernel.api.allEvents(taskId);
  return events.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === nodeId);
}

describe('tag-value conditions (§2.4 {tag, op, value})', () => {
  it('routes to the matching port when the threshold holds', async () => {
    const flow = await kernel.api.createFlow({
      name: 'hot_flow',
      spec: branchFlow('hot_flow', tagIs(mock.tagPath('temp'), 'gt', 30), 'took_hot', 'took_cold'),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(await ranNode(task.id, 'took_hot')).toBe(true);
    expect(await ranNode(task.id, 'took_cold')).toBe(false);
  });

  it('routes to elsePort when the condition does not hold', async () => {
    const flow = await kernel.api.createFlow({
      name: 'cold_flow',
      spec: branchFlow('cold_flow', tagIs(mock.tagPath('temp'), 'lt', 30), 'took_lt', 'took_ge'),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(await ranNode(task.id, 'took_ge')).toBe(true);
    expect(await ranNode(task.id, 'took_lt')).toBe(false);
  });

  it('nested structured conditions: all / any / not compose', async () => {
    const when = {
      all: [
        tagIs(mock.tagPath('temp'), 'ge', 40),
        { not: tagIs(mock.tagPath('temp'), 'gt', 100) },
        { any: [tagIs(mock.tagPath('mode'), 'eq', 'auto'), tagIs(mock.tagPath('mode'), 'eq', 'manual')] },
      ],
    };
    const start = seq('s2', { kind: 'log', message: 'go' });
    const gate = cond('g2', [{ when, port: 'yes' }], 'no');
    const yes = seq('nested_yes', { kind: 'log', message: 'y' });
    const no = seq('nested_no', { kind: 'log', message: 'n' });
    const flow = await kernel.api.createFlow({
      name: 'nested',
      spec: flowDef('nested', [start, gate, yes, no], [
        ...chain(start, gate),
        edge('g2', 'yes', 'nested_yes'),
        edge('g2', 'no', 'nested_no'),
      ]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(await ranNode(task.id, 'nested_yes')).toBe(true);
    expect(await ranNode(task.id, 'nested_no')).toBe(false);
  });
});

describe('var-ref conditions on node results (§2.4 "nodes.<id>.response.x")', () => {
  // A-ECHO-PROVIDER + A-VAR-SPACE: echo responds with the interpolated payloadTemplate
  // verbatim; task input is addressable as input.* in templates.
  it('branches on a service response field (echo loopback provider)', async () => {
    const call = svc('scan', 'reportScan', { station: '{{ input.station }}' });
    const gate = cond('dest', [{ when: varIs('nodes.scan.response.station', 'eq', 'ST-2'), port: 'st2' }], 'other');
    const st2 = seq('went_st2', { kind: 'log', message: 'st2' });
    const other = seq('went_other', { kind: 'log', message: 'other' });
    const flow = await kernel.api.createFlow({
      name: 'var_branch',
      spec: flowDef('var_branch', [call, gate, st2, other], [
        edge('scan', 'then', 'dest'),
        edge('dest', 'st2', 'went_st2'),
        edge('dest', 'other', 'went_other'),
      ]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId, input: { station: 'ST-2' } });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(await ranNode(task.id, 'went_st2')).toBe(true);
    expect(await ranNode(task.id, 'went_other')).toBe(false);

    const otherTask = await kernel.api.createTask({ flowId: flow.flowId, input: { station: 'ST-9' } });
    await waitForTaskStatus(kernel.api, otherTask.id, ['completed'], 10_000);
    expect(await ranNode(otherTask.id, 'went_other')).toBe(true);
  });

  it('whole-string template preserves numeric type (A-TEMPLATE-TYPE)', async () => {
    // input.qty is the number 12. "gt 10" must hold for a NUMBER; if interpolation had
    // produced the string "12" a strictly-typed comparison could not match eq on number.
    const call = svc('q', 'probe', { qty: '{{ input.qty }}' });
    const gate = cond('gc', [{ when: varIs('nodes.q.response.qty', 'gt', 10), port: 'big' }], 'small');
    const big = seq('qty_big', { kind: 'log', message: 'big' });
    const small = seq('qty_small', { kind: 'log', message: 'small' });
    const flow = await kernel.api.createFlow({
      name: 'template_type',
      spec: flowDef('template_type', [call, gate, big, small], [
        edge('q', 'then', 'gc'),
        edge('gc', 'big', 'qty_big'),
        edge('gc', 'small', 'qty_small'),
      ]),
    });
    const task = await kernel.api.createTask({ flowId: flow.flowId, input: { qty: 12 } });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    expect(await ranNode(task.id, 'qty_big')).toBe(true);
  });

  it('service.called / service.responded events correlate the same messageId (§2.5)', async () => {
    const call = svc('s3', 'ping', { n: 1 });
    const flow = await kernel.api.createFlow({ name: 'svc_events', spec: flowDef('svc_events', [call], []) });
    const task = await kernel.api.createTask({ flowId: flow.flowId });
    await waitForTaskStatus(kernel.api, task.id, ['completed'], 10_000);
    const events = await kernel.api.allEvents(task.id);
    const called = events.find((e) => e.type === 'service.called');
    const responded = events.find((e) => e.type === 'service.responded');
    expect(called).toBeDefined();
    expect(responded).toBeDefined();
    expect((called!.payload as { messageId: string }).messageId).toBe(
      (responded!.payload as { messageId: string }).messageId,
    );
  });
});
