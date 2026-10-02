// doc-derived test stub — rewired to @orch/* at merge.
// Determinism utilities: every wait is deadline-bounded polling; ports are ephemeral;
// data dirs are fresh temp dirs. No wall-clock sleeps beyond configured timeouts.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sample, TaskEvent } from './types.js';

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/** Poll `pred` until it returns non-undefined (truthy match returned), or throw on deadline. */
export async function waitUntil<T>(
  pred: () => Promise<T | undefined | false> | T | undefined | false,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined | false = false;
  while (Date.now() < deadline) {
    last = await pred();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `waitUntil timed out after ${timeoutMs}ms${opts.label ? ` waiting for: ${opts.label}` : ''}`,
  );
}

/** Bounded negative-observation window: run `watchMs` and return everything pred saw. */
export async function watchFor<T>(
  pred: () => Promise<T | undefined | false> | T | undefined | false,
  watchMs: number,
  intervalMs = 50,
): Promise<T | undefined> {
  const deadline = Date.now() + watchMs;
  while (Date.now() < deadline) {
    const v = await pred();
    if (v) return v;
    await sleep(intervalMs);
  }
  return undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reserve an ephemeral port by binding port 0 and releasing it. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr == null || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

export async function tempDir(prefix = 'orch-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Repo root = nearest ancestor of this file containing package.json + tests/. */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'tests'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found from ' + import.meta.url);
}

/** §6.1: manifests live in plugins/ at repo root at merge time (dev/runtime config). */
export function defaultPluginsDir(): string {
  return path.join(repoRoot(), 'plugins');
}

export function scenariosDir(name: string): string {
  return path.join(repoRoot(), 'scenarios', name);
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

// ---------------------------------------------------------------- event helpers

export interface EventExpect {
  type: string;
  /** Subset match: every key in payloadSub must deep-equal the event payload's key. */
  payloadSub?: Record<string, unknown>;
  /** When true, this expected entry may be absent (soft requirement). */
  optional?: boolean;
}

export interface SubsequenceResult {
  ok: boolean;
  detail: string;
}

function deepSubset(sub: Record<string, unknown>, obj: unknown): boolean {
  if (obj == null || typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(sub)) {
    const actual = (obj as Record<string, unknown>)[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if (!deepSubset(v as Record<string, unknown>, actual)) return false;
    } else if (JSON.stringify(actual) !== JSON.stringify(v)) return false;
  }
  return true;
}

/**
 * Assert `expected` appears in `events` as an ordered subsequence (interleaving
 * step and command events between expected entries is allowed and normal).
 * Optional entries are skipped when they do not match — they never block progress.
 */
export function matchEventSubsequence(events: TaskEvent[], expected: EventExpect[]): SubsequenceResult {
  const matches = (e: TaskEvent, want: EventExpect) =>
    e.type === want.type && (!want.payloadSub || deepSubset(want.payloadSub, e.payload ?? {}));
  let ptr = 0;
  for (const e of events) {
    let want = expected[ptr];
    // Skip optional entries that this event does not satisfy.
    while (want?.optional && !matches(e, want)) {
      ptr++;
      want = expected[ptr];
    }
    if (!want) break;
    if (matches(e, want)) ptr++;
  }
  // Trailing optional entries at the end may be skipped.
  while (ptr < expected.length && expected[ptr].optional) ptr++;
  if (ptr === expected.length) return { ok: true, detail: 'matched' };
  const missing = expected.slice(ptr).filter((m) => !m.optional);
  return {
    ok: false,
    detail:
      `event subsequence unmatched after ${ptr}/${expected.length} entries; ` +
      `first missing: ${JSON.stringify(missing[0] ?? '(optional)')}; ` +
      `actual types: ${events.map((e) => e.type).join(', ')}`,
  };
}

/** All task events must come from the §2.5 closed set (membership assertion). */
export function assertClosedEventSet(events: TaskEvent[], allowed: readonly string[]): string[] {
  return events.filter((e) => !allowed.includes(e.type)).map((e) => e.type);
}

/** Per-task seq must be strictly monotonic (§2.5). */
export function isStrictlyIncreasing(nums: number[]): boolean {
  return nums.every((n, i) => i === 0 || n > nums[i - 1]);
}

export function sampleFor(samples: Sample[], tagId: string): Sample | undefined {
  return samples.find((s) => s.tagId === tagId);
}

export async function listDir(dir: string): Promise<string[]> {
  return readdir(dir);
}
