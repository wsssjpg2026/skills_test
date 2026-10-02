/**
 * @orch/storage — storage PORT (architecture doc §3.1) + embedded implementation.
 *
 * Ticket #3 adds the minimal ConfigStore surface the kernel/testing seam needs
 * (channels / devices / tags: seed + reconcile). The SQLite-backed store,
 * history ring buffer, and JSONL journals land with #4/#9/#11 behind the same
 * port — no kernel code path may know which implementation is active.
 *
 * The Postgres/Timescale implementation lives in @orch/storage-timescale; the
 * KERNEL dynamically imports it when `storage.mode === "postgres"` (arch §1) —
 * this package never links it (that would be a circular project reference).
 */
import type { Channel, Device, Tag } from '@orch/contracts';

export type StorageMode = 'embedded' | 'postgres';

export interface PostgresStorageOptions {
  dsn?: string;
  poolMax?: number;
}

export interface StorageOptions {
  mode?: StorageMode;
  /** Embedded mode only. Default `./data`. */
  dataDir?: string;
  /** Postgres mode only. */
  postgres?: PostgresStorageOptions;
}

/**
 * Config store: plain CRUD per entity (§3.1). The embedded implementation is
 * session-scoped (in-memory) until #4 lands the SQLite store; the interface
 * is the seam `@orch/testing` seeds through.
 */
export interface ConfigStore {
  listChannels(): Promise<Channel[]>;
  getChannel(id: string): Promise<Channel | undefined>;
  upsertChannel(channel: Channel): Promise<void>;
  deleteChannel(id: string): Promise<void>;

  listDevices(filter?: { channelId?: string }): Promise<Device[]>;
  getDevice(id: string): Promise<Device | undefined>;
  upsertDevice(device: Device): Promise<void>;
  deleteDevice(id: string): Promise<void>;

  listTags(filter?: { channelId?: string; deviceId?: string }): Promise<Tag[]>;
  getTag(id: string): Promise<Tag | undefined>;
  upsertTag(tag: Tag): Promise<void>;
  deleteTag(id: string): Promise<void>;
}

/**
 * Storage handle. `config` grows into the full StoragePort (history +
 * journals) with later tickets; `ping` backs `GET /health/ready`.
 */
export interface StorageHandle {
  readonly mode: StorageMode;
  readonly config: ConfigStore;
  /** Liveness probe used by `GET /health/ready`. */
  ping(): Promise<boolean>;
  stop(): Promise<void>;
}

export { openEmbeddedStorage } from './embedded.js';
