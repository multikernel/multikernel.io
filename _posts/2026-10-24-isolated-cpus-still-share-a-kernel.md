---
layout: post
title: "Isolated CPUs Still Share a Kernel: OS Noise Under Load"
date: 2026-10-24 10:00:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, real-time]
author: Cong Wang, Founder and CEO
excerpt: "We measured OS noise on one CPU of a bare-metal server in two configurations: a CPU isolated with isolcpus, nohz_full and rcu_nocbs inside the host kernel, and a CPU running its own single-CPU multikernel instance. On a quiet machine the isolated CPU was quieter, because its tick stops and the instance's cannot. Under load on the neighboring cores, the isolated CPU received 12,720 function-call IPIs in a minute and its noise rose to 27.0 ms. The instance received none, and finished at 9.5 ms against a heavier load. The IPIs were not a tuning mistake. In our test they came mostly from the host patching kernel text, which the isolated CPU shares and the instance does not."
---

A real-time engineer isolating a CPU on Linux has a well-known checklist. Remove the CPU from the scheduler's load balancing with `isolcpus`. Stop its tick with `nohz_full`. Move its RCU callbacks elsewhere with `rcu_nocbs`. Steer device interrupts away from it. Then run the latency-critical task alone on that CPU and hope that nothing else reaches it.

At Open Source Summit Europe 2026, a team from Texas Instruments presented [Beyond Best-Effort: Deterministic Real-Time Ethernet on Multi-Core Linux](https://hosted-files.sched.co/osselceu2026/2b/OSS-E-Beyond-Best-Effort_100226_Submission.pdf){:target="_blank" rel="noopener noreferrer"}. They ran real-time PROFINET traffic beside best-effort UDP on a PREEMPT_RT system, with both sharing one NIC receive queue. Even with CPU isolation and XDP in place, a small number of cycles still missed their deadlines, and the talk concluded that separating the traffic in hardware was needed.

Their talk made us ask a related question: what still reaches a CPU after the whole checklist is applied, and does it go away when that CPU stops sharing a kernel with the rest of the machine? A [multikernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} instance can run on a single CPU with its own kernel, its own memory, and no scheduler, timer, RCU, or kernel text shared with the host. We measured such a CPU against an isolated CPU inside the host kernel, with the same kinds of load on the neighboring cores.

This addresses the CPU side of a setup like theirs, not the shared NIC queue. A real-time frame waiting behind best-effort frames is delayed before any CPU sees it, and that needs the hardware separation they called for.

## The Measurement

Both configurations ran the same kernel build on the same machine: a dual-socket Xeon Gold 5418Y with 24 cores per socket and no SMT. The measured CPU was CPU 47, the last core on socket 1. The load ran on CPUs 24 to 46, the other 23 cores of the same socket.

**Shared kernel.** The host booted with `isolcpus=nohz,domain,managed_irq,47 nohz_full=47 rcu_nocbs=47`. CPU 47 stayed part of the host kernel, but with the standard isolation applied.

**Multikernel instance.** The host booted without isolation parameters. [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} created a memory pool on node 1 and booted an instance on CPU 47 with 1 GB of memory. The instance ran the same kernel build as the host. It had one CPU and had no work to hand off to the host, so the host never needed to interrupt it.

We used the kernel's [osnoise tracer](https://docs.kernel.org/trace/osnoise-tracer.html){:target="_blank" rel="noopener noreferrer"} in both cases. Its workload thread spins on the measured CPU and records every gap in which something else ran: an interrupt, a softirq, another thread, an NMI, or an unexplained hardware delay. We used a one-second period with a one-second runtime, so the thread sampled the CPU continuously. In the shared kernel, the tracer ran on host CPU 47. In the instance, the tracer ran inside the instance's own kernel. One detail matters later: osnoise counts a gap as noise only if it lasts at least 1 us, its default threshold.

The load mixed several kinds of pressure on the 23 neighboring cores:

| Component | What it does |
|---|---|
| `mmchurn` x 4 | three threads each, repeatedly mapping, writing, protecting and unmapping 32 MB |
| `ping -f` x 2 | loopback ping floods with 1400-byte packets |
| `/bin/true` loops x 4 | fork and exec as fast as possible |
| tracepoint toggle | enables and disables a `sched_wakeup` event in a separate tracing instance, in a loop |

The last component stands in for something production hosts do all the time. Enabling a tracepoint, attaching a BPF program, flipping a static key or applying a live patch all modify kernel code while the kernel runs.

Each configuration had a quiet phase of 60 seconds, a loaded phase of 60 seconds, and a 20-second attribution phase under load, in which osnoise also recorded what caused each gap. The quiet and loaded phases recorded only the per-second summaries, because enabling osnoise events in the host's main tracing instance made the tracepoint toggle much more expensive. We read the CPU's IPI and timer interrupt counts from `/proc/interrupts` at the boundary of each phase.

We ran the comparison in a VM first, and moved to bare metal because the VM could not give a fair answer. Its CPUs showed 0.45% to 1% hardware noise even when idle, and every timer tick in the guest cost a VM exit, which penalized the instance's always-on tick far more than bare metal does. In the VM, the isolated CPU had less noise under load than the instance. On bare metal, the result reversed.

## A Quiet Machine: The Single Kernel Wins

With nothing running on the neighboring cores, both CPUs were quiet.

| Quiet, 60 s | Shared kernel, isolated CPU | Multikernel instance |
|---|---|---|
| Total noise | 0.59 ms | 0.93 ms |
| Longest single gap | 41 us | 35 us |
| Timer interrupts | 2 | 14,775 |
| Function-call IPIs | 522 | 0 |

The difference is the tick. `nohz_full` stopped the isolated CPU's tick; the instance's tick ran at 250 Hz for the whole minute. The totals understate that cost. Most of the instance's ticks were shorter than osnoise's 1 us threshold, so they never entered the 0.93 ms. In the attribution phase, with events enabled, a tick took 0.57 us on average. At that rate, 14,775 ticks add up to about 8 ms per minute. The isolated CPU's real advantage on a quiet machine lies somewhere between the measured 0.3 ms per minute and roughly 8 ms.

The instance cannot stop its tick for a structural reason. `nohz_full` requires at least one housekeeping CPU that keeps the tick and maintains timekeeping, and in a single-CPU kernel the only candidate is the CPU being measured. This is not a fundamental limitation. The host already does housekeeping for the machine, and a single-CPU instance could in principle rely on the host's timekeeping and run tickless. That is future work.

The isolated CPU still received 522 function-call IPIs in that quiet minute, about nine per second. Nothing was running on the neighboring cores. The rest of the host was idle, but it was still the same kernel, and its housekeeping work occasionally needed every CPU to do something.

## Under Load: Multikernel Wins

Then the load started on CPUs 24 to 46.

| Under load, 60 s | Shared kernel, isolated CPU | Multikernel instance |
|---|---|---|
| Load | without `mmchurn` | full, with `mmchurn` |
| Total noise | **27.0 ms** | **9.5 ms** |
| Longest single gap | 34 us | 94 us |
| Timer interrupts | 6 | 14,776 |
| Function-call IPIs | **12,720** | **0** |

The loads were not identical. The shared kernel ran without `mmchurn`, the memory-heavy component, and the instance ran with it, so the instance faced the heavier load.

The isolated CPU's noise rose 46 times, from 0.59 ms to 27.0 ms. Its tick stayed off, with six timer interrupts across the whole minute. Almost all of the noise came from the 12,720 function-call IPIs it received, about 210 per second at roughly 2 us each, well above the 1 us threshold.

The instance received no IPIs at all. Its timer interrupt count was 14,776, against 14,775 in the quiet phase: the same tick, at the same rate. Its softirq and thread counts did not change either. Yet its noise rose from 0.93 ms to 9.5 ms. With the same number of interruptions, each one took longer, along with gaps that osnoise could not attribute to any software cause. That is what contention on shared hardware looks like: the last-level cache and memory controllers of socket 1, which the instance still shares with the neighboring cores.

The instance finished with about a third of the isolated CPU's noise. That holds even if every one of its ticks is charged in full: adding the 8 ms estimate from the quiet section gives about 17.5 ms, still well under 27.0 ms.

The one number that went the other way is the longest single gap: 94 us for the instance, against 34 us for the isolated CPU. We think that came from `mmchurn`. In the quiet phase the instance's longest gap was 35 us, and its noise under load was dominated by hardware contention, which `mmchurn` produces most. We have not yet rerun the instance without `mmchurn` to confirm it.

## Where the IPIs Come From

The attribution phase named the source. With osnoise events enabled, every interrupt on the isolated CPU was `call_function`, vector 252, the IPI that runs a function on another CPU's behalf.

A function-call IPI reaching an isolated CPU is not a tuning mistake that a missing boot parameter would fix. The tracepoint toggle on the neighboring cores patches kernel text. On x86, after rewriting an instruction, the kernel calls `text_poke_sync()`, which runs `on_each_cpu(do_sync_core, NULL, 1)`. Every CPU that might execute the patched code has to serialize its instruction stream before the patch is safe, and every CPU in the host kernel executes the same kernel text, including the isolated one. Nothing in that path consults `nohz_full` or the housekeeping masks. It cannot simply skip a CPU that might be running the code being changed.

A tracepoint toggle is only one source. Static key flips, BPF trampoline updates, live patching, and other cross-CPU work in the same family reach every CPU in the kernel in the same way. That is where the nine IPIs per second on the quiet machine came from.

There have been upstream proposals to defer some of these IPIs on `nohz_full` CPUs until their next kernel entry. That approach handles the IPIs that can wait. It does not change what the CPU shares.

The instance's kernel text is its own copy. When the host patches its text, there is nothing on the instance's CPU to serialize, so the host never targets it. Its attribution phase showed only its own work: the tick, timer softirqs, a few kernel threads, and the unattributed gaps from hardware contention.

The attribution phase also showed how bad this can get for the isolated CPU. With osnoise events enabled in the main tracing instance, each tracepoint toggle became much more expensive, and in 20 seconds the isolated CPU received 1.6 million function-call IPIs. For the periods the tracer recorded, 24.4% of CPU 47's time went to them. That is an artifact of our attribution setup. It is also exactly what an isolated CPU experiences when someone enables tracing on the host while a real-time task is running.

## Why the Instance Gets Zero IPIs

x86 can send one "all CPUs but self" IPI instead of one IPI per CPU, a mode called the broadcast shorthand. It does not explain the shared kernel's IPIs. The kernel uses the shorthand only when the requested mask already covers every online CPU. If it were disabled, the isolated CPU would receive the same IPIs, delivered one at a time.

It did explain a bug on the instance's side. In our first VM runs, the single-CPU instance received 28,293 function-call IPIs in one minute under host load, when it should have received none. When kerf moves a CPU from the host to an instance, the host takes the CPU down and re-evaluates whether shorthand IPIs are safe at the end of that takedown. At that point the CPU was still marked present, so the check passed, and the host kept using the shorthand. But the hardware delivers "all CPUs but self" to every local APIC on the bus, including those that now belonged to another kernel. Every host broadcast also interrupted the instance.

The fix is in the multikernel tree as "x86/multikernel: Don't use IPI shorthands when the APIC bus is shared". The host disables the shorthand while any CPU belongs to another kernel, and a spawned kernel never enables it, since the APIC bus is shared from its first instruction. Each IPI then goes only to the CPUs the kernel owns. The VM run after the fix measured zero IPIs on the instance, and so did both bare-metal phases above.

## What This Does Not Show

The loads were not identical, as noted above. A rerun of the instance without `mmchurn` would make the worst-case comparison like for like.

Each configuration was measured once, for 60 seconds per phase. The differences we report are large compared with what we would expect between repeat runs, but we have not measured that variance.

This is an x86 server running a general-purpose kernel, not PREEMPT_RT, and not the AM62Px used in the TI talk. osnoise measures how much time is taken from a spinning thread. It does not measure deadline misses in a real-time network stack. The noise it records is one source of such misses, and a shared NIC queue is another.

The load is synthetic. The tracepoint toggle runs continuously, which no production host would do. But it is the same operation a production host performs whenever someone attaches a probe or flips a static key, and those moments are exactly when a real-time task cannot afford an interruption.

The instance does not escape the hardware. It shares the last-level cache and memory controllers with its socket, and under load that cost it about 8.5 ms per minute. Hardware partitioning such as cache allocation could reduce it. We did not use any here.

## Conclusion

CPU isolation inside one kernel removes the scheduler, the tick and RCU from a CPU. It cannot remove the kernel. As long as the isolated CPU executes the same kernel text as the rest of the machine, every change to that text has to reach it, and on a busy host those changes arrive hundreds of times per second.

A multikernel instance stops sharing that text. On our machine, the host's work on the neighboring cores sent no IPIs to the instance's CPU. What remained was its own tick, which a single-CPU instance could hand to the host, and contention on shared hardware, which hardware partitioning addresses.

On a quiet machine, the isolated CPU wins because its tick stops. Under load, the instance wins by a factor of about three while facing the heavier load. Real-time systems are designed around the loaded case.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so is [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. If you run latency-critical work on isolated CPUs, from a trading path polling the market to a control loop on the factory floor, and those CPUs are still being interrupted, we would like to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io). For trading specifically, see [Multikernel for High-Frequency Trading](/solutions/hft.html).
