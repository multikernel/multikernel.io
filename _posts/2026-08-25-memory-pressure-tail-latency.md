---
layout: post
title: "The Noisy Neighbor Is the Kernel: Memory Pressure and Tail Latency"
date: 2026-08-25 10:00:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, memory-management]
author: Cong Wang, Founder and CEO
excerpt: "A task that finishes its work in 56 milliseconds on an idle machine watched its median hit 824 milliseconds and its p99 hit 35.6 seconds, on its own dedicated cores, faulting its own private memory, because a batch job it never touches was leaning on the same kernel's reclaim. The sanctioned fix, memory.high on the hog, restored the victim perfectly: 58 milliseconds, as if the hog were gone. It effectively was: 10 completed passes instead of 29,719. Protection and strangulation are the same mechanism, and a single kernel only lets you point it at somebody. Two kernels on the same silicon ran both tenants at once: victim p99 bounded at 232 milliseconds, hog at full speed, and the leftover 4x traced to DRAM, where a placement knob multikernel already owns erased it too: 67 milliseconds at p99, against an unthrottled hog."
---

Here is a task minding its own business: every five milliseconds it faults in 128 MB of its own private memory and hands it back, 56 milliseconds per cycle, 5,100 cycles every five minutes, steady as a clock. Now a batch job starts hoarding memory on the same machine. Different cores. Different memory. Not one byte shared between them. The task's median cycle is now 824 milliseconds. Its p99 is 35.6 seconds. It completes 49 cycles in five minutes. Nothing it can see has changed, and it has stopped working, because the thing it shares with the hog is not visible from userspace at all: one kernel's reclaim machinery, one set of watermarks, one swap device.

So we reached for the sanctioned fix, `memory.high` on the hog's cgroup, and it worked flawlessly. The victim came back to 58 milliseconds as if the hog were gone. It effectively was: in the same five-minute window in which the unconfined hog completed 29,719 full passes over its working set, the confined hog completed 10. Not 10,000. Ten.

Protection and strangulation are the same mechanism. On a single Linux kernel, memory isolation between colocated workloads is not a setting where both run; it is a dial that chooses which one does not. cgroups can move the loss, aim it, schedule it, but not remove it, because both tenants live inside one memory-management machinery that must put the pressure somewhere.

This post measures that dial's two endpoints with components of the kernel community's own memory-management benchmark suite. Then it holds the hardware constant, splits the machine into two kernels, and shows the trade dissolving: both workloads running at once, the victim's p99 bounded at 232 milliseconds, the hog at full throughput. Then it chases the residual 4x over the victim's quiet floor to its actual home, which turns out not to be software at all, and finally sends the obvious alternative, a KVM guest, through the same hog. It is the tail-latency companion to [our will-it-scale post](/2026/08/17/multikernel-will-it-scale/), which measured what one kernel's locks do to throughput; this is what one kernel's reclaim does to your p99, and the failure mode is worse: throughput collapse is gradual, but the tail fails like a cliff, and the standard tool for containing it pushes the other tenant off a different cliff.

## Taking Mel Gorman's Stutter Apart

The antagonist pair comes from [mmtests](https://github.com/gormanm/mmtests){:target="_blank" rel="noopener noreferrer"}, the memory-management test harness maintained by Mel Gorman and used across the kernel MM community. Its `stutterp` benchmark exists because this exact failure kept reaching real users: a foreground task stuttering while background work leans on memory. It has three components, and they map perfectly onto a colocation experiment:

| Component | What it does | Role |
|---|---|---|
| `mmap-latency` | every 5 ms: mmap 128 MB anonymous, fault it in page by page, munmap, report the cycle time | the victim, and the metric |
| `memory-hog` x 10 | each loops over a 5.4 GB anonymous region, touching one word per page, printing each pass's duration | anonymous memory pressure |
| fio writers + reader | 10 buffered 1 MB random writers over 13.4 GB of files, plus stutterp's "inefficient reader" | dirty page cache and writeback |

We used stutterp's own C programs and its fio job template, with our own driver around them, because the stock harness runs all three components inside one kernel and we needed to move them between cgroups and kernels. Sizing follows stutterp's formula: total working set is 120% of the memory arena, with the file share set to the dirty ratio. The arena is one NUMA node.

The machine is the same dual-socket Xeon Gold 5418Y as the [previous](/2026/08/16/multikernel-vs-kvm-lmbench/) [posts](/2026/08/17/multikernel-will-it-scale/): 24 cores per socket, no SMT, 64 GB per NUMA node, 8 GB of swap. Placement is identical in every configuration: the victim runs on the same four socket-1 cores with node-1 memory, and the hog mix runs on the other twenty socket-1 cores, bound to node 1, where its 54 GB of anonymous memory plus 13 GB of dirty files against a 64 GB node produces sustained hard reclaim. In the two-kernel configurations the victim's four cores and 2 to 4 GB of node-1 memory become a [multikernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} instance booted with kerf, running the same kernel build; the hog stays on the host kernel, unchanged, with the same disk underneath its writeback. The only variable, ever, is where the victim lives. Each measurement is a 300-second window after a 90-second warmup.

## The Cliff of One Kernel

Here is the whole experiment in one picture; the rest of the post earns each bar, left to right.

<svg viewBox="0 0 720 430" role="img" aria-label="Victim fault-cycle latency by configuration, log scale; beside a hog on one kernel p99 is 35.6 seconds, in a separate kernel 232 milliseconds" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">The victim's 128 MB fault cycle, by configuration</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">mmtests stutterp mmap-latency, 300 s windows, log scale · pale bar = median, dark bar = p99</text>
<line x1="64" y1="329.6" x2="704" y2="329.6" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="333.6" font-size="11" fill="#9ca3af" text-anchor="end">100 ms</text>
<line x1="64" y1="243.0" x2="704" y2="243.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="247.0" font-size="11" fill="#9ca3af" text-anchor="end">1 s</text>
<line x1="64" y1="156.5" x2="704" y2="156.5" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="160.5" font-size="11" fill="#9ca3af" text-anchor="end">10 s</text>
<line x1="64" y1="70.0" x2="704" y2="70.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="74.0" font-size="11" fill="#9ca3af" text-anchor="end">100 s</text>
<rect x="96.0" y="351.2" width="30" height="12.8" fill="#6b7280" fill-opacity="0.45"><title>one kernel, quiet: p50 = 56.3 ms</title></rect>
<text x="111.0" y="346.2" font-size="10.5" font-weight="600" fill="#6b7280" text-anchor="middle">56</text>
<rect x="130.0" y="332.5" width="30" height="31.5" fill="#6b7280" fill-opacity="1.0"><title>one kernel, quiet: p99 = 92.5 ms</title></rect>
<text x="145.0" y="327.5" font-size="10.5" font-weight="600" fill="#6b7280" text-anchor="middle">92</text>
<text x="128.0" y="380" font-size="11" fill="#6b7280" text-anchor="middle">one kernel</text>
<text x="128.0" y="393" font-size="11" fill="#6b7280" text-anchor="middle">quiet</text>
<rect x="224.0" y="250.3" width="30" height="113.7" fill="#b91c1c" fill-opacity="0.45"><title>one kernel, beside hog: p50 = 824.2 ms</title></rect>
<text x="239.0" y="245.3" font-size="10.5" font-weight="600" fill="#b91c1c" text-anchor="middle">824</text>
<rect x="258.0" y="108.8" width="30" height="255.2" fill="#b91c1c" fill-opacity="1.0"><title>one kernel, beside hog: p99 = 35575.4 ms</title></rect>
<text x="273.0" y="103.8" font-size="10.5" font-weight="600" fill="#b91c1c" text-anchor="middle">35.6 s</text>
<text x="256.0" y="380" font-size="11" fill="#6b7280" text-anchor="middle">one kernel</text>
<text x="256.0" y="393" font-size="11" fill="#6b7280" text-anchor="middle">beside hog</text>
<rect x="352.0" y="350.4" width="30" height="13.6" fill="#a88428" fill-opacity="0.45"><title>one kernel, hog in memcg: p50 = 57.5 ms</title></rect>
<text x="367.0" y="345.4" font-size="10.5" font-weight="600" fill="#a88428" text-anchor="middle">58</text>
<rect x="386.0" y="333.1" width="30" height="30.9" fill="#a88428" fill-opacity="1.0"><title>one kernel, hog in memcg: p99 = 91 ms</title></rect>
<text x="401.0" y="328.1" font-size="10.5" font-weight="600" fill="#a88428" text-anchor="middle">91</text>
<text x="384.0" y="380" font-size="11" fill="#6b7280" text-anchor="middle">one kernel</text>
<text x="384.0" y="393" font-size="11" fill="#6b7280" text-anchor="middle">hog in memcg</text>
<rect x="480.0" y="353.5" width="30" height="10.5" fill="#6b7280" fill-opacity="0.45"><title>two kernels, quiet: p50 = 52.9 ms</title></rect>
<text x="495.0" y="348.5" font-size="10.5" font-weight="600" fill="#6b7280" text-anchor="middle">53</text>
<rect x="514.0" y="353.3" width="30" height="10.7" fill="#6b7280" fill-opacity="1.0"><title>two kernels, quiet: p99 = 53.2 ms</title></rect>
<text x="529.0" y="348.3" font-size="10.5" font-weight="600" fill="#6b7280" text-anchor="middle">53</text>
<text x="512.0" y="380" font-size="11" fill="#6b7280" text-anchor="middle">two kernels</text>
<text x="512.0" y="393" font-size="11" fill="#6b7280" text-anchor="middle">quiet</text>
<rect x="608.0" y="302.1" width="30" height="61.9" fill="#2a78d6" fill-opacity="0.45"><title>two kernels, beside hog: p50 = 207.8 ms</title></rect>
<text x="623.0" y="297.1" font-size="10.5" font-weight="600" fill="#2a78d6" text-anchor="middle">208</text>
<rect x="642.0" y="298.0" width="30" height="66.0" fill="#2a78d6" fill-opacity="1.0"><title>two kernels, beside hog: p99 = 231.7 ms</title></rect>
<text x="657.0" y="293.0" font-size="10.5" font-weight="600" fill="#2a78d6" text-anchor="middle">232</text>
<text x="640.0" y="380" font-size="11" fill="#6b7280" text-anchor="middle">two kernels</text>
<text x="640.0" y="393" font-size="11" fill="#6b7280" text-anchor="middle">beside hog</text>
<line x1="64" y1="364" x2="704" y2="364" stroke="#9ca3af" stroke-width="1"/>
</svg>

Quiet, the victim is boring: 56 ms median, 92 ms p99, cycle after cycle. Its 128 MB burst is a deliberate amplifier, the shape of a process starting, a JIT warming, a cache resizing; each cycle asks the kernel for 32,768 fresh pages and gives them back.

Beside the unconfined hog, the victim does not degrade. It stops. The node is in sustained overcommit, so every allocation the victim makes competes with reclaim for the same watermarks: direct reclaim in the victim's own context, allocation stalls behind kswapd, its just-touched pages eligible to be swapped out beneath it by pressure it did not create. The victim finished 49 cycles in five minutes, with a median of 824 ms and a 35.6-second p99: a median 15x its quiet number, a tail 385x it.

Note what this is not. The victim has its own dedicated cores; this is not CPU contention. It faults its own private memory; it shares nothing with the hog in userspace. Everything between them is inside the kernel: one set of watermarks, one reclaim machinery, one swap device, one flusher.

## What the Cgroup Answer Costs

cgroup v2 gives an operator two memory limits: `memory.max`, a hard cap enforced by the OOM killer, and `memory.high`, a soft cap enforced by throttling, where any task allocating above the limit is forced to reclaim the cgroup's own memory and then made to sleep. `memory.high` is the recommended tool for containing a noisy neighbor precisely because it degrades instead of kills.

So that is what we set: `memory.high` on the hog's cgroup, at 48 GB. On the victim's side of the ledger it is flawless: 58 ms median, 91 ms p99, statistically indistinguishable from an idle machine, reproduced twice.


The hog's side: 10 completed passes, against 29,719 unconfined. Roughly a 3,000x suppression, and the mechanism explains why it cannot be tuned away. The hog's 54 GB of anonymous memory does not fit under a 48 GB cap, and anonymous pages can only leave memory through swap, of which there are 8 GB. So the cgroup fills, swaps out what it can, and then has nowhere to go: every page a hog touches over the cap runs cgroup-local reclaim in the hog's own context, evicting another hog page, and then serves a penalty sleep that `memory.high` scales up for persistently-over cgroups. The hogs spent the window asleep or grinding their own LRU lists. The victim saw a quiet machine because the machine, minus the victim, had been put to sleep.

Could a smarter limit find the middle? For this workload shape there is no middle to find. Set the cap above the hog's total demand and it never engages; you get the 35.6-second column. Set it below the anonymous working set, as any safe sizing must when swap is finite, and you get the 10-passes column. The band in between is a few gigabytes wide, requires knowing the hog's working set in advance to that precision, and vanishes the moment the hog grows. Operators know this dial by its endpoints, which is why in practice so many deployments run with limits unset and take the first column, or set them and take the third, or run an OOM daemon whose remedy, killing the hog, is the third column administered faster.

## Nobody Loses with Two Kernels

Same cores, same node, same hog at full tilt on the host kernel. The victim's four cores and a slice of node-1 memory become a separate kernel instance; the victim inside knows nothing of the hog, and more to the point, its kernel does not either. No shared watermarks, no shared LRU, no shared flusher, no shared swap.

The victim's quiet floor in a spawn is 53 ms with a p99 of 53 ms, tighter than the host's own quiet floor, and identical whether the instance has 2 GB or 4 GB. Beside the full-speed hog it holds 208 ms median, 232 ms p99, 240 ms worst case observed. Read the shape, not just the level: on the shared kernel the tail sat 43x above its own median, 600x above the quiet floor, and the sample count collapsed; here the whole distribution sits in a 33 ms band, 1,550 cycles completed, no outliers at all. A shifted-but-tight distribution is what hardware contention looks like. A distribution smeared across decades is what kernel entanglement looks like.

And the hog: 27,501 passes, full speed. Both columns healthy at once, which neither single-kernel configuration achieved, because the trade they were forced to make does not exist here.

<svg viewBox="0 0 720 300" role="img" aria-label="Victim p99 versus hog completed passes for shared kernel, memcg, and two kernels; only two kernels keep both healthy" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Somebody has to lose. Or nobody.</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">left: victim p99 (log, lower is better) · right: hog completed passes in the same window (higher is better)</text>
<text x="352" y="74" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">one kernel, shared</text>
<rect x="161.1" y="78" width="190.9" height="14" fill="#b91c1c" fill-opacity="0.9"><title>one kernel, shared: victim p99 = 35575.4 ms</title></rect>
<text x="157.1" y="89" font-size="11" font-weight="600" fill="#b91c1c" text-anchor="end">35.6 s</text>
<rect x="368" y="78" width="216.1" height="14" fill="#b91c1c" fill-opacity="0.45"><title>one kernel, shared: hog completed 29719 passes</title></rect>
<text x="590.1" y="89" font-size="11" font-weight="600" fill="#b91c1c">29,719</text>
<text x="352" y="128" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">one kernel, memcg memory.high</text>
<rect x="328.9" y="132" width="23.1" height="14" fill="#a88428" fill-opacity="0.9"><title>one kernel, memcg memory.high: victim p99 = 91 ms</title></rect>
<text x="324.9" y="143" font-size="11" font-weight="600" fill="#a88428" text-anchor="end">91 ms</text>
<rect x="368" y="132" width="2.0" height="14" fill="#a88428" fill-opacity="0.45"><title>one kernel, memcg memory.high: hog completed 10 passes</title></rect>
<text x="376.0" y="143" font-size="11" font-weight="600" fill="#a88428">10</text>
<text x="352" y="182" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">two kernels</text>
<rect x="302.6" y="186" width="49.4" height="14" fill="#2a78d6" fill-opacity="0.9"><title>two kernels: victim p99 = 231.7 ms</title></rect>
<text x="298.6" y="197" font-size="11" font-weight="600" fill="#2a78d6" text-anchor="end">232 ms</text>
<rect x="368" y="186" width="200.0" height="14" fill="#2a78d6" fill-opacity="0.45"><title>two kernels: hog completed 27501 passes</title></rect>
<text x="574.0" y="197" font-size="11" font-weight="600" fill="#2a78d6">27,501</text>
<text x="352" y="252" font-size="11" fill="#9ca3af" text-anchor="end">victim tail latency</text>
<text x="368" y="252" font-size="11" fill="#9ca3af">hog throughput</text>
<line x1="360" y1="68" x2="360" y2="234" stroke="#d1d5db" stroke-width="1"/>
</svg>

## Chasing the Last 4x to DRAM

208 ms against a 53 ms floor still leaves a 4x, and it deserved an explanation rather than a shrug. Two experiments decompose it.

<svg viewBox="0 0 720 320" role="img" aria-label="Decomposing the two-kernel residual: moving hog memory to the other node recovers it, MBA throttling does not" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Where the last 4x lives: DRAM, not the kernel</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">spawn victim p50 (bar) and p99 (tick), milliseconds, linear scale</text>
<line x1="317.9" y1="64" x2="317.9" y2="280" stroke="#e5e7eb" stroke-width="1"/>
<text x="317.9" y="296" font-size="11" fill="#9ca3af" text-anchor="middle">50</text>
<line x1="385.7" y1="64" x2="385.7" y2="280" stroke="#e5e7eb" stroke-width="1"/>
<text x="385.7" y="296" font-size="11" fill="#9ca3af" text-anchor="middle">100</text>
<line x1="453.6" y1="64" x2="453.6" y2="280" stroke="#e5e7eb" stroke-width="1"/>
<text x="453.6" y="296" font-size="11" fill="#9ca3af" text-anchor="middle">150</text>
<line x1="521.4" y1="64" x2="521.4" y2="280" stroke="#e5e7eb" stroke-width="1"/>
<text x="521.4" y="296" font-size="11" fill="#9ca3af" text-anchor="middle">200</text>
<line x1="589.3" y1="64" x2="589.3" y2="280" stroke="#e5e7eb" stroke-width="1"/>
<text x="589.3" y="296" font-size="11" fill="#9ca3af" text-anchor="middle">250</text>
<text x="242" y="95.0" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">two kernels, quiet</text>
<rect x="250" y="82.0" width="71.9" height="18" fill="#6b7280" fill-opacity="0.85"><title>two kernels, quiet: p50 53.0 ms, p99 53.4 ms</title></rect>
<line x1="322.5" y1="79.0" x2="322.5" y2="103.0" stroke="#6b7280" stroke-width="2.5"/>
<text x="328.5" y="95.0" font-size="11" font-weight="600" fill="#6b7280">53 / 53</text>
<text x="242" y="149.0" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">+ hog, same node</text>
<rect x="250" y="136.0" width="282.0" height="18" fill="#2a78d6" fill-opacity="0.85"><title>+ hog, same node: p50 207.8 ms, p99 231.7 ms</title></rect>
<line x1="564.5" y1="133.0" x2="564.5" y2="157.0" stroke="#2a78d6" stroke-width="2.5"/>
<text x="570.5" y="149.0" font-size="11" font-weight="600" fill="#2a78d6">208 / 232</text>
<text x="242" y="203.0" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">+ hog, MBA capped to 10%</text>
<rect x="250" y="190.0" width="286.4" height="18" fill="#7c3aed" fill-opacity="0.85"><title>+ hog, MBA capped to 10%: p50 211.0 ms, p99 247.6 ms</title></rect>
<line x1="586.0" y1="187.0" x2="586.0" y2="211.0" stroke="#7c3aed" stroke-width="2.5"/>
<text x="592.0" y="203.0" font-size="11" font-weight="600" fill="#7c3aed">211 / 248</text>
<text x="242" y="257.0" font-size="11.5" font-weight="600" fill="#374151" text-anchor="end">+ hog, memory on other node</text>
<rect x="250" y="244.0" width="80.3" height="18" fill="#15803d" fill-opacity="0.85"><title>+ hog, memory on other node: p50 59.2 ms, p99 67.0 ms</title></rect>
<line x1="340.9" y1="241.0" x2="340.9" y2="265.0" stroke="#15803d" stroke-width="2.5"/>
<text x="346.9" y="257.0" font-size="11" font-weight="600" fill="#15803d">59 / 67</text>
<text x="440" y="312" font-size="11.5" fill="#6b7280" text-anchor="middle">milliseconds per 128 MB fault cycle</text>
</svg>

First we kept the hog's twenty cores on socket 1 but bound its memory to the other NUMA node, so it no longer touches the victim's DRAM. The victim recovered to 59 ms median, 67 ms p99: 96% of the residual gone. What remains, about 6 ms, is the shared last-level cache and the all-core turbo bins, and that is the entire footprint of twenty screaming cores on the same die. The 4x was DRAM contention on the shared node.

But not bandwidth, and the second experiment proves it. The hog's measured traffic is roughly 10 GB/s against a socket that can move an order of magnitude more; the channel is not full. The victim's fault path suffers latency inflation: the hog's random one-word-per-page strides, plus swap and writeback DMA, destroy DRAM row-buffer locality, so every one of the victim's cache misses waits longer at a controller that is busy, not saturated. So we tried the resource-director knob built for this, MBA, capping the hog's CLOS to 10% memory bandwidth. Nothing moved: the victim held at 211 ms, and the hog's pass rate did not even drop. A latency-bound access pattern with one miss in flight slides completely under a bandwidth-credit throttle. The hardware dial for memory interference does not touch this workload.

The dial that does is placement, and placement is a thing multikernel already owns: which node a kernel instance's memory pool comes from is a first-class parameter of creating one. A pool on the victim's own node, or the socket-aligned layouts from the [cross-socket section of the will-it-scale post](/2026/08/17/multikernel-will-it-scale/), gives the victim a near-floor tail against an unthrottled antagonist, using no throttling at all.

## But a VM Also Has Its Own Kernel

The obvious objection: a virtual machine gives the victim its own kernel too, and VMs are the tool everyone already has. So we ran the same experiment three more ways: the victim inside a KVM guest on the same four cores, 2.4 GB of guest RAM bound to node 1, the same kernel build booted via QEMU's `-kernel`, the same hog on the host. [Our KVM post](/2026/08/16/multikernel-vs-kvm-lmbench/) measured what a guest pays on kernel hot paths; this measures what it pays under a neighbor's memory pressure, and the default answer is worse than not having the VM at all.

| Victim in a KVM guest | p50 | p99 | cycles / 300 s |
|---|---|---|---|
| Quiet host | 58 ms | 96 ms | 4,974 |
| Beside hog, default RAM | starved during its own boot | - | 0 |
| Beside hog, locked RAM, reserved first | 219 ms | 254 ms | 1,484 |
| Two kernels, beside hog (reference) | 208 ms | 232 ms | 1,550 |

The default configuration is the striking row. A guest's "RAM" is nothing special to the host: it is ordinary anonymous memory belonging to the QEMU process, and to a host kernel under reclaim pressure it is the largest, coldest-looking target on the node. The shared-kernel victim at least limped through 49 cycles; the guest never finished booting. Its console shows the kernel still registering key types at t=487 seconds, a step that takes under two seconds on a healthy machine, and our 900-second timeout killed it before the benchmark ever started. A VM boundary without a memory reservation is not isolation from host memory pressure. It is a bull's-eye painted on 2.4 GB.

The fix is to lock the guest's memory, and it is worth being precise about what that means, because it is two separate things. `prealloc` makes QEMU fault in every page of guest RAM at startup, so the memory is physically allocated up front instead of on demand. `mem-lock` then mlocks it, which removes those pages from the host kernel's reclaim lists entirely: they can never be swapped out or reclaimed, whether the guest is using them or not. Together they turn the guest's memory from ordinary evictable process memory into a permanent carve-out of physical RAM.

And the flag has a failure mode the grant does not: timing. When we started the locked VM *after* the hog was already running, QEMU spent its entire 900-second budget trying to fault in and pin 2.4 GB from a node under active reclaim, and never finished. Each page it touched had to win a fight against the hog before it could be locked. That is what "reserved first" means in the table: the reservation must be made while the node is quiet, before the antagonist exists. Boot the locked VM, let it claim its memory, and only then let the neighbor move in. Fleets that sell dedicated memory do operate this way: the reservation is made at VM creation, before any tenant workload exists. But a large share of real virtualization deliberately overcommits memory instead, ballooning and host swap as features, and those fleets are running the unpinned column as a matter of policy. And even for the disciplined, it is a standing constraint: the isolation exists only as long as nobody needs to create or resize a locked guest on a node that is already busy.

Reserved first, the locked VM isolates about as well as the spawn: 219 ms median and 254 ms p99 against the spawn's 208 and 232, both bounded, both beside a hog running at full speed (29,064 passes). The differences are the rent: about 10% more tail under pressure, a quiet-floor p99 twice the spawn's (96 ms against 53, the exit and timer noise widening the distribution), and 2.4 GB of RAM pinned unconditionally for the guest's lifetime. A well-configured VM buys the same escape from the shared kernel; it just pays for it in advance, in cash, and only if the operator knew to configure it.

## What This Does Not Show

Honesty section, as usual. The hog is sized as a worst case: 120% of the node with thin swap is sustained hard overcommit, the failure mode of an unlimited batch job, not the steady state of a well-run fleet. We report the first of two runs of the shared-kernel configuration; the repeat was even worse, a 14-second median and a 58.8-second p99, so the numbers above are the conservative draw. The victim's 128 MB burst amplifies the effect; a steadily-serving process would show the same shape at lower magnitude. The hog's pass counts were initially undercounted by stdio buffering; the numbers above are from a line-buffered rerun, which is why we can say 10 rather than zero. The memcg arm used `memory.high` alone; a `memory.max` cap would OOM-kill the hogs instead of throttling them. And the victim-side comparison is deliberately narrow: one metric, one workload shape, one node. The throughput side of the multikernel story is the previous post's; this one is only about tails.

One more honest note: the two-kernel victim was measured against the hog running on the host kernel, so this is a two-kernel machine in the configuration that matters, victim isolated from antagonist. A fleet of hogs each in its own instance is the same argument applied more times.

The VM arm has its own caveats. The host runs QEMU 4.2 from the distribution, an older build; newer QEMU and tuning (hugepage-backed guests, virtio-balloon policy) could shift the locked guest's numbers some, though nothing about newer QEMU changes what default guest RAM is to the host's reclaim. The two zero-sample guest runs ended at a 900-second timeout rather than running to completion, so "starved during boot" is a lower bound on how bad they are, not a measurement of where they would end up.

## Summary

| Configuration | Victim p50 | Victim p99 | Victim cycles / 300 s | Hog passes |
|---|---|---|---|---|
| One kernel, quiet | 56 ms | 92 ms | 5,100 | n/a |
| One kernel, beside hog | 824 ms | 35.6 s | 49 | 29,719 |
| One kernel, hog under `memory.high` | 58 ms | 91 ms | 4,823 | **10** |
| Two kernels, quiet | 53 ms | 53 ms | 5,671 | n/a |
| **Two kernels, beside hog** | **208 ms** | **232 ms** | **1,550** | **27,501** |
| Two kernels, hog memory on other node | 59 ms | 67 ms | 5,015 | 30,493 |
| Two kernels, hog under MBA 10% | 211 ms | 248 ms | 1,503 | 33,421 |
| KVM guest, quiet | 58 ms | 96 ms | 4,974 | n/a |
| KVM guest beside hog, default RAM | starved during boot | - | 0 | 78,828* |
| KVM guest beside hog, locked RAM reserved first | 219 ms | 254 ms | 1,484 | 29,064 |

*The zero-sample guest run was bounded by a 900-second timeout, so its hog window is longer than the others; the per-minute pass rate is in line with the rest.

## Conclusion

The locks post showed a single kernel converting cores into contention. This post shows it converting neighbors into tail latency, and shows that the built-in remedy is a choice of victim: uncontained, the latency-sensitive task starves under the hog's reclaim; contained, the hog is throttled 3,000x so the latency-sensitive task can breathe. Both outcomes come from the same root, one memory-management machinery arbitrating everything on the machine, and no cgroup boundary changes whose machinery it is.

Two kernels dissolve the choice. The victim's tail stays bounded within a 33 ms band against an antagonist running at full speed, because there is no shared reclaim to entangle them; what interference remains is the DRAM they still share, it yields to placement rather than throttling, and placement is a parameter multikernel sets per instance as a matter of course. The kernel-side interference went to zero. The hardware-side interference went to a knob we hold.

The obvious alternative reaches the same place only by prepayment: a KVM guest with default memory fares worse than the shared kernel, starving during its own boot, and matches the spawn only when its RAM is preallocated, locked, and reserved before the pressure exists, the partition that pays rent, paid in advance. The multikernel instance's grant is the same reservation made structural: it is how instances get memory at all, not a flag an operator has to know about.

You can spend the dial choosing which tenant loses. Or you can stop sharing the kernel.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}. If your p99 has neighbors, we would love to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
