// [test-support] Doc-derived stub — REWIRED AT MERGE.
// Defensive adapters around the PRODUCT simulators @orch/sim-modbus (§5.2, §1:
// "real Modbus server on TCP:502 / RTU") and @orch/sim-opcua (mock OPC UA server,
// ticket #6). A7 (ADJUDICATED, adjudications.md): both are programmable (library +
// CLI) and their configs may carry timed fault scripts faults:[{afterMs,target,action}]
// — a product feature, not test scaffolding. We probe the conventional export names
// and shapes so a rename at merge only touches this file. Per-slave fault injection
// is part of that adjudicated surface; we probe common hook names
// (setSlaveFault / fault / setFault / stopSlave).

export interface SimModbusHandle {
  port: number;
  setRegisters(unitId: number, start: number, values: number[]): Promise<void> | void;
  readRegisters(unitId: number, start: number, count: number): Promise<number[]> | number[];
  setSlaveFault(unitId: number, on: boolean): Promise<void> | void;
  stop(): Promise<void>;
}

export async function startSimModbus(opts: { port?: number; unitIds?: number[] } = {}): Promise<SimModbusHandle> {
  const mod: any = await import('@orch/sim-modbus' as any);
  const factory =
    mod.startSimModbus ?? mod.start ?? mod.createServer ?? mod.default ?? mod;
  const handle = await factory({
    port: opts.port ?? 0,
    host: '127.0.0.1',
    ...(opts.unitIds ? { unitIds: opts.unitIds } : {}),
  });
  const port: number =
    handle.port ?? handle.address?.port ?? (handle.server?.address?.() as any)?.port;
  if (typeof port !== 'number' || port <= 0) {
    throw new Error('A7: sim-modbus adapter could not discover the listening port');
  }
  const setSlaveFault = (unitId: number, on: boolean) => {
    const fn = handle.setSlaveFault ?? handle.fault ?? handle.setFault ?? handle.stopSlave;
    if (typeof fn !== 'function') {
      throw new Error(
        `A7: sim-modbus has no per-slave fault injection hook (probed setSlaveFault/fault/setFault/stopSlave) ` +
          `— required by the per-slave degradation isolation test (§4.5)`,
      );
    }
    return fn.call(handle, unitId, on);
  };
  return {
    port,
    setRegisters: (u, s, v) => handle.setRegisters?.(u, s, v) ?? handle.writeRegisters?.(u, s, v),
    readRegisters: (u, s, c) => handle.readRegisters?.(u, s, c) ?? handle.holding?.(u, s, c),
    setSlaveFault,
    stop: async () => {
      await (handle.stop?.() ?? handle.close?.());
    },
  };
}

export interface SimOpcuaNode {
  nodeId: string;
  dataType: 'Boolean' | 'Int32' | 'Double' | 'String' | 'Int32[]' | 'Double[]' | 'String[]';
  value: unknown;
}
export interface SimOpcuaHandle {
  port: number;
  url: string;
  setValue(nodeId: string, value: unknown): Promise<void> | void;
  stop(): Promise<void>;
  restart(): Promise<SimOpcuaHandle>;
}

export async function startSimOpcua(opts: { nodes: SimOpcuaNode[]; port?: number }): Promise<SimOpcuaHandle> {
  const mod: any = await import('@orch/sim-opcua' as any);
  const factory = mod.startSimOpcua ?? mod.start ?? mod.createServer ?? mod.default ?? mod;
  const handle = await factory({ port: opts.port ?? 0, host: '127.0.0.1', nodes: opts.nodes });
  const port: number = handle.port ?? handle.address?.port ?? (handle.server?.address?.() as any)?.port;
  if (typeof port !== 'number' || port <= 0) {
    throw new Error('A7: sim-opcua adapter could not discover the listening port');
  }
  const url = handle.url ?? `opc.tcp://127.0.0.1:${port}`;
  return {
    port,
    url,
    setValue: (nodeId, value) => {
      const fn = handle.setValue ?? handle.writeValue ?? handle.write;
      if (typeof fn !== 'function') throw new Error('A7: sim-opcua adapter found no setValue hook');
      return fn.call(handle, nodeId, value);
    },
    stop: async () => {
      await (handle.stop?.() ?? handle.close?.());
    },
    async restart() {
      await (handle.stop?.() ?? handle.close?.());
      return startSimOpcua({ ...opts, port });
    },
  };
}
