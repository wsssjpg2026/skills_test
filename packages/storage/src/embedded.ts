/**
 * Embedded storage (default mode — zero external processes).
 *
 * #3 scope: the session-scoped in-memory ConfigStore backing the kernel's
 * channel-reconciliation seam and the @orch/testing seed helper. #4 replaces
 * the maps with the SQLite store (better-sqlite3, WAL mode) behind the same
 * ConfigStore interface; #9 adds the history ring, #11 the JSONL journals.
 */
import type { Channel, Device, Tag } from '@orch/contracts';
import type { ConfigStore, StorageHandle } from './index.js';

class MemoryConfigStore implements ConfigStore {
  private readonly channels = new Map<string, Channel>();
  private readonly devices = new Map<string, Device>();
  private readonly tags = new Map<string, Tag>();

  async listChannels(): Promise<Channel[]> {
    return [...this.channels.values()];
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    return this.channels.get(id);
  }

  async upsertChannel(channel: Channel): Promise<void> {
    this.channels.set(channel.id, { ...channel });
  }

  async deleteChannel(id: string): Promise<void> {
    this.channels.delete(id);
    for (const [deviceId, device] of this.devices) {
      if (device.channelId === id) this.devices.delete(deviceId);
    }
    for (const [tagId, tag] of this.tags) {
      if (!this.devices.has(tag.deviceId)) this.tags.delete(tagId);
    }
  }

  async listDevices(filter?: { channelId?: string }): Promise<Device[]> {
    const all = [...this.devices.values()];
    return filter?.channelId ? all.filter((d) => d.channelId === filter.channelId) : all;
  }

  async getDevice(id: string): Promise<Device | undefined> {
    return this.devices.get(id);
  }

  async upsertDevice(device: Device): Promise<void> {
    this.devices.set(device.id, { ...device });
  }

  async deleteDevice(id: string): Promise<void> {
    this.devices.delete(id);
    for (const [tagId, tag] of this.tags) {
      if (tag.deviceId === id) this.tags.delete(tagId);
    }
  }

  async listTags(filter?: { channelId?: string; deviceId?: string }): Promise<Tag[]> {
    let all = [...this.tags.values()];
    if (filter?.deviceId) all = all.filter((t) => t.deviceId === filter.deviceId);
    if (filter?.channelId) {
      const devices = new Set(
        [...this.devices.values()].filter((d) => d.channelId === filter.channelId).map((d) => d.id),
      );
      all = all.filter((t) => devices.has(t.deviceId));
    }
    return all;
  }

  async getTag(id: string): Promise<Tag | undefined> {
    return this.tags.get(id);
  }

  async upsertTag(tag: Tag): Promise<void> {
    this.tags.set(tag.id, { ...tag });
  }

  async deleteTag(id: string): Promise<void> {
    this.tags.delete(id);
  }
}

export async function openEmbeddedStorage(opts: { dataDir?: string } = {}): Promise<StorageHandle> {
  const { access, constants, mkdir } = await import('node:fs/promises');
  const dataDir = opts.dataDir ?? './data';
  await mkdir(dataDir, { recursive: true });

  return {
    mode: 'embedded',
    config: new MemoryConfigStore(),
    async ping(): Promise<boolean> {
      try {
        await access(dataDir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    async stop(): Promise<void> {
      /* nothing to close in the #3 seam */
    },
  };
}
