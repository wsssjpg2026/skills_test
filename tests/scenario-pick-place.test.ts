// Coverage 10: acceptance scenario scenarios/pick-place/ (§5.3, ticket #15 resident
// regression). The full composite-robot pick&place loop from the spec §Solution 5:
//   导航到取料站 → 机械臂扫码 → 上传 MES → MES 返回目标站点 → 抓取 →（质量人工确认）
//   → 导航到目标站 → 放置 → 上报 MES → 释放资源
// run end-to-end in pure simulation:
//   - fixtures installed through the public REST API (installScenario)
//   - MES is the scriptable @orch/sim-mes WS peer (kernel dials out, §2.6)
//   - a scripted fault (getDestination drop) forces retry_exhausted suspend →
//     operator retry-step; the qa_gate forces the human-intervention suspend → continue
//   - expect.json's task-event sequence is asserted as an ordered subsequence
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, waitForTaskStatus, type TestKernel } from './support/harness.js';
import { applyScenarioFault, installScenario, loadScenario } from './support/fixtures.js';
import { startSimMes } from './support/mes-sim.js';
import { matchEventSubsequence } from './support/util.js';
import type { SimMesConfig } from './support/types.js';

let kernel: TestKernel;
let scenario: Awaited<ReturnType<typeof loadScenario>>;
let installed: Awaited<ReturnType<typeof installScenario>>;
let mes: Awaited<ReturnType<typeof startSimMes>>;

beforeAll(async () => {
  scenario = await loadScenario('pick-place');
  // Start the MES simulator with the scenario's fault injected (first getDestination
  // drops; the operator retry-step then hits the good scripted response).
  const mesConfig = applyScenarioFault(scenario.simulators.mes!, scenario.faults);
  mes = await startSimMes(mesConfig);

  kernel = await startKernel({ config: { northbound: { mes: { url: mes.url, requestTimeoutMs: 5_000, maxRetries: 2 } } } });
  installed = await installScenario(kernel.api, scenario);
});

afterAll(async () => {
  await mes?.stop().catch(() => undefined);
  await kernel?.stop();
});

describe('pick-place acceptance regression (spec §Solution 5, ticket #15)', () => {
  it('runs the full loop through the two operator interventions and completes', { timeout: 120_000 }, async () => {
    // Trigger through the flow-bound webhook token (story 20) — the "调度系统" entry.
    const token = installed.webhookTokens['pick_and_place'];
    expect(token).toBeTruthy();
    const task = await kernel.api.triggerWebhook(token!, { orderId: 'PP-1042', sku: 'BRACKET-A' });
    expect(task.flowId).toBe(installed.flows['pick_and_place'].flowId);
    expect(task.version).toBe(1); // pinned to the deployed version

    // --- operator intervention #1: MES getDestination dropped → retry_exhausted incident
    const suspended = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 30_000);
    expect(suspended.suspendReason).toBe('retry_exhausted');
    expect(suspended.currentNodeIds).toContain('dest');
    await kernel.api.taskCommand(task.id, { type: 'retry-step' });

    // --- operator intervention #2: quality gate after grasp
    const gated = await waitForTaskStatus(kernel.api, task.id, ['suspended'], 30_000);
    expect(gated.suspendReason).toBe('human_intervention');
    await kernel.api.taskCommand(task.id, { type: 'continue' });

    const done = await waitForTaskStatus(kernel.api, task.id, ['completed'], 60_000);
    expect(done.status).toBe('completed');

    // --- expect.json: ordered event-sequence assertion (incl. both suspend/resume paths)
    const events = await kernel.api.allEvents(task.id);
    const result = matchEventSubsequence(events, scenario.expect.taskEventSequence);
    expect(result.detail).toBe('matched');

    // --- MES saw the real handshake (§2.6 request/response by id)
    const received = mes.received();
    const scans = received.filter((m) => m.op === 'reportScan');
    const dests = received.filter((m) => m.op === 'getDestination');
    const places = received.filter((m) => m.op === 'reportPlace');
    expect(scans.length).toBe(1);
    expect(dests.length).toBe(2); // dropped one + answered one
    expect(places.length).toBe(1);
    // Whole-string template preserved the station value into the final report (§2.4).
    expect((places[0].payload as { station: unknown }).station).toBe('ST-2');
    // Barcode flowed from the robot scan result into the MES report.
    expect((scans[0].payload as { barcode: unknown }).barcode).toBe('BC-0042');

    // --- the branchless path was taken (manual_station never ran)
    expect(events.some((e) => e.type === 'step.started' && (e.payload as { nodeId: string }).nodeId === 'manual_station')).toBe(false);
    // --- resource hygiene: exactly one acquire/release pair
    expect(events.filter((e) => e.type === 'resource.acquired').length).toBe(1);
    expect(events.filter((e) => e.type === 'resource.released').length).toBe(1);
    expect((await kernel.api.resourceLock('robot_1')).holder).toBeUndefined();
  });
});
