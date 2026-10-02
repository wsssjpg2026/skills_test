/**
 * Driver SPI contract suite (architecture doc §2.3.6). Spawns any plugin with
 * a synthetic host built on `@orch/plugin-host` and asserts:
 *
 *  1. handshake order — methods before `initialize` fail with −32001;
 *  2. `initialize` result shape + capability registry honesty;
 *  3. unknown method → −32601; malformed params → −32602;
 *  4. `channel.start` accepts the synthetic desired state;
 *  5. `read` sample shapes; unknown device → −32002, unknown tag → −32003;
 *  6. `write` result shapes + read-only rejection (−32008 or ok:false);
 *  7. `tag_update` notification shape, coalescing, and per-tag ts monotonicity;
 *  8. capability honesty — `subscribe` only called when declared,
 *     non-subscribe drivers serve host-simulated polling via `read`;
 *  9. `command`/`command_event`/`command.status` correlation (only when the
 *     capability is declared);
 * 10. clean `shutdown` — result `{}` and process exit code 0.
 *
 * Exit code of the CLI = verdict. The suite must stay green against
 * `@orch/mock-driver` in CI — it is the reference plugin and the admission
 * bar for third-party drivers (incl. the Galbot sidecar).
 */
import type { Device, Sample, Tag } from '@orch/contracts';
import {
  ALL_SPI_CAPABILITIES,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  SPI_ERROR,
  type InitializeResult,
  type JsonRpcNotification,
  type SpiCapability,
  type TagUpdateNotification,
} from '@orch/contracts/spi';
import { PluginRpcError, SupervisedPlugin, type PluginLogger } from '@orch/plugin-host';

export interface ContractSuiteOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Overall budget. Default 30 s. */
  timeoutMs?: number;
  /**
   * Driver-private channel config for the synthetic channel. The default
   * embeds the mock-driver script (§5.2) so the tag_update assertions are
   * deterministic; other drivers ignore unknown keys or bring their own via
   * `--channel-config`.
   */
  channelConfig?: Record<string, unknown>;
  /** Quiet mode for library use. */
  quiet?: boolean;
}

export interface AssertionResult {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
  durationMs: number;
}

export interface SuiteResult {
  plugin: string;
  passed: boolean;
  assertions: AssertionResult[];
}

const DEVICE_ON = 'suite-dev-1';
const DEVICE_OFF = 'suite-dev-2';
const TAG_RW = 'suite-tag-rw';
const TAG_RO = 'suite-tag-ro';
const TAG_STR = 'suite-tag-str';

function synthDevices(): Device[] {
  return [
    { id: DEVICE_ON, channelId: 'suite-ch', name: 'dev1', address: '1', enabled: true, config: {} },
    { id: DEVICE_OFF, channelId: 'suite-ch', name: 'dev2', address: '2', enabled: false, config: {} },
  ];
}

function synthTags(): Tag[] {
  return [
    {
      id: TAG_RW, deviceId: DEVICE_ON, name: 't1', dataType: 'float64', address: 'mock:0',
      access: 'readwrite', historyEnabled: true, scanPeriodMs: 100,
    },
    {
      id: TAG_RO, deviceId: DEVICE_ON, name: 't2', dataType: 'bool', address: 'mock:1',
      access: 'read', historyEnabled: false, scanPeriodMs: 100,
    },
    {
      id: TAG_STR, deviceId: DEVICE_ON, name: 't3', dataType: 'string', address: 'mock:2',
      access: 'readwrite', historyEnabled: false, scanPeriodMs: 100,
    },
  ];
}

const DEFAULT_CHANNEL_CONFIG: Record<string, unknown> = {
  // t=0 coalesced batch, then a quiet period so the write/readback assertions
  // never race a scripted set, then two more batches for the ts-monotonicity
  // check.
  script: [
    { afterMs: 0, set: { t1: 42, t3: 'hello' } },
    { afterMs: 700, set: { t1: 43 } },
    { afterMs: 850, set: { t1: 44, t3: 'world' } },
  ],
  flushMs: 25,
};

class AssertionFailed extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionFailed(message);
}

function isIsoTs(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function sampleShapeOk(sample: Sample, allowedTagIds: Set<string>): string | null {
  if (typeof sample?.tagId !== 'string' || !allowedTagIds.has(sample.tagId)) {
    return `sample.tagId "${sample?.tagId}" not in started tag set`;
  }
  const v = sample.value;
  const typeOk =
    v === null ||
    ['number', 'boolean', 'string'].includes(typeof v) ||
    (Array.isArray(v) && v.every((x) => typeof x === 'number' || typeof x === 'string'));
  if (!typeOk) return `sample.value has an unsupported type (${typeof v})`;
  if (!['good', 'bad', 'uncertain'].includes(sample.quality)) {
    return `sample.quality "${sample.quality}" not in the quality enum`;
  }
  if (!isIsoTs(sample.ts)) return `sample.ts "${sample.ts}" is not ISO-8601`;
  return null;
}

/** Run the suite; never throws — the result carries the verdict. */
export async function runContractSuite(opts: ContractSuiteOptions): Promise<SuiteResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const channelConfig = opts.channelConfig ?? DEFAULT_CHANNEL_CONFIG;
  const notifications: JsonRpcNotification[] = [];

  // Suite output stays readable: plugin-host logs go to stderr, never stdout.
  const suiteLogger: PluginLogger = {
    debug: () => {},
    info: () => {},
    warn: (obj, msg) => console.error(`[plugin-host] ${msg} ${JSON.stringify(obj)}`),
    error: (obj, msg) => console.error(`[plugin-host] ${msg} ${JSON.stringify(obj)}`),
  };

  const plugin = new SupervisedPlugin({
    id: 'contract-suite-target',
    logger: suiteLogger,
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd,
    autoInitialize: false, // the suite itself drives the handshake order
    heartbeatIntervalMs: 0, // suite is short-lived; heartbeat is covered by the host tests
    restart: { initialMs: 200, maxMs: 1_000, maxRestarts: 1, windowMs: 60_000 },
  });
  plugin.on('notification', (n: JsonRpcNotification) => {
    notifications.push(n);
  });

  const results: AssertionResult[] = [];
  let criticalFailure = false;
  const deadline = Date.now() + timeoutMs;

  const run = async (
    name: string,
    critical: boolean,
    fn: () => Promise<void>,
  ): Promise<void> => {
    if (criticalFailure || Date.now() > deadline) {
      results.push({ name, status: 'skipped', durationMs: 0 });
      return;
    }
    const startedAt = Date.now();
    try {
      await fn();
      results.push({ name, status: 'pass', durationMs: Date.now() - startedAt });
      if (!opts.quiet) console.log(`  ok   ${name} (${Date.now() - startedAt} ms)`);
    } catch (err) {
      results.push({
        name,
        status: 'fail',
        detail: err instanceof AssertionFailed ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Date.now() - startedAt,
      });
      if (critical) criticalFailure = true;
      if (!opts.quiet) console.log(`  FAIL ${name} — ${results.at(-1)?.detail}`);
    }
  };

  const expectRpcError = async (method: string, params: unknown, code: number, hint: string): Promise<void> => {
    try {
      await plugin.request(method, params);
    } catch (err) {
      if (err instanceof PluginRpcError) {
        check(err.code === code, `${hint}: expected code ${code}, got ${err.code} (${err.message})`);
        return;
      }
      throw err;
    }
    throw new AssertionFailed(`${hint}: expected error ${code}, got a success result`);
  };

  let init: InitializeResult | null = null;

  try {
    await run('plugin spawns', true, async () => {
      await plugin.start();
      check(plugin.pid !== undefined, 'no pid after start');
    });

    await run('methods before initialize fail with -32001 NOT_INITIALIZED', true, async () => {
      await expectRpcError('read', { deviceId: DEVICE_ON, tagIds: [TAG_RW] }, SPI_ERROR.NOT_INITIALIZED, 'read before initialize');
    });

    await run('initialize handshake returns pluginInfo + capabilities', true, async () => {
      const result = await plugin.initialize();
      init = result;
      check(typeof result.pluginInfo?.id === 'string' && result.pluginInfo.id.length > 0, 'pluginInfo.id missing');
      check(typeof result.pluginInfo?.version === 'string' && result.pluginInfo.version.length > 0, 'pluginInfo.version missing');
      check(Array.isArray(result.capabilities), 'capabilities must be an array');
      const registry = new Set<string>(ALL_SPI_CAPABILITIES);
      for (const cap of result.capabilities) {
        check(registry.has(cap), `capability "${cap}" is not in the frozen registry ${JSON.stringify(ALL_SPI_CAPABILITIES)}`);
      }
      check(new Set(result.capabilities).size === result.capabilities.length, 'capabilities contain duplicates');
    });

    await run('unknown method fails with -32601', false, async () => {
      await expectRpcError('suite/no-such-method', {}, JSON_RPC_METHOD_NOT_FOUND, 'unknown method');
    });

    await run('malformed params fail with -32602', false, async () => {
      await expectRpcError('read', {}, JSON_RPC_INVALID_PARAMS, 'read without deviceId');
    });

    await run('channel.start accepts the synthetic desired state', true, async () => {
      const result = await plugin.request('channel.start', {
        channel: {
          id: 'suite-ch',
          name: 'suite',
          driver: init!.pluginInfo.id,
          enabled: true,
          config: channelConfig,
        },
        devices: synthDevices(),
        tags: synthTags(),
      });
      check(
        result !== null && typeof result === 'object' && Object.keys(result as object).length === 0,
        `channel.start result must be {}, got ${JSON.stringify(result)}`,
      );
    });

    await run('read returns well-formed samples', true, async () => {
      const { samples } = await plugin.request<{ samples: Sample[] }>('read', {
        deviceId: DEVICE_ON,
        tagIds: [TAG_RW, TAG_STR],
      });
      check(Array.isArray(samples) && samples.length === 2, `expected 2 samples, got ${samples?.length}`);
      const ids = new Set([TAG_RW, TAG_STR]);
      for (const s of samples) {
        const problem = sampleShapeOk(s, ids);
        check(problem === null, problem ?? 'bad sample');
      }
    });

    await run('unknown device fails with -32002 DEVICE_NOT_FOUND', false, async () => {
      await expectRpcError('read', { deviceId: 'no-such-device', tagIds: [TAG_RW] }, SPI_ERROR.DEVICE_NOT_FOUND, 'read unknown device');
    });

    await run('unknown tag fails with -32003 TAG_NOT_FOUND', false, async () => {
      await expectRpcError('read', { deviceId: DEVICE_ON, tagIds: ['no-such-tag'] }, SPI_ERROR.TAG_NOT_FOUND, 'read unknown tag');
    });

    await run('write returns result items and verifies readback', true, async () => {
      // Let the channel quiesce first (initial script values / driver init).
      await waitFor(async () => {
        const settled = await plugin.request<{ samples: Sample[] }>('read', {
          deviceId: DEVICE_ON,
          tagIds: [TAG_RW],
        });
        return settled.samples[0]?.value !== null && settled.samples[0]?.value !== undefined ? true : null;
      }, 3_000);
      const { results: items } = await plugin.request<{ results: { tagId: string; ok: boolean }[] }>('write', {
        deviceId: DEVICE_ON,
        writes: [{ tagId: TAG_RW, value: 41.5, verify: true }],
      });
      check(Array.isArray(items) && items.length === 1, `expected 1 result item, got ${items?.length}`);
      check(items[0].tagId === TAG_RW, `result tagId "${items[0]?.tagId}" does not match the write`);
      check(items[0].ok === true, `write result ok=false (write to a readwrite tag must succeed)`);
      const { samples } = await plugin.request<{ samples: Sample[] }>('read', {
        deviceId: DEVICE_ON,
        tagIds: [TAG_RW],
      });
      check(samples[0]?.value === 41.5, `read-after-write returned ${JSON.stringify(samples[0]?.value)}, expected 41.5`);
    });

    await run('write to a read-only tag is rejected', false, async () => {
      try {
        const { results: items } = await plugin.request<{ results: { ok: boolean }[] }>('write', {
          deviceId: DEVICE_ON,
          writes: [{ tagId: TAG_RO, value: true }],
        });
        check(items?.[0]?.ok === false, 'write to read-only tag must fail (ok:false) or return -32008');
      } catch (err) {
        if (err instanceof PluginRpcError) {
          check(err.code === SPI_ERROR.WRITE_REJECTED, `expected -32008 WRITE_REJECTED, got ${err.code}`);
        } else {
          throw err;
        }
      }
    });

    await run('tag_update notifications: shape, coalescing, monotonic ts', false, async () => {
      const tagUpdates = await waitFor(
        () => {
          const updates = notifications.filter((n) => n.method === 'tag_update').map((n) => n.params as TagUpdateNotification);
          return updates.length >= 2 ? updates : null;
        },
        Math.max(2_000, Math.min(deadline - Date.now(), 10_000)),
      );
      const allowedTags = new Set([TAG_RW, TAG_STR, TAG_RO]);
      const lastTs = new Map<string, number>();
      for (const update of tagUpdates) {
        check(typeof update.deviceId === 'string' && update.deviceId.length > 0, 'tag_update.deviceId missing');
        check(Array.isArray(update.samples) && update.samples.length > 0, 'tag_update.samples must be a non-empty array');
        for (const s of update.samples) {
          const problem = sampleShapeOk(s, allowedTags);
          check(problem === null, problem ?? 'bad sample');
          const ts = Date.parse(s.ts);
          const prev = lastTs.get(s.tagId);
          if (prev !== undefined) check(ts >= prev, `tag ${s.tagId} ts went backwards (${ts} < ${prev})`);
          lastTs.set(s.tagId, ts);
        }
      }
      if (opts.channelConfig === undefined) {
        // Default config = mock script: t1+t3 set at the same afterMs must
        // arrive coalesced in one flush.
        const coalesced = tagUpdates.some((u) => u.samples.length >= 2);
        check(coalesced, 'expected at least one coalesced tag_update (>= 2 samples) for simultaneous script sets');
      }
    });

    await run('capability honesty: subscribe only when declared; polling read otherwise', false, async () => {
      const caps = new Set<string>((init?.capabilities ?? []) as SpiCapability[]);
      if (caps.has('subscribe')) {
        const result = await plugin.request('subscribe', { deviceId: DEVICE_ON, tagIds: [TAG_RW] });
        check(
          result !== null && typeof result === 'object' && Object.keys(result as object).length === 0,
          `subscribe result must be {}, got ${JSON.stringify(result)}`,
        );
      } else {
        // Host-simulated subscription: poll read twice — both must succeed.
        for (let i = 0; i < 2; i++) {
          const { samples } = await plugin.request<{ samples: Sample[] }>('read', {
            deviceId: DEVICE_ON,
            tagIds: [TAG_RW],
          });
          check(samples?.length === 1, 'polling read failed for a non-subscribe driver');
        }
      }
    });

    await run('validate reports config errors (empty address)', false, async () => {
      if (!new Set((init?.capabilities ?? []) as string[]).has('validate')) {
        return; // capability not declared — the host never calls validate
      }
      const { errors } = await plugin.request<{ errors: unknown[] }>('validate', {
        kind: 'tag',
        config: { address: '' },
      });
      check(Array.isArray(errors), 'validate result.errors must be an array');
      check(errors.length > 0, 'an empty address must be rejected by every address grammar');
      const first = errors[0] as { path?: string; code?: string; message?: string };
      check(typeof first?.path === 'string' && typeof first?.code === 'string', 'error items need {path, code, message}');
    });

    await run('command + command_event + command.status correlation (capability-gated)', false, async () => {
      const caps = new Set<string>((init?.capabilities ?? []) as string[]);
      if (!caps.has('command')) {
        return; // not declared — the suite never sends command (honesty both ways)
      }
      const commandId = `suite-cmd-${Date.now()}`;
      const result = await plugin.request('command', {
        deviceId: DEVICE_ON,
        commandId,
        command: 'suite.probe',
        params: {},
        timeoutMs: 5_000,
      });
      check(result !== null && typeof result === 'object', 'command result must be an object');
      const event = await waitFor(
        () =>
          notifications.find(
            (n) => n.method === 'command_event' && (n.params as { commandId?: string })?.commandId === commandId,
          ) ?? null,
        8_000,
      );
      check(
        ['completed', 'failed', 'progress'].includes((event.params as { event?: string }).event ?? ''),
        'command_event.event must be completed|failed|progress',
      );
      if (caps.has('command_status')) {
        const status = await plugin.request<{ state: string }>('command.status', {
          deviceId: DEVICE_ON,
          commandId,
        });
        check(
          ['pending', 'running', 'completed', 'failed'].includes(status?.state ?? ''),
          `command.status.state "${status?.state}" not in the state set`,
        );
      }
    });

    await run('clean shutdown: result {} and exit code 0', true, async () => {
      await plugin.stop('contract suite complete');
      check(plugin.lastExit !== null, 'no exit recorded');
      check(plugin.lastExit?.code === 0, `plugin exited with code ${plugin.lastExit?.code} (signal ${plugin.lastExit?.signal}), expected 0`);
    });
  } finally {
    await plugin.stop('contract suite cleanup').catch(() => {});
  }

  return {
    plugin: opts.command,
    passed: results.every((r) => r.status !== 'fail'),
    assertions: results,
  };
}

function waitFor<T>(probe: () => T | Promise<T> | null | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      Promise.resolve(probe())
        .then((value) => {
          if (value !== null && value !== undefined) {
            resolve(value as T);
          } else if (Date.now() - startedAt > timeoutMs) {
            reject(new AssertionFailed(`condition not met within ${timeoutMs} ms`));
          } else {
            setTimeout(tick, 20);
          }
        })
        .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    };
    tick();
  });
}
