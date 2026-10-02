// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with the mock private-protocol
// device of ticket #7). TCP device that streams frames built from a template descriptor:
// [start 2B][len u16 BE = payload length][payload nB][crc16-modbus of payload, 2B LE].
// The template config below is the grammar ASSUMED for @orch/driver-frametemplate
// (A6 in test-map-drivers.md) — both this stub and the channel fixtures in
// frame-template.spec.ts derive from frameFixture(), so rewiring is one edit.
import net from 'node:net';

export const START_DELIM = Buffer.from([0xaa, 0x55]);

export interface FrameTemplate {
  transport: 'tcp';
  frame: {
    startDelimiterHex: string; // 'aa55'
    length: { offset: number; size: 2; endian: 'big'; unit: 'bytes' };
    checksum: { type: 'crc16-modbus'; covers: 'payload'; size: 2; endian: 'little' };
    escape: { escapeHex: '7d'; map: Record<string, string> }; // escape byte → escaped form
  };
}

export function frameFixture(): FrameTemplate {
  return {
    transport: 'tcp',
    frame: {
      startDelimiterHex: 'aa55',
      length: { offset: 2, size: 2, endian: 'big', unit: 'bytes' },
      checksum: { type: 'crc16-modbus', covers: 'payload', size: 2, endian: 'little' },
      escape: { escapeHex: '7d', map: { '7d': '7d5d', 'aa': '7d5a' } },
    },
  };
}

export function crc16Modbus(buf: Buffer, seed = 0xffff): number {
  let crc = seed;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

/** Payload layout for tests: [temp u16 BE @0][pressure u16 BE @2][state u8 @4]. */
export function buildFrame(temp: number, pressure: number, state: number): Buffer {
  const payload = Buffer.alloc(5);
  payload.writeUInt16BE(temp & 0xffff, 0);
  payload.writeUInt16BE(pressure & 0xffff, 2);
  payload.writeUInt8(state & 0xff, 4);
  const crc = crc16Modbus(payload);
  const head = Buffer.alloc(4);
  START_DELIM.copy(head, 0);
  head.writeUInt16BE(payload.length, 2);
  const tail = Buffer.alloc(2);
  tail.writeUInt16LE(crc, 0);
  return Buffer.concat([head, payload, tail]);
}

/** Frame with a corrupted checksum — must be discarded, not disconnect (ticket #7). */
export function buildBadChecksumFrame(temp: number, pressure: number, state: number): Buffer {
  const f = buildFrame(temp, pressure, state);
  f[f.length - 1] ^= 0xff;
  return f;
}

/** Truncated frame (header claims more bytes than follow) — must be discarded too. */
export function buildTruncatedFrame(): Buffer {
  const head = Buffer.alloc(4);
  START_DELIM.copy(head, 0);
  head.writeUInt16BE(200, 2);
  return Buffer.concat([head, Buffer.from([0x01])]);
}

export interface FrameDeviceStub {
  port: number;
  send(...frames: Buffer[]): void;
  connectionEvents: ('connect' | 'disconnect')[];
  connectedCount(): number;
  stop(): Promise<void>;
  /** bytes received from the platform (device-command writes), for write-path checks */
  receivedFromPlatform: Buffer[];
}

export async function startFrameDevice(): Promise<FrameDeviceStub> {
  const connections = new Set<net.Socket>();
  const connectionEvents: ('connect' | 'disconnect')[] = [];
  const receivedFromPlatform: Buffer[] = [];
  const server = net.createServer((socket) => {
    connections.add(socket);
    connectionEvents.push('connect');
    socket.on('data', (d) => receivedFromPlatform.push(d));
    socket.on('close', () => {
      connections.delete(socket);
      connectionEvents.push('disconnect');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    port,
    send(...frames) {
      const buf = Buffer.concat(frames);
      for (const s of connections) s.write(buf);
    },
    connectionEvents,
    connectedCount() {
      return connections.size;
    },
    get receivedFromPlatform() {
      return receivedFromPlatform;
    },
    stop() {
      for (const s of connections) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
