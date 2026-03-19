---
layout: post
title: "1,000 Sandboxes in 718 Milliseconds: Copy-on-Write Forking for AI Agents"
date: 2026-03-19 10:00:00 -0700
categories: [announcement, open-source, linux-kernel, ai-infrastructure]
author: Cong Wang, Founder and CEO
excerpt: "Sandlock introduces COW fork: initialize a sandbox once, then fork thousands of copy-on-write clones in microseconds. Each clone shares the template's memory pages until it writes. No containers, no CRIU, no root."
---

Every AI sandbox today wastes the same resources the same way.

An RL training loop loads a 2 GB reward model, imports PyTorch, preprocesses a dataset. This takes five seconds. Then it evaluates 10,000 candidate programs, each in its own sandbox. With containers, each sandbox re-initializes from scratch: five seconds of setup for one second of work. The math is brutal: 10,000 sandboxes times five seconds of initialization is 14 hours of wasted compute, just loading the same model into the same framework ten thousand times.

The data tells the same story across every AI workload. Code evaluation benchmarks spend 80% of wall time on sandbox startup. Agent tool-calling loops pay a cold-start penalty on every invocation. Hyperparameter sweeps re-initialize identical training setups thousands of times. The sandbox is the bottleneck, and the bottleneck is initialization.

Today we are releasing COW fork for [Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}. Initialize a sandbox once. Fork it a thousand times in under 720 milliseconds. Every clone shares every memory page with the original. To our knowledge, this is the first AI sandbox to provide process-level copy-on-write forking as a first-class API.

## What It Looks Like

```python
from sandlock import Sandbox, Policy

def init():
    global model, dataset
    model = load_model("reward_model.pt")     # 2 GB, loaded once
    dataset = load_dataset("eval_set.pt")     # 500 MB, loaded once

def work():
    clone_id = int(os.environ["CLONE_ID"])    # 0..N-1, set automatically
    result = evaluate(model, dataset, clone_id)
    save_result(result)

policy = Policy(
    fs_readable=["/usr", "/lib", "/etc"],
    fs_writable=["/tmp"],
    max_memory="256M",
    max_processes=5,
)

with Sandbox(policy, init, work) as sb:
    clones = sb.fork(10_000)
    for c in clones:
        c.wait()
```

Three functions. `init()` runs once, loads the model, prepares the data. `work()` runs in each clone, reads the shared state, produces a result. `sb.fork(10_000)` creates all clones in a single batch. Each clone gets a `CLONE_ID` environment variable (0 through 9,999). Ten thousand clones share 2.5 GB of model and dataset memory. Total memory for the model across all clones: 2 GB. Not 20 TB.

## Why This Was Not Possible Before

Every existing sandbox technology has the same structural limitation: each sandbox gets its own memory space, initialized from scratch.

**Containers** isolate processes via kernel namespaces (mount, PID, network, user). This provides strong boundaries, but it also breaks the page table sharing that makes copy-on-write work. A process inside a container lives in a different virtual address space than the host. There is no way to `fork()` a container from the outside and inherit its in-memory state. To "clone" a container, you must either snapshot the filesystem and cold-start a new one (losing all in-memory state), or use CRIU to checkpoint and restore the full process state (approximately 100,000 lines of code, requires root and kernel patches, adds hundreds of milliseconds per cycle).

**MicroVMs** (Firecracker, QEMU) run a separate guest kernel. Each VM has its own physical memory region. Cloning a VM means snapshotting guest memory and creating a new VM from the snapshot. This is faster than container cold-start but still measured in hundreds of milliseconds, and requires KVM and root access.

**gVisor** intercepts every syscall through a user-space kernel reimplementation. Each sandbox runs in its own Sentry process with its own address space. No memory sharing between sandboxes.

The common thread: all these approaches create isolation by placing the sandboxed process in a separate address space. This is exactly what prevents COW page sharing. Isolation and sharing are in tension, and every existing design chose isolation at the cost of sharing.

Sandlock resolves this tension by using a different isolation mechanism entirely.

## How It Works

Sandlock confines processes using the kernel's own security primitives: [Landlock](https://landlock.io){:target="_blank" rel="noopener noreferrer"} for filesystem and network access control, seccomp-bpf for syscall filtering, and seccomp user notification for resource limits. These mechanisms operate within the process's existing address space. They do not create new namespaces and they do not break page table sharing.

This means `fork()` works exactly as the kernel designed it: the child process gets a copy-on-write view of the parent's entire address space. Model weights, dataset buffers, Python interpreter state, imported modules, JIT caches. All shared at the physical page level. All isolated by Landlock, seccomp, and process group boundaries.

The implementation has no exotic dependencies:

```
Template process (main thread):
    init()                           # user's setup, runs once
    while True:
        cmd = os.read(control_fd)    # blocks, GIL released
        if cmd == TRIGGER_FORK_BATCH:
            envs = read_envs()       # all N envs in one read
            pids = []
            for env in envs:
                pid = fork()         # raw fork(2), bypasses seccomp
                if pid == 0:
                    setpgid(0, 0)
                    os.environ.update(env)
                    work()
                    os._exit(0)
                else:
                    pids.append(pid)
            send_pids(pids)          # all N pids in one write
```

After `init()` returns, the main thread enters a fork-ready loop. It blocks on `os.read()`, which releases the GIL. No CPU is consumed while waiting. When the parent calls `sb.fork(N)`, a single batch command is sent. The main thread forks N times in a tight loop using the raw `fork(2)` syscall, which bypasses the seccomp notification path entirely. All N clone PIDs are sent back in one write. 1,000 clones in 718 ms. No signals. No ptrace. No machine code injection.

Each clone inherits the template's Landlock ruleset and seccomp filter. These are kernel-level restrictions that survive `fork()` and cannot be removed by the child. The clone is confined from its first instruction.

## The Numbers

| | Sandlock `fork()` | Container restart | MicroVM snapshot |
|---|---|---|---|
| 1,000 clones | 718 ms | ~200 s | ~150 s |
| Per-clone latency | ~680 us | ~200 ms | ~150 ms |
| Memory per clone (2 GB model) | ~4 KB (page tables) | 2 GB (full copy) | 2 GB (guest RAM) |
| 10,000 clones total memory | ~2 GB | ~20 TB | ~20 TB |
| Root required | No | Yes (CRIU) | Yes (KVM) |
| State preserved | Full (heap, stack, fds) | Filesystem only | Full (with snapshot) |

1,000 clones in 718 milliseconds, measured end to end. `sb.fork(1000)` sends a single batch command to the template. The template forks 1,000 times in a tight loop using the raw `fork(2)` syscall, which bypasses the seccomp notification path entirely. All 1,000 PIDs are returned in one write.

The per-clone memory overhead is the cost of a new set of page table entries, roughly 4 KB. The shared pages remain shared until written. For a read-heavy workload like model inference, most pages are never written, so the sharing persists for the clone's entire lifetime.

## Correctness Guarantees

COW fork is not a shortcut that trades safety for speed. Each clone provides the same isolation guarantees as a standalone sandbox:

**Memory isolation.** `fork()` creates a private address space. Writes in a clone do not affect the template or other clones. The kernel enforces this at the hardware level through page table permissions.

**Confinement inheritance.** Landlock rulesets and seccomp filters are inherited across `fork()` and cannot be removed. A clone cannot grant itself permissions that the template does not have.

**Process group isolation.** Each clone creates its own process group via `setpgid(0, 0)`. Signals (SIGSTOP, SIGKILL) can target individual clones without affecting the template or other clones.

**Environment isolation.** Each clone receives its own environment overrides. The template's environment is never modified because `os.environ.update()` triggers COW on the affected pages.

**File descriptor isolation.** The clone closes the control socket immediately after fork. It cannot send commands to the template or create additional clones.

## Use Cases

**RL rollouts.** Load a reward model once, fork 10,000 clones with different random seeds. Each clone evaluates a candidate solution against the model and dataset. The model exists once in physical memory.

**AI agent tool execution.** An agent loads a large context window, knowledge base, and tool registry. Each tool call runs in a forked clone that inherits the full agent state via COW. The clone executes the tool in isolation and returns the result. No re-initialization between calls.

**Code evaluation at scale.** A benchmark harness loads test cases and reference implementations. Each candidate solution runs in a forked clone with memory caps and process limits. Crashes, infinite loops, and memory leaks are contained. The harness continues without interruption.

**Hyperparameter search.** A training setup function initializes the model architecture, data loaders, and optimizer state. Each hyperparameter configuration runs in a forked clone, starting from the exact same initialized state. No variation from re-initialization.

## Getting Started

COW fork is available in Sandlock today:

```bash
pip install git+https://github.com/multikernel/sandlock.git
```

```python
from sandlock import Sandbox, Policy

def init():
    global model
    model = load_model()

def work():
    clone_id = int(os.environ["CLONE_ID"])
    rollout(model, clone_id)

with Sandbox(Policy(fs_readable=["/usr","/lib","/etc"], fs_writable=["/tmp"]), init, work) as sb:
    for c in sb.fork(1000):
        c.wait()
```

Sandlock requires Linux 5.13+ and Python 3.10+. No root, no cgroups, no container runtime, no CRIU. The project is open source under Apache 2.0.

We welcome contributions, bug reports, and feedback on [GitHub](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}.
