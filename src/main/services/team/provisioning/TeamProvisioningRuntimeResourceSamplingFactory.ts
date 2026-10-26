import { TeamProvisioningRuntimeResourceSampling } from './TeamProvisioningRuntimeResourceSampling';

import type {
  RuntimeResourceSamplingCacheAccess,
  RuntimeResourceSamplingLogPorts,
  RuntimeResourceSamplingOptions,
} from './TeamProvisioningRuntimeResourceSampling';

export const DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS = {
  processTableTimeoutMs: 1_500,
  // A cold PowerShell CIM query: 1.6-3.6 s on a Windows 11 desktop. At 1.5 s
  // every read was cut off, so idle native teammates and OpenCode lanes lost
  // their only liveness evidence on Windows.
  windowsProcessTableTimeoutMs: 8_000,
  livenessProcessTableCacheTtlMs: 5_000,
  livenessProcessTableFailureCacheTtlMs: 2_000,
  resourceTelemetryCacheTtlMs: 60_000,
  resourceTelemetryFailureCacheTtlMs: 10_000,
  processUsageCacheTtlMs: 30_000,
  processUsageCacheMaxEntries: 4_096,
  pidusageBatchTimeoutMs: 2_000,
  pidusageSingleTimeoutMs: 750,
  pidusageFallbackConcurrency: 16,
  maxRuntimeTreePidsPerRoot: 64,
  maxRuntimeUsagePidsPerSnapshot: 512,
  historyLimit: 60,
  minSampleIntervalMs: 30_000,
} satisfies RuntimeResourceSamplingOptions;

export function createDefaultTeamProvisioningRuntimeResourceSampling(
  cacheAccess: RuntimeResourceSamplingCacheAccess,
  logPorts: RuntimeResourceSamplingLogPorts,
  options: RuntimeResourceSamplingOptions = DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS
): TeamProvisioningRuntimeResourceSampling {
  return new TeamProvisioningRuntimeResourceSampling(options, cacheAccess, logPorts);
}
