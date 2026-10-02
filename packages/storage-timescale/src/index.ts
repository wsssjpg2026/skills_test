/**
 * @orch/storage-timescale — Postgres/TimescaleDB implementation of the storage
 * port (architecture doc §3.1). Implemented by ticket #9 (db vitest project).
 *
 * The kernel reaches this module ONLY via dynamic import when
 * `storage.mode === "postgres"` — it is never statically linked into the kernel.
 */
import type { StorageHandle, StorageOptions } from '@orch/storage';

export async function openTimescaleStorage(_opts: StorageOptions = {}): Promise<StorageHandle> {
  throw new Error('@orch/storage-timescale: not implemented yet (ticket #9)');
}
