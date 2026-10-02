/**
 * @orch/storage — storage PORT (architecture doc §3.1) + embedded implementation.
 *
 * The skeleton ships only the open/close + ping seam so the kernel's health
 * endpoints can report `storage: {mode, ok}`. The full StoragePort surface
 * (ConfigStore / HistoryStore / JournalStore) lands with tickets #4/#9/#11.
 *
 * The Postgres/Timescale implementation lives in @orch/storage-timescale; the
 * KERNEL dynamically imports it when `storage.mode === "postgres"` (arch §1) —
 * this package never links it (that would be a circular project reference).
 */

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
 * Minimal handle for the walking skeleton. Grows into the full StoragePort
 * with later tickets.
 */
export interface StorageHandle {
  readonly mode: StorageMode;
  /** Liveness probe used by `GET /health/ready`. */
  ping(): Promise<boolean>;
  stop(): Promise<void>;
}

export { openEmbeddedStorage } from './embedded.js';
