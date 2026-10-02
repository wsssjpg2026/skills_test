/**
 * REST DTO types for the resources that exist at ticket #3 (architecture doc
 * §2.1: `Channel` / `Device`; `Tag` lives in common.ts). The remaining
 * resources arrive with tickets #4+.
 *
 * Channel/Device records are also part of the driver SPI payload
 * (`channel.start` / `channel.update` carry the full desired state), so they
 * are shared between the REST API and the SPI.
 *
 * Types + JSON constants only — @orch/contracts contains zero logic.
 */

/** A driver channel. `driver` = plugin id (adjudication A-PLUGIN-IDS). */
export interface Channel {
  /** UUIDv7. */
  id: string;
  /** Unique per parent, matches `^[A-Za-z0-9_-]{1,64}$`. */
  name: string;
  /** Plugin id this channel runs on, e.g. `mock-driver`. */
  driver: string;
  enabled: boolean;
  /**
   * Driver-private configuration, validated against the driver's reported
   * `configSchema` (e.g. the mock-driver script, §5.2).
   */
  config: object;
  createdAt: string;
  updatedAt: string;
}

/** A device (slave / endpoint) on a channel. */
export interface Device {
  /** UUIDv7. */
  id: string;
  channelId: string;
  /** Unique per channel, matches `^[A-Za-z0-9_-]{1,64}$`. */
  name: string;
  /** Driver-private address grammar. */
  address: string;
  enabled: boolean;
  /** Driver-private extras, validated by the driver. */
  config: object;
}
