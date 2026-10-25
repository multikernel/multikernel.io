---
layout: post
title: "Unprivileged Containers Are Not Unprivileged"
date: 2026-10-25 10:00:00 -0700
categories: [linux-kernel, open-source, security, ai-infrastructure]
author: Cong Wang, Founder and CEO
excerpt: "\"Unprivileged container\" sounds like a safer container. It is not. A container is unprivileged because it runs in a user namespace, and a user namespace hands the process a full set of capabilities that the kernel honors for a long list of operations a normal user could never reach. That is more kernel, not less. Sandlock takes the opposite route: no user namespace by default, a seccomp filter that removes syscalls a normal user is allowed to make, and a user-space supervisor that answers some of the rest without entering the kernel. Ranked by kernel attack surface: Sandlock < unprivileged user < user namespace < root."
---

"Unprivileged container" is one of the most successful names in Linux security. It tells you that the container runtime does not need root, and that root inside the container is not root on the host. Both are true. What most readers hear, though, is something else: that an unprivileged container is a container with fewer privileges, and therefore a safer one.

That is not what the name means, and in the way that matters most for escapes, it is backwards. An unprivileged container is built on a user namespace, and a user namespace grants privileges. It gives an ordinary process a full set of capabilities, and the kernel honors those capabilities across a large and historically fragile part of its code. The process is unprivileged with respect to the host's files and users. It is more privileged with respect to the kernel.

We build [Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}, a process sandbox that does not use user namespaces by default. This post explains why, and argues for a ranking that the word "unprivileged" hides:

**Sandlock < unprivileged user < user namespace < root**

measured by how much of the kernel a process can reach.

## What "Unprivileged" Actually Describes

There are two separate questions you can ask about a sandboxed process.

The first is about identity: if the process breaks out, who is it on the host? A container running as root without a user namespace is UID 0 on the host, so a breakout is a host compromise. A user namespace maps UID 0 inside the container to an ordinary UID outside, say 100000. A breakout lands as that UID, which owns nothing. This is the problem user namespaces solve, and they solve it well.

The second is about reach: how much kernel code can the process execute with arguments it controls? Every container escape that does not rely on a misconfiguration is a kernel bug, and a kernel bug can only be triggered from code the process can reach. Identity tells you how bad a breakout is. Reach tells you how likely one is.

"Unprivileged" answers the first question and is silent on the second. The trouble is that a user namespace improves the first answer by making the second one worse.

## A User Namespace Is a Bag of Capabilities

When a process calls `unshare(CLONE_NEWUSER)`, it becomes the owner of a new user namespace and receives every capability in it: `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_SYS_CHROOT`, all of them. Once it maps itself to root inside the namespace, as `unshare -r` and every container runtime do, it keeps those capabilities across `execve`. These capabilities are scoped. They only count for resources owned by that namespace. But the kernel decides what "owned by that namespace" covers, and since unprivileged user namespaces arrived in Linux 3.8, that coverage has kept growing.

With those capabilities, an ordinary user can create a network namespace and configure it fully: add interfaces, set routes, load netfilter and nf_tables rules, attach traffic control qdiscs, create tunnels and bridges. They can create a mount namespace and mount tmpfs, procfs, sysfs, overlayfs and FUSE filesystems in it. They can create PID, IPC and UTS namespaces. None of this takes more than one syscall: the kernel processes `CLONE_NEWUSER` first, so `unshare(CLONE_NEWUSER|CLONE_NEWNET|CLONE_NEWNS)` creates the user namespace and then uses its fresh capabilities to create the network and mount namespaces in the same call. Each of these operations was once root only, and each is now reachable by anyone on a host where unprivileged user namespaces are enabled.

The kernel code behind them was mostly written when its only callers were root. Root was trusted, so a malformed netlink message or an odd sequence of mount options was not a security boundary. Opening that code to every local user turned it into one.

And it is opened to every local user, not just to containers. Unprivileged user namespaces are a host-wide switch. To run unprivileged containers, you enable them for every process on the machine, not just for your container runtime. Every local user and every compromised service can then call `unshare` and walk into the same code. The setting that makes your containers "unprivileged" grants the whole host a larger kernel.

## The CVE Record

The bugs followed, and the pattern is easiest to see in the vulnerabilities themselves. Each bug below sits behind a capability check that a normal user fails. A user namespace passes it.

| CVE | Where | Capability required | Outcome |
|---|---|---|---|
| [CVE-2017-7308](https://nvd.nist.gov/vuln/detail/CVE-2017-7308){:target="_blank" rel="noopener noreferrer"} | AF_PACKET ring setup | `CAP_NET_RAW` | Heap overflow, local root |
| [CVE-2018-18955](https://nvd.nist.gov/vuln/detail/CVE-2018-18955){:target="_blank" rel="noopener noreferrer"} | User namespace ID mapping | `CAP_SYS_ADMIN` and `CAP_SETUID` in a user namespace | Access to host files such as `/etc/shadow` |
| [CVE-2020-14386](https://nvd.nist.gov/vuln/detail/CVE-2020-14386){:target="_blank" rel="noopener noreferrer"} | AF_PACKET receive path | `CAP_NET_RAW` | Heap overflow, local root |
| [CVE-2021-22555](https://nvd.nist.gov/vuln/detail/CVE-2021-22555){:target="_blank" rel="noopener noreferrer"} | netfilter x_tables | `CAP_NET_ADMIN` | Heap overflow, local root, exploited in the wild |
| [CVE-2022-0185](https://nvd.nist.gov/vuln/detail/CVE-2022-0185){:target="_blank" rel="noopener noreferrer"} | Filesystem context parsing | `CAP_SYS_ADMIN` | Heap overflow, Kubernetes container escape |
| [CVE-2022-0492](https://nvd.nist.gov/vuln/detail/CVE-2022-0492){:target="_blank" rel="noopener noreferrer"} | cgroup v1 `release_agent` | `CAP_SYS_ADMIN` | Container escape, code runs as host root |
| [CVE-2023-0386](https://nvd.nist.gov/vuln/detail/CVE-2023-0386){:target="_blank" rel="noopener noreferrer"} | overlayfs copy-up | `CAP_SYS_ADMIN` | Setuid root binary on the host, exploited in the wild |
| [CVE-2023-32233](https://nvd.nist.gov/vuln/detail/CVE-2023-32233){:target="_blank" rel="noopener noreferrer"} | nf_tables | `CAP_NET_ADMIN` | Use-after-free, local root |
| [CVE-2024-1086](https://nvd.nist.gov/vuln/detail/CVE-2024-1086){:target="_blank" rel="noopener noreferrer"} | nf_tables | `CAP_NET_ADMIN` | Use-after-free, local root, used by ransomware |
| [CVE-2026-53075](https://linux.oracle.com/cve/CVE-2026-53075.html){:target="_blank" rel="noopener noreferrer"} | PPP | `CAP_NET_ADMIN` | Administration of a network namespace inherited from the host |

A few of these deserve a closer look.

**Netfilter.** CVE-2021-22555 was a heap out-of-bounds write in the iptables compat code that had been in the kernel since 2.6.19. Its author used it to break out of a pod in Google's kCTF Kubernetes cluster, and CISA later listed it as exploited in the wild. CVE-2024-1086 followed in nf_tables. The README of its public exploit lists three requirements: `CONFIG_USER_NS=y`, unprivileged user namespaces enabled, and nf_tables enabled. It notes that all three are the default on Debian and Ubuntu. In October 2025, CISA confirmed that ransomware groups were using it.

**Filesystems.** CVE-2022-0185 was an integer underflow in `legacy_parse_param` reachable through `fsconfig`, which requires `CAP_SYS_ADMIN`. The exploit got that capability with a single call, `unshare(CLONE_NEWNS|CLONE_NEWUSER)`, and was demonstrated as a Kubernetes container escape. CVE-2023-0386 let a user mount overlayfs inside a user namespace and copy a setuid file into a place where the host would honor it. CISA added it to its exploited list in June 2025.

**The user namespace code itself.** CVE-2018-18955, found by Jann Horn, was a bug in how nested user namespaces translate IDs when a mapping has more than five ranges. A user holding `CAP_SYS_ADMIN` and `CAP_SETUID` in an outer user namespace, which anyone can create, could write a crafted ID map for a namespace nested inside it and read files on the host such as `/etc/shadow`.

None of these bugs could be reached by a normal user. The user namespace is what made each of them reachable. This is why Debian carried a sysctl to disable unprivileged user namespaces for years, why hardened deployments set `user.max_user_namespaces` to zero, and why Ubuntu 24.04 lets applications create user namespaces but denies them the capabilities inside unless an AppArmor profile allows it. Even that is hard to get right: in March 2025, Qualys [published three ways to bypass Ubuntu's restriction](https://blog.qualys.com/vulnerabilities-threat-research/2025/03/27/qualys-tru-discovers-three-bypasses-of-ubuntu-unprivileged-user-namespace-restrictions){:target="_blank" rel="noopener noreferrer"} and obtain a user namespace with full capabilities, and described them as a way to reach kernel bugs that the restriction was meant to keep out of reach.

## How Sandlock Gets Below a Normal User

Sandlock does not change who the process is. It changes what the process can ask the kernel to do.

**It cannot create a user namespace.** Sandlock's default seccomp filter denies `unshare`, `setns`, and namespace flags on `clone`, and makes `clone3` unavailable. A sandboxed process cannot obtain the capabilities that every bug in the table above depends on, so those code paths stay closed even on a host that permits unprivileged user namespaces.

**It removes other syscalls a normal user is allowed to make.** The same filter denies `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`, `ptrace`, `process_vm_readv`, `process_vm_writev`, `open_by_handle_at`, `personality`, and the three `io_uring` syscalls, among others. Several of these are reachable by any user on a default kernel and have long CVE histories of their own. Google reported in 2023 that 60% of the kernel exploits submitted to its kCTF bug bounty targeted `io_uring`, and restricted `io_uring` across its products as a result. Raw sockets are denied outright.

**It answers some syscalls in user space.** With its supervisor enabled, Sandlock intercepts selected syscalls through seccomp user notification and handles them in an ordinary user-space process. When a sandboxed program opens an `AF_NETLINK` socket, Sandlock hands it one end of a Unix socket pair instead, and the supervisor synthesizes `NETLINK_ROUTE` replies describing a loopback-only network. The kernel's netlink and routing code never sees the request. Other netlink protocols are rejected. Opens of `/proc/cpuinfo`, `/proc/meminfo`, `/proc/mounts`, `/proc/net/*` and similar files return a sealed memfd with synthesized content, and sensitive `/proc` and `/sys` paths are denied. A bug in a parser that the sandboxed process can no longer reach is a bug it cannot exploit.

The supervisor is itself code that parses untrusted input, so this moves attack surface rather than deleting it. But it moves it to the right place. A bug in the supervisor yields the privileges of the user who started it, which are a normal user's. A bug in the kernel's netlink parser yields the kernel.

**It confines the rest with Landlock.** The syscalls that remain are restricted by a [Landlock](https://landlock.io){:target="_blank" rel="noopener noreferrer"} ruleset: which paths can be read or written, which TCP ports can be bound or connected, and which IPC and signals can cross the sandbox boundary.

The result is a strict subset. Everything a Sandlock process can do, the same user could do without Sandlock. Much of what that user could do, the Sandlock process cannot.

## The Ranking

Put the four cases side by side and answer both questions from the start of this post.

| | Who you are after a breakout | Kernel reach |
|---|---|---|
| Root | root | everything |
| User namespace | an unprivileged UID | a normal user's reach, plus every `ns_capable()` path |
| Unprivileged user | an unprivileged UID | the ordinary syscall interface |
| Sandlock | an unprivileged UID | a subset of the ordinary syscall interface |

Against root, a user namespace improves the first column. Against a normal user, it worsens the second. Sandlock keeps the first column of a normal user and shrinks the second below it.

## What User Namespaces Get Right

This is a tradeoff, not a verdict, and user namespaces win on the first question.

User namespaces are the right tool when the goal is a different view of the system: a private PID tree, a private mount table, a private network stack. Sandlock does not build those views. It enforces policy on the view the process already has, and it virtualizes the few parts of that view, like `/proc` and `NETLINK_ROUTE`, that would otherwise leak host information.

They are also the standard way to run software that expects to be root, such as a package manager in a container image, without making it root. Sandlock supports this too, as an opt-in UID and GID mapping, and when you turn it on, the sandboxed process does run in a user namespace. Sandlock still applies its seccomp filter inside, so the process cannot reach mount or the other namespace types, and Sandlock never grants it `CAP_NET_ADMIN`. But the namespace exists, and we document it as the exception it is.

## Conclusion

"Unprivileged" describes the runtime and the UID mapping. It does not describe the workload's relationship to the kernel, and readers reasonably assume it does. A container whose root user holds `CAP_SYS_ADMIN` and `CAP_NET_ADMIN` in its own namespaces is many things, but it is not unprivileged in the sense that matters for a kernel exploit.

Most container escapes are kernel bugs, and a kernel bug can only be triggered from code you can reach. User namespaces shrink the blast radius of an escape by changing who you are when you land, and they pay for it by widening what you can reach on the way out. On a host that enables them, they widen it for every process, not just the container.

Sandlock goes the other way. It leaves the process as the user who started it, removes syscalls that user could otherwise make, answers the risky remainder in user space, and confines the rest with Landlock. That puts it below a normal user, and well below a user namespace, on the measure that decides whether an escape is possible at all.

If you want the smallest kernel attack surface for an AI agent, a build step, or any code you would rather not trust, you can also leave unprivileged user namespaces disabled on the host. Sandlock does not need them.

[Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"} is open source under Apache 2.0 and runs on Linux 6.12 or later, with no root, no cgroup, and no namespace:

```bash
pip install sandlock
```

See the [Sandlock FAQ](https://sandlock.io/faq.html){:target="_blank" rel="noopener noreferrer"} for how this compares with containers in practice, and reach us at [contact@multikernel.io](mailto:contact@multikernel.io).
