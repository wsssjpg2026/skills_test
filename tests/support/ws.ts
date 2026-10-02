// doc-derived test stub — rewired to @orch/* at merge.
// §2.2 WebSocket client for /ws/tags: hello/welcome auth-by-first-frame, subscribe +
// snapshot, batched change-only data pushes, unsubscribe, ping/pong, error frames.
// Uses the Node 24 global WebSocket (no ws dependency needed on the client side).

import type { WsClientFrame, WsFrame, WsSnapshotEntry, WsUpdate } from './types.js';
import { waitUntil } from './util.js';

export type AnyFrame = WsFrame & Record<string, unknown>;

export class WsTagsClient {
  private socket: WebSocket | undefined;
  readonly frames: AnyFrame[] = [];
  private closed = false;
  private closeCode: number | undefined;

  private constructor(public url: string) {}

  /** Connect and authenticate; resolves on `welcome`. Throws on error frame / close before welcome. */
  static async connect(port: number, token: string, opts: { timeoutMs?: number } = {}): Promise<WsTagsClient> {
    const url = `ws://127.0.0.1:${port}/ws/tags`;
    const client = new WsTagsClient(url);
    await client.open(token, opts.timeoutMs ?? 5_000);
    return client;
  }

  private open(token: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.socket = ws;
      const fail = (err: Error) => {
        if (this.socket === ws) this.socket = undefined;
        reject(err);
      };
      ws.addEventListener('open', () => {
        this.send({ op: 'hello', token });
      });
      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(String(ev.data)) as AnyFrame;
        this.frames.push(frame);
        if (frame.op === 'welcome') resolve();
      });
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.closeCode = ev.code;
      });
      ws.addEventListener('error', () => {
        /* surfaced via close or via absent welcome */
      });
      // Deadline: welcome must arrive (or an error frame / close explains why not).
      setTimeout(() => {
        if (this.frames.some((f) => f.op === 'welcome')) return resolve();
        const errFrame = this.frames.find((f) => f.op === 'error');
        if (errFrame) {
          return fail(new Error(`hello rejected with error frame: ${JSON.stringify(errFrame)}`));
        }
        if (this.closed) {
          return fail(new Error(`socket closed before welcome (code=${this.closeCode})`));
        }
        fail(new Error(`no welcome within ${timeoutMs}ms; frames=${JSON.stringify(this.frames)}`));
      }, timeoutMs).unref();
    });
  }

  get isOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  send(frame: WsClientFrame): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`ws not open (closed=${this.closed})`);
    }
    this.socket.send(JSON.stringify(frame));
  }

  /** Wait for the next frame matching pred (scans buffered frames first). */
  async next(pred: (f: AnyFrame) => boolean, timeoutMs = 5_000, label = 'frame'): Promise<AnyFrame> {
    return waitUntil(
      () => {
        for (const f of this.frames) if (pred(f)) return f;
        return undefined;
      },
      { timeoutMs, intervalMs: 25, label },
    );
  }

  async subscribe(topics: string[], timeoutMs = 5_000): Promise<{ snapshot: WsSnapshotEntry[] }> {
    this.send({ op: 'subscribe', topics });
    const ack = await this.next((f) => f.op === 'subscribed', timeoutMs, `subscribed ${topics.join(',')}`);
    return { snapshot: (ack.snapshot ?? []) as WsSnapshotEntry[] };
  }

  async unsubscribe(topics: string[], timeoutMs = 5_000): Promise<void> {
    this.send({ op: 'unsubscribe', topics });
    await this.next(
      (f) => f.op === 'unsubscribed' && JSON.stringify(f.topics) === JSON.stringify(topics),
      timeoutMs,
      `unsubscribed ${topics.join(',')}`,
    );
  }

  async ping(timeoutMs = 5_000): Promise<void> {
    this.send({ op: 'ping' });
    await this.next((f) => f.op === 'pong', timeoutMs, 'pong');
  }

  /** Wait until an update matching pred appears in a data frame. */
  async waitForUpdate(pred: (u: WsUpdate) => boolean, timeoutMs = 5_000, label = 'update'): Promise<WsUpdate> {
    return waitUntil(
      () => {
        for (const f of this.frames) {
          if (f.op !== 'data') continue;
          for (const u of (f.updates ?? []) as WsUpdate[]) if (pred(u)) return u;
        }
        return undefined;
      },
      { timeoutMs, intervalMs: 25, label },
    );
  }

  /** All updates seen so far (flattened across data frames), in arrival order. */
  allUpdates(): WsUpdate[] {
    const out: WsUpdate[] = [];
    for (const f of this.frames) if (f.op === 'data') out.push(...((f.updates ?? []) as WsUpdate[]));
    return out;
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}
