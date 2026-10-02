/**
 * ndjson transport primitives for the driver SPI (architecture doc §2.3):
 * one JSON-RPC 2.0 message per `\n`, 16 MiB per-message cap in both
 * directions, and write backpressure against a slow plugin stdin.
 */
import { SPI_MAX_MESSAGE_BYTES } from '@orch/contracts/spi';

/** A line exceeded the 16 MiB per-message cap (protocol violation). */
export class MessageTooLargeError extends Error {
  constructor(bytes: number) {
    super(`ndjson message exceeds ${SPI_MAX_MESSAGE_BYTES} bytes (got ${bytes})`);
    this.name = 'MessageTooLargeError';
  }
}

/**
 * Line assembler over a byte stream with a hard cap. Emits complete lines
 * (without the newline); rejects oversized messages instead of buffering
 * them forever.
 */
export class CappedLineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly maxBytes: number = SPI_MAX_MESSAGE_BYTES,
  ) {}

  /** Feed raw bytes; returns complete lines decoded as UTF-8. */
  push(chunk: Buffer): string[] {
    if (this.closed || chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) {
      this.closed = true;
      throw new MessageTooLargeError(this.buffer.length);
    }
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, nl).toString('utf8');
      this.buffer = this.buffer.subarray(nl + 1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Flush a trailing partial line at end-of-stream (spec allows none). */
  rest(): string[] {
    const rest = this.buffer.toString('utf8');
    this.buffer = Buffer.alloc(0);
    return rest.length > 0 ? [rest] : [];
  }
}

/**
 * Serialized writer with backpressure: messages are queued and written one at
 * a time; when the writable signals high-water mark, further writes wait for
 * `drain` instead of piling up in kernel buffers.
 */
export class BackpressureWriter {
  private queue: Buffer[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly writable: NodeJS.WritableStream,
    private readonly maxBytes: number = SPI_MAX_MESSAGE_BYTES,
  ) {}

  /** Queue one ndjson message (a `\n` is appended). */
  write(message: string): void {
    const payload = Buffer.from(`${message}\n`, 'utf8');
    if (payload.length > this.maxBytes) {
      throw new MessageTooLargeError(payload.length);
    }
    this.queue.push(payload);
    this.chain = this.chain.then(() => this.flush());
  }

  /** Resolves once every queued message has been handed to the stream. */
  drained(): Promise<void> {
    return this.chain;
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.writable.write(next)) {
        await onceDrain(this.writable);
      }
      this.queue.shift();
    }
  }
}

function onceDrain(writable: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    writable.once('drain', () => resolve());
  });
}
