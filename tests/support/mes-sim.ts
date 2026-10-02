// doc-derived test stub — rewired to @orch/* at merge.
// §5.2: "@orch/sim-mes is a scriptable WS server (a northbound *peer*, not a plugin)" —
// the kernel DIALS OUT to it (§2.6, kernel is the client). Tests start it out-of-band and
// point kernel config northbound.mes.url at it. At merge: dynamic import of @orch/sim-mes.

import { freePort } from './util.js';
import type { MesEnvelope, SimMesConfig } from './types.js';

export interface MesSimHandle {
  port: number;
  url: string;
  /** All envelopes the "MES" received, in order (for request-correlation assertions). */
  received: () => MesEnvelope[];
  /** All responses sent. */
  sent: () => MesEnvelope[];
  stop: () => Promise<void>;
}

/**
 * Start the scriptable MES simulator on an ephemeral port.
 * Doc contract (§5.2): per-`op` response scripts with delayMs / error / drop and scripted
 * sequences; §2.6: responses echo the request `id` verbatim.
 */
export async function startSimMes(config: SimMesConfig): Promise<MesSimHandle> {
  const port = await freePort();
  let mod: {
    createMesServer(cfg: SimMesConfig & { port: number }): Promise<{
      port: number; received: MesEnvelope[]; sent: MesEnvelope[]; close(): Promise<void>;
    }>;
  };
  // Non-literal specifier: the package does not exist until the implementation branch
  // merges (stub by design, same pattern as boot.ts).
  const spec = '@orch/sim-mes';
  try {
    mod = (await import(/* @vite-ignore */ spec)) as typeof mod;
  } catch (err) {
    throw new Error(
      'STUB: @orch/sim-mes is not merged yet — startSimMes() is a doc-derived stub that ' +
      'imports it at merge time (see tests/support/ASSUMPTIONS.md A-SIMMES-EXPORT). ' +
      `Underlying import error: ${String(err)}`,
    );
  }
  const server = await mod.createMesServer({ ...config, port });
  return {
    port: server.port,
    url: `ws://127.0.0.1:${server.port}`,
    received: () => [...server.received],
    sent: () => [...server.sent],
    stop: () => server.close(),
  };
}
