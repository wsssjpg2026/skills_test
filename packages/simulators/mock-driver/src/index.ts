/**
 * @orch/mock-driver — generic scriptable driver plugin (§5.2), the reference
 * plugin for the SPI contract suite (§2.3.6). The process entry is
 * `dist/main.js` (bin `orch-mock-driver`); this module exposes the driver
 * logic for in-process reuse by later simulators.
 */
export {
  MOCK_DRIVER_CONFIG_SCHEMA,
  MOCK_DRIVER_ID,
  MOCK_DRIVER_VERSION,
  MockDriver,
  SpiError,
  type OutboundNotification,
} from './driver.js';
export {
  type MockChannelConfig,
  type MockScriptStep,
  parseScriptConfig,
  validateChannelConfig,
} from './script.js';
