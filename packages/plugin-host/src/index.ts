/**
 * @orch/plugin-host — driver plugin host (architecture doc §2.3, §6.1):
 * manifest discovery, child-process supervision, ndjson JSON-RPC 2.0 framing
 * with deadlines/backpressure/16 MiB cap, heartbeat, restart backoff +
 * full-resync orchestration. Implemented by ticket #3.
 */
export {
  BackpressureWriter,
  CappedLineReader,
  MessageTooLargeError,
} from './transport.js';
export {
  discoverManifests,
  loadManifest,
  ManifestError,
  type PluginManifest,
} from './manifest.js';
export {
  consolePluginLogger,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RESTART_POLICY,
  PluginRequestTimeout,
  PluginRpcError,
  PluginUnavailableError,
  SupervisedPlugin,
  type PluginLifecycleState,
  type PluginLogger,
  type RestartPolicy,
  type SupervisedPluginOptions,
} from './supervised-plugin.js';
export {
  PluginHost,
  type DesiredChannel,
  type PluginHostOptions,
  type PluginStateSnapshot,
} from './plugin-host.js';
