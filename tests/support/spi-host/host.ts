// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with test/spec branch helpers).
// Derived from architecture.md §2.3 (Driver SPI — JSON-RPC 2.0 over ndjson on stdio),
// §2.3.1–§2.3.4. This is the independent oracle's own host harness: it is NOT
// @orch/plugin-host; it spawns any plugin command and speaks the documented wire
// contract directly, so contract failures cannot be masked by implementation bugs.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Application error codes — architecture.md §2.3.3 (stable, defined in contracts). */
export const SpiErrorCodes = {
  DRIVER_INTERNAL: -32000,
  NOT_INITIALIZED: -32001,
  DEVICE_NOT_FOUND: -32002,
  TAG_NOT_FOUND: -32003,
  ADDRESS_INVALID: -32004,
  NOT_CONNECTED: -32005,
  TIMEOUT: -32006,
  BUSY: -32007,
  WRITE_REJECTED: -32008,
  COMMAND_REJECTED: -32009,
  SHUTTING_DOWN: -32010,
} as const;

/** Reserved JSON-RPC 2.0 standard codes (§2.3.3). */
export const StdRpcCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // §2.3: max message 16 MiB

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class SpiRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
    public readonly method: string = '?',
  ) {
    super(`JSON-RPC error ${code} from method '${method}': ${message}`);
  }
}

export interface IncomingNotification {
  method: string;
  params: any;
  receivedAt: number;
  raw: any;
}

export interface HostOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Deadline used when a request does not pass an explicit deadline. */
  defaultDeadlineMs?: number;
}

/**
 * Minimal host per §2.3: spawns the plugin, frames one JSON-RPC 2.0 message per
 * `\n` on stdin/stdout, issues downward requests with increasing integer ids,
 * and collects upward notifications. stderr is ignored (it belongs to plugin logs).
 */
export class SpiHostHarness {
  readonly child: ChildProcess;
  readonly sentMethods: string[] = [];
  readonly notifications: IncomingNotification[] = [];
  /** Protocol violations observed on the plugin→host stream. */
  readonly violations: string[] = [];
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }
  >();
  private waiters: Array<{
    method: string;
    pred: (p: any) => boolean;
    resolve: (n: IncomingNotification) => void;
    timer: NodeJS.Timeout;
    reject: (e: Error) => void;
  }> = [];
  private buf = '';
  private readonly defaultDeadlineMs: number;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitWaiters: Array<{ resolve: (c: number | null) => void; timer: NodeJS.Timeout }> = [];
  readonly exited$ = new EventEmitter();

  constructor(
    readonly command: string[],
    opts: HostOptions = {},
  ) {
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? 10_000;
    this.child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } as Record<string, string> : process.env,
      stdio: ['pipe', 'pipe', 'pipe'], // stderr = plugin logs; we only count it
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.exitWaiters) {
        clearTimeout(w.timer);
        w.resolve(code);
      }
      this.exitWaiters = [];
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`plugin exited before responding to '${p.method}'`));
      }
      this.pending.clear();
      this.exited$.emit('exit', code, signal);
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 2 * MAX_MESSAGE_BYTES) {
      this.violations.push(`stdout buffer exceeded 2x max message size without newline framing`);
      this.buf = '';
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      this.violations.push(`message exceeds 16 MiB cap (${Buffer.byteLength(line)} bytes)`);
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.violations.push(`non-JSON line on stdout: ${line.slice(0, 120)}`);
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      this.violations.push(`non-object message on stdout`);
      return;
    }
    // §2.3: plugin→host direction uses notifications only (no upward requests in v1).
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      this.violations.push(
        `plugin sent an upward REQUEST (method='${msg.method}', id=${msg.id}) — notifications only in v1`,
      );
      return;
    }
    if (typeof msg.method === 'string') {
      const n: IncomingNotification = {
        method: msg.method,
        params: msg.params ?? {},
        receivedAt: Date.now(),
        raw: msg,
      };
      this.notifications.push(n);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.method === msg.method && w.pred(n.params)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(n);
        }
      }
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.violations.push(`response for unknown id=${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg && msg.error) {
        const e = msg.error as RpcErrorObject;
        p.reject(new SpiRpcError(e.code, e.message ?? '', e.data, p.method));
      } else {
        p.resolve(msg.result ?? {});
      }
    }
  }

  /** Send a host→plugin request; resolves with the result, rejects with SpiRpcError. */
  request<T = any>(method: string, params: object = {}, deadlineMs?: number): Promise<T> {
    const id = this.nextId++;
    const deadline = deadlineMs ?? this.defaultDeadlineMs;
    this.sentMethods.push(method);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`deadline (${deadline}ms) expired waiting for '${method}'`));
      }, deadline);
      this.pending.set(id, { resolve: resolve as any, reject, timer, method });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child.stdin!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Resolve with the first (already-received or future) notification matching pred. */
  waitForNotification(
    method: string,
    pred: (params: any) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<IncomingNotification> {
    const found = this.notifications.find((n) => n.method === method && pred(n.params));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout (${timeoutMs}ms) waiting for notification '${method}'`));
      }, timeoutMs);
      this.waiters.push({ method, pred, resolve, timer, reject });
    });
  }

  notificationsOf(method: string): any[] {
    return this.notifications.filter((n) => n.method === method).map((n) => n.params);
  }

  /** §2.3 lifecycle: shutdown request must return {} and the process exits 0. */
  async gracefulShutdown(reason = 'test-complete'): Promise<void> {
    const res = await this.request('shutdown', { reason }, 5_000);
    if (!res || typeof res !== 'object' || Object.keys(res).length !== 0) {
      throw new Error(`shutdown result must be {} — got ${JSON.stringify(res)}`);
    }
    const code = await this.waitForExit(5_000);
    if (code !== 0) throw new Error(`plugin must exit 0 after shutdown — got ${code}`);
  }

  waitForExit(timeoutMs = 5_000): Promise<number | null> {
    if (this.exited) return Promise.resolve(this.exited.code);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null as any), timeoutMs);
      this.exitWaiters.push({ resolve, timer });
    });
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }

  get exitCode(): number | null | undefined {
    return this.exited ? this.exited.code : undefined;
  }
}

export function isISO8601(s: unknown): boolean {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}
