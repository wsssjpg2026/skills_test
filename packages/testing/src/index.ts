/**
 * @orch/testing — the kernel test seam (architecture doc §5):
 * `bootKernel()` / `spawnKernel()` (in-process + real child process),
 * typed REST + WS clients (thin, doc-shaped), the programmatic seed helper
 * (channels/devices/tags through the storage port), and the tag_update seam
 * hook. Fault-injection helpers and `installScenario()` grow with later
 * tickets.
 */
export { ApiError, OrchRestClient, TagsWsClient, type RestHealth, type WsFrame } from './clients.js';
export {
  bootKernel,
  spawnKernel,
  waitForTagUpdate,
  type BootKernelOptions,
  type KernelHandle,
  type SpawnKernelOptions,
  type SpawnedKernel,
} from './harness.js';
export {
  seedTopology,
  uuidv7,
  type SeedChannelSpec,
  type SeedDeviceSpec,
  type SeedResult,
  type SeedSpec,
  type SeedTagSpec,
} from './seed.js';
