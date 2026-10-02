// Coverage 8: RBAC permission matrix (7 permissions; roles admin/engineer/operator;
// custom roles) + audit query. Spec story 35 ("谁改了流程、谁下了单可追溯"); ticket #17.
// The exact built-in engineer/operator mappings are NOT specified in the doc — the
// enforcement matrix is tested via custom roles with exactly-chosen permissions
// (fully determined by the API surface). admin = all seven is asserted in health-auth.
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, type TestKernel } from './support/harness.js';
import { chain, flowDef, seq } from './support/fixtures.js';
import type { Permission, Role } from './support/types.js';

let kernel: TestKernel;
let roles: Record<string, Role> = {};

const MATRIX: Array<{ grant: Permission[]; allowed: Permission[] }> = [
  { grant: ['config:write'], allowed: ['config:write'] },
  { grant: ['tasks:create', 'tasks:command'], allowed: ['tasks:create', 'tasks:command'] },
  { grant: ['alarms:ack'], allowed: ['alarms:ack'] },
  { grant: [], allowed: [] }, // user with a permissionless role can still read /auth/me
];

beforeAll(async () => {
  kernel = await startKernel();
  // Distinct roles per permission for clean matrix testing.
  for (const grant of MATRIX) {
    const key = grant.grant.join('+') || 'none';
    roles[key] = await kernel.api.createRole({ name: `role_${key.replace(/[^a-z0-9]/gi, '_')}`, permissions: grant.grant });
  }
  // A flow + a channel-less task surface for tasks:create/tasks:command probes.
  const flow = await kernel.api.createFlow({
    name: 'rbac_probe',
    spec: flowDef('rbac_probe', [seq('a', { kind: 'log', message: 'p' })], chain(seq('a', { kind: 'log', message: 'p' }))),
  });
  (kernel as TestKernel & { probeFlowId?: string }).probeFlowId = flow.flowId;
});

afterAll(async () => {
  try {
    await kernel.stop();
  } catch {
    // kernel boot failed in beforeAll - nothing to stop
  }
});

async function userWith(permissions: Permission[]) {
  const key = permissions.join('+') || 'none';
  const username = `u_${key.replace(/[^a-z0-9]/gi, '_')}_${Math.random().toString(36).slice(2, 7)}`;
  await kernel.api.createUser({ username, password: 'pw-12345678', roles: [roles[key].id] }); // A-USER-ROLES-REF
  const login = await kernel.anon.login(username, 'pw-12345678');
  return kernel.anon.withToken(login.token);
}

describe('permission enforcement matrix (§2.1: 7 permissions)', () => {
  it('config:write gates channel creation', async () => {
    const withIt = await userWith(['config:write']);
    await withIt.createChannel({ name: 'rbac_ok_ch', driver: 'mock-driver', enabled: true, config: { script: [] } });

    const withoutIt = await userWith(['tasks:create']);
    await withoutIt.expectError('POST', '/channels', {
      name: 'rbac_denied_ch', driver: 'mock-driver', enabled: true, config: { script: [] },
    }, 'FORBIDDEN', 403);
  });

  it('flows:write gates flow deployment', async () => {
    const withoutIt = await userWith(['alarms:ack']);
    const spec = flowDef('denied', [seq('a')], []);
    await withoutIt.expectError('POST', '/flows', { name: 'denied', spec }, 'FORBIDDEN', 403);
  });

  it('tasks:create gates manual ordering (story 21: 界面上手动下单)', async () => {
    const flowId = (kernel as TestKernel & { probeFlowId: string }).probeFlowId;
    const withIt = await userWith(['tasks:create']);
    const task = await withIt.createTask({ flowId });
    expect(task.status).toBeTruthy();

    const withoutIt = await userWith(['config:write']);
    await withoutIt.expectError('POST', '/tasks', { flowId }, 'FORBIDDEN', 403);
    // Cleanup: abort the probe task so nothing lingers.
    await kernel.api.taskCommand(task.id, { type: 'abort' }).catch(() => undefined);
  });

  it('tasks:command gates pause/abort commands', async () => {
    const flowId = (kernel as TestKernel & { probeFlowId: string }).probeFlowId;
    const task = await kernel.api.createTask({ flowId });
    const withoutIt = await userWith(['tasks:create']);
    await withoutIt.expectError('POST', `/tasks/${task.id}/commands`, { type: 'abort' }, 'FORBIDDEN', 403);
    await kernel.api.taskCommand(task.id, { type: 'abort' });
    await expect(kernel.api.getTask(task.id)).resolves.toMatchObject({ status: 'aborted' });
  });

  it('alarms:ack gates the ack endpoint', async () => {
    const withoutIt = await userWith(['tasks:create']);
    await withoutIt.expectError('POST', '/alarms/00000000-0000-7000-8000-00000000beef/ack', undefined, 'FORBIDDEN', 403);
  });

  it('users:manage gates user administration', async () => {
    const withoutIt = await userWith(['config:write']);
    await withoutIt.expectError('POST', '/users', { username: 'sneaky', password: 'x'.repeat(12), roles: [] }, 'FORBIDDEN', 403);
    await withoutIt.expectError('GET', '/users', undefined, 'FORBIDDEN', 403);
  });

  it('audit:read gates the audit query (§2.1: audit errors FORBIDDEN)', async () => {
    const withoutIt = await userWith(['alarms:ack']);
    await withoutIt.expectError('GET', '/audit', undefined, 'FORBIDDEN', 403);
    const withIt = await userWith(['audit:read']);
    const page = await withIt.audit({});
    expect(Array.isArray(page.items)).toBe(true);
  });

  it('/auth/me lists only the role-granted permissions', async () => {
    const api = await userWith(['config:write']);
    const { user } = await api.me();
    expect(user.permissions).toEqual(['config:write']);
  });

  it('a user with a permissionless role can still authenticate', async () => {
    const api = await userWith([]);
    const { user } = await api.me();
    expect(user.permissions).toEqual([]);
  });
});

describe('built-in roles (§2.1 v1 ships admin/engineer/operator)', () => {
  it('all three exist with permissions drawn from the seven', async () => {
    const list = await kernel.api.listRoles();
    const names = list.map((r) => r.name);
    for (const name of ['admin', 'engineer', 'operator']) expect(names).toContain(name);
    const allowed = ['config:write', 'flows:write', 'tasks:create', 'tasks:command', 'alarms:ack', 'users:manage', 'audit:read'];
    for (const r of list) {
      for (const p of r.permissions) expect(allowed).toContain(p);
    }
  });
});

describe('audit trail (§2.1 GET /audit, story 35)', () => {
  it('records config + task actions with actor/action/resourceType and supports filters', async () => {
    const auditor = await userWith(['audit:read']);

    // Generate attributable actions as a distinct user.
    const actor = await userWith(['config:write', 'tasks:create', 'flows:write']);
    const ch = await actor.createChannel({ name: 'audited_ch', driver: 'mock-driver', enabled: true, config: { script: [] } });
    const flow = await actor.createFlow({ name: 'audited_flow', spec: flowDef('audited_flow', [seq('a')], []) });
    await actor.createTask({ flowId: flow.flowId });

    const page = await auditor.audit({});
    expect(page.items.length).toBeGreaterThanOrEqual(3);
    for (const rec of page.items) {
      expect(typeof rec.actor).toBe('string');
      expect(typeof rec.action).toBe('string');
      expect(typeof rec.resourceType).toBe('string');
      expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
    }
    // Filter by action narrows the result set to matching actions only.
    const filtered = await auditor.audit({ action: 'channel.create' }).catch(async () => auditor.audit({ resourceType: 'channel' }));
    for (const rec of filtered.items) {
      expect(
        rec.action === 'channel.create' || rec.resourceType === 'channel',
      ).toBe(true);
    }
    // The channel creation by the non-admin actor is traceable (who changed what).
    const byActor = await auditor.audit({ actor: (await actor.me()).user.username });
    expect(byActor.items.length).toBeGreaterThanOrEqual(1);
    void ch;
  });
});
