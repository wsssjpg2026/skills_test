/**
 * `orch-kernel` CLI entry point: loads orch.config.json (path via ORCH_CONFIG,
 * default ./orch.config.json — architecture doc §6.1), boots the kernel and
 * handles graceful shutdown.
 */
import { createKernel, type Kernel } from './boot.js';
import { loadConfig, resolveConfigPath, type KernelConfig } from './config.js';

const configPath = resolveConfigPath();

let config: KernelConfig = {};
let configMissing = false;
try {
  config = await loadConfig(configPath);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    // No config file — boot with embedded defaults (friendly for local dev).
    configMissing = true;
  } else {
    console.error(`orch-kernel: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

let kernel: Kernel;
try {
  kernel = await createKernel(config);
} catch (err) {
  console.error(`orch-kernel: boot failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (configMissing) {
  kernel.log.warn({ configPath }, 'config file not found — using embedded defaults');
}

await kernel.start();

kernel.log.info({ config: configPath, port: kernel.port, url: `http://localhost:${kernel.port}/` }, 'kernel started');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  kernel.log.info({ signal }, 'shutting down');
  try {
    await kernel.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
