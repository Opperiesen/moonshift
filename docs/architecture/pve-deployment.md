# Proxmox VE Deployment Target

Moonshift initially targets one owner-operated Proxmox VE host with 16 GB RAM, NVMe storage, and
remote model inference. These are validation targets, not guaranteed reservations or universal sizing
claims.

## Production-oriented topology

```text
Proxmox VE host
├── moonshift-control (lightweight VM or suitably constrained LXC)
│   ├── web/API/orchestrator
│   ├── PostgreSQL
│   └── artifact storage implementation
└── moonshift-runner-01 (dedicated VM)
    ├── runner daemon
    ├── rootless OCI runtime
    ├── isolated workspaces
    └── Git worktrees
```

The dedicated runner VM is the strong isolation boundary for repository-controlled and generated
code. Container isolation inside that VM provides job separation but does not replace the VM boundary.

## Reference workload

- one supervisor and one primary active project;
- three persistent personas and four active specialists by default;
- three concurrent cognitive executions by default, five only as a validated ceiling;
- one standard runner job by default, two only after capacity discovery permits;
- durable events and responsive live UI;
- no local GPU requirement.

## Planning envelope

The control plane should fit approximately 2 vCPU and 2–3 GB RAM. One normal runner job should fit
approximately 4–6 vCPU and at most 6 GB RAM. The rest of the host remains available to PVE, the host
kernel, storage services, filesystem cache, and spikes. These figures must be benchmarked with the
first representative slice and adjusted from evidence.

Capacity scheduling uses resource units for CPU, memory, process count, disk, time, and optional GPU,
not an agent count. Runner registration records cgroup version, rootless runtime, storage, filesystem,
network-control, process-limit, and artifact capabilities plus whether every requested unit is
enforceable. Slice 001 registers only the fixture-process profile with one job, denied network, bounded
time, and zero requested GPU. The scheduler fails closed when a requested CPU, memory, process, disk,
time, network, or GPU control is unavailable. Rootless OCI eligibility additionally requires cgroups
v2, subordinate UID/GID ranges, a supported rootless network helper, storage driver, and local
filesystem; slice 001 records these probes but cannot schedule OCI work or a second job.

## Deployment modes

**All-in-one evaluation mode** packages control plane, database, artifact store, and runner together
for local development or trusted fixtures. It must bind locally by default and display its weaker
isolation.

**Split mode** separates the control plane and runner, uses authenticated runner enrollment, and is
the production-oriented baseline. It supports additional runners later without changing authoritative
state ownership.

## Storage and recovery

PostgreSQL stores canonical state and event/outbox records in the preferred plan. Artifact bytes use a
filesystem or S3-compatible implementation behind an interface; metadata and hashes remain relational.
Backups must capture a consistent database snapshot, artifact set, configuration excluding plaintext
secrets, and version manifest. Restore validates hashes and schema compatibility before resuming work.
Reference-host validation records final backup size, temporary backup and restore working-space
high-water marks, and scheduling downtime from the required stop through manifest/schema/hash
validation and projection rebuild. The run fails if the complete backup plus working space exceeds its
declared disk envelope or if scheduling resumes before validation succeeds.

Upgrade planning requires forward migration, pre-upgrade backup, compatibility checks, rollback limits,
and restoration rehearsal. Downgrade is not assumed safe after a schema migration.

## Network posture

The control UI is not publicly exposed by default. Runner management is on a trusted private network.
Job egress defaults to denied or approved destinations for Git, package registries, and necessary test
services. Remote inference traffic leaves only through the credentialed backend boundary and is
recorded in context manifests.
