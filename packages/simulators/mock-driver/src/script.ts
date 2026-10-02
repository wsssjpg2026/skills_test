/**
 * mock-driver script model (architecture doc §5.2): the plugin is driven
 * purely by its channel `config`. A script is a list of timed steps relative
 * to `channel.start` / `channel.update`:
 *
 *   { script: [
 *       { afterMs: 0,    set: { t1: 42 } },
 *       { afterMs: 5000, quality: "bad", reason: "device_offline", devices: ["d1"] },
 *       { afterMs: 9000, quality: "good" },
 *       { afterMs: 12000, deviceStatus: { state: "degraded", reason: "comm_error" } },
 *     ], flushMs: 25 }
 *
 * `set` targets tags by id or name; `quality`/`deviceStatus` target devices
 * by id or name (all devices when `devices` is absent).
 */
import type { Quality, QualityReason, TagValue } from '@orch/contracts';
import type { DeviceState } from '@orch/contracts/spi';

export interface MockScriptStep {
  afterMs: number;
  /** tagName-or-id → value; sets quality good. */
  set?: Record<string, TagValue>;
  /** Quality change for the targeted devices; the last value is retained. */
  quality?: Quality;
  reason?: QualityReason;
  devices?: string[];
  /** Emit a `device_status` notification (§2.3.2). */
  deviceStatus?: { state: DeviceState; reason?: QualityReason; detail?: string };
}

export interface MockChannelConfig {
  script?: MockScriptStep[];
  /** tag_update coalescing window (>= 1 flush per scan period). Default 25 ms. */
  flushMs?: number;
}

export interface ScriptIssue {
  path: string;
  code: string;
  message: string;
}

const QUALITIES: Quality[] = ['good', 'bad', 'uncertain'];
const DEVICE_STATES: DeviceState[] = ['connected', 'reconnecting', 'degraded', 'failed', 'disabled'];

/** Validate a channel config; returns issues (empty = valid). */
export function validateChannelConfig(config: Record<string, unknown>): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  if (config.script !== undefined) {
    if (!Array.isArray(config.script)) {
      issues.push({ path: 'script', code: 'TYPE_INVALID', message: 'script must be an array' });
      return issues;
    }
    config.script.forEach((raw, i) => {
      const p = (field: string): string => `script[${i}]${field}`;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ path: `script[${i}]`, code: 'TYPE_INVALID', message: 'step must be an object' });
        return;
      }
      const step = raw as Record<string, unknown>;
      if (typeof step.afterMs !== 'number' || !Number.isFinite(step.afterMs) || step.afterMs < 0) {
        issues.push({ path: p('.afterMs'), code: 'VALUE_INVALID', message: 'afterMs must be a number >= 0' });
      }
      const actions = ['set', 'quality', 'deviceStatus'].filter((k) => step[k] !== undefined);
      if (actions.length === 0) {
        issues.push({
          path: `script[${i}]`,
          code: 'VALUE_INVALID',
          message: 'step needs one of set / quality / deviceStatus',
        });
      }
      if (step.set !== undefined) {
        if (step.set === null || typeof step.set !== 'object' || Array.isArray(step.set)) {
          issues.push({ path: p('.set'), code: 'TYPE_INVALID', message: 'set must be an object of tag → value' });
        }
      }
      if (step.quality !== undefined && !QUALITIES.includes(step.quality as Quality)) {
        issues.push({ path: p('.quality'), code: 'VALUE_INVALID', message: `quality must be one of ${QUALITIES.join('|')}` });
      }
      if (step.devices !== undefined) {
        if (!Array.isArray(step.devices) || step.devices.some((d) => typeof d !== 'string')) {
          issues.push({ path: p('.devices'), code: 'TYPE_INVALID', message: 'devices must be an array of strings' });
        }
      }
      if (step.deviceStatus !== undefined) {
        const ds = step.deviceStatus as Record<string, unknown> | undefined;
        if (ds === null || typeof ds !== 'object' || Array.isArray(ds) || !DEVICE_STATES.includes(ds?.state as DeviceState)) {
          issues.push({
            path: p('.deviceStatus.state'),
            code: 'VALUE_INVALID',
            message: `deviceStatus.state must be one of ${DEVICE_STATES.join('|')}`,
          });
        }
      }
    });
  }
  if (config.flushMs !== undefined) {
    if (typeof config.flushMs !== 'number' || !Number.isFinite(config.flushMs) || config.flushMs < 5) {
      issues.push({ path: 'flushMs', code: 'VALUE_INVALID', message: 'flushMs must be a number >= 5' });
    }
  }
  return issues;
}

/** Parse (after validation) — invalid entries are dropped, not thrown. */
export function parseScriptConfig(config: Record<string, unknown> | undefined): MockChannelConfig {
  if (!config) return {};
  const out: MockChannelConfig = {};
  if (Array.isArray(config.script)) {
    out.script = config.script.filter(
      (s): s is MockScriptStep =>
        s !== null && typeof s === 'object' && !Array.isArray(s) && typeof (s as MockScriptStep).afterMs === 'number',
    );
  }
  if (typeof config.flushMs === 'number' && config.flushMs >= 5) out.flushMs = config.flushMs;
  return out;
}
