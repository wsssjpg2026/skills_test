/**
 * Embedded storage (default mode — zero external processes).
 *
 * TODO(#9): SQLite config store (better-sqlite3, WAL mode; optional dep with a
 * JSON-file fallback slot), per-tag ring-buffer history (10k samples/tag),
 * fsync'd JSONL journals. Until then the handle only owns the data directory
 * and answers pings, which is all the walking skeleton's health checks need.
 */
import { access, constants, mkdir } from 'node:fs/promises';
import type { StorageHandle } from './index.js';

export async function openEmbeddedStorage(opts: { dataDir?: string } = {}): Promise<StorageHandle> {
  const dataDir = opts.dataDir ?? './data';
  await mkdir(dataDir, { recursive: true });

  return {
    mode: 'embedded',
    async ping(): Promise<boolean> {
      try {
        await access(dataDir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    async stop(): Promise<void> {
      /* nothing to close in the skeleton */
    },
  };
}
