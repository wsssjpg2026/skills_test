/**
 * Supervised driver plugin: one child process speaking the driver SPI
 * (architecture doc §2.3–§2.3.4) over ndjson stdio.
 *
 * Owns: spawn + `initialize` handshake, JSON-RPC 2.0 requests with deadlines,
 * per-direction ids, plugin→host notification dispatch, stderr forwarding,
 * heartbeat (idle `initialize`-level liveness ping every 30 s), stdio-silence
 * kill rule (> 2× deadline with in-flight requests), restart with exponential
 * backoff (1 s → 30 s cap, > 5 restarts / 10 min → `failed`), and full resync
 * (replay `initialize` + `channel.start` for the desired state) after every
 * restart.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  JSON_RPC_INVALID_REQUEST,
  SPI_DEFAULT_DEADLINE_MS,
  SPI_PROTOCOL_VERSION,
  type HostInfo,
  type InitializeResult,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from '@orch/contracts/spi';
import { BackpressureWriter, CappedLineReader } from './transport.js';

export type PluginLifecycleState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface RestartPolicy {
  initialMs: number;
  maxMs: number;
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  initialMs: 1000,
  maxMs: 30_000,
  maxRestarts: 5,
  windowMs: 600_000,
};

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** pino-shaped logger; the plugin-host stays dependency-free (§8). */
export interface PluginLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export const consolePluginLogger: PluginLogger = {
  debug: (obj, msg) => console.debug(JSON.stringify(obj), msg),
  info: (obj, msg) => console.info(JSON.stringify(obj), msg),
  warn: (obj, msg) => console.warn(JSON.stringify(obj), msg),
  error: (obj, msg) => console.error(JSON.stringify(obj), msg),
};

/** Plugin answered with a JSON-RPC error object. */
export class PluginRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'PluginRpcError';
  }
}

/** Request deadline expired (per §2.3.3 this degrades, not kills). */
export class PluginRequestTimeout extends Error {
  constructor(public readonly method: string, deadlineMs: number) {
    super(`plugin request "${method}" timed out after ${deadlineMs} ms`);
    this.name = 'PluginRequestTimeout';
  }
}

/** Plugin is not usable right now (dead, failed, restarting, or undiscovered). */
export class PluginUnavailableError extends Error {
  constructor(id: string, reason: PluginLifecycleState | 'not-discovered') {
    super(`plugin "${id}" is not available (${reason})`);
    this.name = 'PluginUnavailableError';
  }
}

export interface SupervisedPluginOptions {
  /** Identity used for logging and health reporting. */
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Sent inside `initialize`; identifies the host to the plugin. */
  hostInfo?: HostInfo;
  restart?: Partial<RestartPolicy>;
  /** Idle liveness ping interval; `<= 0` disables the heartbeat. */
  heartbeatIntervalMs?: number;
  /**
   * Perform the `initialize` handshake inside `start()` (default true). The
   * contract suite sets this to false so it can probe NOT_INITIALIZED first.
   */
  autoInitialize?: boolean;
  /** Invoked after EVERY successful `initialize` (crash restarts included) — the full-resync hook. */
  onReady?: () => Promise<void>;
  logger?: PluginLogger;
}

interface PendingRequest {
  method: string;
  sentAt: number;
  deadlineMs: number;
  bytesAtSend: number;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const SHUTDOWN_GRACE_MS = 2_000;

export class SupervisedPlugin extends EventEmitter {
  readonly id: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly hostInfo: HostInfo;
  private readonly policy: RestartPolicy;
  private readonly heartbeatIntervalMs: number;
  private readonly autoInitialize: boolean;
  private readonly onReady?: () => Promise<void>;
  protected readonly log: PluginLogger;

  private child: ChildProcess | null = null;
  private writer: BackpressureWriter | null = null;
  private stateValue: PluginLifecycleState = 'stopped';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastByteAt = 0;
  private lastRequestAt = 0;
  private lastHeartbeatAt = 0;
  private intent: 'run' | 'restart' | 'stop' = 'run';
  private stoppedPromise: Promise<void> | null = null;
  private initializeResult: InitializeResult | null = null;

  constructor(opts: SupervisedPluginOptions) {
    super();
    this.id = opts.id;
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.hostInfo = opts.hostInfo ?? { name: '@orch/plugin-host', version: '0.1.0' };
    this.policy = { ...DEFAULT_RESTART_POLICY, ...opts.restart };
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.autoInitialize = opts.autoInitialize ?? true;
    this.onReady = opts.onReady;
    this.log = opts.logger ?? consolePluginLogger;
  }

  get state(): PluginLifecycleState {
    return this.stateValue;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Exit code / signal of the most recent process (clean shutdown asserts 0). */
  lastExit: { code: number | null; signal: string | null } | null = null;

  /** Last successful `initialize` result (pluginInfo / capabilities). */
  get info(): InitializeResult | null {
    return this.initializeResult;
  }

  get capabilities(): readonly string[] {
    return this.initializeResult?.capabilities ?? [];
  }

  /**
   * Spawn the plugin and run the `initialize` handshake. Safe to call once;
   * later (re)spawns are driven by the supervisor itself.
   */
  async start(): Promise<void> {
    if (this.stateValue !== 'stopped' && this.stateValue !== 'failed') {
      throw new Error(`plugin "${this.id}" already started (state: ${this.stateValue})`);
    }
    this.intent = 'run';
    this.restarts = [];
    await this.spawnAndHandshake();
    this.startTicker();
  }

  /**
   * Send one host → plugin request. Works before `initialize` completes (the
   * contract suite relies on that to probe NOT_INITIALIZED).
   */
  request<T = unknown>(method: string, params?: unknown, opts: { deadlineMs?: number } = {}): Promise<T> {
    const deadlineMs = opts.deadlineMs ?? SPI_DEFAULT_DEADLINE_MS[method as keyof typeof SPI_DEFAULT_DEADLINE_MS] ?? 5_000;
    if (this.stateValue === 'stopped' || this.stateValue === 'failed') {
      return Promise.reject(new PluginUnavailableError(this.id, this.stateValue));
    }
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new PluginUnavailableError(this.id, this.stateValue));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0' as const, id, method, params });
    this.lastRequestAt = Date.now();

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        sentAt: Date.now(),
        deadlineMs,
        bytesAtSend: this.lastByteAt,
        settled: false,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          // Deadline expiry degrades the caller, not the plugin (§2.3.3). The
          // entry stays pending (marked) so the silence rule can still see it.
          entry.settled = true;
          reject(new PluginRequestTimeout(method, deadlineMs));
        }, deadlineMs),
      };
      this.pending.set(id, entry);
      try {
        this.writer?.write(message);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Convenience: the whole lifecycle handshake. */
  initialize(deadlineMs?: number): Promise<InitializeResult> {
    return this.request<InitializeResult>(
      'initialize',
      { protocolVersion: SPI_PROTOCOL_VERSION, hostInfo: this.hostInfo },
      { deadlineMs },
    );
  }

  /**
   * Graceful stop: `shutdown` request → wait exit → SIGTERM → SIGKILL.
   * Idempotent.
   */
  async stop(reason = 'host shutdown'): Promise<void> {
    this.stoppedPromise ??= this.doStop(reason);
    return this.stoppedPromise;
  }

  private async doStop(reason: string): Promise<void> {
    this.intent = 'stop';
    this.stopTicker();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        // State flips to 'stopped' only AFTER the request: the request guard
        // rejects calls on stopped plugins.
        await this.request('shutdown', { reason }, { deadlineMs: SPI_DEFAULT_DEADLINE_MS.shutdown });
      } catch {
        /* best effort — SIGTERM follows */
      }
      this.setState('stopped');
      await this.waitForExit(child, SHUTDOWN_GRACE_MS);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await this.waitForExit(child, SHUTDOWN_GRACE_MS);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    } else {
      this.setState('stopped');
    }
    this.failAllPending(new PluginUnavailableError(this.id, 'stopped'));
    this.log.info({ plugin: this.id, reason }, 'plugin stopped');
  }

  private waitForExit(child: ChildProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve();
      }, ms);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', onExit);
    });
  }

  // --- spawn / respawn ------------------------------------------------------

  private async spawnAndHandshake(): Promise<void> {
    this.setState('starting');
    this.spawnProcess();
    if (!this.autoInitialize) return;

    try {
      const result = await this.initialize();
      this.initializeResult = result;
      this.setState('running');
      this.log.info(
        { plugin: this.id, pid: this.pid, pluginInfo: result.pluginInfo, capabilities: result.capabilities },
        'plugin initialized',
      );
    } catch (err) {
      this.log.error({ plugin: this.id, err: errText(err) }, 'initialize handshake failed');
      // initialize failure = unresponsive/faulty plugin → supervision path
      this.killForRestart();
      return;
    }

    try {
      await this.onReady?.();
    } catch (err) {
      // Full resync is part of the lifecycle; a failing resync degrades the
      // channel, not the plugin — #4 turns this into channel state.
      this.log.error({ plugin: this.id, err: errText(err) }, 'full resync after initialize failed');
    }
  }

  private spawnProcess(): void {
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: this.env,
    });
    this.child = child;
    this.intent = 'run';
    const reader = new CappedLineReader();
    this.writer = new BackpressureWriter(child.stdin!);

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.lastByteAt = Date.now();
      let lines: string[];
      try {
        lines = reader.push(Buffer.from(chunk, 'utf8'));
      } catch (err) {
        this.log.error({ plugin: this.id, err: errText(err) }, 'protocol violation on plugin stdout');
        this.killForRestart();
        return;
      }
      for (const line of lines) this.handleLine(line);
    });
    child.stdout!.on('end', () => {
      for (const line of reader.rest()) this.handleLine(line);
    });
    child.stdout!.on('error', () => this.handleStreamError('stdout'));

    // stderr belongs to the plugin's logs: forward prefixed (§2.3).
    const stderrReader = new CappedLineReader();
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = stderrReader.push(Buffer.from(chunk, 'utf8'));
      } catch {
        return; // oversize stderr line: dropped, not fatal
      }
      for (const line of lines) this.emit('stderr', line);
    });
    child.stderr!.on('error', () => this.handleStreamError('stderr'));

    child.on('error', (err) => {
      this.log.error({ plugin: this.id, err: err.message }, 'plugin process error');
      this.handleUnexpectedExit();
    });
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal };
      this.log.debug({ plugin: this.id, code, signal }, 'plugin process exited');
      this.handleUnexpectedExit();
    });

    this.log.info({ plugin: this.id, pid: child.pid, command: `${this.command} ${this.args.join(' ')}`.trim() }, 'plugin spawned');
  }

  private handleStreamError(which: string): void {
    this.log.warn({ plugin: this.id, stream: which }, 'plugin stream error');
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn({ plugin: this.id, line: line.slice(0, 200) }, 'unparseable line from plugin');
      return;
    }
    if (msg === null || typeof msg !== 'object') {
      this.log.warn({ plugin: this.id }, 'non-object message from plugin');
      return;
    }
    const m = msg as Record<string, unknown>;

    // Plugin → host direction is notifications only: a message with an id AND
    // a method is an upward request — a spec violation. Reject it explicitly.
    if (m.method !== undefined && m.id !== undefined) {
      this.log.error({ plugin: this.id, method: m.method }, 'plugin sent a request upward (notifications only in v1)');
      this.writer?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: JSON_RPC_INVALID_REQUEST, message: 'plugin→host direction is notifications only' },
        }),
      );
      return;
    }

    if (m.method !== undefined) {
      this.dispatchNotification(m as unknown as JsonRpcNotification);
      return;
    }

    if (m.id !== undefined) {
      this.settleResponse(m as unknown as JsonRpcResponse);
      return;
    }

    this.log.warn({ plugin: this.id }, 'message from plugin is neither request, response, nor notification');
  }

  private dispatchNotification(n: JsonRpcNotification): void {
    // Emit synchronously; heavy consumers batch on their own side.
    this.emit('notification', n);
  }

  private settleResponse(response: JsonRpcResponse): void {
    const id = typeof response.id === 'number' ? response.id : Number(response.id);
    const entry = this.pending.get(id);
    if (!entry) {
      this.log.warn({ plugin: this.id, id: response.id }, 'response with unknown request id');
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (entry.settled) return; // caller already timed out
    if (response.error) {
      const e: JsonRpcErrorObject = response.error;
      entry.reject(new PluginRpcError(e.code, e.message, e.data));
    } else {
      entry.resolve(response.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(err);
      }
    }
    this.pending.clear();
  }

  // --- supervision ----------------------------------------------------------

  private handleUnexpectedExit(): void {
    if (this.stateValue === 'stopped' || this.intent === 'stop') return;
    this.failAllPending(new PluginUnavailableError(this.id, this.stateValue));
    if (this.intent === 'restart') return; // respawn already scheduled
    this.scheduleRestart();
  }

  private killForRestart(): void {
    this.scheduleRestart(); // respawn is scheduled exactly once, from here
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, SHUTDOWN_GRACE_MS).unref();
    }
  }

  /** Exponential backoff 1 s → 30 s; > maxRestarts within windowMs → failed (§2.3.4). */
  private scheduleRestart(): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'failed') return;
    if (this.intent === 'restart' && this.restartTimer) return; // already scheduled
    this.intent = 'restart';
    this.failAllPending(new PluginUnavailableError(this.id, this.stateValue));

    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < this.policy.windowMs);
    this.restarts.push(now);
    if (this.restarts.length > this.policy.maxRestarts) {
      this.setState('failed');
      this.log.error(
        { plugin: this.id, restarts: this.restarts.length, windowMs: this.policy.windowMs },
        'plugin exceeded restart budget — marked failed (channel failed, alarm at #4)',
      );
      return;
    }

    const backoff = Math.min(
      this.policy.initialMs * 2 ** (this.restarts.length - 1),
      this.policy.maxMs,
    );
    this.setState('restarting');
    this.log.warn({ plugin: this.id, backoffMs: backoff, restartNo: this.restarts.length }, 'plugin restart scheduled');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnAndHandshake();
    }, backoff);
    this.restartTimer.unref();
  }

  private startTicker(): void {
    this.tickTimer ??= setInterval(() => this.tick(), 500);
    this.tickTimer.unref();
  }

  private stopTicker(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (this.stateValue !== 'running') return;
    const now = Date.now();

    // Kill rule (§2.3.4): stdio silence with in-flight requests > 2× deadline.
    for (const [, entry] of this.pending) {
      if (now - entry.sentAt > 2 * entry.deadlineMs && this.lastByteAt <= entry.bytesAtSend) {
        this.log.error(
          { plugin: this.id, method: entry.method, waitedMs: now - entry.sentAt },
          'plugin silent with in-flight requests — restarting',
        );
        this.killForRestart();
        return;
      }
    }

    // Heartbeat: idle `initialize`-level liveness ping (§2.3.4). initialize is
    // replayable by contract (every restart replays it), so it is the probe.
    if (
      this.heartbeatIntervalMs > 0 &&
      this.pending.size === 0 &&
      now - this.lastRequestAt >= this.heartbeatIntervalMs &&
      now - this.lastByteAt >= this.heartbeatIntervalMs &&
      now - this.lastHeartbeatAt >= this.heartbeatIntervalMs
    ) {
      this.lastHeartbeatAt = now;
      this.initialize()
        .then(() => this.log.debug({ plugin: this.id }, 'heartbeat ok'))
        .catch((err) => {
          this.log.error({ plugin: this.id, err: errText(err) }, 'heartbeat failed — restarting');
          this.killForRestart();
        });
    }
  }

  private setState(state: PluginLifecycleState): void {
    if (this.stateValue === state) return;
    const previous = this.stateValue;
    this.stateValue = state;
    this.emit('state', state, previous);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
