// doc-derived test stub — rewired to @orch/* at merge.
// §2.1 REST client. Base path /api/v1, Bearer auth, and the normative error envelope
// { error: { code, message, details?, requestId } } surfaced as ApiError.

import type {
  AlarmInstance, AlarmRule, AuditRecord, ByteorderDiagnosticResult, Channel,
  ChannelTestResult, Device, ErrorEnvelope, FlowDefinition, FlowVersion, FlowVersionMeta,
  HealthStatus, LoginResponse, Page, Resource, ResourceLockInfo, Role, Sample, SystemCommand,
  Task, TaskCommand, TaskEvent, User,
} from './types.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | undefined,
    public details: unknown,
  ) {
    super(`HTTP ${status} ${code}: ${message}`);
  }
}

export interface RawResponse {
  status: number;
  body: unknown;
  text: string;
}

export class RestClient {
  constructor(
    public baseUrl: string,
    public token?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async raw(method: string, path: string, body?: unknown, opts: { text?: boolean } = {}): Promise<RawResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: this.headers(opts.text ? { 'content-type': 'text/plain' } : {}),
      body: body === undefined ? undefined : opts.text ? String(body) : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined; // export endpoint returns canonical JSON text — still JSON, but be safe
    }
    return { status: res.status, body: parsed, text };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status >= 200 && res.status < 300) return res.body as T;
    throw toApiError(res);
  }

  /** Call expecting a non-2xx; asserts the error envelope shape and returns it. */
  async expectError(
    method: string,
    path: string,
    body?: unknown,
    wantCode?: string,
    wantStatus?: number,
  ): Promise<ErrorEnvelope> {
    const res = await this.raw(method, path, body);
    if (res.status < 400) {
      throw new Error(`expected error for ${method} ${path}, got ${res.status}: ${res.text.slice(0, 200)}`);
    }
    if (wantStatus) expectEq(res.status, wantStatus, `status for ${method} ${path}`);
    const env = res.body as ErrorEnvelope;
    if (!env || typeof env !== 'object' || !('error' in env) || env.error == null) {
      throw new Error(`missing error envelope for ${method} ${path}: ${res.text.slice(0, 300)}`);
    }
    if (typeof env.error.code !== 'string' || env.error.code.length === 0) {
      throw new Error(`error.code must be a non-empty string for ${method} ${path}`);
    }
    if (typeof env.error.message !== 'string') {
      throw new Error(`error.message must be a string for ${method} ${path}`);
    }
    if (typeof env.error.requestId !== 'string' || !env.error.requestId.startsWith('req_')) {
      throw new Error(
        `error.requestId must be an opaque string starting "req_" for ${method} ${path}, got: ${env.error.requestId}`,
      );
    }
    if (wantCode) expectEq(env.error.code, wantCode, `error.code for ${method} ${path}`);
    return env;
  }

  withToken(token: string): RestClient {
    return new RestClient(this.baseUrl, token);
  }

  // ------------------------------------------------------------ health & auth

  healthLive(): Promise<HealthStatus> { return this.request('GET', '/health/live'); }
  healthReady(): Promise<HealthStatus> { return this.request('GET', '/health/ready'); }
  login(username: string, password: string): Promise<LoginResponse> {
    return this.request('POST', '/auth/login', { username, password });
  }
  me(): Promise<{ user: User }> { return this.request('GET', '/auth/me'); }

  // ------------------------------------------------------------ channels/devices/tags

  listChannels(): Promise<Channel[]> {
    return this.request<Page<Channel>>('GET', '/channels').then((p) => p.items);
  }
  createChannel(body: Partial<Channel>): Promise<Channel> { return this.request('POST', '/channels', body); }
  getChannel(id: string): Promise<Channel> { return this.request('GET', `/channels/${id}`); }
  patchChannel(id: string, body: Partial<Channel>): Promise<Channel> { return this.request('PATCH', `/channels/${id}`, body); }
  deleteChannel(id: string): Promise<void> { return this.request('DELETE', `/channels/${id}`); }
  testChannel(id: string): Promise<ChannelTestResult> { return this.request('POST', `/channels/${id}/test`); }

  listDevices(channelId?: string): Promise<Device[]> {
    const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : '';
    return this.request<Page<Device>>('GET', `/devices${q}`).then((p) => p.items);
  }
  createDevice(body: Partial<Device>): Promise<Device> { return this.request('POST', '/devices', body); }
  getDevice(id: string): Promise<Device> { return this.request('GET', `/devices/${id}`); }
  patchDevice(id: string, body: Partial<Device>): Promise<Device> { return this.request('PATCH', `/devices/${id}`, body); }
  deleteDevice(id: string): Promise<void> { return this.request('DELETE', `/devices/${id}`); }
  byteorderDiagnostic(deviceId: string, body: { tagId: string; testValue: number }): Promise<ByteorderDiagnosticResult> {
    return this.request('POST', `/devices/${deviceId}/diagnostics/byteorder`, body);
  }

  listTags(filter: { deviceId?: string; channelId?: string; cursor?: string } = {}): Promise<Page<import('./types.js').Tag>> {
    const qs = Object.entries(filter)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.request('GET', `/tags${qs ? `?${qs}` : ''}`);
  }
  createTag(body: Partial<import('./types.js').Tag>): Promise<import('./types.js').Tag> {
    return this.request('POST', '/tags', body);
  }
  batchTags(items: Partial<import('./types.js').Tag>[]): Promise<unknown> {
    return this.request('POST', '/tags:batch', { items });
  }
  getTag(id: string): Promise<import('./types.js').Tag> { return this.request('GET', `/tags/${id}`); }
  patchTag(id: string, body: Partial<import('./types.js').Tag>): Promise<import('./types.js').Tag> {
    return this.request('PATCH', `/tags/${id}`, body);
  }
  deleteTag(id: string): Promise<void> { return this.request('DELETE', `/tags/${id}`); }
  tagValues(query: { ids?: string[]; filter?: string }): Promise<{ samples: Sample[] }> {
    const qs: string[] = [];
    if (query.ids) qs.push(`ids=${query.ids.join(',')}`);
    if (query.filter) qs.push(`filter=${encodeURIComponent(query.filter)}`);
    return this.request('GET', `/tags/values${qs.length ? `?${qs.join('&')}` : ''}`);
  }
  history(tagId: string, query: Record<string, string>): Promise<{ samples: Sample[] }> {
    const qs = Object.entries(query)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return this.request('GET', `/history/tags/${tagId}?${qs}`);
  }

  // ------------------------------------------------------------ flows

  createFlow(body: { name: string; spec: FlowDefinition; source?: string }): Promise<FlowVersion> {
    return this.request('POST', '/flows', body);
  }
  listFlows(): Promise<unknown[]> { return this.request<Page<unknown>>('GET', '/flows').then((p) => p.items); }
  getFlow(flowId: string): Promise<unknown> { return this.request('GET', `/flows/${flowId}`); }
  publishVersion(flowId: string, body: { spec: FlowDefinition; note?: string }): Promise<FlowVersion> {
    return this.request('POST', `/flows/${flowId}/versions`, body);
  }
  listVersions(flowId: string): Promise<Page<FlowVersionMeta>> {
    return this.request('GET', `/flows/${flowId}/versions`);
  }
  getVersion(flowId: string, v: number): Promise<FlowVersion> {
    return this.request('GET', `/flows/${flowId}/versions/${v}`);
  }
  /** Export returns canonical JSON TEXT (§2.4: sorted keys, LF, trailing newline). */
  async exportVersion(flowId: string, v: number): Promise<string> {
    const res = await this.raw('GET', `/flows/${flowId}/versions/${v}/export`);
    if (res.status !== 200) throw toApiError(res);
    return typeof res.body === 'string' ? (res.body as string) : res.text;
  }
  /** ASSUMPTION: import accepts a FlowDefinition JSON body; export returns canonical JSON text. */
  importFlow(spec: unknown): Promise<FlowVersion> { return this.request('POST', '/flows/import', spec); }

  // ------------------------------------------------------------ tasks

  createTask(body: { flowId: string; version?: number; input?: object }): Promise<Task> {
    return this.request('POST', '/tasks', body);
  }
  triggerWebhook(token: string, body: unknown): Promise<Task> {
    return this.request('POST', `/triggers/webhook/${encodeURIComponent(token)}`, body);
  }
  listTasks(filter: { status?: string; flowId?: string; cursor?: string } = {}): Promise<Page<Task>> {
    const qs = Object.entries(filter)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.request('GET', `/tasks${qs ? `?${qs}` : ''}`);
  }
  getTask(id: string): Promise<Task> { return this.request('GET', `/tasks/${id}`); }
  taskCommand(id: string, cmd: TaskCommand): Promise<Task> { return this.request('POST', `/tasks/${id}/commands`, cmd); }
  systemCommand(cmd: SystemCommand): Promise<unknown> { return this.request('POST', '/system/commands', cmd); }
  listEvents(taskId: string, cursor?: string): Promise<Page<TaskEvent>> {
    return this.request('GET', `/tasks/${taskId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  }
  /** Page through the full event history of a task. */
  async allEvents(taskId: string, maxPages = 200): Promise<TaskEvent[]> {
    const out: TaskEvent[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.listEvents(taskId, cursor);
      out.push(...page.items);
      cursor = page.cursor;
      if (!cursor) return out;
    }
    throw new Error(`event history paging did not terminate for task ${taskId}`);
  }

  // ------------------------------------------------------------ resources

  listResources(): Promise<Resource[]> {
    return this.request<Page<Resource>>('GET', '/resources').then((p) => p.items);
  }
  createResource(body: Partial<Resource>): Promise<Resource> { return this.request('POST', '/resources', body); }
  resourceLock(key: string): Promise<ResourceLockInfo> { return this.request('GET', `/resources/${encodeURIComponent(key)}/lock`); }

  // ------------------------------------------------------------ alarms

  listAlarmRules(): Promise<AlarmRule[]> {
    return this.request<Page<AlarmRule>>('GET', '/alarm-rules').then((p) => p.items);
  }
  createAlarmRule(body: Partial<AlarmRule>): Promise<AlarmRule> { return this.request('POST', '/alarm-rules', body); }
  patchAlarmRule(id: string, body: Partial<AlarmRule>): Promise<AlarmRule> { return this.request('PATCH', `/alarm-rules/${id}`, body); }
  deleteAlarmRule(id: string): Promise<void> { return this.request('DELETE', `/alarm-rules/${id}`); }
  listAlarms(state?: string): Promise<AlarmInstance[]> {
    return this.request<Page<AlarmInstance>>('GET', `/alarms${state ? `?state=${state}` : ''}`).then((p) => p.items);
  }
  ackAlarm(id: string): Promise<AlarmInstance> { return this.request('POST', `/alarms/${id}/ack`); }
  shelveAlarm(id: string, durationSec: number): Promise<AlarmInstance> {
    return this.request('POST', `/alarms/${id}/shelve`, { durationSec });
  }
  unshelveAlarm(id: string): Promise<AlarmInstance> { return this.request('POST', `/alarms/${id}/unshelve`); }

  // ------------------------------------------------------------ users/roles/audit

  listUsers(): Promise<User[]> { return this.request<Page<User>>('GET', '/users').then((p) => p.items); }
  createUser(body: { username: string; password: string; roles: string[] }): Promise<User> {
    return this.request('POST', '/users', body);
  }
  patchUser(id: string, body: Partial<User>): Promise<User> { return this.request('PATCH', `/users/${id}`, body); }
  listRoles(): Promise<Role[]> { return this.request<Page<Role>>('GET', '/roles').then((p) => p.items); }
  createRole(body: { name: string; permissions: string[] }): Promise<Role> {
    return this.request('POST', '/roles', body);
  }
  audit(query: { from?: string; to?: string; actor?: string; action?: string; resourceType?: string } = {}): Promise<Page<AuditRecord>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.request('GET', `/audit${qs ? `?${qs}` : ''}`);
  }
}

function toApiError(res: RawResponse): ApiError {
  const env = res.body as ErrorEnvelope | undefined;
  if (env && typeof env === 'object' && 'error' in env && env.error) {
    return new ApiError(res.status, env.error.code, env.error.message, env.error.requestId, env.error.details);
  }
  return new ApiError(res.status, 'NO_ENVELOPE', res.text.slice(0, 300), undefined, undefined);
}

function expectEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
