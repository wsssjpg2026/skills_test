// [test-support] Doc-derived stub — REWIRED AT MERGE (dedup with any product HTTP test device).
// Minimal REST device stub for the HTTP southbound driver (ticket #8): serves
// scripted JSON per path, records requests, and can be set to fail with a status code.
import http from 'node:http';

export interface HttpDeviceStub {
  port: number;
  baseUrl: string;
  setJson(path: string, json: unknown): void;
  setFunction(path: string, fn: (req: http.IncomingMessage) => unknown): void;
  setFault(path: string, statusCode: number): void;
  clearFault(path: string): void;
  requestCount(path?: string): number;
  /** timestamps of requests to a path — used to assert polling cadence */
  requestTimes(path?: string): number[];
  stop(): Promise<void>;
}

export async function startHttpDevice(): Promise<HttpDeviceStub> {
  const routes = new Map<string, { json?: unknown; fn?: (req: http.IncomingMessage) => unknown; fault?: number }>();
  const times: { path: string; at: number; method: string }[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const route = routes.get(url.pathname);
    times.push({ path: url.pathname, at: Date.now(), method: req.method ?? 'GET' });
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route' }));
      return;
    }
    if (route.fault !== undefined) {
      res.writeHead(route.fault, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'scripted fault' }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = route.fn
        ? route.fn(req)
        : typeof route.json === 'function'
          ? (route.json as any)()
          : route.json;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    setJson(path, json) {
      routes.set(path, { json });
    },
    setFunction(path, fn) {
      routes.set(path, { fn });
    },
    setFault(path, statusCode) {
      const r = routes.get(path) ?? {};
      routes.set(path, { ...r, fault: statusCode });
    },
    clearFault(path) {
      const r = routes.get(path) ?? {};
      delete (r as any).fault;
      routes.set(path, r);
    },
    requestCount(path) {
      return times.filter((t) => (path === undefined || t.path === path)).length;
    },
    requestTimes(path) {
      return times.filter((t) => (path === undefined || t.path === path)).map((t) => t.at);
    },
    stop() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
