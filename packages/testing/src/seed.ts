/**
 * Programmatic seed helper (§5, acceptance 3c): write a channel + devices +
 * tags THROUGH the storage port, then let the kernel reconcile channels
 * against the discovered plugins. No REST shortcuts — the storage port is
 * the seam, so the seed stays valid when #4 swaps in the SQLite store.
 */
import { getRandomValues } from 'node:crypto';
import type { Channel, Device, Tag, TagDataType } from '@orch/contracts';
import type { Kernel } from '@orch/kernel';

/** UUIDv7 (time-ordered, §2.0) — entity ids are UUIDv7 by contract. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  const ts = Date.now();
  view.setUint32(0, Math.floor(ts / 2 ** 32));
  view.setUint16(4, ts % 2 ** 16);
  view.setUint16(6, (getRandomValues(new Uint16Array(1))[0] & 0x0fff) | 0x7000);
  view.setUint16(8, (getRandomValues(new Uint16Array(1))[0] & 0x3fff) | 0x8000);
  getRandomValues(bytes.subarray(10));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SeedChannelSpec {
  id?: string;
  name: string;
  /** Plugin id, e.g. `mock-driver`. */
  driver: string;
  enabled?: boolean;
  /** Driver-private config — the mock-driver script (§5.2). */
  config?: object;
}

export interface SeedDeviceSpec {
  id?: string;
  name: string;
  address: string;
  enabled?: boolean;
  config?: object;
}

export interface SeedTagSpec {
  id?: string;
  /** Defaults to the (only) seeded device. */
  deviceId?: string;
  deviceName?: string;
  name: string;
  dataType?: TagDataType;
  address: string;
  access?: 'read' | 'write' | 'readwrite';
  historyEnabled?: boolean;
  scanPeriodMs?: number;
  config?: object;
}

export interface SeedSpec {
  channel: SeedChannelSpec;
  devices: SeedDeviceSpec[];
  tags: SeedTagSpec[];
}

export interface SeedResult {
  channel: Channel;
  devices: Device[];
  tags: Tag[];
}

const nowIso = (): string => new Date().toISOString();

/** Write the topology through the storage port and reconcile channels. */
export async function seedTopology(kernel: Kernel, spec: SeedSpec): Promise<SeedResult> {
  const channel: Channel = {
    id: spec.channel.id ?? uuidv7(),
    name: spec.channel.name,
    driver: spec.channel.driver,
    enabled: spec.channel.enabled ?? true,
    config: spec.channel.config ?? {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await kernel.storage.config.upsertChannel(channel);

  const devices: Device[] = spec.devices.map((d) => ({
    id: d.id ?? uuidv7(),
    channelId: channel.id,
    name: d.name,
    address: d.address,
    enabled: d.enabled ?? true,
    config: d.config ?? {},
  }));
  for (const device of devices) await kernel.storage.config.upsertDevice(device);

  const byName = new Map(devices.map((d) => [d.name, d]));
  const tags: Tag[] = spec.tags.map((t) => {
    const deviceId =
      t.deviceId ?? (t.deviceName !== undefined ? byName.get(t.deviceName)?.id : undefined) ?? devices[0]?.id;
    if (deviceId === undefined) throw new Error(`seed tag "${t.name}" has no resolvable device`);
    return {
      id: t.id ?? uuidv7(),
      deviceId,
      name: t.name,
      dataType: t.dataType ?? 'float64',
      address: t.address,
      access: t.access ?? 'readwrite',
      historyEnabled: t.historyEnabled ?? false,
      ...(t.scanPeriodMs !== undefined ? { scanPeriodMs: t.scanPeriodMs } : {}),
      ...(t.config !== undefined ? { config: t.config } : {}),
    };
  });
  for (const tag of tags) await kernel.storage.config.upsertTag(tag);

  await kernel.reconcileChannels();
  return { channel, devices, tags };
}
