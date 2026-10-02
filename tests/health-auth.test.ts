// Coverage 1: health & auth bootstrap (§2.1), error envelope shape (§2.1).
// Spec stories 35 (RBAC groundwork) + acceptance for skeleton (ticket #2 health).
// doc-derived test stub — rewired to @orch/* at merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKernel, type TestKernel } from './support/harness.js';
import { PERMISSIONS } from './support/types.js';

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

describe('health & auth bootstrap (§2.1)', () => {
  it('GET /health/live is unauthenticated and reports storage + plugin states', async () => {
    const health = await kernel.anon.healthLive();
    expect(health.status).toBe('ok'); // A-HEALTH-STATUS
    expect(typeof health.version).toBe('string');
    expect(health.version.length).toBeGreaterThan(0);
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(health.storage.mode).toBe('embedded');
    expect(health.storage.ok).toBe(true);
    expect(Array.isArray(health.plugins)).toBe(true);
    for (const p of health.plugins) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.state).toBe('string');
    }
  });

  it('GET /health/ready is unauthenticated', async () => {
    const ready = await kernel.anon.healthReady();
    expect(ready.status).toBe('ok');
    expect(ready.storage.ok).toBe(true);
  });

  it('first boot seeds admin; login returns token, expiry and user', async () => {
    const bad = await kernel.anon.expectError('POST', '/auth/login', {
      username: kernel.admin.username,
      password: 'definitely-wrong',
    }, 'UNAUTHORIZED', 401);
    expect(bad.error.message.length).toBeGreaterThan(0);

    const login = await kernel.anon.login(kernel.admin.username, kernel.admin.password);
    expect(typeof login.token).toBe('string');
    expect(login.token.length).toBeGreaterThan(20); // opaque 256-bit random
    expect(typeof login.expiresAt).toBe('string');
    expect(Number.isNaN(Date.parse(login.expiresAt))).toBe(false);
    expect(login.user.username).toBe(kernel.admin.username);
  });

  it('bootstrap admin carries all seven permissions (§2.1 role→permission mapping)', async () => {
    const { user } = await kernel.api.me();
    expect(user.username).toBe(kernel.admin.username);
    expect(Array.isArray(user.roles)).toBe(true);
    expect(user.roles).toContain('admin');
    for (const perm of PERMISSIONS) {
      expect(user.permissions).toContain(perm);
    }
  });

  it('GET /auth/me without a token is UNAUTHORIZED with envelope', async () => {
    await kernel.anon.expectError('GET', '/auth/me', undefined, 'UNAUTHORIZED', 401);
  });

  it('GET /auth/me with a garbage token is UNAUTHORIZED', async () => {
    const garbage = kernel.anon.withToken('not-a-real-token');
    await garbage.expectError('GET', '/auth/me', undefined, 'UNAUTHORIZED', 401);
  });
});

describe('error envelope shape (§2.1)', () => {
  it('404 carries {error:{code,message,requestId}} with requestId starting req_', async () => {
    const env = await kernel.api.expectError('GET', '/tags/00000000-0000-7000-8000-000000000000', undefined, 'NOT_FOUND', 404);
    expect(env.error.requestId.startsWith('req_')).toBe(true);
    expect(typeof env.error.message).toBe('string');
  });

  it('400 validation errors use VALIDATION_ERROR', async () => {
    // POST /tags with required fields missing must be rejected by schema validation.
    await kernel.api.expectError('POST', '/tags', {}, 'VALIDATION_ERROR', 400);
  });

  it('requestId differs between two failing requests (per-request correlation)', async () => {
    const a = await kernel.api.expectError('GET', '/tasks/nope-1', undefined, 'NOT_FOUND', 404);
    const b = await kernel.api.expectError('GET', '/tasks/nope-2', undefined, 'NOT_FOUND', 404);
    expect(a.error.requestId).not.toBe(b.error.requestId);
  });
});
