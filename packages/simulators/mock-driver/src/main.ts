#!/usr/bin/env node
/**
 * mock-driver process entry: ndjson JSON-RPC 2.0 on stdio (§2.3).
 * stderr carries the plugin's own logs (the host prefixes and forwards).
 */
import { createInterface } from 'node:readline';
import { JSON_RPC_PARSE_ERROR } from '@orch/contracts/spi';
import { MockDriver } from './driver.js';

const driver = new MockDriver((n) => writeMessage({ jsonrpc: '2.0', method: n.method, params: n.params }));

function writeMessage(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`${new Date().toISOString()} mock-driver ${level}: ${message}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'parse error' } });
    return;
  }

  if (typeof msg.method !== 'string' || msg.id === undefined) {
    // Host → plugin direction carries requests only; a notification upward
    // from the host is a protocol violation.
    log('warn', `dropping invalid host message (method/id missing): ${trimmed.slice(0, 120)}`);
    return;
  }

  try {
    const result = driver.handle(msg.method, msg.params);
    writeMessage({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'shutdown') {
      // Reply first, flush, then exit 0 (§2.3.1: `{}` then exit 0).
      setImmediate(() => process.exit(0));
    }
  } catch (err) {
    const code = (err as { code?: number }).code;
    const e =
      typeof code === 'number'
        ? { code, message: err instanceof Error ? err.message : String(err) }
        : { code: -32000, message: err instanceof Error ? err.message : String(err) };
    writeMessage({ jsonrpc: '2.0', id: msg.id, error: e });
  }
});

// Host closed stdin → the host is gone; exit without ceremony.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log('info', 'mock-driver plugin up (stdio ndjson, protocolVersion 1)');
