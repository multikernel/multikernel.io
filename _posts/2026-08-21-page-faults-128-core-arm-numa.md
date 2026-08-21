---
layout: post
title: "Scaling Anonymous Page Faults on a 128-Core ARM NUMA Server"
date: 2026-08-21 10:00:00 -0700
categories: [benchmark, linux-kernel, performance, scalability, arm, numa]
author: Cong Wang, Founder and CEO
excerpt: "We measured anonymous page fault throughput with will-it-scale on a 128-core ARM server that exposes four NUMA nodes in a single socket. Within a 32-core node, throughput saturates at roughly 4.5 million operations per second by eight workers, and adding the remaining 24 cores increases kernel CPU time 5.7x without increasing throughput. Across nodes, aggregate throughput scales almost linearly, reaching 18 million operations per second at 128 cores. Node-level scaling is strong; core-level efficiency is about 15%. The two results describe the same system, and the distinction matters for how high-core-count servers should be evaluated."
---

Modern ARM servers are shipping with core counts well beyond what was common a few years ago. At this scale, the core count alone says little about application throughput. NUMA topology, memory-management behavior, and kernel synchronization determine whether additional cores become additional capacity.

This post examines a 128-core ARM server with four NUMA nodes in a single physical socket, using the `page_fault1_processes` test from [will-it-scale](https://github.com/multikernel/will-it-scale){:target="_blank" rel="noopener noreferrer"} to measure how anonymous page fault throughput scales from one worker to all 128 cores. The central finding is that the workload scales poorly from core to core within a NUMA node, but the resulting per-node capacity scales almost linearly as additional nodes are added. Our [previous will-it-scale post](/2026/08/17/multikernel-will-it-scale/) characterized the scaling wall on a 48-core x86 system and measured a multikernel split against it. This post is a single-kernel study on a different architecture with a considerably larger NUMA node, and it establishes where that wall stands on ARM.

## Hardware Topology

The test system has 128 cores in one physical socket, organized as four NUMA nodes of 32 cores and approximately 64 GB of memory each. It runs the stock Ubuntu 7.0 kernel with no patches or tuning; every result below is what the distribution kernel does out of the box.

```
NUMA node 0: CPUs   0-31
NUMA node 1: CPUs  32-63
NUMA node 2: CPUs  64-95
NUMA node 3: CPUs 96-127
```

Although the system contains only one socket, the processor exposes four NUMA domains. This topology is increasingly common in high-core-count parts, where a single package contains multiple compute dies, memory controllers, and interconnect segments. The NUMA distance matrix confirms a genuine internal hierarchy:

```
       0   1   2   3
0:    10  11  11  12
1:    11  10  12  11
2:    11  12  10  11
3:    12  11  11  10
```

A distance of 10 is local memory. Remote nodes report 11 or 12, so the processor distinguishes more than one tier of remote locality within the socket. These are relative topology costs rather than measured latencies, but they establish that the system is not a uniform 128-core machine.

## Benchmark Method

`page_fault1_processes` has each worker map anonymous memory and touch it page by page. Every iteration passes through the fault handler, the page allocator, page zeroing, page table updates, memcg and per-node accounting, and LRU insertion. In processes mode, workers share nothing in userspace: each has its own address space and its own mappings. Any failure to scale is therefore inside the kernel.

Each run lasted 30 seconds. CPU placement was controlled with `taskset`, and the larger masks were chosen to align exactly with NUMA boundaries:

```bash
taskset -c 0-7    ./page_fault1_processes -s 30 -t 8
taskset -c 0-31   ./page_fault1_processes -s 30 -t 32    # node 0
taskset -c 0-63   ./page_fault1_processes -s 30 -t 64    # nodes 0-1
taskset -c 0-95   ./page_fault1_processes -s 30 -t 96    # nodes 0-2
taskset -c 0-127  ./page_fault1_processes -s 30 -t 128   # nodes 0-3
```

This design separates two questions: how the workload scales as cores are added within one NUMA node, and how aggregate throughput scales as additional nodes are brought online. The answers differ substantially.

## Scaling Within One NUMA Node

The first experiment restricted execution to node 0, with 32 cores available:

| Workers | Throughput | Speedup vs 1 | Efficiency |
|---:|---:|---:|---:|
| 1 | 0.91 M ops/s | 1.00x | 100% |
| 2 | 1.74 M ops/s | 1.91x | 96% |
| 4 | 3.15 M ops/s | 3.46x | 87% |
| 8 | **4.64 M ops/s** | 5.10x | 64% |
| 16 | 4.58 M ops/s | 5.03x | 31% |
| 24 | 4.53 M ops/s | 4.98x | 21% |
| 32 | **4.46 M ops/s** | 4.90x | **15%** |

<svg viewBox="0 0 720 400" role="img" aria-label="Anonymous page fault throughput on one 32-core NUMA node rises from 0.91 million per second at one worker to 4.64 million at eight, then flattens at 4.5 million through 32 workers" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">One NUMA node, 32 cores: the ceiling is at eight workers</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">page_fault1_processes, taskset to CPUs 0-31 · one worker per core, 30 second runs</text>
<line x1="56" y1="294.0" x2="600" y2="294.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="298.0" font-size="11" fill="#9ca3af" text-anchor="end">1 M</text>
<line x1="56" y1="248.0" x2="600" y2="248.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="252.0" font-size="11" fill="#9ca3af" text-anchor="end">2 M</text>
<line x1="56" y1="202.0" x2="600" y2="202.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="206.0" font-size="11" fill="#9ca3af" text-anchor="end">3 M</text>
<line x1="56" y1="156.0" x2="600" y2="156.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="160.0" font-size="11" fill="#9ca3af" text-anchor="end">4 M</text>
<line x1="56" y1="110.0" x2="600" y2="110.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="114.0" font-size="11" fill="#9ca3af" text-anchor="end">5 M</text>
<line x1="56" y1="64.0" x2="600" y2="64.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="68.0" font-size="11" fill="#9ca3af" text-anchor="end">6 M</text>
<line x1="56" y1="340" x2="600" y2="340" stroke="#9ca3af" stroke-width="1"/>
<text x="56.0" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="146.7" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">2</text>
<text x="237.3" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">4</text>
<text x="328.0" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">8</text>
<text x="418.7" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">16</text>
<text x="509.3" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">24</text>
<text x="600.0" y="358" font-size="11" fill="#9ca3af" text-anchor="middle">32</text>
<text x="328.0" y="378" font-size="11.5" fill="#6b7280" text-anchor="middle">workers (one per core)</text>
<text x="56.0" y="77.8" font-size="11" fill="#6b7280">perfect scaling would reach 29 M at 32 workers</text>
<polyline points="56.0,298.1 146.7,260.0 237.3,195.1 328.0,126.6 418.7,129.3 509.3,131.6 600.0,134.8" fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="56.0" cy="298.1" r="3.5" fill="#7c3aed"/>
<text x="56.0" y="288.1" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">0.91</text>
<circle cx="146.7" cy="260.0" r="3.5" fill="#7c3aed"/>
<text x="146.7" y="250.0" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">1.74</text>
<circle cx="237.3" cy="195.1" r="3.5" fill="#7c3aed"/>
<text x="237.3" y="185.1" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">3.15</text>
<circle cx="328.0" cy="126.6" r="3.5" fill="#7c3aed"/>
<text x="328.0" y="116.6" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">4.64</text>
<circle cx="418.7" cy="129.3" r="3.5" fill="#7c3aed"/>
<text x="418.7" y="147.3" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">4.58</text>
<circle cx="509.3" cy="131.6" r="3.5" fill="#7c3aed"/>
<text x="509.3" y="149.6" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">4.53</text>
<circle cx="600.0" cy="134.8" r="3.5" fill="#7c3aed"/>
<text x="600.0" y="152.8" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">4.46</text>
<text x="509.3" y="102.7" font-size="12" font-weight="600" fill="#be123c" text-anchor="middle">24 more cores, zero more throughput</text>
</svg>

Scaling from one to eight workers is reasonable: throughput rises from 0.91 million to 4.64 million operations per second, with efficiency declining but the curve still climbing. Beyond eight workers the behavior changes. Sixteen workers deliver 4.58 million, 24 deliver 4.53 million, and 32 deliver 4.46 million. The additional 24 cores contribute no throughput, and the curve declines slightly. With the node fully occupied, the workload reaches about 15% of ideal linear per-core scaling.

For this workload, a 32-core NUMA node does not behave like 32 independently scalable cores. Anonymous page fault throughput reaches a ceiling at approximately eight workers.

## Scaling Across NUMA Nodes

The second experiment widened the CPU mask one node at a time:

| Workers | NUMA nodes | Throughput | vs 32 workers |
|---:|---:|---:|---:|
| 32 | 1 | 4.46 M ops/s | 1.00x |
| 64 | 2 | 8.95 M ops/s | 2.00x |
| 96 | 3 | 13.49 M ops/s | 3.02x |
| 128 | 4 | 17.99 M ops/s | 4.03x |

<svg viewBox="0 0 720 420" role="img" aria-label="Throughput across all 128 cores climbs in four steps of about 4.5 million per second, one step per NUMA node, reaching 18 million at 128 workers" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Four NUMA nodes: throughput scales by the node, not by the core</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">page_fault1_processes, taskset widened one NUMA node at a time · shaded bands are NUMA nodes 0 to 3</text>
<rect x="56.0" y="64" width="146.0" height="286" fill="#2a78d6" opacity="0.07"/>
<text x="129.0" y="78" font-size="11" font-weight="600" fill="#2a78d6" text-anchor="middle">node 0</text>
<rect x="202.0" y="64" width="146.0" height="286" fill="#15803d" opacity="0.07"/>
<text x="275.0" y="78" font-size="11" font-weight="600" fill="#15803d" text-anchor="middle">node 1</text>
<rect x="348.0" y="64" width="146.0" height="286" fill="#d97706" opacity="0.07"/>
<text x="421.0" y="78" font-size="11" font-weight="600" fill="#d97706" text-anchor="middle">node 2</text>
<rect x="494.0" y="64" width="146.0" height="286" fill="#0f766e" opacity="0.07"/>
<text x="567.0" y="78" font-size="11" font-weight="600" fill="#0f766e" text-anchor="middle">node 3</text>
<line x1="56" y1="278.5" x2="640" y2="278.5" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="282.5" font-size="11" fill="#9ca3af" text-anchor="end">5 M</text>
<line x1="56" y1="207.0" x2="640" y2="207.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="211.0" font-size="11" fill="#9ca3af" text-anchor="end">10 M</text>
<line x1="56" y1="135.5" x2="640" y2="135.5" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="139.5" font-size="11" fill="#9ca3af" text-anchor="end">15 M</text>
<line x1="56" y1="64.0" x2="640" y2="64.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="68.0" font-size="11" fill="#9ca3af" text-anchor="end">20 M</text>
<line x1="56" y1="350" x2="640" y2="350" stroke="#9ca3af" stroke-width="1"/>
<text x="60.6" y="368" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="202.0" y="368" font-size="11" fill="#9ca3af" text-anchor="middle">32</text>
<text x="348.0" y="368" font-size="11" fill="#9ca3af" text-anchor="middle">64</text>
<text x="494.0" y="368" font-size="11" fill="#9ca3af" text-anchor="middle">96</text>
<text x="640.0" y="368" font-size="11" fill="#9ca3af" text-anchor="middle">128</text>
<text x="348.0" y="388" font-size="11.5" fill="#6b7280" text-anchor="middle">workers (one per core)</text>
<polyline points="60.6,337.0 65.1,325.1 74.2,305.0 92.5,283.6 129.0,284.5 165.5,285.2 202.0,286.2 348.0,222.0 494.0,157.1 640.0,92.7" fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="60.6" cy="337.0" r="3.5" fill="#7c3aed"/>
<circle cx="65.1" cy="325.1" r="3.5" fill="#7c3aed"/>
<circle cx="74.2" cy="305.0" r="3.5" fill="#7c3aed"/>
<circle cx="92.5" cy="283.6" r="3.5" fill="#7c3aed"/>
<circle cx="129.0" cy="284.5" r="3.5" fill="#7c3aed"/>
<circle cx="165.5" cy="285.2" r="3.5" fill="#7c3aed"/>
<circle cx="202.0" cy="286.2" r="3.5" fill="#7c3aed"/>
<circle cx="348.0" cy="222.0" r="3.5" fill="#7c3aed"/>
<circle cx="494.0" cy="157.1" r="3.5" fill="#7c3aed"/>
<circle cx="640.0" cy="92.7" r="3.5" fill="#7c3aed"/>
<text x="340.0" y="212.0" font-size="11.5" font-weight="600" fill="#7c3aed" text-anchor="end">8.95 M</text>
<text x="340.0" y="226.0" font-size="10.5" fill="#be123c" text-anchor="end">15% of ideal</text>
<text x="486.0" y="147.1" font-size="11.5" font-weight="600" fill="#7c3aed" text-anchor="end">13.49 M</text>
<text x="486.0" y="161.1" font-size="10.5" fill="#be123c" text-anchor="end">15% of ideal</text>
<text x="632.0" y="82.7" font-size="11.5" font-weight="600" fill="#7c3aed" text-anchor="end">17.99 M</text>
<text x="632.0" y="96.7" font-size="10.5" fill="#be123c" text-anchor="end">15% of ideal</text>
<text x="138.1" y="260.2" font-size="11.5" font-weight="600" fill="#7c3aed" text-anchor="middle">4.46 M</text>
<text x="138.1" y="273.2" font-size="10.5" fill="#be123c" text-anchor="middle">15% of ideal</text>
<text x="275.0" y="320.2" font-size="11.5" fill="#6b7280" text-anchor="middle">+4.5 M per node</text>
</svg>

Relative to the saturated single-node result, two nodes deliver 2.00x, three deliver 3.02x, and four deliver 4.03x. Aggregate throughput increases almost exactly with the number of NUMA nodes, each contributing approximately 4.5 million operations per second largely independently of the others.

This should not be read as linear 128-core scaling. The unit that scales is the NUMA node, and each node has already lost most of its per-core efficiency before it joins the aggregate. Against the 0.91 million single-worker baseline:

| Workers | Ideal (0.91 M x N) | Actual | Efficiency |
|---:|---:|---:|---:|
| 32 | ~29 M | 4.46 M | **15%** |
| 64 | ~58 M | 8.95 M | **15%** |
| 96 | ~87 M | 13.49 M | **15%** |
| 128 | ~116 M | 17.99 M | **15%** |

Throughput scales almost linearly from 32 to 128 workers while overall efficiency remains at roughly 15% throughout. There is no contradiction: the system adds approximately 4.5 million operations per second for every 32 cores. Measured per NUMA domain, that is strong scaling. Measured per core, it is not.

## Below the Throughput Numbers

To characterize the saturation point, `perf stat` was used to compare eight workers against 32 on node 0:

| | 8 workers | 32 workers |
|---|---:|---:|
| CPUs utilized | 8.0 | 31.9 |
| Page faults completed | 165.4 M | 162.9 M |
| System CPU time | 200.0 s | 1146.5 s |
| Wall time | 36.0 s | 36.1 s |
| IPC | 1.8 | 1.7 |

Four times as many CPUs complete essentially the same number of page faults while consuming 5.7x the system CPU time. Per completed fault, system time rises from approximately 1.2 microseconds to 7.0 microseconds. The additional cores are fully utilized but contribute no useful work; they execute kernel code that exists only because of the added concurrency. IPC is nearly unchanged, which argues against a simple memory-bandwidth stall: the cores retire instructions at a normal rate, but the instructions are synchronization and accounting rather than fault handling.

A kernel-only `perf` profile of the 32-worker case identifies where that time goes:

<svg viewBox="0 0 720 270" role="img" aria-label="Kernel profile at 32 workers: spin unlock 22.9 percent, clear page 17.1 percent, node state accounting 5.3 percent, spin lock 5.0 percent, memcg lruvec state 4.9 percent" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Where 32 workers spend their time in the kernel</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">perf record, kernel only, 32 workers on NUMA node 0 · top five symbols by samples</text>
<text x="240" y="80" font-size="12" fill="#1f2937" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">_raw_spin_unlock_irqrestore</text>
<rect x="250" y="66" width="366.2" height="20" fill="#be123c" rx="2"/>
<text x="624.2" y="80" font-size="12" font-weight="600" fill="#1f2937">22.89%</text>
<text x="240" y="114" font-size="12" fill="#1f2937" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">__pi_clear_page</text>
<rect x="250" y="100" width="273.8" height="20" fill="#2a78d6" rx="2"/>
<text x="531.8" y="114" font-size="12" font-weight="600" fill="#1f2937">17.11%</text>
<text x="240" y="148" font-size="12" fill="#1f2937" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">mod_node_state</text>
<rect x="250" y="134" width="85.4" height="20" fill="#d97706" rx="2"/>
<text x="343.4" y="148" font-size="12" font-weight="600" fill="#1f2937">5.34%</text>
<text x="240" y="182" font-size="12" fill="#1f2937" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">_raw_spin_lock</text>
<rect x="250" y="168" width="79.4" height="20" fill="#be123c" rx="2"/>
<text x="337.4" y="182" font-size="12" font-weight="600" fill="#1f2937">4.96%</text>
<text x="240" y="216" font-size="12" fill="#1f2937" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">mod_memcg_lruvec_state</text>
<rect x="250" y="202" width="78.2" height="20" fill="#d97706" rx="2"/>
<text x="336.2" y="216" font-size="12" font-weight="600" fill="#1f2937">4.89%</text>
<rect x="250" y="238" width="14" height="10" fill="#be123c"/><text x="270" y="247" font-size="11" fill="#6b7280">spinlock</text>
<rect x="350" y="238" width="14" height="10" fill="#d97706"/><text x="370" y="247" font-size="11" fill="#6b7280">MM accounting</text>
<rect x="490" y="238" width="14" height="10" fill="#2a78d6"/><text x="510" y="247" font-size="11" fill="#6b7280">useful work (zeroing)</text>
</svg>

Further down the profile are the remaining memory-management functions: `lruvec_stat_mod_folio`, `folio_remove_rmap_ptes`, `count_memcg_events`, `handle_mm_fault`, `do_page_fault`, `__alloc_frozen_pages_noprof`, and `get_page_from_freelist`.

Lock profiles require some care. A sample attributed to `_raw_spin_unlock_irqrestore` reflects where the CPU was when the sampling interrupt was delivered, which on ARM includes the point where interrupts are re-enabled after a critical section, so part of that 23% is time deferred from inside the lock rather than time spent waiting for it. Inlining and attribution affect the rest. Even so, the shape is clear: over a quarter of kernel samples land on spinlock primitives, roughly a tenth on memcg and per-node statistics, and the one unambiguously useful symbol, `__pi_clear_page`, accounts for 17%.

The evidence points to a kernel-side scalability bottleneck in the memory-management path rather than exhaustion of CPU capacity. Identifying the specific shared structure would require further profiling; the usual candidates are the allocator's zone lock, the LRU lock, and the per-node and per-memcg counters updated on every fault.

## Interpreting the Results

<svg viewBox="0 0 720 300" role="img" aria-label="Block diagram: one 128-core socket contains four NUMA nodes of 32 CPUs, each saturating at about 4.5 million page faults per second, summing to about 18 million" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">What the hardware is, versus what the kernel sees</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">one socket, four NUMA domains, four independent ceilings</text>
<rect x="40" y="60" width="640" height="150" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="6,4" rx="6"/>
<text x="52" y="78" font-size="11.5" fill="#6b7280">one socket · 128 cores</text>
<rect x="60" y="90" width="140" height="100" fill="#2a78d6" opacity="0.12" rx="4"/>
<rect x="60" y="90" width="140" height="100" fill="none" stroke="#2a78d6" stroke-width="1.5" rx="4"/>
<text x="130" y="115" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">NUMA node 0</text>
<text x="130" y="135" font-size="11.5" fill="#1f2937" text-anchor="middle">CPUs 0-31 · 64 GB</text>
<text x="130" y="160" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">ceiling ~4.5 M/s</text>
<text x="130" y="178" font-size="11" fill="#be123c" text-anchor="middle">reached at 8 of 32 cores</text>
<line x1="130" y1="210" x2="130" y2="240" stroke="#9ca3af" stroke-width="1.5"/>
<rect x="215" y="90" width="140" height="100" fill="#15803d" opacity="0.12" rx="4"/>
<rect x="215" y="90" width="140" height="100" fill="none" stroke="#15803d" stroke-width="1.5" rx="4"/>
<text x="285" y="115" font-size="13" font-weight="600" fill="#15803d" text-anchor="middle">NUMA node 1</text>
<text x="285" y="135" font-size="11.5" fill="#1f2937" text-anchor="middle">CPUs 32-63 · 64 GB</text>
<text x="285" y="160" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">ceiling ~4.5 M/s</text>
<text x="285" y="178" font-size="11" fill="#be123c" text-anchor="middle">reached at 8 of 32 cores</text>
<line x1="285" y1="210" x2="285" y2="240" stroke="#9ca3af" stroke-width="1.5"/>
<rect x="370" y="90" width="140" height="100" fill="#d97706" opacity="0.12" rx="4"/>
<rect x="370" y="90" width="140" height="100" fill="none" stroke="#d97706" stroke-width="1.5" rx="4"/>
<text x="440" y="115" font-size="13" font-weight="600" fill="#d97706" text-anchor="middle">NUMA node 2</text>
<text x="440" y="135" font-size="11.5" fill="#1f2937" text-anchor="middle">CPUs 64-95 · 64 GB</text>
<text x="440" y="160" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">ceiling ~4.5 M/s</text>
<text x="440" y="178" font-size="11" fill="#be123c" text-anchor="middle">reached at 8 of 32 cores</text>
<line x1="440" y1="210" x2="440" y2="240" stroke="#9ca3af" stroke-width="1.5"/>
<rect x="525" y="90" width="140" height="100" fill="#0f766e" opacity="0.12" rx="4"/>
<rect x="525" y="90" width="140" height="100" fill="none" stroke="#0f766e" stroke-width="1.5" rx="4"/>
<text x="595" y="115" font-size="13" font-weight="600" fill="#0f766e" text-anchor="middle">NUMA node 3</text>
<text x="595" y="135" font-size="11.5" fill="#1f2937" text-anchor="middle">CPUs 96-127 · 64 GB</text>
<text x="595" y="160" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">ceiling ~4.5 M/s</text>
<text x="595" y="178" font-size="11" fill="#be123c" text-anchor="middle">reached at 8 of 32 cores</text>
<line x1="595" y1="210" x2="595" y2="240" stroke="#9ca3af" stroke-width="1.5"/>
<line x1="130" y1="240" x2="595" y2="240" stroke="#9ca3af" stroke-width="1.5"/>
<line x1="360" y1="240" x2="360" y2="262" stroke="#9ca3af" stroke-width="1.5"/>
<polygon points="354,260 366,260 360,270" fill="#9ca3af"/>
<text x="360" y="290" font-size="13" font-weight="600" fill="#1f2937" text-anchor="middle">~18 M page faults/s from 128 cores: 15% of what 128 × one core would be</text>
</svg>

Physically, the system is one socket with 128 cores. For workloads that exercise kernel memory management, allocation, or shared kernel state, a more useful description is four domains of 32 cores, within each of which the kernel makes effective use of roughly eight. The second description predicts the benchmark results; the first does not.

The experiment also shows why measuring only the endpoints is insufficient. One worker at 0.91 million and 128 workers at 17.99 million is a 20x speedup, and the obvious conclusion is simply that the workload scales poorly. The intermediate points reveal the structure:

| Range | Behavior |
|---|---|
| 1 to 8 workers | core-level scaling |
| 8 to 32 workers | node saturation; CPU time up 5.7x, throughput flat |
| 32 to 64 workers | second NUMA node adds ~4.5 M |
| 64 to 96 workers | third node adds ~4.5 M |
| 96 to 128 workers | fourth node adds ~4.5 M |

The NUMA boundaries explain why throughput resumes growing after the first node has saturated. Whatever is contended is largely per node, so each additional node brings a fresh instance of it. That is a useful clue in itself: the contention has a locality, and the locality is the NUMA domain.

## Conclusion

The statement "the server scales" is incomplete without a unit. On this system, scaling at the core level stops at roughly eight workers per NUMA node. At the node level, each additional node contributes approximately 4.5 million operations per second, almost perfectly linearly. At the system level, 128 cores reach 18 million operations per second, about 15% of the single-worker rate multiplied out. All three statements describe the same run.

For performance engineering on high-core-count hardware, the practical lesson is to evaluate scalability against the NUMA topology rather than the total core count. A worker sweep should cross every node boundary, because those boundaries are where the curve changes shape. A single 128-core measurement reports how fast the machine is; measurements at 8, 32, 64, 96, and 128 workers report where that throughput comes from and where it is lost.

For multikernel, this is the relevant baseline. The x86 study showed that when a kernel's shared state is the limit, partitioning the cores between kernels partitions the limit with them. On this system the hardware already defines four partitions, and the kernel's contention respects them closely enough to scale by node. One kernel per NUMA node is the natural configuration to test on this machine, and it is the next experiment. We have not run it yet and make no claim about it here. What this post establishes is the number any such configuration must improve on: approximately 4.5 million operations per second per node, with eight of 32 cores doing useful work.

## Reproducing the Measurement

The method does not depend on this hardware. Build will-it-scale, read the NUMA map from `lscpu` or `numactl -H`, and sweep [`page_fault1_processes`](https://github.com/multikernel/will-it-scale/blob/master/tests/page_fault1.c){:target="_blank" rel="noopener noreferrer"} with `taskset` masks that fill one node first and then add nodes whole. Run `perf stat` at the knee and at the full node width, and `perf record` on the saturated case. Absolute numbers will vary with core count and kernel version (ours is the stock Ubuntu 7.0 kernel); the two-regime shape of the curve follows from where the kernel's shared state lives and should not.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}. If you are evaluating high-core-count servers and would like to discuss these results, contact us at [contact@multikernel.io](mailto:contact@multikernel.io).
