// doc-derived test stub — rewired to @orch/* at merge.
// Per-file test harness: boot kernel (ephemeral port + temp data dir), resolve bootstrap
// admin credentials, hand out authenticated + anonymous REST clients, and provide
// task-level wait helpers. At merge this collapses onto @orch/testing's boot harness.

import { bootKernel, resolveAdminCredentials, spawnKernel, type BootHandle, type DeepPartial, type SpawnHandle } from './boot.js';
import { ApiError, RestClient } from './rest.js';
import { WsTagsClient } from './ws.js';
import type { KernelConfig, Sample, Tag, Task, TaskEvent, TaskStatus } from './types.js';
import { waitUntil } from './util.js';

export interface TestKernel {
  boot: BootHandle;
  port: number;
  baseUrl: string;
  /** REST client authenticated as bootstrap admin. */
  api: RestClient;
  /** REST client with no token. */
  anon: RestClient;
  admin: { username: string; password: string; token: string };
  stop(): Promise<void>;
  wsTags(token?: string): Promise<WsTagsClient>;
}

export async function startKernel(opts: {
  config?: DeepPartial<KernelConfig>;
  pluginsDir?: string;
} = {}): Promise<TestKernel> {
  const config = opts.pluginsDir
    ? { ...opts.config, plugins: { ...opts.config?.plugins, dir: opts.pluginsDir } }
    : opts.config;
  const boot = await bootKernel({ config });
  return finalizeKernel(boot);
}

export async function spawnTestKernel(opts: {
  config?: DeepPartial<KernelConfig>;
  env?: Record<string, string>;
} = {}): Promise<TestKernel & { boot: SpawnHandle }> {
  const boot = await spawnKernel(opts);
  return (await finalizeKernel(boot)) as TestKernel & { boot: SpawnHandle };
}

async function finalizeKernel(boot: BootHandle): Promise<TestKernel> {
  const creds = resolveAdminCredentials(boot.config, boot.stdout());
  const anon = new RestClient(boot.baseUrl);
  const login = await anon.login(creds.username, creds.password);
  const api = anon.withToken(login.token);
  return {
    boot,
    port: boot.port,
    baseUrl: boot.baseUrl,
    api,
    anon,
    admin: { ...creds, token: login.token },
    stop: () => boot.stop(),
    wsTags: (token?: string) => WsTagsClient.connect(boot.port, token ?? login.token),
  };
}

// ---------------------------------------------------------------- task helpers

export async function waitForTaskStatus(
  api: RestClient,
  taskId: string,
  statuses: TaskStatus[],
  timeoutMs = 15_000,
): Promise<Task> {
  return waitUntil(
    async () => {
      const t = await api.getTask(taskId);
      return statuses.includes(t.status) ? t : undefined;
    },
    { timeoutMs, intervalMs: 50, label: `task ${taskId} to reach ${statuses.join('|')}` },
  );
}

export async function waitForTerminal(api: RestClient, taskId: string, timeoutMs = 15_000): Promise<Task> {
  return waitForTaskStatus(api, taskId, ['completed', 'failed', 'aborted', 'stopped'], timeoutMs);
}

export async function waitForTaskEvent(
  api: RestClient,
  taskId: string,
  pred: (e: TaskEvent) => boolean,
  timeoutMs = 15_000,
): Promise<TaskEvent> {
  return waitUntil(
    async () => {
      const events = await api.allEvents(taskId);
      return events.find(pred);
    },
    { timeoutMs, intervalMs: 100, label: `task event matching predicate on ${taskId}` },
  );
}

/** Wait until the realtime value of a tag equals `value` (event-driven poll, deadline-bounded). */
export async function waitForTagValue(
  api: RestClient,
  tagId: string,
  value: unknown,
  timeoutMs = 10_000,
): Promise<Sample> {
  return waitUntil(
    async () => {
      const { samples } = await api.tagValues({ ids: [tagId] });
      const s = samples.find((x) => x.tagId === tagId);
      return s && JSON.stringify(s.value) === JSON.stringify(value) ? s : undefined;
    },
    { timeoutMs, intervalMs: 50, label: `tag ${tagId} to hold value ${JSON.stringify(value)}` },
  );
}

// ---------------------------------------------------------------- mock channel helper

/**
 * The single canonical way engine tests get observable tags: one mock-driver channel
 * named `factory`, one device `plc`, tags per the map. §5.2 mock config is purely
 * channel.config-driven, so tests pass `script` here.
 */
export interface MockTagSpec {
  name: string;
  dataType?: Tag['dataType'];
  address?: string;
  historyEnabled?: boolean;
}

export async function installMockChannel(
  api: RestClient,
  opts: {
    channel?: string;
    device?: string;
    tags: MockTagSpec[];
    script?: object;
  },
): Promise<{ channel: string; deviceId: string; tagIds: Record<string, string>; tagPath: (name: string) => string }> {
  const channelName = opts.channel ?? 'factory';
  const deviceName = opts.device ?? 'plc';
  const ch = await api.createChannel({
    name: channelName,
    driver: 'mock-driver',
    enabled: true,
    config: { script: opts.script ?? [] } as object,
  });
  const dev = await api.createDevice({ channelId: ch.id, name: deviceName, address: 'mock:1', enabled: true });
  const tagIds: Record<string, string> = {};
  for (const t of opts.tags) {
    const tag = await api.createTag({
      deviceId: dev.id,
      name: t.name,
      dataType: t.dataType ?? 'float64',
      address: t.address ?? `mock:${t.name}`,
      access: 'readwrite',
      historyEnabled: t.historyEnabled ?? false,
    });
    tagIds[t.name] = tag.id;
  }
  return {
    channel: channelName,
    deviceId: dev.id,
    tagIds,
    tagPath: (name: string) => `${channelName}.${deviceName}.${name}`,
  };
}

export { ApiError };
