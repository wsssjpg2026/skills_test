// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with product broker harness;
// license note: aedes is MIT, dev-only here, never enters the kernel dependency tree).
// In-process MQTT broker (aedes) on an ephemeral port for driver-mqtt (Sparkplug B
// consumer role, ticket #8) and the northbound MQTT bridge (ticket #18).
// Sparkplug payloads are encoded with a hand-rolled protobuf writer so the EPL-licensed
// sparkplug-payload package never enters the test tree.
import net from 'node:net';
import { connect, type MqttClient } from 'mqtt';

// ---------- minimal protobuf writer (Sparkplug B Payload subset, Tahu field numbers) ----------
function varint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}
function tag(field: number, wire: 0 | 1 | 2 | 5): Buffer {
  return varint((field << 3) | wire);
}
function lenDelimited(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
}
function int64Field(field: number, v: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(v)]);
}

export interface SpMetric {
  name: string;
  type: 'int' | 'long' | 'float' | 'double' | 'boolean' | 'string';
  value: number | bigint | boolean | string;
}
function metric(m: SpMetric): Buffer {
  const parts: Buffer[] = [lenDelimited(1, Buffer.from(m.name, 'utf8'))]; // name = 1
  parts.push(int64Field(3, Date.now())); // timestamp = 3
  const datatype =
    m.type === 'boolean' ? 11 : m.type === 'int' ? 6 : m.type === 'long' ? 8 : m.type === 'float' ? 9 : m.type === 'double' ? 10 : 12;
  parts.push(int64Field(4, datatype)); // datatype = 4 (DataType enum)
  const enc = (field: number, bytes: Buffer) => parts.push(lenDelimited(field, bytes));
  switch (m.type) {
    case 'boolean':
      enc(9, Buffer.of(m.value ? 1 : 0));
      break; // boolean_value = 9
    case 'int':
      enc(5, varint(m.value as number));
      break; // int_value = 5
    case 'long':
      enc(6, varint(m.value as number));
      break; // long_value = 6
    case 'double': {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(m.value as number);
      enc(8, b);
      break; // double_value = 8
    }
    case 'float': {
      const b = Buffer.alloc(4);
      b.writeFloatBE(m.value as number);
      enc(7, b);
      break; // float_value = 7
    }
    case 'string':
      enc(10, Buffer.from(String(m.value), 'utf8'));
      break; // string_value = 10
  }
  return Buffer.concat(parts);
}
export function sparkplugPayload(metrics: SpMetric[], seq: number, ts = Date.now()): Buffer {
  return Buffer.concat([
    int64Field(1, ts), // timestamp = 1
    ...metrics.map((m) => lenDelimited(2, metric(m))), // metrics = 2 (repeated)
    int64Field(3, seq), // seq = 3
  ]);
}

// ---------- broker ----------
export interface MqttBrokerStub {
  port: number;
  url: string;
  /** all PUBLISH packets seen by the broker, with client id (to observe what the platform publishes) */
  publishes: { clientId: string; topic: string; payload: Buffer; qos: number; at: number }[];
  /** publishes NOT sent by our own edge-node test clients (i.e. from the platform) */
  platformPublishes(): { topic: string; payload: Buffer; at: number }[];
  stop(): Promise<void>;
}

export async function startMqttBroker(opts: { port?: number } = {}): Promise<MqttBrokerStub> {
  const mod: any = (await import('aedes' as any)) as any;
  const Aedes = mod.default ?? mod.Aedes ?? mod;
  const aedes = new Aedes({ id: 'orch-test-broker' });
  const publishes: { clientId: string; topic: string; payload: Buffer; qos: number; at: number }[] = [];
  aedes.on('publish', (packet: any, client: any) => {
    if (!client) return; // broker-internal (e.g. $SYS) — ignore
    publishes.push({
      clientId: client.id,
      topic: packet.topic,
      payload: Buffer.from(packet.payload),
      qos: packet.qos ?? 0,
      at: Date.now(),
    });
  });
  const server = net.createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    port,
    url: `mqtt://127.0.0.1:${port}`,
    publishes,
    platformPublishes() {
      return publishes
        .filter((p) => !p.clientId.startsWith('orch-test-edge'))
        .map(({ topic, payload, at }) => ({ topic, payload, at }));
    },
    stop() {
      return new Promise<void>((resolve) => {
        aedes.close(() => server.close(() => resolve()));
      });
    },
  };
}

// ---------- edge-node test publisher (Sparkplug device emulator, consumer-role tests) ----------
export interface EdgeNodeHandle {
  client: MqttClient;
  publishBirth(deviceId: string, metrics: SpMetric[]): void;
  publishDeath(deviceId: string): void;
  publishData(deviceId: string, metrics: SpMetric[]): void;
  /** Destroy the TCP socket ungracefully so the broker fires the LWT (NDEATH). */
  destroySocket(): void;
  end(): Promise<void>;
}

export function sparkplugTopics(group: string, edge: string, device: string) {
  const ns = `spBv1.0/${group}`;
  return {
    nbirthDevice: `${ns}/DBIRTH/${edge}/${device}`,
    ndeathDevice: `${ns}/DDEATH/${edge}/${device}`,
   ndataDevice: `${ns}/DDATA/${edge}/${device}`,
    nbirthNode: `${ns}/NBIRTH/${edge}`,
    ndeathNode: `${ns}/NDEATH/${edge}`,
  };
}

export async function connectEdgeNode(brokerUrl: string, group: string, edge: string): Promise<EdgeNodeHandle> {
  const t = sparkplugTopics(group, edge, 'unused');
  const ndeathPayload = sparkplugPayload([], 0);
  const client = connect(brokerUrl, {
    clientId: `orch-test-edge-${edge}-${Math.random().toString(36).slice(2, 8)}`,
    clean: false,
    will: { topic: t.ndeathNode, payload: ndeathPayload, qos: 1, retain: false },
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  let seq = 0;
  const topics = (device: string) => sparkplugTopics(group, edge, device);
  return {
    client,
    publishBirth(device, metrics) {
      client.publish(topics(device).nbirthDevice, sparkplugPayload(metrics, seq++), { qos: 1 });
    },
    publishDeath(device) {
      client.publish(topics(device).ndeathDevice, sparkplugPayload([], seq++), { qos: 1 });
    },
    publishData(device, metrics) {
      client.publish(topics(device).ndataDevice, sparkplugPayload(metrics, seq++), { qos: 1 });
    },
    destroySocket() {
      // stream destroy → no DISCONNECT packet → broker publishes the will (LWT path)
      (client as any).stream?.destroy?.();
    },
    end() {
      return new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    },
  };
}
