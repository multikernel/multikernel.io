---
layout: post
title: "The Partition Is Not Optional: Heterogeneous RISC-V and the Cost of a Single Kernel"
date: 2026-07-08 10:00:00 -0700
categories: [linux-kernel, riscv, architecture, multikernel]
author: Cong Wang, Founder and CEO
excerpt: "RISC-V server silicon now ships cores with different vector widths on the same die, and it just killed the oldest promise in operating systems: that any task can run on any core. A task holding 4 KB of vector state can never land in a 1 KB register file. No patch changes that. This machine will be partitioned no matter what you do. The only question is who draws the line: you, or an accident inside the scheduler."
---

Sixteen cores. Eight of them are AI cores with 1024-bit vector registers, the entire reason the chip exists. Boot mainline Linux on SpacemiT's Key Stone K3 and those eight cores stay dark.

Not a driver bug. Not a firmware quirk. Linux inspects each core as it comes up, sees a vector width that does not match the boot core, and refuses it. Half the machine, the half you paid for, is gone.

The kernel is defending the oldest promise in operating systems: any task can run on any core. Every mainstream OS for fifty years has been built on it. On every context switch, the kernel saves a program's vector registers and restores them wherever the program lands next.

On this chip, that promise is unkeepable. Thirty-two vector registers at 1024 bits is 4 KB of live state. A 256-bit core has 1 KB of register file to receive it. The bits have nowhere to go. Linux is not failing this machine. The assumption is. Everything else in this post is that single fact, playing out.

You could wait for chips with matched cores. They are not coming. The reasons are economic, and they are not going away. That leaves one conclusion, and it is uncomfortable for a single kernel: on this class of machine, the partition is not optional. Your only choice is whether it is a boundary you designed or a policy knob bolted on afterward.

## The mismatch is the business model

A wide vector unit is the most expensive block in a modern core. Massive register files, wide execution lanes, the load-store bandwidth to feed them. Put that engine on all sixteen cores and you pay for it sixteen times, so that workloads occupying a quarter of the machine can use it. No vendor fighting for sockets will sign that check. The economical design is obvious: a few clusters get the wide engine, the rest stay lean.

RISC-V adds the twist: nobody makes the clusters agree. RISC-V SoCs are assembled from licensed core IP, often from multiple suppliers, and no central authority holds two IP blocks to a common vector width the way ARM holds big.LITTLE clusters to a common architectural state. Agreement can be bought. [AMD's Zen 4 buys it for AVX-512](https://www.techinsights.com/blog/amd-zen-4-adds-avx-512), giving cores full-width architectural registers behind a narrower datapath. But 4 KB of multiported register file, plus the wiring to feed it, is a second cost, and it lands on exactly the cores that exist to be cheap. Intel is paying it right now: its converged [AVX10](https://www.phoronix.com/news/Intel-AVX10) ISA first let efficiency cores stop at 256 bits, then the [2025 revision](https://www.phoronix.com/news/Intel-AVX10-Drops-256-Bit) surrendered and made 512-bit mandatory on every core. RISC-V vendors are refusing to pay. Heterogeneous width is not a mistake in their products. It is the product.

This is shipping hardware, today. SpacemiT's [Key Stone K3](https://www.spacemit.com/products/keystone/k3), a server-class RVA23 SoC, puts eight general-purpose X100 cores at 256 bits next to eight AI-first A100 cores at [1024 bits](https://github.com/spacemit-com/docs-chip/blob/main/en/key_stone/k3/k3_docs/k3_ds.md). A four-fold width gap on one die, same RVV 1.0 ISA on both sides. The installed base is worse: the 64-core Sophgo SG2042 in the [Milk-V Pioneer](https://milkv.io/pioneer) implements draft RVV 0.7.1, which is [instruction-level incompatible](https://arxiv.org/abs/2406.12394) with the ratified RVV 1.0 that newer cores speak. Not narrower. Incompatible.

## Four lines of code, half a machine

The boot failure is not buried in some driver. It is four lines, in the open, doing exactly what they say:

```c
if (riscv_v_vsize != this_vsize) {
        WARN(1, "RISCV_ISA_V only supports one vlenb on SMP systems");
        return -EOPNOTSUPP;
}
```

A core that disagrees [never comes up](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/smpboot.c). And the number it disagrees with, [`riscv_v_vsize`](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/vector.c), is one width for the whole machine. It sizes every buffer that will ever hold a program's vector state. Linux has no concept of one process living at 256 bits while another lives at 1024.

That part is software, and software gets fixed: SpacemiT's [downstream kernel](https://github.com/spacemit-com/linux-6.18/blob/k3-br-v1.0.y/arch/riscv/kernel/vector.c) already stores the width per process and sizes buffers for the widest cluster. So yes, a single kernel can boot this machine. Booting was never the hard part.

The hard part is physics. The 4 KB of state still does not fit in the 1 KB register file. Hiding the width is impossible: any program can read it, and compilers and tuned libraries read it once and specialize themselves around it forever. Between RVV 0.7.1 and 1.0, even the instruction encodings differ. So every design that touches this hardware, patched single kernel or multikernel, will confine a vector task to one cluster for its entire life. Migration is dead for everyone. The only question left is what the confinement looks like: a boundary you chose, or a restriction the scheduler improvises.

The industry has faced this before, and its verdicts are on the record. Linux on ARM [intersects SVE vector lengths across cores](https://github.com/torvalds/linux/blob/master/arch/arm64/kernel/fpsimd.c) and refuses any core that breaks the agreement. Intel shipped Alder Lake with AVX-512 on the performance cores only, then [fused it off in silicon](https://www.intel.com/content/www/us/en/support/articles/000089918/processors.html). Consider what that means: Intel found it easier to destroy the feature than to schedule around it. And RISC-V cannot even copy Intel's escape, because vector width is not a feature bit you can clear. It is the physical size of the register file, and the same `vadd` encoding runs at every width. Disable vector on a cluster, hide the cluster in firmware, or let Linux refuse it: three different ways to ship silicon nobody can use.

## The cost of patching a single kernel

Say the patches land in mainline: per-process width, buffers sized for the widest cluster, vector programs pinned to the cluster where they started. What does that cost?

No need to guess. Linux already ran this experiment. Some ARM chips run 32-bit code on only a subset of cores, the kernel copes by confining those programs, and the [documentation reads like a price list](https://github.com/torvalds/linux/blob/master/Documentation/arch/arm64/asymmetric-32bit.rst). Nothing on the list is about 32-bit code. Every charge comes from one fact: some programs are confined to a subset of the machine, and the rest of Linux was built assuming none are. Any RISC-V fix inherits every one of these costs:

- **The feature ships disabled.** Linux turns the mismatched capability off unless the operator passes a special boot flag. A stock distro hides the very cluster you taped out.
- **Hotplug is gone.** Affinity restrictions [do not survive it](https://github.com/torvalds/linux/blob/master/kernel/sched/core.c), so ARM forbids offlining the last capable core. No powering down under light load. No draining a core for maintenance. No retiring one that starts throwing correctable errors.
- **`SCHED_DEADLINE` says no.** A confined program cannot be admitted unless the operator disables admission control machine-wide, trading away the guarantee for everyone. Latency-bounded inference, the exact workload the wide cluster exists for, cannot get the guarantee.
- **Affinity lies.** The kernel silently swaps the CPU set you requested for the subset that works. systemd, Kubernetes' CPU manager, and `numactl` now disagree with the kernel about where their own processes run.
- **Cpuset isolation is undefined behaviour.** ARM's documentation says so in those words. Fencing the AI cluster off from the rest of the machine is the first thing any operator would do with this part.

And RISC-V drew a harder hand than ARM. A 32-bit binary declares itself in its header, so ARM confines it once, at startup, before it holds any state. A RISC-V binary carries no such mark: vector-length agnostic code is correct on both clusters, so the kernel can only decide at the first vector instruction, and from that instant the program is welded to whichever cluster the load balancer happened to hand it in its first microsecond. Worse: ARM's mistake traps. Yours truncates. A 32-bit program on the wrong ARM core dies cleanly; restoring 4 KB of vector state into a 1 KB register file silently destroys data, unless the kernel re-checks the width on the hottest path it owns.

Three more costs are welded into the kernel binary itself, beyond the reach of any scheduler patch:

- **The C library abandons the vector unit you shipped.** Linux hands every program a capability word built by [intersecting what every core reports](https://github.com/torvalds/linux/blob/master/arch/riscv/kernel/cpufeature.c). Mix RVV 0.7.1 with 1.0 and the vector bit survives nowhere. Scalar `memcpy` on every core, including the ones with a perfectly good vector unit.
- **Kernel vector code runs narrow everywhere.** One binary, compiled once: the kernel's own [crypto](https://github.com/torvalds/linux/blob/master/arch/riscv/crypto/Kconfig) and [RAID](https://github.com/torvalds/linux/blob/master/lib/raid/raid6/riscv/rvv.h) paths get built for the narrowest cluster, and errata workarounds are patched in at boot for whichever core booted first.
- **Two vector generations cannot share one kernel at all.** RVV 0.7.1 and 1.0 state have different layouts and different save/restore paths. Supporting both in one image is a second architecture port hiding inside the first. Nobody has written it. Nobody is going to.

Now read that list again and notice who pays. Not the AI cluster. The scalar cores lose hotplug, deadline scheduling, honest affinity, cpuset isolation, and full-speed kernel crypto, all to tolerate a cluster most of their programs never touch. You degraded the general-purpose half of the machine to appease the specialized half. That is exactly backwards from why anyone built this silicon.

The patches do not remove the partition. They hide it, and a hidden partition is the most expensive kind.

## One kernel per cluster

The machine will be partitioned. That was decided at tape-out. The only decision left to software is whether the partition is a first-class boundary or an apology scattered across the scheduler. So make it a boundary.

Multikernel is a split-kernel architecture for Linux. Instead of one kernel image owning the whole machine, multiple independent Linux kernels boot on one machine, each owning a fixed subset of cores. Device drivers and interrupt handling live in a dedicated device kernel; application kernels get dedicated cores with nothing else on them. The kernels share nothing and communicate through explicit, well-defined channels. It is 100% open source and built on upstream Linux.

Multikernel does not work around this hardware. It takes the hardware's side.

We built it for isolation and performance. The standard objection is that you give up whole-machine scheduling. On this hardware there is no whole-machine scheduling to give up. The silicon already took it. Draw the partition along the cluster boundaries and the entire price list evaporates:

- **Every kernel sees a machine where all cores match.** The wide cluster's kernel records the wide width, the capability word describes silicon its programs will actually run on, and the C library selects the vector routines the hardware really has. No lowest common denominator, because nothing is shared.
- **Every kernel is compiled for its exact silicon.** Its own instruction set, its own errata workarounds, its own kernel vector code at full width. RVV 0.7.1 and RVV 1.0 software run side by side on one machine, each in its own domain with the toolchain that matches.
- **Nothing has to be enforced, because nothing is shared.** No affinity lists to maintain or silently override. Hotplug works. `SCHED_DEADLINE` admits your inference job on the wide cluster. Cpusets do what the documentation says. Inside each domain, Linux behaves like Linux on an ordinary machine, because from that kernel's point of view, it is one.
- **Placement is a decision, not an accident.** Inference and data-parallel jobs deploy to the wide-vector domain, general services to the scalar domains, the device kernel on scalar cores so the expensive vector silicon serves applications only. Cross-domain coordination is IPC and shared memory. That is the honest model: on this hardware, a thread that transparently spans core types was never on offer from anyone.

For a silicon vendor, this is bigger than performance. It is the difference between shipping a part whose headline capability must be disabled to run mainline Linux, and shipping a part where every cluster runs at full capability on day one. Nobody buys a sixteen-core part to run eight.

## A JIT does not change the physics

One objection keeps trying to resurrect migration: let a runtime regenerate code for whichever core the task lands on. It usually arrives citing the [RISC-V J extension](https://github.com/riscv/riscv-j-extension), whose only ratified component is pointer masking and which says nothing about vectors or migration.

The serious version of the idea was built, and it makes our argument for us. [Popcorn Linux](https://www.ssrg.ece.vt.edu/papers/asplos_2017.pdf) migrates threads across incompatible ISAs at compiler-inserted equivalence points, and to pull it off, it runs a separate kernel per ISA island with migration as an explicit service between them. The research project that pushed cross-ISA migration further than anyone ended up building a multikernel.

For everything else, the objection confuses code with state. A JIT changes when machine code gets generated, not how many bits fit in a register. When Linux delivers a signal, the saved register snapshot [records the width it was taken at](https://github.com/torvalds/linux/blob/master/arch/riscv/include/uapi/asm/ptrace.h), and no compiler regenerates state that outlives the code it compiled. And most vector code on a server has no runtime behind it anyway: the C library's `memcpy`, OpenSSL's hand-written assembly, OpenBLAS's tuned kernels, everything the compiler vectorized out of C, C++, and Rust. Alder Lake closes the case. Intel had the JVM, .NET, V8, and the deepest compiler expertise in the industry. If runtime code generation could carry a task across a vector-capability boundary, it would have happened there. Intel reached for the fuse instead, and that decision settles the question.

## Migration is off the table for everyone

A single kernel will run this hardware once the patches are written, and they should be written. What they buy is a partitioned machine wearing a policy knob where a boundary should be, paid for in hotplug, deadline scheduling, affinity semantics, and isolation, while the kernel binary still compiles for the narrowest cluster and still cannot host two vector generations. For a single kernel, that is not the starting point. That is the ceiling.

Multikernel does not migrate a running process across a cluster boundary either. Nothing does. The hardware forbids the operation, for us and for everyone. Moving a workload between domains means restarting it there, and the restart is cheap for the same reason the migration is impossible: a process that has not run yet holds no vector registers, no signal frames, no data tiled to a width. For the service-oriented deployments these machines target, that is how operations already work.

The platform work is real, and it is substantial. Kernel spawning, interrupt routing across domains with AIA and IMSIC, clean device tree and ACPI descriptions of heterogeneous topology: all of it is younger on RISC-V than on x86 or ARM. That is precisely the work we want to do with platform partners.

## Build it with us

Heterogeneous RISC-V servers are not a corner case on the roadmap. They are the roadmap, because the economics that produce them are not going away.

If you are a RISC-V silicon vendor, we want to do the bring-up on your parts: kernel spawning on your boot flow, device kernel enablement for your I/O, one kernel per cluster running at its full vector width. If you build boards or systems, we want your platform in our support matrix from day one. If you operate infrastructure and are evaluating RISC-V, we will run a proof of concept on your real workloads and let the results speak.

The engagement model has three steps: platform adaptation on your target silicon, proof of concept on real workloads, then pushing everything into upstream Linux together. The work is open source end to end, so what we build with you becomes part of the platform every RISC-V vendor benefits from, with your silicon as the reference.

- Explore our Linux kernel code: [github.com/multikernel/linux](https://github.com/multikernel/linux)
- Learn the multikernel architecture: [Split-Kernel Architecture](https://multikernel.io/technology.html)
- Start the conversation: [cwang@multikernel.io](mailto:cwang@multikernel.io)
