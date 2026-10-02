// [test-support] Doc-derived stub — REWIRED AT MERGE.
// Minimal public-API client per architecture.md §2.0–§2.2 (REST /api/v1 + /ws/tags).
// Types here restate the contract shapes from the doc; after merge they may be
// replaced by @orch/contracts types.
import WebSocket from 'ws';

export type Quality = 'good' | 'bad' | 'uncertain';

export interface Sample {
  tagId?: string;
  topic?: string;
  value: unknown;
  quality: Quality;
  reason?: string;
  ts: string;
}

export interface Channel {
  id: string;
  name: string;
  driver: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface Device {
  id: string;
  channelId: string;
  name: string;
  address: string;
  enabled: boolean;
  config: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Tag {
  id: string;
  deviceId: string;
  name: string;
  dataType: string;
  address: string;
  access: 'read' | 'write' | 'readwrite';
  historyEnabled?: boolean;
  scanPeriodMs?: number;
  byteOrder?: string;
  scaling?: { slope?: number; offset?: number };
  deadband?: { abs?: number; pct?: number };
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TaskEvent {
  seq: number;
  ts: string;
  taskId: string;
  type: string;
  payload?: Record<string, unknown>;
  actor?: string;
}

export interface Task {
  id: string;
  flowId: string;
  version?: number;
  status: string;
  currentNodeIds?: string[];
  input?: unknown;
  suspendReason?: string;
  startedAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/** REST client for /api/v1 with bearer auth (§2.1). */
export class OrchApi {
  constructor(
    public readonly baseUrl: string,
    private token?: string,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = json?.error;
      throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
    }
    return json as T;
  }

  login(username: string, password: string): Promise<{ token: string; expiresAt: string; user: unknown }> {
    return this.req('POST', '/auth/login', { username, password });
  }

  health(path: 'live' | 'ready' = 'ready'): Promise<any> {
    return fetch(`${this.baseUrl}/health/${path}`).then((r) => r.json());
  }

  // channels / devices / tags
  createChannel(body: Partial<Channel> & { name: string; driver: string }): Promise<Channel> {
    return this.req('POST', '/channels', body);
  }
  getChannel(id: string): Promise<Channel> {
    return this.req('GET', `/channels/${id}`);
  }
  patchChannel(id: string, body: Partial<Channel>): Promise<Channel> {
    return this.req('PATCH', `/channels/${id}`, body);
  }
  deleteChannel(id: string): Promise<void> {
    return this.req('DELETE', `/channels/${id}`);
  }
  testChannel(id: string, timeoutMs = 10_000): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
    return Promise.race([
      this.req('POST', `/channels/${id}/test`, {}),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('channel test client timeout')), timeoutMs)),
    ]);
  }
  createDevice(channelId: string, body: Partial<Device> & { name: string }): Promise<Device> {
    return this.req('POST', '/devices', { channelId, ...body });
  }
  patchDevice(id: string, body: Partial<Device>): Promise<Device> {
    return this.req('PATCH', `/devices/${id}`, body);
  }
  byteorderDiagnostics(deviceId: string, body: { tagId: string; testValue: number }): Promise<{
    ok: boolean;
    readBack?: number;
    diagnosis?: string;
  }> {
    return this.req('POST', `/devices/${deviceId}/diagnostics/byteorder`, body);
  }
  createTag(body: Partial<Tag> & { deviceId: string; name: string }): Promise<Tag> {
    return this.req('POST', '/tags', body);
  }
  createTags(items: Partial<Tag>[]): Promise<{ items: Tag[] }> {
    return this.req('POST', '/tags:batch', { items });
  }
  listTags(query = ''): Promise<Page<Tag>> {
    return this.req('GET', `/tags${query}`);
  }
  tagValues(params: { ids?: string[]; filter?: string }): Promise<{ samples: Sample[] }> {
    const q = new URLSearchParams();
    if (params.ids) q.set('ids', params.ids.join(','));
    if (params.filter) q.set('filter', params.filter);
    return this.req('GET', `/tags/values?${q.toString()}`);
  }
  history(tagId: string, query: string): Promise<{ samples: Sample[] }> {
    return this.req('GET', `/history/tags/${tagId}${query}`);
  }

  // flows & tasks
  createFlow(body: { name: string; spec: unknown }): Promise<{ flowId: string; version: number }> {
    return this.req('POST', '/flows', body);
  }
  createTask(body: { flowId: string; version?: number; input?: unknown }): Promise<Task> {
    return this.req('POST', '/tasks', body);
  }
  getTask(id: string): Promise<Task> {
    return this.req('GET', `/tasks/${id}`);
  }
  listTasks(query = ''): Promise<Page<Task>> {
    return this.req('GET', `/tasks${query}`);
  }
  taskCommand(id: string, type: string): Promise<Task> {
    return this.req('POST', `/tasks/${id}/commands`, { type });
  }
  taskEvents(id: string, query = ''): Promise<Page<TaskEvent>> {
    return this.req('GET', `/tasks/${id}/events${query}`);
  }
  async allTaskEvents(id: string): Promise<TaskEvent[]> {
    const out: TaskEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await this.taskEvents(id, q);
      out.push(...page.items);
      cursor = page.cursor;
      if (!cursor || page.items.length === 0) return out;
    }
  }

  // northbound
  mesStatus(): Promise<{ state: string; lastMsgAt?: string }> {
    return this.req('GET', '/northbound/mes/status');
  }
  putMesConfig(cfg: Record<string, unknown>): Promise<unknown> {
    return this.req('PUT', '/northbound/mes/config', cfg);
  }
  mqttConfig(): Promise<any> {
    return this.req('GET', '/northbound/mqtt/config');
  }

  // alarms (used by store-and-forward bounds assertions)
  listAlarms(query = ''): Promise<Page<any>> {
    return this.req('GET', `/alarms${query}`);
  }

  async waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 15_000, intervalMs = 250): Promise<T> {
    const t0 = Date.now();
    let lastErr: unknown;
    for (;;) {
      try {
        const v = await fn();
        if (pred(v)) return v;
      } catch (e) {
        lastErr = e;
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`waitFor timeout${lastErr ? ` (last error: ${String(lastErr)})` : ''}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  cursor?: string;
}

/**
 * /ws/tags client per §2.2: hello-auth first frame, subscribe with optional
 * trailing '*', batched `data` pushes of change-detected updates only.
 */
export class TagsWsClient {
  private ws?: WebSocket;
  private queue: { topic: string; value: unknown; quality: Quality; reason?: string | null; ts: string }[] = [];
  private opened = false;
  private readonly pendingWaiters: Array<{
    pred: (u: any) => boolean;
    resolve: (u: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  async connect(baseUrl: string, token: string): Promise<void> {
    const url = baseUrl.replace(/^http/, 'ws') + '/ws/tags';
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', reject);
    });
    this.opened = true;
    this.ws.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.op === 'data') {
        for (const u of msg.updates ?? []) {
          this.queue.push(u);
          for (let i = this.pendingWaiters.length - 1; i >= 0; i--) {
            const w = this.pendingWaiters[i];
            if (w.pred(u)) {
              clearTimeout(w.timer);
              this.pendingWaiters.splice(i, 1);
              w.resolve(u);
            }
          }
        }
      }
    });
    this.send({ op: 'hello', token });
    await this.waitForServer((m: any) => m.op === 'welcome');
    // Assumption A-ws-welcome: welcome frame is pushed by server on hello.
  }

  private serverFrames: any[] = [];
  private serverWaiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; timer: NodeJS.Timeout }> = [];

  private waitForServer(pred: (m: any) => boolean, timeoutMs = 5_000): Promise<any> {
    const found = this.serverFrames.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ws server frame')), timeoutMs);
      this.serverWaiters.push({ pred, resolve, timer });
    });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('ws not open');
    this.ws.send(JSON.stringify(msg));
  }

  async subscribe(topics: string[]): Promise<void> {
    this.send({ op: 'subscribe', topics });
    await this.waitForServer((m: any) => m.op === 'subscribed');
  }

  waitForUpdate(pred: (u: any) => boolean, timeoutMs = 10_000): Promise<any> {
    const found = this.queue.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ws update`)), timeoutMs);
      this.pendingWaiters.push({ pred, resolve, timer });
    });
  }

  close(): void {
    this.ws?.close();
  }
}
