---
layout: post
title: "The Partition Is Not Optional: Heterogeneous RISC-V and the Cost of a Single Kernel"
date: 2026-07-08 10:00:00 -0700
categories: [linux-kernel, riscv, architecture, multikernel]
author: Cong Wang, Founder and CEO
excerpt: "RISC-V server SoCs now mix cores with different vector widths on one die. Boot mainline Linux on one and half the cores never come up. The boot failure is fixable software. What no patch fixes is that a task holding 4 KB of vector state cannot run on a core with a 1 KB register file, so every OS design ends up partitioning the machine. The only question is whether the partition is a boundary or a policy knob."
---

Boot mainline Linux on SpacemiT's Key Stone K3, a sixteen-core RISC-V server chip built around eight AI cores with 1024-bit vector registers, and those eight cores never come up. The kernel compares each core's vector width against the boot core's, finds a mismatch, and leaves the core offline. Half the machine, the half you bought the part for, is simply not there.

The kernel is not being stubborn. It is defending an assumption every mainstream operating system has carried for fifty years: any task can run on any core. The operating system saves and restores a program's vector registers on every context switch, and a program moved to a core whose registers are a quarter the size has saved state that does not fit. Everything in this post follows from that sentence.

The tempting response is to call the hardware broken and wait for matched cores. The hardware is not broken, and matched cores are not coming. The reasons are economic, they are not going away, and they lead somewhere uncomfortable for a single kernel: on this class of machine, the partition is not optional. The only choice is whether it is a kernel boundary or an ugly policy knob.

## Why the silicon looks like this

A wide vector unit is the most expensive block in a modern core: register files, execution lanes, the load-store bandwidth to feed them. Putting a wide engine on every core means paying that area and power dozens of times over, when the workloads that need it might use a quarter of the machine. The economical design gives a few clusters the wide engine and keeps the rest lean.

And nobody makes the clusters agree. RISC-V SoCs are assembled from licensed core IP, often from more than one supplier, and no central authority holds two IP blocks to a common vector width the way ARM holds big.LITTLE clusters to a common architectural state. A vendor could buy agreement, giving lean cores wide architectural registers behind a narrow datapath the way [AMD's Zen 4 does for AVX-512](https://www.techinsights.com/blog/amd-zen-4-adds-avx-512). But 4 KB of multiported register file plus the paths to feed it is a second bill, charged to exactly the cores that exist to be cheap. Intel is paying that bill right now: its converged [AVX10](https://www.phoronix.com/news/Intel-AVX10) ISA first let efficiency cores stop at 256 bits, then the [2025 revision](https://www.phoronix.com/news/Intel-AVX10-Drops-256-Bit) made 512-bit mandatory on every core. RISC-V vendors are declining to pay it, and heterogeneous width is the result.

This is shipping hardware, not a hypothetical. SpacemiT's [Key Stone K3](https://www.spacemit.com/products/keystone/k3), a server-class RVA23 SoC, puts eight general-purpose X100 cores with 256-bit vector registers beside eight AI-first A100 cores at [1024 bits](https://github.com/spacemit-com/docs-chip/blob/main/en/key_stone/k3/k3_docs/k3_ds.md): a four-fold width difference on one die, same RVV 1.0 ISA on both. And the installed base is worse: the 64-core Sophgo SG2042 in the [Milk-V Pioneer](https://milkv.io/pioneer) implements the draft RVV 0.7.1 vector extension, which is [instruction-level incompatible](https://arxiv.org/abs/2406.12394) with the ratified RVV 1.0 that newer cores speak.

## Today, half the machine does not boot

Return to the boot failure that opened this post. It is not a bug, and it is not buried deep in some driver. It is four lines of source. As each core starts, the kernel compares its vector register width against the boot core's:

```c
if (riscv_v_vsize != this_vsize) {
        WARN(1, "RISCV_ISA_V only supports one vlenb on SMP systems");
        return -EOPNOTSUPP;
}
```

A core that disagrees [never comes up](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/smpboot.c); the comment in the boot path says exactly that. And the number it compares against, [`riscv_v_vsize`](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/vector.c), is one width for the whole machine. It sizes every buffer that will ever hold a program's vector state. There is no notion of one process having 256-bit registers and another 1024.

That is a software limit, and it is already being fixed: SpacemiT's [downstream kernel](https://github.com/spacemit-com/linux-6.18/blob/k3-br-v1.0.y/arch/riscv/kernel/vector.c) stores the width per process and sizes buffers for the widest cluster. We are not arguing that a single kernel cannot boot this machine.

The limit underneath is not software. Thirty-two vector registers at 1024 bits is 4 KB of live state, and a 256-bit core has 1 KB of register file to put it in. A program that has used the wide cluster cannot resume on the narrow one because the bits have nowhere to go. Hiding the difference is impossible: the width is readable by any program, and compilers and tuned libraries read it once and specialize. Between RVV 0.7.1 and 1.0, the instruction encodings differ outright. So every design that runs on this hardware, patched single kernel or multikernel, confines a vector task to one cluster for its lifetime. Migration is off the table for everyone. The only question is how the confinement gets expressed.

This is not a new problem, and the precedents are instructive. Linux on ARM [intersects SVE vector lengths across cores](https://github.com/torvalds/linux/blob/master/arch/arm64/kernel/fpsimd.c) and refuses any core that does not fit the agreement. Intel shipped Alder Lake with AVX-512 on the performance cores only, then [fused it off in silicon](https://www.intel.com/content/www/us/en/support/articles/000089918/processors.html) rather than schedule around it. RISC-V cannot even take Intel's way out: vector width is not a feature bit to clear, it is the physical size of the register file, and the same `vadd` encoding runs at every width. A vendor can disable vector on a cluster entirely, hide the cluster behind firmware, or let Linux refuse it. All three ship silicon that cannot be used.

## The bill for teaching one kernel

Suppose the patch lands in mainline: per-process width, buffers sized for the widest cluster, vector programs pinned to the cluster they started on. Linux has already run this experiment. Some ARM chips run 32-bit code on only a subset of cores, the kernel copes by confining those programs, and the [documentation reads like a price list](https://github.com/torvalds/linux/blob/master/Documentation/arch/arm64/asymmetric-32bit.rst). The charges come not from anything 32-bit but from one fact: some programs are confined to a subset of the machine, and the rest of Linux was built assuming none are. Any RISC-V fix inherits the bill:

- **The feature ships disabled.** Linux turns the mismatched capability off unless the operator passes a special boot flag. A stock distribution on your part hides the cluster you taped out.
- **Cores can no longer be taken offline.** Affinity restrictions [do not survive hotplug](https://github.com/torvalds/linux/blob/master/kernel/sched/core.c), so ARM forbids offlining the last capable core. No powering down under light load, no draining for maintenance, no retiring a core that starts reporting correctable errors.
- **Deadline scheduling is refused.** A confined program cannot be admitted to `SCHED_DEADLINE` unless the operator disables admission control machine-wide, trading away the guarantee for everyone. Latency-bounded inference, the very workload the wide cluster exists for, cannot get the guarantee.
- **Affinity lies.** The kernel silently replaces the CPU set you requested with the subset that works. systemd, Kubernetes' CPU manager, and `numactl` now disagree with the kernel about where their own processes run.
- **Cpuset isolation breaks.** The ARM documentation calls the result undefined behaviour. Fencing the AI cluster away from everything else is the first thing an operator would do with this machine.

RISC-V is also harder than the ARM case. A 32-bit binary declares itself in its header, so ARM confines it once, at startup, before it has state to lose. A RISC-V binary carries no such mark: vector-length agnostic code is correct on both clusters, so the kernel can only decide at the first vector instruction, and the program is welded to whichever cluster the load balancer happened to give it for its first microsecond. And a mistake is silent. A 32-bit program on the wrong ARM core traps cleanly; restoring 4 KB of vector state into a 1 KB register file does not trap, it truncates, unless the kernel re-checks the width on the hottest path it owns.

Three more costs live in the kernel binary itself, beyond the reach of any scheduler patch:

- **The C library stops using the vector unit you shipped.** Linux computes the capability word it hands every program by [intersecting what every core reports](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/cpufeature.c). Mix RVV 0.7.1 with 1.0 and the vector bit survives nowhere: scalar `memcpy` on every core, including the ones with a perfectly good vector unit.
- **Kernel vector code runs at the narrow width everywhere.** A kernel is one binary, compiled once, so its own [crypto](https://github.com/torvalds/linux/blob/master/arch/riscv/crypto/Kconfig) and [RAID](https://github.com/torvalds/linux/blob/master/lib/raid/raid6/riscv/rvv.h) paths are built for the narrowest cluster, and errata workarounds are patched in at boot for whichever core booted first.
- **Two vector generations cannot share one kernel.** RVV 0.7.1 and 1.0 state have different layouts and different save/restore paths. That is a second architecture port inside one image, and nobody has written it.

Notice who pays. Not the AI cluster. The scalar cores lose hotplug, deadline work, honest affinity, isolation, and full-speed kernel crypto, all to tolerate a cluster most of their programs never touch. The general-purpose half of the machine is degraded to accommodate the specialized half. That is backwards from why the silicon was built this way.

## One kernel per cluster

If the machine is going to be partitioned either way, make the partition a boundary instead of a policy knob.

Multikernel is a split-kernel architecture for Linux. Instead of one kernel image owning the whole machine, multiple independent Linux kernels boot on one machine, each owning a fixed subset of cores. Device drivers and interrupt handling are consolidated in a dedicated device kernel; application kernels get dedicated cores with nothing else on them. The kernels share nothing and communicate through explicit, well-defined channels. It is 100% open source and built on upstream Linux.

We built it for isolation and performance. The usual objection is that you give up whole-machine scheduling; on heterogeneous RISC-V you give that up anyway. Partition along the cluster boundaries and:

- **Every kernel sees a machine where all cores match.** The wide cluster's kernel records the wide width, the capability word describes silicon its programs will actually run on, and the C library selects the vector routines the hardware has. There is no lowest common denominator, because nothing is shared.
- **Every kernel is compiled for its exact silicon**: its own instruction set, its own errata workarounds, its kernel vector code at its real width. RVV 0.7.1 and RVV 1.0 software run side by side on one machine, each in its own domain with the toolchain that matches.
- **Nothing has to be enforced, because nothing is shared.** No affinity lists to maintain or silently override. Hotplug works, `SCHED_DEADLINE` admits your inference job on the wide cluster, cpusets do what the documentation says. Inside each domain, Linux behaves like Linux on an ordinary machine, because from that kernel's point of view it is one.
- **Placement is explicit instead of accidental.** Inference and data-parallel jobs deploy to the wide-vector domain, general services to the scalar domains, the device kernel on scalar cores so the expensive vector silicon serves applications only. Cross-domain coordination is IPC and shared memory. That is the honest model: on this hardware, a thread that transparently spans core types was never on offer from anyone.

For a silicon vendor, the strategic point matters more than the performance argument. This is the difference between shipping a heterogeneous part whose headline capability must be disabled to run mainline Linux, and shipping one where every cluster runs at full capability on day one.

## What about a JIT?

One objection tries to put migration back on the table: let a runtime regenerate code for whichever core the task lands on. It usually arrives citing the [RISC-V J extension](https://github.com/riscv/riscv-j-extension), whose only ratified component is pointer masking and which says nothing about vectors or migration.

The serious version of the idea has been built, and it proves our point. [Popcorn Linux](https://www.ssrg.ece.vt.edu/papers/asplos_2017.pdf) migrates threads across incompatible ISAs at compiler-inserted equivalence points, and to do it, it runs a separate kernel per ISA island with migration as an explicit service between them. The research that pushed cross-ISA migration furthest ended up building a multikernel.

For everything else, the problem is state, not code. A JIT changes when machine code is generated, not how many bits fit in a register. When Linux delivers a signal, the saved register snapshot [records the width it was taken at](https://github.com/torvalds/linux/blob/master/arch/riscv/include/uapi/asm/ptrace.h), and no compiler regenerates state that outlives the code it compiled. Most vector code on a server has no runtime behind it anyway: the C library's `memcpy`, OpenSSL's hand-written assembly, OpenBLAS's tuned kernels, everything the compiler vectorized out of C, C++, or Rust. And Alder Lake settles it empirically. Intel had the JVM, .NET, V8, and its own compilers; if runtime code generation could carry a task across a vector-capability boundary, that is where it would have happened. Intel fused the feature off instead.

## What we are honest about

A single kernel can run this hardware once the patches are written, and they should be written. What they buy is a partitioned machine with a policy knob where the boundary should be, paid for in hotplug, deadline scheduling, affinity semantics, and isolation, while the kernel binary still compiles for the narrowest cluster and still cannot host two vector generations.

Multikernel does not migrate a running process across a cluster boundary either. Nothing does; the hardware forbids the operation. Moving a workload between domains means restarting it there, and the restart is cheap for the same reason the migration is impossible: a process that has not run yet holds no vector registers, no signal frames, no data tiled to a width. For the service-oriented deployments these machines target, that is how operations already work.

The platform work is real. Kernel spawning, interrupt routing across domains with AIA and IMSIC, and clean device tree and ACPI descriptions of heterogeneous topology are all younger on RISC-V than on x86 or ARM. That is exactly the adaptation work we want to do with platform partners.

## Partner with us

Heterogeneous RISC-V servers are not a corner case on the roadmap. They are the roadmap, because the economics that produce them are not going away.

If you are a RISC-V silicon vendor, we want to do the bring-up on your parts: kernel spawning on your boot flow, device kernel enablement for your I/O, one kernel per cluster running at its full vector width. If you build boards or systems, we want your platform in our support matrix from day one. If you operate infrastructure and are evaluating RISC-V, we will run a proof of concept on your real workloads and let the results speak.

The engagement model has three steps: platform adaptation on your target silicon, proof of concept on real workloads, then pushing everything into upstream Linux together. The work is open source end to end, so what we build with you becomes part of the platform every RISC-V vendor benefits from, with your silicon as the reference.

- Explore our Linux kernel code: [github.com/multikernel/linux](https://github.com/multikernel/linux)
- Learn the multikernel architecture: [Split-Kernel Architecture](https://multikernel.io/technology.html)
- Start the conversation: [cwang@multikernel.io](mailto:cwang@multikernel.io)
