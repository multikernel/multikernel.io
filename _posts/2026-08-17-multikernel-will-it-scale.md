---
layout: post
title: "The Fastest Lock Is One You Don't Share: Linux's Scaling Wall"
date: 2026-08-17 10:00:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, scalability]
author: Cong Wang, Founder and CEO
excerpt: "We pointed will-it-scale at a 48-core Xeon and watched a single Linux kernel bend under its own locks: unlink throughput at 48 cores is 40% of what one core delivers alone, and open() stops scaling at 8 cores no matter how many more you add. Then we held the hardware constant and changed one thing: the same 24 cores, split between two multikernel instances instead of managed by one kernel. Result: 2.6x the unlinks, with the control benchmarks moving by at most 1% to prove nothing else did. The locks did not get faster. They stopped being shared."
---

Every year the core counts go up, and every year the same quiet assumption ships with them: that the operating system underneath will spread across those cores like water. It will not. A single Linux kernel is a single shared data structure at heart, and some of its locks are load-bearing walls. You cannot tune them away, because they are not misconfigurations. They are the architecture.

Here is the sharpest number we measured. On a 48-core Xeon, one process doing creat and unlink in a directory sustains 467,000 operations per second. Forty-eight processes, each on its own dedicated core, each working on its **own file**, sustain 188,000 between them. Not per process. Total. Every core you add past the first makes the machine slower at this job, until 48 cores deliver 40% of what one core managed alone.

This post does four things. It measures that wall with [will-it-scale](https://github.com/antonblanchard/will-it-scale){:target="_blank" rel="noopener noreferrer"}, the community's standard scalability microbenchmark, the same one Intel's 0-day robot uses to report kernel regressions. It names the locks responsible. It walks around the wall the only way that works: holding the hardware exactly constant and splitting one kernel into two. And it stretches the wall across the socket boundary, where it grows taller and the same split pays twice as much. Running alongside all four are the benchmarks that should not move, and do not, because a mechanism claim that cannot fail is not a claim.

## One Kernel, 48 Cores: The Wall

The machine is the same dual-socket Intel Xeon Gold 5418Y from [our KVM comparison](/2026/08/16/multikernel-vs-kvm-lmbench/): 24 cores per socket, SMT disabled, 128 GB of RAM split evenly across two NUMA nodes. will-it-scale runs one benchmark loop in N processes, each pinned to its own dedicated core, and reports the summed throughput as N grows; it fills socket 0 first, so every curve below is socket-local through 24 tasks. Processes mode is deliberately the easy case for the kernel: no shared address space, no shared file descriptors, nothing shared in userspace at all. Whatever refuses to scale is shared inside the kernel. Every number in this post is processes mode unless a section says otherwise; the threads-mode results answer a different question and get their own section near the end. We ran ten tests:

| Test | Each task's loop | Kernel state actually shared |
|---|---|---|
| getppid1 | trivial syscall | nothing (our control) |
| futex4 | lock/unlock a private futex | nothing in practice |
| poll2 | poll private file descriptors | nothing in practice |
| tcp_rr1 | TCP ping-pong, own loopback connection | nothing in practice |
| udp1 | UDP ping-pong, own socket pair | nothing in practice |
| page_fault1 | fault in 128 MB, page by page | allocator, LRU |
| mmap1 | map and unmap 128 MB | commit accounting |
| tcp_conn1 | connect/accept/close, own listener | connection hashes, port search |
| open1 | open/close its own file | security label, dcache |
| unlink1 | creat/unlink its own file | parent directory's `i_rwsem` |

Run the sweep on the single kernel and the ten tests split cleanly into three families.

<svg viewBox="0 0 720 480" role="img" aria-label="Throughput speedup vs task count on one 48-core Linux kernel; getppid1 scales 35x while unlink1 falls to 0.4x of a single task" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">One kernel, 48 cores: speedup over a single task</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">will-it-scale, processes mode, one task per core · dashed line = perfect scaling</text>
<line x1="56" y1="334.0" x2="596" y2="334.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="338.0" font-size="11" fill="#9ca3af" text-anchor="end">12×</text>
<line x1="56" y1="244.0" x2="596" y2="244.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="248.0" font-size="11" fill="#9ca3af" text-anchor="end">24×</text>
<line x1="56" y1="154.0" x2="596" y2="154.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="158.0" font-size="11" fill="#9ca3af" text-anchor="end">36×</text>
<line x1="56" y1="64.0" x2="596" y2="64.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="68.0" font-size="11" fill="#9ca3af" text-anchor="end">48×</text>
<line x1="56" y1="424" x2="596" y2="424" stroke="#9ca3af" stroke-width="1"/>
<text x="56.0" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="136.4" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">8</text>
<text x="228.3" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">16</text>
<text x="320.3" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">24</text>
<text x="412.2" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">32</text>
<text x="504.1" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">40</text>
<text x="596.0" y="442" font-size="11" fill="#9ca3af" text-anchor="middle">48</text>
<text x="326" y="460" font-size="11.5" fill="#6b7280" text-anchor="middle">tasks (= busy cores)</text>
<line x1="56.0" y1="416.5" x2="596.0" y2="64.0" stroke="#a88428" stroke-width="1.5" stroke-dasharray="6 5"/>
<text x="496.1" y="112.8" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">perfect scaling</text>
<polyline points="56.0,416.5 67.5,409.0 90.5,394.0 136.4,364.1 182.4,343.4 228.3,324.3 320.3,291.2 412.2,231.5 504.1,188.7 596.0,158.5" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>getppid1: trivial syscall, no shared state (control). 48 tasks = 35.4x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#2a78d6"/>
<circle cx="67.5" cy="409.0" r="2.5" fill="#2a78d6"/>
<circle cx="90.5" cy="394.0" r="2.5" fill="#2a78d6"/>
<circle cx="136.4" cy="364.1" r="2.5" fill="#2a78d6"/>
<circle cx="182.4" cy="343.4" r="2.5" fill="#2a78d6"/>
<circle cx="228.3" cy="324.3" r="2.5" fill="#2a78d6"/>
<circle cx="320.3" cy="291.2" r="2.5" fill="#2a78d6"/>
<circle cx="412.2" cy="231.5" r="2.5" fill="#2a78d6"/>
<circle cx="504.1" cy="188.7" r="2.5" fill="#2a78d6"/>
<circle cx="596.0" cy="158.5" r="2.5" fill="#2a78d6"/>
<polyline points="56.0,416.5 67.5,410.1 90.5,393.1 136.4,375.1 182.4,359.7 228.3,337.8 320.3,330.5 412.2,289.9 504.1,255.7 596.0,232.3" fill="none" stroke="#15803d" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>mmap1: mmap+munmap 128MB anonymous. 48 tasks = 25.6x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#15803d"/>
<circle cx="67.5" cy="410.1" r="2.5" fill="#15803d"/>
<circle cx="90.5" cy="393.1" r="2.5" fill="#15803d"/>
<circle cx="136.4" cy="375.1" r="2.5" fill="#15803d"/>
<circle cx="182.4" cy="359.7" r="2.5" fill="#15803d"/>
<circle cx="228.3" cy="337.8" r="2.5" fill="#15803d"/>
<circle cx="320.3" cy="330.5" r="2.5" fill="#15803d"/>
<circle cx="412.2" cy="289.9" r="2.5" fill="#15803d"/>
<circle cx="504.1" cy="255.7" r="2.5" fill="#15803d"/>
<circle cx="596.0" cy="232.3" r="2.5" fill="#15803d"/>
<polyline points="56.0,416.5 67.5,410.2 90.5,400.6 136.4,392.4 182.4,389.5 228.3,385.3 320.3,367.7 412.2,336.7 504.1,329.7 596.0,312.5" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>page_fault1: fault in 128MB, page by page. 48 tasks = 14.9x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#7c3aed"/>
<circle cx="67.5" cy="410.2" r="2.5" fill="#7c3aed"/>
<circle cx="90.5" cy="400.6" r="2.5" fill="#7c3aed"/>
<circle cx="136.4" cy="392.4" r="2.5" fill="#7c3aed"/>
<circle cx="182.4" cy="389.5" r="2.5" fill="#7c3aed"/>
<circle cx="228.3" cy="385.3" r="2.5" fill="#7c3aed"/>
<circle cx="320.3" cy="367.7" r="2.5" fill="#7c3aed"/>
<circle cx="412.2" cy="336.7" r="2.5" fill="#7c3aed"/>
<circle cx="504.1" cy="329.7" r="2.5" fill="#7c3aed"/>
<circle cx="596.0" cy="312.5" r="2.5" fill="#7c3aed"/>
<polyline points="56.0,416.5 67.5,409.9 90.5,396.9 136.4,374.4 182.4,358.4 228.3,343.9 320.3,327.3 412.2,338.1 504.1,335.9 596.0,334.7" fill="none" stroke="#0f766e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>tcp_conn1: connect/accept/close to its own loopback listener. Peaks at 24 tasks; 48 tasks = 11.9x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#0f766e"/>
<circle cx="67.5" cy="409.9" r="2.5" fill="#0f766e"/>
<circle cx="90.5" cy="396.9" r="2.5" fill="#0f766e"/>
<circle cx="136.4" cy="374.4" r="2.5" fill="#0f766e"/>
<circle cx="182.4" cy="358.4" r="2.5" fill="#0f766e"/>
<circle cx="228.3" cy="343.9" r="2.5" fill="#0f766e"/>
<circle cx="320.3" cy="327.3" r="2.5" fill="#0f766e"/>
<circle cx="412.2" cy="338.1" r="2.5" fill="#0f766e"/>
<circle cx="504.1" cy="335.9" r="2.5" fill="#0f766e"/>
<circle cx="596.0" cy="334.7" r="2.5" fill="#0f766e"/>
<polyline points="56.0,416.5 67.5,411.8 90.5,399.6 136.4,387.8 182.4,388.3 228.3,388.2 320.3,388.0 412.2,393.4 504.1,392.4 596.0,392.4" fill="none" stroke="#d97706" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>open1: open/close own file, shared /tmp. 48 tasks = 4.2x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#d97706"/>
<circle cx="67.5" cy="411.8" r="2.5" fill="#d97706"/>
<circle cx="90.5" cy="399.6" r="2.5" fill="#d97706"/>
<circle cx="136.4" cy="387.8" r="2.5" fill="#d97706"/>
<circle cx="182.4" cy="388.3" r="2.5" fill="#d97706"/>
<circle cx="228.3" cy="388.2" r="2.5" fill="#d97706"/>
<circle cx="320.3" cy="388.0" r="2.5" fill="#d97706"/>
<circle cx="412.2" cy="393.4" r="2.5" fill="#d97706"/>
<circle cx="504.1" cy="392.4" r="2.5" fill="#d97706"/>
<circle cx="596.0" cy="392.4" r="2.5" fill="#d97706"/>
<polyline points="56.0,416.5 67.5,416.0 90.5,416.5 136.4,416.7 182.4,417.6 228.3,418.3 320.3,419.2 412.2,420.3 504.1,420.7 596.0,421.0" fill="none" stroke="#be123c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>unlink1: creat+unlink own file, shared /tmp. 48 tasks = 0.4x of one task</title></polyline>
<circle cx="56.0" cy="416.5" r="2.5" fill="#be123c"/>
<circle cx="67.5" cy="416.0" r="2.5" fill="#be123c"/>
<circle cx="90.5" cy="416.5" r="2.5" fill="#be123c"/>
<circle cx="136.4" cy="416.7" r="2.5" fill="#be123c"/>
<circle cx="182.4" cy="417.6" r="2.5" fill="#be123c"/>
<circle cx="228.3" cy="418.3" r="2.5" fill="#be123c"/>
<circle cx="320.3" cy="419.2" r="2.5" fill="#be123c"/>
<circle cx="412.2" cy="420.3" r="2.5" fill="#be123c"/>
<circle cx="504.1" cy="420.7" r="2.5" fill="#be123c"/>
<circle cx="596.0" cy="421.0" r="2.5" fill="#be123c"/>
<text x="604" y="162.5" font-size="12" font-weight="600" fill="#2a78d6">getppid1 35.4×</text>
<text x="604" y="236.3" font-size="12" font-weight="600" fill="#15803d">mmap1 25.6×</text>
<text x="604" y="316.5" font-size="12" font-weight="600" fill="#7c3aed">page_fault1 14.9×</text>
<text x="604" y="338.7" font-size="12" font-weight="600" fill="#0f766e">tcp_conn1 11.9×</text>
<text x="604" y="396.4" font-size="12" font-weight="600" fill="#d97706">open1 4.2×</text>
<text x="604" y="425.0" font-size="12" font-weight="600" fill="#be123c">unlink1 0.40×</text>
</svg>

The control behaves like a control: getppid1 reaches 35.4x at 48 cores, and the shortfall from 48x is the hardware's all-core turbo bins, not the kernel; futex4 and poll2 land within a point of the same curve. These three lines are the proof that the machine itself scales, which converts every flat line below them from a suspicion into a verdict.

Then the wall. open1 climbs normally to 8 cores and stops: 9.6 million opens per second at 8 tasks, 9.6 million at 24, 8.4 million at 48. Sixteen additional dedicated cores add exactly nothing, then the cross-socket step subtracts. Every task opens its **own** file, and when we chased the ceiling to its exact cacheline it turned out not to be the dcache walk, which scales cleanly, but AppArmor's file-open label accounting: one shared refcount bumped on every open, even for unconfined tasks. Boot the same kernel with that module off and the plateau simply disappears, 9.6M becoming 41M at 24 tasks. We keep the default-stack numbers throughout because they are what AppArmor distributions actually run, but the attribution matters for reading the tables below. Nothing here is held long enough to be called contention in a profiler. The cacheline just has one home and 48 visitors.

unlink1 is the same story with a write lock in it, and a write lock makes the story regress instead of plateau. Every creat and every unlink takes the parent directory's `i_rwsem` exclusively. One directory means one rwsem; one rwsem means the whole machine advances one create or unlink at a time, while the lock's cacheline ping-pongs between more and more cores:

<svg viewBox="0 0 720 320" role="img" aria-label="unlink1 absolute throughput falls from 467 thousand per second at one task to 188 thousand at 48 tasks" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">unlink1: every core you add makes it slower</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">absolute throughput, one kernel · every task works on its own file, in the same directory</text>
<line x1="64" y1="215.9" x2="640" y2="215.9" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="219.9" font-size="11" fill="#9ca3af" text-anchor="end">125K</text>
<line x1="64" y1="167.8" x2="640" y2="167.8" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="171.8" font-size="11" fill="#9ca3af" text-anchor="end">250K</text>
<line x1="64" y1="119.8" x2="640" y2="119.8" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="123.8" font-size="11" fill="#9ca3af" text-anchor="end">375K</text>
<line x1="64" y1="71.7" x2="640" y2="71.7" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="75.7" font-size="11" fill="#9ca3af" text-anchor="end">500K</text>
<line x1="64" y1="264" x2="640" y2="264" stroke="#9ca3af" stroke-width="1"/>
<text x="64.0" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="149.8" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">8</text>
<text x="247.8" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">16</text>
<text x="345.9" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">24</text>
<text x="443.9" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">32</text>
<text x="542.0" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">40</text>
<text x="640.0" y="282" font-size="11" fill="#9ca3af" text-anchor="middle">48</text>
<text x="352" y="302" font-size="11.5" fill="#6b7280" text-anchor="middle">tasks (= busy cores)</text>
<polygon points="64.0,264 64.0,84.5 76.3,72.4 100.8,84.7 149.8,88.1 198.8,109.7 247.8,127.2 345.9,148.6 443.9,176.2 542.0,185.7 640.0,191.7 640.0,264" fill="#be123c" opacity="0.08"/>
<polyline points="64.0,84.5 76.3,72.4 100.8,84.7 149.8,88.1 198.8,109.7 247.8,127.2 345.9,148.6 443.9,176.2 542.0,185.7 640.0,191.7" fill="none" stroke="#be123c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>unlink1 ops/sec on one kernel, 1 to 48 tasks</title></polyline>
<circle cx="64.0" cy="84.5" r="3" fill="#be123c"><title>1 tasks: 466,773 ops/sec</title></circle>
<circle cx="76.3" cy="72.4" r="3" fill="#be123c"><title>2 tasks: 498,088 ops/sec</title></circle>
<circle cx="100.8" cy="84.7" r="3" fill="#be123c"><title>4 tasks: 466,208 ops/sec</title></circle>
<circle cx="149.8" cy="88.1" r="3" fill="#be123c"><title>8 tasks: 457,427 ops/sec</title></circle>
<circle cx="198.8" cy="109.7" r="3" fill="#be123c"><title>12 tasks: 401,268 ops/sec</title></circle>
<circle cx="247.8" cy="127.2" r="3" fill="#be123c"><title>16 tasks: 355,722 ops/sec</title></circle>
<circle cx="345.9" cy="148.6" r="3" fill="#be123c"><title>24 tasks: 299,939 ops/sec</title></circle>
<circle cx="443.9" cy="176.2" r="3" fill="#be123c"><title>32 tasks: 228,362 ops/sec</title></circle>
<circle cx="542.0" cy="185.7" r="3" fill="#be123c"><title>40 tasks: 203,623 ops/sec</title></circle>
<circle cx="640.0" cy="191.7" r="3" fill="#be123c"><title>48 tasks: 188,013 ops/sec</title></circle>
<text x="82.3" y="62.4" font-size="12" font-weight="600" fill="#1f2937">467K/s at 1 task</text>
<text x="638.0" y="217.7" font-size="12" font-weight="600" fill="#be123c" text-anchor="end">188K/s at 48 tasks: 0.4× of one core</text>
</svg>

That downward slope is worth staring at. It is not a benchmark artifact and it is not exotic: it is `fs/namei.c` doing what a shared mutable directory requires under one kernel. Mail spools, session stores, build systems, lock-file protocols, anything that churns files in a common directory lives on some part of this curve.

The middle family, page_fault1 and mmap1 processes mode, scales but leaks: 15x and 26x at 48 cores, paying rent to the page allocator and to a commit-accounting counter we will meet properly in a moment.

The network rows split along the same line. tcp_rr1 and udp1, one established loopback connection or socket pair per task, ride the control curve to 35x: data transfer on an established connection touches per-connection state only, and the kernel proves it by scaling it. tcp_conn1 is the one with a wall in it: connection setup climbs to 1.81 million connects per second at 24 tasks, 12.9x of one task against the control's 17.7x at the same count, and then the cross-socket step subtracts, 32 tasks delivering less than 24 and 48 never recovering the peak. Where that contention actually lives has a surprising answer, measured in its own section below.

## Two Kernels, Same 24 Cores

Now the experiment this site exists for. Take 24 cores of one socket and 24 total tasks, and change only who manages them: one Linux kernel with 24 cores, versus two multikernel instances with 12 cores each, running 12 tasks each, concurrently, their throughputs summed. Same silicon, same clocks, same busy-core count, same binaries, same kernel build; the full fairness checklist lives in the reproduction section at the end. If the wall is really made of shared kernel state, splitting the kernel should tear it down, and the control tests should not move at all.

<svg viewBox="0 0 720 460" role="img" aria-label="Aggregate throughput of two 12-core kernels relative to one 24-core kernel on the same cores; unlink1 2.6x, open1 2x, tcp_conn1 1.16x, controls at 1x" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Two kernels vs. one, on the same 24 cores</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">24 tasks total · blue = structural kernel-lock win, gray = control or configuration-attributable · hover bars for detail</text>
<line x1="301.3" y1="60" x2="301.3" y2="408" stroke="#e5e7eb" stroke-width="1"/>
<text x="301.3" y="426" font-size="11" fill="#9ca3af" text-anchor="middle">1×</text>
<line x1="470.7" y1="60" x2="470.7" y2="408" stroke="#e5e7eb" stroke-width="1"/>
<text x="470.7" y="426" font-size="11" fill="#9ca3af" text-anchor="middle">2×</text>
<line x1="640.0" y1="60" x2="640.0" y2="408" stroke="#e5e7eb" stroke-width="1"/>
<text x="640.0" y="426" font-size="11" fill="#9ca3af" text-anchor="middle">3×</text>
<line x1="301.3" y1="60" x2="301.3" y2="408" stroke="#a88428" stroke-width="1.5"/>
<text x="301.3" y="54" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="middle">one kernel = 1×</text>
<text x="122" y="88.0" font-size="12.5" fill="#1f2937" text-anchor="end">unlink1</text>
<path d="M132,73 L568.3,73 Q572.3,73 572.3,77 L572.3,91 Q572.3,95 568.3,95 L132,95 Z" fill="#2a78d6"><title>unlink1: 780K vs 300K ops/sec</title></path>
<text x="580.3" y="88.0" font-size="12" font-weight="600" fill="#1f2937">2.60×</text>
<text x="122" y="122.0" font-size="12.5" fill="#1f2937" text-anchor="end">open1</text>
<path d="M132,107 L470.1,107 Q474.1,107 474.1,111 L474.1,125 Q474.1,129 470.1,129 L132,129 Z" fill="#a6adba"><title>open1: 19.3M vs 9.6M ops/sec; splits AppArmor's shared label, 1.00x with that module disabled</title></path>
<text x="482.1" y="122.0" font-size="12" font-weight="600" fill="#1f2937">2.02×</text>
<text x="122" y="156.0" font-size="12.5" fill="#1f2937" text-anchor="end">mmap1</text>
<path d="M132,141 L336.3,141 Q340.3,141 340.3,145 L340.3,159 Q340.3,163 336.3,163 L132,163 Z" fill="#2a78d6"><title>mmap1: 12.2M vs 9.9M ops/sec</title></path>
<text x="348.3" y="156.0" font-size="12" font-weight="600" fill="#1f2937">1.23×</text>
<text x="122" y="190.0" font-size="12.5" fill="#1f2937" text-anchor="end">tcp_conn1</text>
<path d="M132,175 L324.4,175 Q328.4,175 328.4,179 L328.4,193 Q328.4,197 324.4,197 L132,197 Z" fill="#2a78d6"><title>tcp_conn1: 2.10M vs 1.81M conn/sec; identical with one netns per task, the wall is below the namespace</title></path>
<text x="336.4" y="190.0" font-size="12" font-weight="600" fill="#1f2937">1.16×</text>
<text x="122" y="224.0" font-size="12.5" fill="#1f2937" text-anchor="end">udp1</text>
<path d="M132,209 L310.9,209 Q314.9,209 314.9,213 L314.9,227 Q314.9,231 310.9,231 L132,231 Z" fill="#a6adba"><title>udp1: 10.7M vs 9.9M ops/sec (per-connection state)</title></path>
<text x="322.9" y="224.0" font-size="12" font-weight="600" fill="#1f2937">1.08×</text>
<text x="122" y="258.0" font-size="12.5" fill="#1f2937" text-anchor="end">tcp_rr1</text>
<path d="M132,243 L307.5,243 Q311.5,243 311.5,247 L311.5,261 Q311.5,265 307.5,265 L132,265 Z" fill="#a6adba"><title>tcp_rr1: 7.2M vs 6.8M ops/sec (per-connection state)</title></path>
<text x="319.5" y="258.0" font-size="12" font-weight="600" fill="#1f2937">1.06×</text>
<text x="122" y="292.0" font-size="12.5" fill="#1f2937" text-anchor="end">getppid1</text>
<path d="M132,277 L297.3,277 Q301.3,277 301.3,281 L301.3,295 Q301.3,299 297.3,299 L132,299 Z" fill="#a6adba"><title>getppid1: 267.1M vs 268.2M ops/sec (control)</title></path>
<text x="309.3" y="292.0" font-size="12" font-weight="600" fill="#1f2937">1.00×</text>
<text x="122" y="326.0" font-size="12.5" fill="#1f2937" text-anchor="end">futex4</text>
<path d="M132,311 L297.3,311 Q301.3,311 301.3,315 L301.3,329 Q301.3,333 297.3,333 L132,333 Z" fill="#a6adba"><title>futex4: 134.9M vs 135.5M ops/sec (control)</title></path>
<text x="309.3" y="326.0" font-size="12" font-weight="600" fill="#1f2937">1.00×</text>
<text x="122" y="360.0" font-size="12.5" fill="#1f2937" text-anchor="end">poll2</text>
<path d="M132,345 L295.6,345 Q299.6,345 299.6,349 L299.6,363 Q299.6,367 295.6,367 L132,367 Z" fill="#a6adba"><title>poll2: 26.5M vs 26.7M ops/sec (control)</title></path>
<text x="307.6" y="360.0" font-size="12" font-weight="600" fill="#1f2937">0.99×</text>
<text x="122" y="394.0" font-size="12.5" fill="#1f2937" text-anchor="end">page_fault1</text>
<path d="M132,379 L290.6,379 Q294.6,379 294.6,383 L294.6,397 Q294.6,401 290.6,401 L132,401 Z" fill="#a6adba"><title>page_fault1: 4.9M vs 5.2M ops/sec</title></path>
<text x="302.6" y="394.0" font-size="12" font-weight="600" fill="#1f2937">0.96×</text>
</svg>

| Test | 1 kernel, 24 tasks | 2 kernels, 12+12 tasks | Ratio |
|---|---|---|---|
| getppid1 (control) | 268.2M/s | 267.1M/s | 1.00x |
| futex4 (control) | 135.5M/s | 134.9M/s | 1.00x |
| poll2 (control) | 26.7M/s | 26.5M/s | 0.99x |
| page_fault1 | 5.2M/s | 4.9M/s | 0.96x |
| tcp_rr1 | 6.79M/s | 7.22M/s | 1.06x |
| udp1 | 9.86M/s | 10.7M/s | 1.08x |
| **tcp_conn1** | 1.81M/s | **2.10M/s** | **1.16x** |
| **mmap1** | 9.9M/s | **12.2M/s** | **1.23x** |
| **open1** | 9.6M/s | **19.3M/s** | **2.02x** |
| **unlink1** | 300K/s | **780K/s** | **2.60x** |

Read the controls first, because they are what make the rest believable. getppid1 at 1.00x to three digits says the two configurations are running on indistinguishable hardware: same frequency, same cache, no spawn-kernel overhead on the syscall path. We also booted a single 24-core spawn as a second control, and it reproduces the single-kernel curves test for test, open1 plateau included. A spawn kernel is not faster Linux. It is just Linux, on fewer cores. And tcp_rr1 and udp1 join the parity block from the network side: an established connection's state lives wherever the connection lives, so splitting kernels rightly buys it nothing.

Which is the point. The 2.6x on unlink1 was not bought with a better kernel, a patched lock, or a tuned knob. Two kernels means two /tmp inodes, two rwsems, two dcaches, two of every cacheline that had one home before. The open1 row carries an asterisk the others do not: its 2.02x comes from splitting AppArmor's shared label, and disabling that module lifts both configurations to 40.8M and returns the ratio to 1.00x, so that win belongs to configuration, not architecture (unlink1 holds its win either way, 2.24x with the module off). Partitioning turns a lock wall into a per-partition speed bump, and the aggregate compounds with every split. That compounding, incidentally, is the honest version of the pitch: at 48 cores against unlink1's negative slope, two 12-core kernels using **half** the machine already beat the full 48-core kernel by 4x.

And unlike a sharded set of VMs, nothing here paid rent for the privilege: [as we measured last week](/2026/08/16/multikernel-vs-kvm-lmbench/), each partition is a native kernel on its own cores, syscalls at native cost, sleeping in real C-states.

## The Global Lock We Didn't Order

Honesty section. Our first multikernel run did not look like the table above: mmap1 came in at 0.45x, twice as slow as one kernel, and page_fault1 sagged too. Wrong direction, and too interesting to ignore, so we profiled inside the spawn kernel. Sixty-eight percent of all cycles were inside `percpu_counter_add_batch`, spinning on one global spinlock: `vm_committed_as`, the counter behind the Committed_AS line of /proc/meminfo.

The mechanism is a heuristic in `mm/mm_init.c` that nobody thinks about because on big machines it never fires. The counter is per-CPU with a spill batch sized as `totalram / ncpus / 4`. Our first spawns had 4 GB and 12 cores: batch of 21,214 pages. mmap1 maps and unmaps 128 MB at a time, which is 32,768 pages, over the batch on every single call. Every mmap and every munmap on every core skipped the per-CPU fast path and took the same global lock. On the 128 GB host the batch is 169,000 pages and the lock is never touched: same kernel, same test, opposite behavior, decided by a division.

This is not a multikernel bug, and that is why it earns this section: any Linux instance with that RAM-to-CPU ratio behaves this way, including a 4 GB, 12-vCPU cloud VM doing large mappings. Resize the spawn to 8 GB and the batch clears the mapping size; mmap1 jumps from 0.45x to the 1.23x in the table, and the lock vanishes from the profile. The lesson is to partition memory and cores together, keeping `RAM / cores / 4` above your largest mapping; and since the counter is purely statistical under the default overcommit policy, a more generous batch on small instances is a patch discussion worth having on linux-mm.

## The Walls No Flag Removes

unlink1's wall invites an obvious mitigation, and will-it-scale ships the proof it works: unlink2 gives every task its own directory and the collapse disappears. So we went hunting for the walls no layout or boot flag can dodge, and found the first one missing from the suite entirely: there has never been a rename test, because the suite grew around locks people were actively fixing and this one has been accepted as unfixable for decades. We wrote it: rename1 is thirty lines in the standard harness, published with stat2 in [our will-it-scale fork](https://github.com/multikernel/will-it-scale){:target="_blank" rel="noopener noreferrer"}. Each task renames its own file between its own two private directories, nothing logically shared, yet every cross-directory rename takes `s_vfs_rename_mutex`, one mutex per superblock, there to keep concurrent renames from creating directory cycles. It sits under the atomic-replace idiom, the temp-file-rename of maildirs, package managers, and every editor that saves safely.

<svg viewBox="0 0 720 400" role="img" aria-label="Cross-directory rename throughput: one kernel peaks at two tasks and decays below a single task at 24, two kernels sustain 2.1x more" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">rename1: a mutex per filesystem, so bring two filesystems</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">cross-directory rename, every task in its own two directories · <tspan fill="#be123c" font-weight="600">one kernel</tspan> vs. <tspan fill="#2a78d6" font-weight="600">two kernels, aggregate</tspan></text>
<line x1="64" y1="263.5" x2="600" y2="263.5" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="267.5" font-size="11" fill="#9ca3af" text-anchor="end">0.65M</text>
<line x1="64" y1="197.0" x2="600" y2="197.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="201.0" font-size="11" fill="#9ca3af" text-anchor="end">1.3M</text>
<line x1="64" y1="130.5" x2="600" y2="130.5" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="134.5" font-size="11" fill="#9ca3af" text-anchor="end">1.9M</text>
<line x1="64" y1="64.0" x2="600" y2="64.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="68.0" font-size="11" fill="#9ca3af" text-anchor="end">2.6M</text>
<line x1="64" y1="330" x2="600" y2="330" stroke="#9ca3af" stroke-width="1"/>
<text x="64.0" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="133.9" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">4</text>
<text x="227.1" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">8</text>
<text x="320.3" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">12</text>
<text x="413.6" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">16</text>
<text x="506.8" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">20</text>
<text x="600.0" y="348" font-size="11" fill="#9ca3af" text-anchor="middle">24</text>
<text x="332" y="368" font-size="11.5" fill="#6b7280" text-anchor="middle">total tasks (= busy cores)</text>
<polyline points="64.0,242.4 87.3,209.6 133.9,224.8 227.1,228.8 320.3,234.6 413.6,238.4 600.0,249.0" fill="none" stroke="#be123c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>one kernel: s_vfs_rename_mutex serializes the whole filesystem</title></polyline>
<circle cx="64.0" cy="242.4" r="3" fill="#be123c"><title>1 tasks: 856,192/sec</title></circle>
<circle cx="87.3" cy="209.6" r="3" fill="#be123c"><title>2 tasks: 1,177,127/sec</title></circle>
<circle cx="133.9" cy="224.8" r="3" fill="#be123c"><title>4 tasks: 1,027,925/sec</title></circle>
<circle cx="227.1" cy="228.8" r="3" fill="#be123c"><title>8 tasks: 989,628/sec</title></circle>
<circle cx="320.3" cy="234.6" r="3" fill="#be123c"><title>12 tasks: 932,636/sec</title></circle>
<circle cx="413.6" cy="238.4" r="3" fill="#be123c"><title>16 tasks: 895,340/sec</title></circle>
<circle cx="600.0" cy="249.0" r="3" fill="#be123c"><title>24 tasks: 792,192/sec</title></circle>
<polyline points="87.3,144.7 133.9,75.9 227.1,111.1 413.6,138.4 600.0,156.7" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>two kernels, throughputs summed: two superblocks, two mutexes</title></polyline>
<circle cx="87.3" cy="144.7" r="3" fill="#2a78d6"><title>2 tasks: 1,811,636/sec</title></circle>
<circle cx="133.9" cy="75.9" r="3" fill="#2a78d6"><title>4 tasks: 2,483,387/sec</title></circle>
<circle cx="227.1" cy="111.1" r="3" fill="#2a78d6"><title>8 tasks: 2,140,032/sec</title></circle>
<circle cx="413.6" cy="138.4" r="3" fill="#2a78d6"><title>16 tasks: 1,872,519/sec</title></circle>
<circle cx="600.0" cy="156.7" r="3" fill="#2a78d6"><title>24 tasks: 1,693,788/sec</title></circle>
<text x="594.0" y="182.7" font-size="12" font-weight="600" fill="#2a78d6" text-anchor="end">2 kernels: 1.69M/s (2.14×)</text>
<text x="594.0" y="273.0" font-size="12" font-weight="600" fill="#be123c" text-anchor="end">1 kernel: 792K/s, below one task alone</text>
<text x="95.3" y="199.6" font-size="11.5" fill="#1f2937">peak at 2 tasks</text>
</svg>

The single-kernel curve is the starkest in this post: throughput peaks at two tasks and decays until 24 dedicated cores deliver less than one task alone. Two kernels hold 2.14x, controls at 1.00x, and the security-module audit moves it 1%. The only single-kernel escape is one filesystem per worker, which surrenders the shared namespace, exactly the concession the multikernel split makes; partitioning is the only exit either way.

The second wall is the one your machine hits most often without noticing: every process start makes the loader stat and open the same shared libraries, every worker stats the same config file, all cores, one path, all day. stat2 (which we added alongside rename1) stats one shared file from every task; the suite's open3 opens and closes it. The shared object is a single dentry, and every call takes a reference on it: one cacheline, updated by every core. One kernel caps stat2 at 2.8x of a single task and open3 at 2.3x, whatever the core count, and both pass the audit that open1 failed, moving about 1% with the security module off. We ran the suite's open2 alongside them as the foil: a private file in a private directory, nothing logically shared at all. Two kernels give the shared-dentry pair back:

| Test | 1 kernel, 24 tasks | 2 kernels, 12+12 | Ratio |
|---|---|---|---|
| **stat2** | 9.42M/s | **19.8M/s** | **2.10x** |
| **open3** | 3.42M/s | **7.41M/s** | **2.17x** |
| open2 (own file, own dir) | 9.62M/s | 18.5M/s | 1.93x |

The open2 row is the audit cutting the other way: nothing shared, yet a 1.93x "win" that a single kernel reclaims entirely once the security module is off, the same story as open1. Structural or configurational: the whole post reduces to learning to tell them apart. And the structural rows carry honest semantics: a multikernel escapes the shared-dentry wall because each kernel genuinely has its own filesystem and its own copy of what its partition loads. The wall exists because one kernel insists all 48 cores agree on one dentry; two kernels simply have two.

The obvious objection is that our two kernels had two filesystems, so of course they had two dentries. Multikernel has an answer for workloads that genuinely need one filesystem: [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}, a shared-memory filesystem that multiple kernels mount simultaneously over one physical region. So we ran the strongest version of the experiment: open4, which is open3 with a fixed path so that every kernel opens the very same file, over one daxfs, one file existing exactly once in storage, both kernels mounting the same physical pages.

| open4, same file, same physical storage | Throughput | Ratio |
|---|---|---|
| 1 kernel, 24 tasks, shared daxfs | 3.41M/s | 1.00x |
| **2 kernels, 12+12, mounting the same daxfs** | **7.41M/s** | **2.18x** |

The split survives real sharing, controls at 1.00x, and the number says why: 7.41M is what the private-filesystem configuration scored too. The wall was never the storage. Every kernel builds its own dentries and inodes over whatever it mounts, so the refcount cacheline that serializes one kernel exists once per kernel, not once per file. DAXFS shares the bytes; it does not share the locks. One measured boundary keeps this honest: this is the read path. Two kernels mutating shared metadata through one daxfs is a different experiment, and until it is run, the shared-mutable-directory concession in the caveats stands.

## The Wall Below the Namespace

The networking rows earn their own audit, because networking is where single-kernel tenancy has its most celebrated sharding tool: the network namespace. Every container platform leans on it, and it is the obvious objection to tcp_conn1's row in the table above. Surely a netns per worker, with its own loopback, its own port space, its own everything, shards whatever connection setup contends on.

We wrote the test. tcp_conn2 is tcp_conn1 with one call added: each task unshares its own network namespace and brings up its own loopback before running the identical connect/accept/close loop, so nothing above the kernel is shared at all. The result is the cleanest null in this post: 1.80M connects per second at 24 tasks against tcp_conn1's 1.80M, and identical at every task count on the way up. We audited the shared per-destination tcp_metrics entry the same way (`net.ipv4.tcp_no_metrics_save=1`) and it moved nothing either. The namespace splits the device, the port range, and the metrics cache, and none of it matters, because the contention lives below all of it: the established and bind hash tables with their bucket spinlocks, and the connect-time port search, are one structure per kernel, shared across every namespace that kernel hosts. Two kernels moved the number because two kernels means two of those structures.

That makes tcp_conn1 the strictest wall in this post. unlink1 falls to a per-task directory layout. rename1 falls to a filesystem per worker, at the price of the shared namespace. tcp_conn1 falls to nothing an administrator can reach: not a layout, not a mount, not a sysctl, not the namespace machinery built precisely to shard the network stack. The honest counterweight ships with it: at 24 socket-local cores the structural win is 1.16x, real but modest, the toll of bucket-lock cachelines rather than a serializing mutex. The single-kernel curve's negative slope past one socket says the toll grows with distance, and the socket-aligned version of this experiment is the obvious next measurement.

## Crossing the Socket

Everything above stayed inside one socket on purpose, to keep the lock wall isolated from NUMA effects. But almost every serious server is multi-socket, and a single kernel image spans all of it by default. So we ran the experiment again with the boundary moved: 24 tasks split 12 and 12 across the machine's two sockets. One kernel managing both halves, versus two multikernel instances aligned to the sockets, each with 12 cores and memory on its own NUMA node. Same tests, same rules, twelve busy cores per socket in every configuration so the turbo bins match.

The most instructive number in this entire post came out of the smallest run. One task doing creat and unlink sustains 467,000 operations per second. Add one more task, on the other socket, in the same kernel, touching only its own file, and the two of them together sustain 213,000. The machine got slower than half of itself. Nothing in userspace is shared; the parent directory's `i_rwsem` is, and its cacheline now crosses the UPI interconnect on every operation. A lock that costs nanoseconds inside a socket costs a coherence round-trip across one. Two kernels, one per socket, same two tasks: 1.01 million.


Load both configurations fully and the gap holds at every count, between 3.7x and 5.2x on unlink1 across the whole sweep:

<svg viewBox="0 0 720 350" role="img" aria-label="Aggregate throughput of two socket-aligned kernels relative to one kernel straddling both sockets; unlink1 4.1x, open1 2.2x, controls near 1x" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Two socket-aligned kernels vs. one kernel straddling both</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">24 tasks, 12 per socket in both configs · blue = structural kernel-lock win, gray = control or configuration-attributable</text>
<line x1="233.6" y1="60" x2="233.6" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="233.6" y="324" font-size="11" fill="#9ca3af" text-anchor="middle">1×</text>
<line x1="335.2" y1="60" x2="335.2" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="335.2" y="324" font-size="11" fill="#9ca3af" text-anchor="middle">2×</text>
<line x1="436.8" y1="60" x2="436.8" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="436.8" y="324" font-size="11" fill="#9ca3af" text-anchor="middle">3×</text>
<line x1="538.4" y1="60" x2="538.4" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="538.4" y="324" font-size="11" fill="#9ca3af" text-anchor="middle">4×</text>
<line x1="640.0" y1="60" x2="640.0" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="640.0" y="324" font-size="11" fill="#9ca3af" text-anchor="middle">5×</text>
<line x1="233.6" y1="60" x2="233.6" y2="306" stroke="#a88428" stroke-width="1.5"/>
<text x="233.6" y="54" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="middle">one kernel = 1×</text>
<text x="122" y="88.0" font-size="12.5" fill="#1f2937" text-anchor="end">unlink1</text>
<path d="M132,73 L541.5,73 Q545.5,73 545.5,77 L545.5,91 Q545.5,95 541.5,95 L132,95 Z" fill="#2a78d6"><title>unlink1: 939K vs 231K ops/sec</title></path>
<text x="553.5" y="88.0" font-size="12" font-weight="600" fill="#1f2937">4.07×</text>
<text x="122" y="122.0" font-size="12.5" fill="#1f2937" text-anchor="end">open1</text>
<path d="M132,107 L353.6,107 Q357.6,107 357.6,111 L357.6,125 Q357.6,129 353.6,129 L132,129 Z" fill="#a6adba"><title>open1: 20.1M vs 9.1M ops/sec; same label mechanism, crossing UPI</title></path>
<text x="365.6" y="122.0" font-size="12" font-weight="600" fill="#1f2937">2.22×</text>
<text x="122" y="156.0" font-size="12.5" fill="#1f2937" text-anchor="end">mmap1</text>
<path d="M132,141 L246.9,141 Q250.9,141 250.9,145 L250.9,159 Q250.9,163 246.9,163 L132,163 Z" fill="#2a78d6"><title>mmap1: 14.8M vs 12.6M ops/sec</title></path>
<text x="258.9" y="156.0" font-size="12" font-weight="600" fill="#1f2937">1.17×</text>
<text x="122" y="190.0" font-size="12.5" fill="#1f2937" text-anchor="end">getppid1</text>
<path d="M132,175 L233.7,175 Q237.7,175 237.7,179 L237.7,193 Q237.7,197 233.7,197 L132,197 Z" fill="#a6adba"><title>getppid1: 352.3M vs 339.5M ops/sec (control)</title></path>
<text x="245.7" y="190.0" font-size="12" font-weight="600" fill="#1f2937">1.04×</text>
<text x="122" y="224.0" font-size="12.5" fill="#1f2937" text-anchor="end">futex4</text>
<path d="M132,209 L233.7,209 Q237.7,209 237.7,213 L237.7,227 Q237.7,231 233.7,231 L132,231 Z" fill="#a6adba"><title>futex4: 177.6M vs 171.0M ops/sec (control)</title></path>
<text x="245.7" y="224.0" font-size="12" font-weight="600" fill="#1f2937">1.04×</text>
<text x="122" y="258.0" font-size="12.5" fill="#1f2937" text-anchor="end">page_fault1</text>
<path d="M132,243 L231.6,243 Q235.6,243 235.6,247 L235.6,261 Q235.6,265 231.6,265 L132,265 Z" fill="#a6adba"><title>page_fault1: 6.4M vs 6.3M ops/sec</title></path>
<text x="243.6" y="258.0" font-size="12" font-weight="600" fill="#1f2937">1.02×</text>
<text x="122" y="292.0" font-size="12.5" fill="#1f2937" text-anchor="end">poll2</text>
<path d="M132,277 L230.6,277 Q234.6,277 234.6,281 L234.6,295 Q234.6,299 230.6,299 L132,299 Z" fill="#a6adba"><title>poll2: 34.3M vs 33.9M ops/sec (control)</title></path>
<text x="242.6" y="292.0" font-size="12" font-weight="600" fill="#1f2937">1.01×</text>
</svg>

| Test | 1 kernel, 12+12 across sockets | 2 kernels, one per socket | Ratio |
|---|---|---|---|
| getppid1 (control) | 339.5M/s | 352.3M/s | 1.04x |
| futex4 (control) | 171.0M/s | 177.6M/s | 1.04x |
| poll2 (control) | 33.9M/s | 34.3M/s | 1.01x |
| page_fault1 | 6.29M/s | 6.42M/s | 1.02x |
| **mmap1** | 12.6M/s | **14.8M/s** | **1.17x** |
| **open1** | 9.06M/s | **20.1M/s** | **2.22x** |
| **unlink1** | 231K/s | **939K/s** | **4.07x** |

Two readings of that table. First, the straddling kernel at 24 tasks is slower than the same kernel was with all 24 tasks packed on one socket: 231K versus 300K on unlink1, 9.1M versus 9.6M on open1, even though each socket now runs half loaded with correspondingly better clocks (the control shows 27% more per-core headroom than the packed configuration had). Spreading a lock-bound workload across sockets is negative-value parallelism: you pay for the second socket and receive less than you had. Second, the partitioning win grew from 2.6x to 4.1x for the same reason, because the partition boundary now coincides with the hardware boundary (open1's row carries the same asterisk as before: its share of the win is the label cacheline, now bouncing over UPI). That is the rule this whole post has been circling. Shared state costs what the interconnect charges, and the further apart the sharers sit, the higher the toll. A multikernel does not negotiate the toll. It closes the bridge.

## The Tests That Don't Move

A fair reader of the tables above should ask whether we picked the benchmarks that flatter us. So we ran the rest of will-it-scale's VM surface through the same two configurations as the first table: brk1 and malloc1 (the `mmap_lock` write path at two granularities), page_fault2 and page_fault3 (private and shared file-backed faults), and tlb_flush1 and tlb_flush3 (TLB shootdowns). Same 24 cores, same rules:

brk1 lands at 1.04x, tlb_flush1 and tlb_flush3 at 1.03x and 1.07x, page_fault3 at 0.98x, page_fault2 at 1.15x, malloc1 at 0.95x.

Parity almost everywhere, and the parity is the finding. brk1 and the TLB flush tests sit within 7% of 1x because the state they stress is per-process: a process's `mmap_lock` lives in whichever kernel the process lives in, per-VMA locks shard it further within the process, and TLB shootdowns go only to the CPUs in the mm's own cpumask. Splitting the machine into two kernels cannot speed up what one process does to itself, and the table says exactly that. This also answers a question we get about the per-VMA lock work: it is orthogonal to multikernel, not competing with it. Per-VMA locks shard contention inside a process; a multikernel shards it between processes. What neither can shard is contention inside one address space, which is the next section's subject.

page_fault2 is the instructive row: a 1.15x win, but the mechanism is not locks. The single kernel plateaus at 2.1M faults per second from 12 cores onward, and each 12-core spawn plateaus at about half that while the two of them share the socket, summing to just above the single-kernel wall. That is a memory bandwidth ceiling wearing a benchmark costume. Partitioning cannot manufacture DRAM bandwidth, and a methodology that could not tell this row apart from open1's would not deserve trust.

malloc1 is the row we owe the most honesty on: a 5% loss at 24 tasks, dipping to 15% at low counts. malloc of 128 MB is the mmap path in a glibc coat plus one page fault for the chunk header, so it should track mmap1's win, and it does not. Profiling inside a spawn localizes the extra cycles to the page table install and teardown path (the page table lock in `__pte_alloc`, plus `unmap_page_range`), with clocks ruled out by the control tests and contention ruled out by the lock being per-process. It has the same signature as a stall we chased and cleared elsewhere in this work, an uncontended lock-prefixed instruction absorbing the cost of the stores ahead of it, but the residual here is real, bounded, and not yet explained, so it stays on the books as an open item rather than a footnote we buried.

Sixteen tests now. The wins appear exactly where kernel state is shared machine-wide, the parity appears exactly where it is not, and the one small loss ships with a profile attached. That is the shape an honest mechanism claim should have.

## The Wall You Cannot Split: One Address Space

Everything above used processes because processes are what a multikernel can partition. Run the same tests as threads, all sharing one address space, and you meet a different wall, one we measured and can do nothing about, which is exactly why it deserves its own section instead of a footnote.

Three tests, three mechanisms, one root cause. mmap1 as threads collapses to 0.33x of a single task at 24 cores and 0.09x at 48: every map and unmap takes the one `mmap_lock` write-side, and an entire socket's worth of threads advances one VMA operation at a time. tlb_flush1 shows the interrupt half: as 24 processes it scales 15.2x, as 24 threads only 2.6x, and the entire 6x gap is shootdown IPIs, because every unmap must broadcast to every CPU running the shared mm, while single-threaded processes flush only themselves and never send one. And page_fault3 as threads regresses from 15.0M faults per second at 12 cores to 10.6M at 24: shared-file faults serialize on the mapping's rmap lock, the path the per-VMA lock work does not cover.

<svg viewBox="0 0 720 360" role="img" aria-label="At 24 tasks on one kernel, mmap1, tlb_flush1 and page_fault3 scale 12 to 18x as processes but 0.3 to 7x as threads" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Same test, two sharing models: 24 tasks on one kernel</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">speedup over a single task · <tspan fill="#2a78d6" font-weight="600">processes (share nothing)</tspan> vs. <tspan fill="#be123c" font-weight="600">threads (one address space)</tspan></text>
<line x1="251.5" y1="82" x2="251.5" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="251.5" y="322" font-size="11" fill="#9ca3af" text-anchor="middle">6×</text>
<line x1="371.0" y1="82" x2="371.0" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="371.0" y="322" font-size="11" fill="#9ca3af" text-anchor="middle">12×</text>
<line x1="490.5" y1="82" x2="490.5" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="490.5" y="322" font-size="11" fill="#9ca3af" text-anchor="middle">18×</text>
<line x1="610.0" y1="82" x2="610.0" y2="306" stroke="#e5e7eb" stroke-width="1"/>
<text x="610.0" y="322" font-size="11" fill="#9ca3af" text-anchor="middle">24×</text>
<line x1="610.0" y1="82" x2="610.0" y2="306" stroke="#a88428" stroke-width="1.5"/>
<text x="610.0" y="76" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">perfect = 24×</text>
<text x="122" y="108" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="end">mmap1</text>
<text x="122" y="124" font-size="10.5" fill="#6b7280" text-anchor="end">mmap_lock write side</text>
<path d="M132,92 L377.0,92 Q381.0,92 381.0,96 L381.0,108 Q381.0,112 377.0,112 L132,112 Z" fill="#2a78d6"><title>mmap1: 12.5x vs 0.33x: 38x apart</title></path>
<text x="388.0" y="107" font-size="12" font-weight="600" fill="#1f2937">12.5×</text>
<path d="M132,114 L134.6,114 Q138.6,114 138.6,118 L138.6,130 Q138.6,134 134.6,134 L132,134 Z" fill="#be123c"><title>mmap1: 12.5x vs 0.33x: 38x apart</title></path>
<text x="145.6" y="129" font-size="12" font-weight="600" fill="#1f2937">0.33×</text>
<text x="122" y="184" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="end">tlb_flush1</text>
<text x="122" y="200" font-size="10.5" fill="#6b7280" text-anchor="end">shootdown IPI broadcast</text>
<path d="M132,168 L430.7,168 Q434.7,168 434.7,172 L434.7,184 Q434.7,188 430.7,188 L132,188 Z" fill="#2a78d6"><title>tlb_flush1: 15.2x vs 2.6x: 6x apart</title></path>
<text x="441.7" y="183" font-size="12" font-weight="600" fill="#1f2937">15.2×</text>
<path d="M132,190 L179.8,190 Q183.8,190 183.8,194 L183.8,206 Q183.8,210 179.8,210 L132,210 Z" fill="#be123c"><title>tlb_flush1: 15.2x vs 2.6x: 6x apart</title></path>
<text x="190.8" y="205" font-size="12" font-weight="600" fill="#1f2937">2.6×</text>
<text x="122" y="260" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="end">page_fault3</text>
<text x="122" y="276" font-size="10.5" fill="#6b7280" text-anchor="end">shared-file rmap lock</text>
<path d="M132,244 L480.5,244 Q484.5,244 484.5,248 L484.5,260 Q484.5,264 480.5,264 L132,264 Z" fill="#2a78d6"><title>page_fault3: 17.7x vs 7.1x: 2.5x apart</title></path>
<text x="491.5" y="259" font-size="12" font-weight="600" fill="#1f2937">17.7×</text>
<path d="M132,266 L269.4,266 Q273.4,266 273.4,270 L273.4,282 Q273.4,286 269.4,286 L132,286 Z" fill="#be123c"><title>page_fault3: 17.7x vs 7.1x: 2.5x apart</title></path>
<text x="280.4" y="281" font-size="12" font-weight="600" fill="#1f2937">7.1×</text>
</svg>

These numbers are the boundary of the multikernel claim, drawn in data: one address space lives inside one kernel, so none of this is fixable by splitting kernels. But notice what the boundary is made of. It is the same law that built every wall in this post, applied one level down: scaling is set by the granularity of sharing. One mm does not scale across threads; one kernel does not scale across processes; and the remedy at each level is the same move at a different radius. Per-VMA locks shard the address space, multi-process designs shard the mm entirely, and a multikernel shards the kernel. The workloads that could go share-nothing largely already have, nginx workers, postgres backends, sharded fleets of every kind, and our processes-mode tables show the wall they hit next: the kernel's own shared state. The threads columns are not a counterargument to multikernel. They are rung one of the ladder multikernel finishes.

## Caveats

The multikernel result is a claim about share-nothing partitioning, stated plainly: in the two-kernel configuration the 24 tasks never share a directory, a dcache, or an allocator, because each kernel has its own. That is the product, not a trick, but it draws the boundary honestly: a workload that fundamentally needs one shared mutable directory, or one 48-core address space, cannot be split this way, and the previous section measured that boundary. Multikernel scales the machine for workloads built of independent processes, which is what most server fleets already are, sharded web workers, per-core network stacks, build farms, CI runners.

page_fault1 at 0.96x is page zeroing bound rather than lock bound at this core count, so parity is the expected result, and 0.96 is within the turbo noise we measured between runs. The single-kernel numbers above 24 tasks include a cross-socket step visible in the curves; every one-versus-two comparison in this post stays inside one socket to keep that out of the ratios. And kerf currently has no `--node` flag for the memory pool, so socket-local placement takes one line of its Python API; that flag is on our list.

The cross-socket experiment ran its socket-aligned spawn pair in two phases with a reboot between them, because the multikernel pool is currently one contiguous physical range and therefore lives on one NUMA node per boot; that is fair here because the two sockets are independent turbo and memory domains, and each phase loaded its socket exactly as the single-kernel configuration did, but it is a tooling gap on our list next to the `--node` flag. And will-it-scale's own core pinning ignores an external CPU mask, so the cross-socket runs used its no-affinity mode inside taskset masks, identically for both configurations; the cross-socket controls landed at 1.01x to 1.04x rather than 1.00x, and normalizing every ratio by the control still leaves 3.9x on unlink1 and 2.1x on open1.

## Reproduce It

The fairness work is where the effort went, so here is the full setup. One kernel build, `7.0.0-mk1+`, boots every configuration in this post. The single-kernel baseline runs on the host with all 48 cores. The multikernel side uses [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} to boot spawn kernels on socket 1, with memory allocated on socket 1's NUMA node, booted with the same mitigation flags as the host command line, running the identical binaries from the same rootfs, with tmpfs mounted over /tmp on both sides. At every comparison point the same number of cores on one socket are busy, so turbo bins match. Every number is the average over five one-second samples after warmup.

will-it-scale builds in a minute: clone ([our fork](https://github.com/multikernel/will-it-scale){:target="_blank" rel="noopener noreferrer"} adds rename1, stat2, open4, pread4, and the network tests tcp_conn1, tcp_conn2, tcp_rr1, and udp1; every other test in this post, open2 and open3 included, is upstream), make, and each test is a standalone binary that takes a task count. The sweep is a shell loop. The multikernel side is `kerf create`, `kerf load` with a rootfs directory containing the same binaries, and `kerf exec`, with results read back from the DAXFS overlay on the host:

```
kerf create wis0 --cpus=<12 cores of socket 1> --memory=8192MB
kerf load wis0 --kernel=vmlinux --rootfs-dir=/root/wis-rootfs \
    --entrypoint="/bin/bash /run-wis.sh"
kerf exec wis0
```

Nothing in the method needs our hardware: pick the biggest box you have, run the single-kernel sweep, find your wall (open1 and unlink1 will find it for you), then split the same cores between two spawns and run it again. The absolute numbers will move with your core count and kernel version. The shape will not, because the shape is the architecture.

## The Shape of the Wall

Every experiment in this post, one scoreboard. Ratios are two kernels against one on the same 24 cores unless noted; each row's story lives in its section above.

| Test | Machine-wide state | Verdict | 2 kernels vs 1 |
|---|---|---|---|
| unlink1 | directory `i_rwsem` | **structural** | **2.60x** (4.07x across sockets) |
| rename1 | `s_vfs_rename_mutex`, per filesystem | **structural** | **2.14x** |
| open3 | shared file's dentry refcount | **structural** | **2.17x** |
| open4, one daxfs in both kernels | dentry refcount, per kernel not per storage | **structural** | **2.18x** |
| stat2 | shared file's dentry refcount | **structural** | **2.10x** |
| pread4 | shared file's page-cache folio refcount | **structural** | **1.94x** |
| mmap1 | commit accounting | **structural**, sizing-sensitive | **1.23x** |
| tcp_conn1 | connection hash buckets, port search; survives per-task netns | **structural** | **1.16x** |
| open1 | AppArmor's shared label | configuration | 2.02x (2.22x across sockets); 1.00x with the module off |
| open2 | AppArmor's shared label | configuration | 1.93x; likewise |
| page_fault2 | none; DRAM bandwidth | hardware ceiling | 1.15x |
| page_fault1 | allocator, zeroing-bound | parity | 0.96x |
| brk1 | none; per-process `mmap_lock` | parity | 1.04x |
| tlb_flush1 / tlb_flush3 | none; per-mm IPIs | parity | 1.03x / 1.07x |
| page_fault3 | none; per-process mappings | parity | 0.98x |
| tcp_rr1 / udp1 | none; per-connection state | parity | 1.06x / 1.08x |
| malloc1 | page-table path, unexplained | open item | 0.95x |
| getppid1 / futex4 / poll2 | none | controls | 1.00x |

The threads-mode walls have no ratio column because one address space cannot be split; their numbers live in their own section above.

## Conclusion

Add it up. A single Linux kernel turned 48 dedicated cores into 40% of one core on unlink, capped open at its 8-core number forever, and did both while the control tests scaled 35x on the very same silicon, which is the kernel confessing that the limit is its own shared state. Two kernels on the same cores gave back 2.6x immediately, with the controls at 1.00x certifying that nothing else changed. A rename test the benchmark suite never had showed a mutex per filesystem doing the same at any directory layout, and the same split gave back 2.1x. Stat and open on one shared file, the shape of every exec storm, capped near 2.5x on one kernel however many cores arrived, and split to 2.1x as well. Even mounting one shared filesystem in both kernels, the same physical pages and the same file, kept the whole 2.18x, because the locks live in each kernel's VFS, not in the storage. Stretch the one kernel across two sockets instead and the wall grows with the distance: two tasks ran slower than one, and the socket-aligned split paid back 4.1x. TCP connection setup hit its own wall at a smaller toll, 1.16x back from the split, and survived the strongest single-kernel counter there is: one network namespace per task, the sharding tool built for exactly this stack, changed the number by nothing at all. Six more VM benchmarks moved by at most 15% in either direction, and established-connection TCP and UDP sat at parity beside them, because the state they stress is per-process or per-connection: the mechanism claim passing its own control.

The industry's answer to this wall has been twenty years of heroic lock surgery, and this post shows both its successes and its limit: some ceilings turn out to be configuration and fall to a boot flag, as open1's did, but the locks that remain after that audit are the ones that define what "one kernel" means. You do not shard those. You shard the kernel.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}. If your machines have more cores than your kernel can honestly use, we would love to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
