/**
 * Common wire types (architecture doc §2.0).
 *
 * Timestamps on the wire are ISO-8601 UTC strings (epoch ms internally).
 * This module is types-only — @orch/contracts contains zero logic.
 */

/** Quality stamped on every sample; carried end-to-end (cache → history → northbound → WS). */
export type Quality = 'good' | 'bad' | 'uncertain';

export type QualityReason =
  | 'ok'
  | 'timeout'
  | 'comm_error'
  | 'config_error'
  | 'device_offline'
  | 'address_invalid'
  | 'write_rejected'
  | 'overrange'
  | 'stale'
  | 'link_backoff'
  | 'recovering'
  | 'substituted'
  | 'unknown';

export type TagValue = number | boolean | string | number[] | string[] | null;

export interface Sample {
  tagId: string;
  value: TagValue;
  quality: Quality;
  reason?: QualityReason;
  /** ISO-8601 UTC string. */
  ts: string;
}

/** `{channelName}.{deviceName}.{tagName}` — names contain no dots. */
export type TagPath = string;

export interface Page<T> {
  items: T[];
  total: number;
  cursor?: string;
}

/** All-protocol superset; every field optional except where marked. Drivers validate their own address/config extras via SPI `validate`. */
export type TagDataType =
  | 'bool'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'float32'
  | 'float64'
  | 'string'
  | 'json'
  | 'int16[]'
  | 'uint16[]'
  | 'int32[]'
  | 'uint32[]'
  | 'float32[]'
  | 'float64[]'
  | 'string[]';

export interface TagScaling {
  slope?: number;
  offset?: number;
  enumMap?: Record<string, number>;
}

export interface TagDeadband {
  /** Absolute change threshold. */
  abs?: number;
  /** Percent-of-span change threshold. */
  pct?: number;
}

export interface Tag {
  /** Required. UUIDv7. */
  id: string;
  /** Required. */
  deviceId: string;
  /** Required; unique per device, matches `^[A-Za-z0-9_-]{1,64}$`. */
  name: string;
  dataType: TagDataType;
  /** Driver-private grammar, e.g. Modbus `4x:INT32:0`. */
  address: string;
  byteOrder?: 'AB' | 'BA' | 'ABCD' | 'DCBA' | 'BADC' | 'CDAB';
  scaling?: TagScaling;
  /** 10..3_600_000; scan group = (deviceId, scanPeriodMs). */
  scanPeriodMs?: number;
  deadband?: TagDeadband;
  access: 'read' | 'write' | 'readwrite';
  historyEnabled: boolean;
  /** Driver-private extras, validated by the driver. */
  config?: object;
}
