---
layout: post
title: "Processes Are All You Need for AI Sandboxing"
date: 2026-03-14 10:00:00 -0700
categories: [announcement, open-source, linux-kernel, ai-infrastructure]
author: Cong Wang, Founder and CEO
excerpt: "Containers and microVMs start from scratch. Processes start from a copy. We explain why fork() and copy-on-write memory are the right primitives for AI sandboxing, and introduce Sandlock, a lightweight process sandbox using Landlock and seccomp."
---

AI agents run as processes. A coding agent is a Python process that calls an LLM API, generates code, and executes it. A tool-using agent is a process that spawns subprocesses to run shell commands, query databases, or call external services. An RL training loop runs candidate programs in sandboxed environments to compute rewards.

At the OS level, all of these are process trees. The question is not whether to run AI code in processes. It already does. The question is how to confine them.

The industry's default answer is to reach for virtualization: wrap each process in a container or a microVM. But this is an abstraction inversion. The process is already the operating system's unit of isolation. Every process gets its own virtual address space, its own file descriptor table, its own credentials, and its own signal context. The kernel already tracks its memory, enforces its permissions, and mediates its access to every resource. Virtualization does not add a new isolation primitive. It duplicates the isolation the kernel already provides, but at the cost of an entire additional layer: a guest kernel, a virtual device model, or a container runtime that must reconstruct, from scratch, the environment the host kernel already maintains for every process.

The missing piece has been confinement. Historically, confining a process meant using containers (namespaces + cgroups) or a hypervisor. But the Linux kernel now provides three independent security mechanisms at the process level: [Landlock](https://landlock.io){:target="_blank" rel="noopener noreferrer"} for filesystem and network access control, seccomp-bpf for syscall filtering, and seccomp user notification for dynamic policy enforcement. None require root, namespaces, or cgroups. With these primitives, a process can be confined as tightly as a container, without the overhead of one.

This is why we built [Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}: a process sandbox that combines Landlock, seccomp-bpf, and seccomp user notification into a single Python library. We are releasing it today as open source under Apache 2.0.

## Copy-on-Write: The Key Advantage

The practical difference between process sandboxing and container/microVM sandboxing comes down to how memory is handled at scale.

Containers and microVMs **start from scratch**: each sandbox gets its own memory space, independently loading libraries, models, and data. There is no way for a container to inherit the parent's in-memory state. A process created by `fork()` **starts from a copy**. The child is an instant clone of the parent, with all loaded libraries, model weights, and warm caches already present. The kernel shares the parent's memory pages via copy-on-write (COW) and only copies the pages the child modifies. For AI workloads that are read-heavy, this means near-zero memory overhead per sandbox.

Consider an RL training loop that loads a 2 GB model and runs 10,000 concurrent evaluation episodes:

| Approach | Per-sandbox startup | Per-sandbox memory | Total memory for model |
|---|---|---|---|
| MicroVM | ~100 ms | ~128 MB+ overhead | 20 TB (10K copies) |
| Container | ~90 ms | ~50 MB overhead | 20 TB (10K re-inits) |
| Process (fork) | ~1 ms | Near zero (COW) | 2 GB (shared pages) |

With containers, the model must be loaded or memory-mapped independently in each sandbox. With microVMs, each guest must load its own copy. With `fork()`, the model is loaded once in the parent. All 10,000 children read it through shared COW pages. The kernel handles the sharing transparently. No bind-mounts, no shared memory configuration, no serialization.

This is not a minor optimization. It changes the scaling model from O(N) to O(1) for read-only data.

The same advantage applies to long-running agents. An agent process that loads a large context, knowledge base, or tool registry can fork sandboxed children for each tool call. Every child inherits the full context via COW without copying it.

COW also extends to the filesystem. Sandlock integrates with [BranchFS](https://github.com/multikernel/branchfs){:target="_blank" rel="noopener noreferrer"}, a FUSE filesystem that provides copy-on-write branching for directories. Each sandbox gets its own branch: reads go to the shared base, writes go to an isolated delta. On success, writes can be committed back. On failure, they are discarded. No overlay mounts, no image layers, no root.

Container runtimes also serialize sandbox creation through a daemon (dockerd, containerd). Under high concurrency, the daemon becomes the bottleneck: lock contention on image layers, sequential cgroup setup, and overlay mount operations limit how many sandboxes can start per second. Scaling to thousands of concurrent sandboxes requires a cluster, load balancing, and orchestration.

`fork()` has no daemon. Each call is an independent kernel operation that runs in the calling process's context. There is no shared lock, no central coordinator, and no serialization point. Startup takes roughly 1 millisecond. Teardown is a `kill()` that completes in microseconds. A single machine can sustain tens of thousands of concurrent forked sandboxes, bounded only by available memory (which COW minimizes) and CPU. The sandbox layer disappears from the performance profile entirely. A process sandbox is a function call, not an infrastructure service.

The following example shows a simplified RL reward computation loop. The parent loads a model and a dataset once, then forks sandboxed children to evaluate LLM-generated code candidates. Each child inherits the model weights and dataset through COW pages without copying them. The sandbox confines the untrusted code to a read-only view of system libraries and a per-sandbox writable `/tmp`, with a 256 MB memory cap and a 5-process limit.

```python
from sandlock import Sandbox, Policy
import multiprocessing
import torch

# Load once in the parent: all children share via COW
model = torch.load("reward_model.pt", map_location="cpu")  # 2 GB
dataset = torch.load("eval_set.pt")                         # 500 MB

policy = Policy(
    fs_readable=["/usr", "/lib", "/etc"],
    fs_writable=["/tmp"],
    max_memory="256M",
    max_processes=5,
    clean_env=True,
)

def evaluate(candidate_code: str) -> float:
    """Fork a sandbox, run untrusted code, return reward."""
    def score():
        exec(compile(candidate_code, "<candidate>", "exec"))
        fn = locals().get("solve")
        if fn is None:
            return -1.0
        correct = sum(fn(x) == y for x, y in dataset)
        return correct / len(dataset)

    result = Sandbox(policy).call(score)
    return result.value if result.success else -1.0

# 10K candidates across 10K workers, 2.5 GB total (not 25 TB)
with multiprocessing.Pool(10000) as pool:
    rewards = pool.map(evaluate, candidate_codes)
```

## Comparison with Bubblewrap and gVisor

Sandlock is not the first tool to sandbox processes without a full container runtime. [Bubblewrap](https://github.com/containers/bubblewrap){:target="_blank" rel="noopener noreferrer"} and [gVisor](https://gvisor.dev){:target="_blank" rel="noopener noreferrer"} are two widely used alternatives with different design points.

**Bubblewrap** is the sandboxing tool behind Flatpak. It creates isolated environments using Linux namespaces: mount, user, IPC, PID, network, and UTS. The sandboxed process gets a new mount namespace with a tmpfs root, and the caller explicitly binds in the paths it needs. This is lighter than a full container runtime (no daemon, no image layers), but it is still namespace-based isolation. Because the sandboxed command is launched in new namespaces rather than forked from the parent, there is no COW sharing of the parent's in-memory state. Bubblewrap also provides no resource limits: it has no cgroup integration and no mechanism to cap memory or process counts. It is designed as a low-level building block: the caller must assemble the right namespace flags and bind-mount arguments to construct a sandbox. This makes it flexible for desktop application sandboxing, but it lacks the policy abstraction, resource enforcement, and COW memory sharing that AI workloads require.

**gVisor** takes the opposite approach: rather than restricting a process's access to the host kernel, it replaces the kernel entirely. gVisor's Sentry component is a user-space reimplementation of the Linux kernel interface, written in Go. Every syscall from the sandboxed application is intercepted and serviced by the Sentry, which never passes it to the host kernel. Filesystem access is mediated by a separate Gofer process over the 9P protocol. This provides strong isolation: the sandboxed process never touches the host kernel's syscall surface. The cost is scope. Reimplementing the kernel in user space means gVisor must support every syscall an application might use, and it does not yet cover the full Linux surface. Some syscalls, `/proc` entries, and `/sys` files are unimplemented, causing compatibility issues with applications that depend on them. gVisor also runs as an OCI runtime (`runsc`), so it requires the container infrastructure stack. And like containers, each gVisor sandbox starts from scratch with its own memory space, with no COW sharing of a parent's loaded state.

| | Bubblewrap | gVisor | Sandlock |
|---|---|---|---|
| Isolation mechanism | Linux namespaces | User-space kernel | Process + Landlock + seccomp |
| COW memory sharing | No (new namespace) | No (separate runtime) | Yes (fork) |
| Startup latency | ~10 ms | ~100 ms+ | ~1 ms |
| Syscall overhead | None (native kernel) | High (user-space interposition) | None (native kernel) |
| Resource limits | No | Yes (OCI cgroup) | Yes (seccomp notif) |
| Linux syscall compatibility | Full | Partial (subset) | Full (minus blocklist) |
| Requires root/daemon | No | No (but needs OCI runtime) | No |
| Nesting | Fragile (nested namespaces) | Not supported | Native (Landlock stacking) |

Sandlock occupies a different point in the design space. It does not create namespaces, so the child inherits the parent's memory through COW. It does not reimplement the kernel, so syscalls run at native speed with full compatibility. It lets the vast majority of syscalls pass through to the host kernel natively, and only interposes on the small subset that require policy decisions (resource accounting, network enforcement, /proc filtering) via seccomp user notification. It confines processes using the kernel's own security primitives, Landlock and seccomp, which are designed to be stacked, nested, and applied without privilege. The trade-off is that the sandboxed process shares the host kernel, but three independent confinement layers ensure that sharing the kernel does not mean running unconfined.

## CLI and API

Sandlock exposes the same confinement model through both a CLI and a Python API. The CLI is designed for ad-hoc use and shell scripts: specify readable and writable paths, network rules, and resource limits as flags, then pass the command to run after `--`. For repeated configurations, save a TOML profile and reference it with `-p`.

```bash
# Filesystem restrictions
sandlock run -r /usr -r /lib -w /tmp -- python3 untrusted.py

# Use a Docker image as rootfs
sandlock run --image alpine -- /bin/echo "hello from sandbox"

# IPC and signal isolation
sandlock run --isolate-ipc --isolate-signals -r /usr -r /lib -- python3 script.py

# Saved TOML profiles (CLI flags override profile values)
sandlock run -p build -- make -j4
```

The Python API is designed for programmatic use, where sandboxes are created and managed as part of a larger application. `Sandbox.run()` executes a command in a subprocess; `Sandbox.call()` runs a Python function in a forked child, preserving COW memory sharing. Both return a result object with the exit status, stdout, stderr, and (for `call`) the function's return value. The context manager form gives fine-grained control over long-lived sandboxes.

```python
from sandlock import Sandbox, Policy

# One-shot command or function
result = Sandbox(policy).run(["python3", "untrusted.py"])
result = Sandbox(policy).call(my_function, args=(data,))

# Long-lived sandbox with pause/resume
with Sandbox(policy) as sb:
    sb.exec(["python3", "server.py"])
    sb.pause()
    sb.resume()
    sb.wait(timeout=30)
```

The rest of this post explains what happens under the hood.

## Defense in Depth Without Containers

The common objection to process-level sandboxing is that it shares the kernel with the host. This is true, but "shares the kernel" does not mean "unconfined." Sandlock layers three independent kernel confinement mechanisms. Bypassing one does not weaken the others.

### Layer 1: Landlock (Access Control)

[Landlock](https://landlock.io){:target="_blank" rel="noopener noreferrer"} is a Linux Security Module that restricts filesystem and network access per process, without root privileges. Unlike SELinux or AppArmor, Landlock is self-imposed: a process voluntarily restricts itself, and the restrictions are irreversible.

Sandlock maps `Policy` fields directly to Landlock rules:

```python
Policy(
    fs_readable=["/usr", "/lib", "/etc"],   # read-only access
    fs_writable=["/tmp/work"],              # read-write access
    # Everything else: denied by the kernel
    net_connect=[443],                      # only TCP port 443
    isolate_ipc=True,                       # block abstract Unix sockets to host
    isolate_signals=True,                   # block signals to host processes
)
```

After `landlock_restrict_self()`, the child cannot open `/home`, cannot connect to port 80, and cannot send signals to the parent. The kernel enforces this on every file operation and socket call. There is no userspace component to bypass.

### Layer 2: seccomp-bpf (Syscall Filtering)

Landlock controls *what resources* a process can access. seccomp controls *what operations* it can perform. Sandlock installs a classic BPF filter at the syscall entry point, before the kernel does any work.

The default blocklist prevents privilege escalation (`ptrace`, `keyctl`), namespace escape (`mount`, `unshare`, `setns`, `pivot_root`), and kernel manipulation (`kexec_load`, `bpf`, `perf_event_open`). Argument-level filtering blocks namespace creation flags in `clone` while allowing normal `fork`, and blocks `TIOCSTI` terminal injection in `ioctl` while allowing normal I/O.

A process that passes Landlock checks can still be blocked by seccomp. A process that passes seccomp can still be blocked by Landlock. The two layers operate independently.

### Layer 3: seccomp User Notification (Supervisor)

Some policy decisions cannot be expressed as static rules. Network allowlists require inspecting IP addresses. /proc isolation requires knowing which PIDs belong to the sandbox.

For these, Sandlock routes specific syscalls to a supervisor thread in the parent via `SECCOMP_RET_USER_NOTIF`. The child blocks until the supervisor responds:

- **Network enforcement.** The supervisor resolves allowed domains before fork, virtualizes `/etc/hosts` via `memfd` injection, and intercepts `connect`/`sendto` to check destination IPs against the resolved set.
- **/proc PID isolation.** The supervisor intercepts `getdents64` on `/proc`, filters out PIDs not belonging to the sandbox, and writes filtered entries back to the child's memory. The child's `top` or `ps` sees only its own processes.

The same mechanism also handles the resource limits described below, making seccomp user notification the single interposition point for all dynamic policy decisions.

### How the Layers Compose

After `fork()`, the child applies all three layers in sequence before executing any user code:

```
fork()
  ├── Landlock: restrict filesystem + network + IPC (irreversible)
  ├── seccomp-bpf: block dangerous syscalls (irreversible)
  ├── seccomp user notification: connect to supervisor (irreversible)
  ├── Clean environment (strip env vars)
  └── exec(cmd) or call(fn)
```

Each layer is applied via a one-way kernel operation. The child cannot remove Landlock rules, cannot unload seccomp filters, and cannot detach from the notification supervisor.

## Resource Limits Without cgroups

Container sandboxes enforce memory and process limits through cgroup v2, which requires either root or a delegated cgroup subtree from systemd. This is often unavailable in CI runners, nested containers, and minimal cloud instances.

Sandlock takes a different approach. Instead of relying on cgroups, the supervisor intercepts allocation syscalls via seccomp user notification: `mmap`, `brk`, and `munmap` for memory tracking, `clone` and `fork` for process counting. When a budget is exceeded, the supervisor returns `ENOMEM` or `EAGAIN` directly.

CPU throttling works like cgroup v2's `cpu.max` but without root: a supervisor thread cycles `SIGSTOP`/`SIGCONT` on the sandbox's process group every 100 ms. Setting `max_cpu=50` means roughly 50 ms running and 50 ms stopped per cycle, roughly 50% of one core. The throttle applies collectively to all processes in the sandbox, so the group as a whole never exceeds the specified utilization regardless of how many processes are active. This gives operators the same burst-control they get from cgroup bandwidth limiting, with nothing more than POSIX signals.

```python
Policy(
    max_memory="256M",    # per-sandbox, enforced via seccomp notif
    max_processes=10,     # per-sandbox, threads excluded
    max_cpu=50,           # throttle: ~50% of one core via SIGSTOP/SIGCONT
)
```

No cgroup hierarchy, no delegation, no root. This works everywhere Linux runs: bare metal, CI, Docker, Kubernetes pods, cloud instances.

## Native Nesting

AI agent architectures often involve multiple isolation levels: an outer sandbox for the agent, inner sandboxes for each tool invocation or code execution step. Container nesting (Docker-in-Docker or Docker-outside-Docker) is notoriously fragile, requires privileged mode or socket mounting, and multiplies the startup overhead at each level.

Process sandboxes nest naturally. A sandboxed parent can fork a child and apply a stricter policy. Landlock rules stack: the child gets the intersection of the parent's and its own rules. seccomp filters stack: the child's filter runs in addition to the parent's. There is no special configuration, no privileged mode, and no additional startup cost.

```python
with Sandbox(agent_policy) as agent:
    # Agent runs with broad permissions
    agent.exec(["python3", "agent.py"])

    # Each tool call runs in a tighter nested sandbox
    child = agent.sandbox(tool_policy)
    result = child.call(run_tool, args=(tool_input,))
```

Each nesting level adds only the cost of one `fork()` plus confinement setup. The depth is limited only by the kernel's 16-level Landlock nesting limit.

## Requirements

- Linux 5.13+ (Landlock ABI v1)
- Python 3.10+
- No root, no cgroups, no special system configuration

Optional kernel versions unlock additional features:

| Feature | Minimum Kernel |
|---|---|
| seccomp user notification | 5.6 |
| Landlock filesystem rules | 5.13 |
| Landlock TCP port rules | 6.7 (ABI v4) |
| Landlock IPC scoping | 6.12 (ABI v6) |

Sandlock is open source under Apache 2.0 and available on [GitHub](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}. We welcome contributions, bug reports, and feedback.
