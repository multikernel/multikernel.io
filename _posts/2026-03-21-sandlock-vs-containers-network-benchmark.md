---
layout: post
title: "Sandlock vs. Containers: 25% Higher Throughput for High-Frequency Messaging"
date: 2026-03-21 10:00:00 -0700
categories: [benchmark, open-source, linux-kernel, performance]
author: Cong Wang, Founder and CEO
excerpt: "We benchmarked Sandlock against Docker using Redis 8.6 with 50 concurrent clients and 256-byte payloads. Sandlock delivered 141,000 ops/sec versus Docker's 113,000. Median latency: 0.33 ms versus 0.50 ms. Tail latency: 0.88 ms versus 1.46 ms. The difference is structural: containers add a virtual network stack that Sandlock does not need."
---

Every message sent to a containerized service on the same machine pays a tax. It traverses iptables DNAT rules, a Linux bridge, and a virtual Ethernet device before it reaches the process inside. For large file transfers, the tax is invisible. For the workloads that define modern infrastructure (real-time stream processing, in-memory caching, sidecar communication), it is the single largest source of overhead.

We measured this tax using Redis, and the results surprised us.

## Benchmark Setup

We ran a Redis 8.6 server inside each isolation environment while `redis-benchmark` ran directly on the host, connecting to the server. This models the common deployment pattern where external clients or co-located services connect to a confined server process.

The identical Redis binary (`/usr/bin/redis-server`) was used in all three configurations. For Docker, the host binary and its libraries were bind-mounted into the container, eliminating version differences as a variable. Persistence was disabled across all tests (`--save ""`, `--appendonly no`) to isolate network and processing overhead from disk I/O.

**Three configurations tested:**

1. **Bare metal.** Redis server runs directly on the host. No isolation. The benchmark client connects over localhost. This establishes the performance ceiling.

2. **[Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}.** Redis server runs inside a process sandbox with real security restrictions:
   - Landlock filesystem confinement: read access to system libraries and `/dev`; write access limited to `/tmp`.
   - Landlock network restrictions: `net_bind` and `net_connect` locked to the Redis port only.
   - Seccomp-bpf: default deny list blocking 34 dangerous syscalls (`mount`, `ptrace`, `io_uring`, `bpf`, and others).
   - Argument-level seccomp filtering on `prctl`, `ioctl`, and `clone` to block specific dangerous operations while allowing safe usage.
   - No root privileges. No namespaces. No container runtime.

   The benchmark client connects over localhost. Both server and client share the host network stack.

3. **Docker.** Redis server runs in a container with the default bridge network and port mapping (`-p 16379:16379`). The benchmark client connects through the mapped port. Traffic traverses the veth pair, the Docker bridge, and the netfilter/conntrack rules that Docker configures for port forwarding.

Each configuration was tested for three rounds with 50 concurrent clients, 100,000 requests, and 256-byte values. Results were averaged.

## The Numbers

| | SET ops/sec | GET ops/sec | SET p50 | SET p99 | GET p50 | GET p99 | Combined |
|---|---|---|---|---|---|---|---|
| Bare metal | 81,229 | 78,342 | 0.316 ms | 0.631 ms | 0.327 ms | 0.540 ms | 100% |
| Sandlock | 70,777 | 69,967 | 0.327 ms | 0.911 ms | 0.327 ms | 0.850 ms | 88.2% |
| Docker | 56,210 | 56,639 | 0.498 ms | 1.471 ms | 0.498 ms | 1.447 ms | 70.7% |

Three things stand out.

**Throughput.** Sandlock delivers 140,744 combined ops/sec. Docker delivers 112,849. That is **25% more operations per second** for the same workload on the same hardware. Sandlock retains 88% of bare metal performance; Docker retains 71%.

**Median latency.** Sandlock: 0.33 ms. Docker: 0.50 ms. Docker adds 0.17 ms to every request at the median. That is **50% higher** than Sandlock, which is within 3% of bare metal.

**Tail latency.** Sandlock: 0.88 ms at p99. Docker: 1.46 ms. Docker's 99th percentile is **66% higher**. For systems bound by SLAs at the 99th percentile, this is the number that determines whether you meet your contract or breach it.

## Two Paths Through the Kernel

Where does the 25% gap come from? It is not a tuning issue. It is a consequence of how each technology routes packets.

When a client sends a request to a Docker container on the same host, the packet takes this path:

```
Client  -->  host TCP  -->  netfilter DNAT  -->  bridge  -->  veth  -->  container TCP  -->  Redis
```

Docker uses iptables rules for port mapping. Every packet hits a conntrack lookup in the PREROUTING chain (the NAT decision is cached after the first packet, but the lookup itself is per-packet). The bridge performs MAC-level forwarding. The veth pair transfers the packet between network namespaces, adding a netdev traversal on each side. At 50 concurrent clients generating thousands of small requests per second, these costs compound.

When a client sends a request to a Sandlock-confined process:

```
Client  -->  loopback  -->  Redis
```

There is no virtual device. No bridge. No netfilter evaluation. Both processes share the host network stack. The kernel's loopback path delivers the packet directly.

Sandlock's security enforcement operates at the syscall boundary, not at the packet level. Landlock restricts which TCP ports a process may `bind()` or `connect()` to, checked once at connection time. The data path syscalls (`sendmsg`, `recvmsg`, `read`, `write`) pass through the seccomp-bpf filter in nanoseconds (arch check, arg filter skip, syscall number match) and proceed directly to the kernel's TCP implementation. There is no per-packet overhead beyond the BPF filter evaluation, which is negligible at this scale.

## Host Mode Is Not the Answer

Docker offers `--network=host`, which bypasses the bridge/veth/iptables stack entirely. The container shares the host's network namespace and gets the same loopback performance as bare metal. This would eliminate the throughput gap we measured.

The tradeoff: `--network=host` provides **zero network isolation**. The container can bind any port, connect to any address, and see all host network traffic. Docker's network isolation depends entirely on the namespace/bridge/iptables layer, and host mode disables all of it.

This is where Sandlock's architecture provides a distinct advantage. Sandlock uses the host network stack (the same fast path as `--network=host`) while still enforcing port-level restrictions through Landlock. A Sandlock-confined process can only `bind()` and `connect()` to the ports specified in the policy. Sandlock also supports transparent port remapping via seccomp user notification: the sandboxed process calls `bind(3000)`, but the kernel silently assigns a unique real port, preventing port conflicts between multiple sandboxes on the same host. This provides the port mapping functionality of Docker's bridge network without the virtual networking overhead.

Docker forces a choice: fast networking without isolation (`--network=host`), or isolated networking with overhead (bridge mode). Sandlock provides both.

## Same Security, Different Mechanism

The natural question: does Sandlock sacrifice security for performance?

No. It provides equivalent isolation through different kernel primitives.

| Capability | Docker | Sandlock |
|---|---|---|
| Filesystem confinement | Mount namespace + overlay | Landlock (per-path read/write/deny) |
| Network port restriction | iptables + bridge rules (none in host mode) | Landlock ABI v4 (`net_bind`, `net_connect`) |
| Syscall filtering | Default seccomp profile | Seccomp-bpf with arg-level filtering |
| Dangerous operation blocking | Capability dropping | Seccomp arg filters (prctl, ioctl, clone flags) |
| Root required | Yes (daemon) | No |
| Kernel version | Any modern Linux | Linux 6.7+ for network rules |

Both approaches prevent a confined process from accessing the host filesystem, binding to unauthorized ports, or executing dangerous syscalls. Docker achieves isolation by placing the process in a separate namespace and routing its traffic through a virtual network. Sandlock achieves isolation by restricting the process's access within the existing namespace. The latter avoids the virtual networking layer entirely.

## Where This Matters

The 25% throughput gap and 50% latency gap are significant for a specific class of workloads: those that generate a high rate of small messages.

**Real-time stream processing.** Services that ingest and analyze 50,000 to 150,000 events per second, where each event is a few hundred bytes. The per-message overhead of the container networking stack directly limits the maximum sustainable event rate.

**In-memory caching and session stores.** Redis, Memcached, and similar services that handle thousands of small key-value operations per second from many concurrent clients. The p99 latency difference (0.88 ms vs 1.46 ms) is the difference between meeting and missing a latency SLA.

**Sidecar services.** Monitoring agents, log collectors, and security sensors deployed alongside a primary service on the same host. These services communicate with the primary process over localhost. Container networking adds overhead to every message on a path that should be zero-cost.

For bulk data transfer (large file copies, streaming video, database replication with large payloads), containers and process sandboxes perform identically. The overhead only becomes visible when messages are small and frequent.

## Kernel Compatibility

Sandlock's network port restrictions require Landlock ABI v4, available in Linux 6.7 and later:

| Distribution | Kernel | Network Port Restrictions |
|---|---|---|
| Ubuntu 24.04 LTS | 6.8 | Supported |
| Debian 13 (Trixie) | 6.12 | Supported |
| Fedora 40+ | 6.8+ | Supported |
| RHEL 10 | 6.12 | Supported |
| Arch Linux | 6.18+ | Supported |
| AWS Bottlerocket | 6.18 | Supported |
| Alpine 3.23 | 6.18 | Supported |

On older kernels (Debian 12, RHEL 9, Ubuntu 22.04 GA), filesystem confinement and syscall filtering work fully. If network port restrictions are requested on a kernel that does not support them, Sandlock raises an explicit error rather than silently degrading.

## Reproduce It Yourself

The [benchmark script](https://gist.github.com/congwang-mk/47335c5fcca7d4c71574f430ab18aef3){:target="_blank" rel="noopener noreferrer"} is available as a GitHub Gist:

```bash
pip install sandlock
python3 bench_redis.py
```

Requirements: `redis-server`, `redis-benchmark`, and Docker. The script bind-mounts the host Redis binary into Docker to ensure version parity.

We encourage you to run this on your own hardware. The numbers will vary with CPU, kernel version, and Docker configuration, but the structural advantage holds: eliminating the virtual networking stack is always faster than traversing it.
