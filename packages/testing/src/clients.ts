/**
 * Typed clients, thin and doc-shaped (architecture doc §2.1 / §2.2).
 *
 * `OrchRestClient` talks real HTTP. `TagsWsClient` speaks the §2.2 frame set
 * (hello/welcome/subscribe/…); the `/ws/tags` endpoint itself lands with
 * ticket #4 — the client is the seam the frontend and the tests share.
 */
import WebSocket from 'ws';

// --- REST -------------------------------------------------------------------

/** §2.1 error envelope. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string; details?: object; requestId?: string };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: object,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RestHealth {
  status: string;
  version: string;
  uptimeSec: number;
  storage: { mode: string; ok: boolean };
  plugins: { id: string; state: string }[];
}

export class OrchRestClient {
  constructor(
    readonly baseUrl: string,
    private readonly opts: { token?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  setToken(token: string | undefined): void {
    this.opts.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const envelope = parsed as ApiErrorEnvelope;
      if (envelope?.error) {
        throw new ApiError(envelope.error.code, envelope.error.message, res.status, envelope.error.details);
      }
      throw new ApiError('INTERNAL', `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  healthLive(): Promise<RestHealth> {
    return this.get<RestHealth>('/health/live');
  }

  healthReady(): Promise<RestHealth> {
    return this.get<RestHealth>('/health/ready');
  }
}

// --- WebSocket (§2.2 frames) -------------------------------------------------

export type WsFrame =
  | { op: 'hello'; token: string }
  | { op: 'welcome'; serverTime: string; protocolVersion: number }
  | { op: 'subscribe'; topics: string[] }
  | { op: 'subscribed'; topics: string[]; snapshot: { topic: string; value: unknown; quality: string; ts: string }[] }
  | { op: 'unsubscribe'; topics: string[] }
  | { op: 'unsubscribed'; topics: string[] }
  | { op: 'data'; updates: { topic: string; value: unknown; quality: string; reason: string | null; ts: string }[] }
  | { op: 'ping' }
  | { op: 'pong' }
  | { op: 'error'; code: string; message: string };

export class TagsWsClient {
  private readonly ws: WebSocket;
  private readonly frames: WsFrame[] = [];
  private readonly waiters: { predicate: (f: WsFrame) => boolean; resolve: (f: WsFrame) => void; timer: NodeJS.Timeout }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as WsFrame;
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.predicate(frame)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
  }

  /** Connect and authenticate with the first frame (§2.2). */
  static async connect(baseUrl: string, token?: string, opts: { timeoutMs?: number } = {}): Promise<TagsWsClient> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/ws/tags`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), opts.timeoutMs ?? 5_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const client = new TagsWsClient(ws);
    client.send({ op: 'hello', token: token ?? '' });
    await client.waitFor((f) => f.op === 'welcome', opts.timeoutMs ?? 5_000, 'welcome frame');
    return client;
  }

  send(frame: WsFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  async subscribe(topics: string[], timeoutMs = 5_000): Promise<Extract<WsFrame, { op: 'subscribed' }>> {
    this.send({ op: 'subscribe', topics });
    return (await this.waitFor((f) => f.op === 'subscribed', timeoutMs, 'subscribed frame')) as Extract<
      WsFrame,
      { op: 'subscribed' }
    >;
  }

  async unsubscribe(topics: string[], timeoutMs = 5_000): Promise<Extract<WsFrame, { op: 'unsubscribed' }>> {
    this.send({ op: 'unsubscribe', topics });
    return (await this.waitFor((f) => f.op === 'unsubscribed', timeoutMs, 'unsubscribed frame')) as Extract<
      WsFrame,
      { op: 'unsubscribed' }
    >;
  }

  async nextData(timeoutMs = 5_000): Promise<Extract<WsFrame, { op: 'data' }>> {
    return (await this.waitFor((f) => f.op === 'data', timeoutMs, 'data frame')) as Extract<WsFrame, { op: 'data' }>;
  }

  async ping(): Promise<void> {
    this.send({ op: 'ping' });
    await this.waitFor((f) => f.op === 'pong', 5_000, 'pong frame');
  }

  received(): WsFrame[] {
    return [...this.frames];
  }

  close(): void {
    this.ws.close();
  }

  private waitFor(predicate: (f: WsFrame) => boolean, timeoutMs: number, what: string): Promise<WsFrame> {
    const seen = this.frames.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timeout waiting for ${what}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}
