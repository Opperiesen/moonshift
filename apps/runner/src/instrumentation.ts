import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

export type ProcessResourceSnapshot = {
  readonly observedAt: string;
  readonly elapsedMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly rssBytes: number;
  readonly maxRssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly availableCpuUnits: number;
};

const processStartedAt = process.hrtime.bigint();

/** Aggregate process telemetry only; it never captures arguments, environment, or payloads. */
export function collectProcessResourceSnapshot(now = new Date()): ProcessResourceSnapshot {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const resources = process.resourceUsage();
  return Object.freeze({
    observedAt: now.toISOString(),
    elapsedMs: Number(process.hrtime.bigint() - processStartedAt) / 1_000_000,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: memory.rss,
    maxRssBytes: resources.maxRSS * 1024,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    availableCpuUnits: availableParallelism(),
  });
}

export type RunnerHostDiscovery = {
  readonly cgroupVersion: 'V2' | 'V1' | 'NONE';
  readonly cgroupPath: string | null;
  readonly cgroupControllers: readonly string[];
  readonly delegatedControllers: readonly string[];
  readonly enforceable: {
    readonly cpu: boolean;
    readonly memory: boolean;
    readonly process: boolean;
  };
  readonly subordinateUidRange: boolean;
  readonly subordinateGidRange: boolean;
  readonly rootlessRuntime: 'PODMAN' | 'UNAVAILABLE' | 'UNVERIFIED';
  readonly rootlessNetwork: 'PASTA' | 'SLIRP4NETNS' | 'UNAVAILABLE' | 'UNVERIFIED';
  readonly storageDriver: 'OVERLAY' | 'FUSE_OVERLAYFS' | 'UNAVAILABLE' | 'UNVERIFIED';
  readonly filesystemType: 'APFS' | 'OTHER_UNSUPPORTED' | 'UNVERIFIED';
  readonly supportsRootlessOci: false;
};

type HostProbeDependencies = {
  readonly readText?: (path: string) => Promise<string>;
  readonly isWritable?: (path: string) => Promise<boolean>;
  readonly identity?: string;
  readonly platform?: NodeJS.Platform;
  /** Parsed output supplied by an operator-owned `podman info --format json` probe. */
  readonly podmanInfo?: unknown;
};

async function optionalText(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readText(path);
  } catch {
    return null;
  }
}

function words(value: string | null): readonly string[] {
  return Object.freeze((value?.trim().split(/\s+/u).filter(Boolean) ?? []).sort());
}

function unifiedCgroupPath(value: string | null): string | null {
  if (value === null) return null;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith('0::')) return line.slice(3) || '/';
  }
  return null;
}

function hasSubordinateRange(value: string | null, identity: string): boolean {
  return (
    value?.split(/\r?\n/u).some((line) => {
      const [owner, start, count, ...extra] = line.split(':');
      return (
        extra.length === 0 &&
        owner === identity &&
        /^\d+$/u.test(start ?? '') &&
        /^\d+$/u.test(count ?? '') &&
        Number(count) > 0
      );
    }) ?? false
  );
}

function podmanFacts(value: unknown): {
  readonly runtime: RunnerHostDiscovery['rootlessRuntime'];
  readonly network: RunnerHostDiscovery['rootlessNetwork'];
  readonly storage: RunnerHostDiscovery['storageDriver'];
} {
  if (value === undefined) {
    return { runtime: 'UNVERIFIED', network: 'UNVERIFIED', storage: 'UNVERIFIED' };
  }
  if (value === null || typeof value !== 'object') {
    return { runtime: 'UNAVAILABLE', network: 'UNAVAILABLE', storage: 'UNAVAILABLE' };
  }
  const info = value as Record<string, unknown>;
  const host = info.host;
  const store = info.store;
  if (host === null || typeof host !== 'object' || store === null || typeof store !== 'object') {
    return { runtime: 'UNAVAILABLE', network: 'UNAVAILABLE', storage: 'UNAVAILABLE' };
  }
  const hostFacts = host as Record<string, unknown>;
  const storeFacts = store as Record<string, unknown>;
  const rootless =
    hostFacts.security !== null &&
    typeof hostFacts.security === 'object' &&
    (hostFacts.security as Record<string, unknown>).rootless === true;
  const backend = String(hostFacts.networkBackend ?? '').toLowerCase();
  const graphDriver = String(storeFacts.graphDriverName ?? '').toLowerCase();
  return {
    runtime: rootless ? 'PODMAN' : 'UNAVAILABLE',
    network: backend.includes('pasta')
      ? 'PASTA'
      : backend.includes('slirp4netns')
        ? 'SLIRP4NETNS'
        : 'UNAVAILABLE',
    storage:
      graphDriver === 'overlay'
        ? 'OVERLAY'
        : graphDriver.includes('fuse-overlayfs')
          ? 'FUSE_OVERLAYFS'
          : 'UNAVAILABLE',
  };
}

/**
 * Records host facts without enabling OCI execution. Presence of Podman can never make the
 * foundation fixture profile eligible; slice 006 owns hostile-workload conformance.
 */
export async function discoverRunnerHost(
  dependencies: HostProbeDependencies = {},
): Promise<RunnerHostDiscovery> {
  const readText = dependencies.readText ?? ((path: string) => readFile(path, 'utf8'));
  const isWritable =
    dependencies.isWritable ??
    (async (path: string) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  const cgroup = await optionalText('/proc/self/cgroup', readText);
  const mountInfo = await optionalText('/proc/self/mountinfo', readText);
  const cgroupPath = unifiedCgroupPath(cgroup);
  const hasCgroupV2Mount =
    mountInfo?.split(/\r?\n/u).some((line) => line.includes(' - cgroup2 ')) ?? false;
  const cgroupVersion =
    cgroupPath !== null && hasCgroupV2Mount
      ? ('V2' as const)
      : cgroup?.includes(':')
        ? ('V1' as const)
        : ('NONE' as const);
  const unifiedDirectory =
    cgroupVersion === 'V2' && cgroupPath !== null
      ? join('/sys/fs/cgroup', cgroupPath.replace(/^\/+/, ''))
      : null;
  const controllers: readonly string[] =
    unifiedDirectory === null
      ? Object.freeze([])
      : words(await optionalText(join(unifiedDirectory, 'cgroup.controllers'), readText));
  const delegatedControllers: readonly string[] =
    unifiedDirectory === null
      ? Object.freeze([])
      : words(await optionalText(join(unifiedDirectory, 'cgroup.subtree_control'), readText)).map(
          (controller) => controller.replace(/^\+/u, ''),
        );
  const enforceable = async (controller: string, control: string): Promise<boolean> =>
    unifiedDirectory !== null &&
    controllers.includes(controller) &&
    delegatedControllers.includes(controller) &&
    (await isWritable(join(unifiedDirectory, control)));
  const identity = dependencies.identity ?? process.env.USER ?? String(process.getuid?.() ?? '');
  const [subuid, subgid, cpu, memory, pids] = await Promise.all([
    optionalText('/etc/subuid', readText),
    optionalText('/etc/subgid', readText),
    enforceable('cpu', 'cpu.max'),
    enforceable('memory', 'memory.max'),
    enforceable('pids', 'pids.max'),
  ]);
  const podman = podmanFacts(dependencies.podmanInfo);
  return Object.freeze({
    cgroupVersion,
    cgroupPath,
    cgroupControllers: controllers,
    delegatedControllers: Object.freeze(delegatedControllers),
    enforceable: Object.freeze({ cpu, memory, process: pids }),
    subordinateUidRange: hasSubordinateRange(subuid, identity),
    subordinateGidRange: hasSubordinateRange(subgid, identity),
    rootlessRuntime: podman.runtime,
    rootlessNetwork: podman.network,
    storageDriver: podman.storage,
    filesystemType:
      (dependencies.platform ?? process.platform) === 'darwin' ? 'APFS' : 'UNVERIFIED',
    supportsRootlessOci: false,
  });
}
