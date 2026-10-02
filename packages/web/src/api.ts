/**
 * Health-endpoint client. Shape per architecture doc §2.1:
 * `{status, version, uptimeSec, storage: {mode, ok}, plugins: [{id, state}]}`.
 */
export interface Health {
  status: string;
  version: string;
  uptimeSec: number;
  storage: { mode: string; ok: boolean };
  plugins: { id: string; state: string }[];
}

export interface HealthCheck {
  /** HTTP-level ok (2xx). */
  ok: boolean;
  httpStatus: number;
  body: Health | null;
  error?: string;
}

export async function fetchHealth(kind: 'live' | 'ready'): Promise<HealthCheck> {
  try {
    const res = await fetch(`/health/${kind}`);
    let body: Health | null = null;
    try {
      body = (await res.json()) as Health;
    } catch {
      /* non-JSON body — surfaced via httpStatus */
    }
    return { ok: res.ok, httpStatus: res.status, body };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
