export type FixtureResourceRequest = {
  readonly memoryBytes: number;
  readonly cpuUnits: number;
  readonly processLimit: number;
  readonly diskBytes: number;
  readonly maxRuntimeMs: number;
  readonly networkMode: 'DENY';
  readonly gpuUnits: number;
};

export type FixtureResourceCapacity = {
  readonly fixtureOperations: true;
  readonly arbitraryShell: false;
  readonly maxJobs: 1;
  readonly memoryBytes: number;
  readonly cpuUnits: number;
  readonly processLimit: number;
  readonly diskBytes: number;
  readonly maxRuntimeMs: number;
  readonly networkMode: 'DENY';
  readonly gpuUnits: 0;
  readonly enforcement: {
    readonly cpu: boolean;
    readonly memory: boolean;
    readonly process: boolean;
    readonly disk: boolean;
    readonly time: boolean;
    readonly network: boolean;
    readonly gpu: boolean;
  };
};

export const DEFAULT_FIXTURE_CAPACITY: FixtureResourceCapacity = Object.freeze({
  fixtureOperations: true,
  arbitraryShell: false,
  maxJobs: 1,
  memoryBytes: 268_435_456,
  cpuUnits: 1,
  processLimit: 1,
  diskBytes: 16_777_216,
  maxRuntimeMs: 60_000,
  networkMode: 'DENY',
  gpuUnits: 0,
  enforcement: Object.freeze({
    // Node 24 provides no hard CPU quota, and --max-old-space-size is not an RSS/process-memory
    // limit. Those controls stay false, making scheduling fail closed on this non-OCI profile.
    cpu: false,
    memory: false,
    // The remaining facts apply only to the immutable WRITE_APPROVED_MARKER entrypoint: one child,
    // no caller code, filesystem writes/subprocesses/workers denied, no network primitive in the
    // fixed source, a hard timeout, and no GPU/native-addon/WASI path. This is not generic isolation.
    process: true,
    disk: true,
    time: true,
    network: true,
    gpu: true,
  }),
});

export function fixtureRuntimeDiscovery() {
  const filesystemType = process.platform === 'darwin' ? 'APFS' : 'OTHER_UNSUPPORTED';
  return Object.freeze({
    cgroupVersion: 'NONE' as const,
    subordinateUidRange: false,
    subordinateGidRange: false,
    rootlessRuntime: 'UNAVAILABLE' as const,
    rootlessNetwork: 'UNAVAILABLE' as const,
    storageDriver: 'UNAVAILABLE' as const,
    filesystemType,
    supportsRootlessOci: false,
  });
}

export type FixtureEligibility =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

export function evaluateFixtureEligibility(
  request: FixtureResourceRequest,
  capacity: FixtureResourceCapacity,
): FixtureEligibility {
  if (!capacity.fixtureOperations || capacity.arbitraryShell || capacity.maxJobs !== 1) {
    return { eligible: false, reason: 'FIXTURE_PROFILE_UNAVAILABLE' };
  }
  if (request.networkMode !== 'DENY' || capacity.networkMode !== 'DENY') {
    return { eligible: false, reason: 'NETWORK_DENIAL_REQUIRED' };
  }
  if (!capacity.enforcement.network) return { eligible: false, reason: 'NETWORK_NOT_ENFORCEABLE' };
  if (request.gpuUnits !== 0 || capacity.gpuUnits !== 0)
    return { eligible: false, reason: 'GPU_UNSUPPORTED' };
  if (!capacity.enforcement.gpu) return { eligible: false, reason: 'GPU_NOT_ENFORCEABLE' };
  if (!capacity.enforcement.memory) return { eligible: false, reason: 'MEMORY_NOT_ENFORCEABLE' };
  if (!capacity.enforcement.cpu) return { eligible: false, reason: 'CPU_NOT_ENFORCEABLE' };
  if (!capacity.enforcement.process) return { eligible: false, reason: 'PROCESS_NOT_ENFORCEABLE' };
  if (!capacity.enforcement.disk) return { eligible: false, reason: 'DISK_NOT_ENFORCEABLE' };
  if (!capacity.enforcement.time) return { eligible: false, reason: 'TIME_NOT_ENFORCEABLE' };
  if (request.memoryBytes > capacity.memoryBytes)
    return { eligible: false, reason: 'MEMORY_EXCEEDED' };
  if (request.cpuUnits > capacity.cpuUnits) return { eligible: false, reason: 'CPU_EXCEEDED' };
  if (request.processLimit > capacity.processLimit)
    return { eligible: false, reason: 'PROCESS_LIMIT_EXCEEDED' };
  if (request.diskBytes > capacity.diskBytes) return { eligible: false, reason: 'DISK_EXCEEDED' };
  if (request.maxRuntimeMs > capacity.maxRuntimeMs)
    return { eligible: false, reason: 'RUNTIME_EXCEEDED' };
  return { eligible: true };
}
