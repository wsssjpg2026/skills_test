// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with @orch/sim-mes).
// Scriptable WebSocket MES peer implementing the §5.2 sim-mes config contract:
//   { responses: { reportScan: { payload: { ok: true } },
//                  getDestination: [ { payload: {...} }, { delayMs: 60000, drop: true } ] } }
// (an array is a per-attempt sequence; the last entry repeats) and the §2.6 envelope:
//   { id, type: 'request'|'response'|'event', op, payload, ts }
// Kernel is the WS client that dials out (adjudication Q5); this peer is the server.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export interface MesScriptEntry {
  payload?: object;
  delayMs?: number;
  drop?: boolean;
  error?: { code: string; message: string };
}

export interface MesSimConfig {
  responses: Record<string, MesScriptEntry | MesScriptEntry[]>;
}

export interface ReceivedMesMessage {
  id: string;
  type: string;
  op?: string;
  payload?: unknown;
  ts?: string;
  raw: any;
  receivedAt: number;
  envelopeViolations: string[];
}

export interface MesPeer {
  port: number;
  url: string;
  received: ReceivedMesMessage[];
  requestsFor(op: string): ReceivedMesMessage[];
  /** envelope-shape violations across all received messages (§2.6) */
  violations: string[];
  heartbeats: { at: number; kind: 'ws-ping' | 'json' }[];
  /** add/replace the response script for an op on the running peer */
  addScript(op: string, script: MesScriptEntry | MesScriptEntry[]): void;
  closeClient(): void;
  sendEvent(op: string, payload: object): void;
  stop(): Promise<void>;
  connectionCount(): number;
}

export async function startMesPeer(config: MesSimConfig): Promise<MesPeer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(410);
    res.end('MES sim peer: WebSocket only');
  });
  const wss = new WebSocketServer({ server });
  const received: ReceivedMesMessage[] = [];
  const violations: string[] = [];
  const heartbeats: { at: number; kind: 'ws-ping' | 'json' }[] = [];
  const dedupeCache = new Map<string, any>();
  let client: WebSocket | null = null;
  let connections = 0;
  const attemptCounts = new Map<string, number>();
  const responses: Record<string, MesScriptEntry | MesScriptEntry[]> = { ...config.responses };

  wss.on('connection', (ws) => {
    connections += 1;
    client = ws;
    ws.on('ping', () => {
      heartbeats.push({ at: Date.now(), kind: 'ws-ping' });
      try { ws.pong(); } catch {}
    });
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        violations.push(`non-JSON message received: ${String(data).slice(0, 120)}`);
        return;
      }
      const envViol: string[] = [];
      if (typeof msg.id !== 'string' || msg.id.length === 0) envViol.push('id must be a non-empty string');
      if (!['request', 'response', 'event'].includes(msg.type)) envViol.push(`type must be request|response|event (got ${msg.type})`);
      if (typeof msg.op !== 'string') envViol.push('op must be a string');
      if (typeof msg.ts !== 'string' || Number.isNaN(Date.parse(msg.ts))) envViol.push('ts must be ISO-8601');
      if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null)) envViol.push('payload must be an object when present');
      if (envViol.length > 0) violations.push(`message id=${msg.id}: ${envViol.join('; ')}`);
      received.push({
        id: msg.id,
        type: msg.type,
        op: msg.op,
        payload: msg.payload,
        ts: msg.ts,
        raw: msg,
        receivedAt: Date.now(),
        envelopeViolations: envViol,
      });
      // Heartbeat may also be expressed as a JSON envelope message.
      if (msg.type === 'request' && /ping|heartbeat/i.test(String(msg.op))) {
        heartbeats.push({ at: Date.now(), kind: 'json' });
      }

      if (msg.type !== 'request' || typeof msg.op !== 'string') return;

      const sendTo = (payload: string) => {
        if (ws.readyState !== WebSocket.OPEN) return; // socket died mid-flight: silence
        ws.send(payload);
      };
      // MES-side dedupe by id (§2.6: simulator implements it; recommended for real MES).
      if (dedupeCache.has(msg.id)) {
        const cached = dedupeCache.get(msg.id);
        setTimeout(() => sendTo(JSON.stringify(cached)), 10);
        return;
      }

      const script = responses[msg.op];
      if (script === undefined) {
        // no script: generic ack
        const resp = envelope(msg.id, 'response', msg.op, { ok: true });
        dedupeCache.set(msg.id, resp);
        sendTo(JSON.stringify(resp));
        return;
      }
      const seqArr = Array.isArray(script) ? script : [script];
      const n = (attemptCounts.get(msg.op) ?? 0) + 1;
      attemptCounts.set(msg.op, n);
      const entry = seqArr[Math.min(n - 1, seqArr.length - 1)];
      const apply = () => {
        if (entry.drop) return; // silence — drives caller timeout/retry paths
        const resp = envelope(
          msg.id,
          'response',
          msg.op,
          entry.payload ?? {},
          entry.error,
        );
        dedupeCache.set(msg.id, resp);
        sendTo(JSON.stringify(resp));
      };
      if (entry.delayMs && entry.delayMs > 0) setTimeout(apply, entry.delayMs);
      else apply();
    });
  });

  function envelope(id: string, type: 'response' | 'event', op: string, payload: object, error?: { code: string; message: string }): any {
    return {
      id,
      type,
      op,
      payload,
      ts: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    received,
    violations,
    heartbeats,
    requestsFor(op: string) {
      return received.filter((m) => m.op === op && m.type === 'request');
    },
    addScript(op, script) {
      responses[op] = script;
      attemptCounts.delete(op);
    },
    closeClient() {
      client?.terminate();
      client = null;
    },
    sendEvent(op: string, payload: object) {
      if (!client || client.readyState !== WebSocket.OPEN) throw new Error('MES peer: no connected client to push event to');
      client.send(JSON.stringify(envelope(`mes-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 'event', op, payload)));
    },
    connectionCount() {
      return connections;
    },
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
