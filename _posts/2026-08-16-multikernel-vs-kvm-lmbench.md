---
layout: post
title: "A Perfectly Tuned VM Is a Partition That Pays Rent: Multikernel vs. KVM"
date: 2026-08-16 10:00:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, virtualization]
author: Cong Wang, Founder and CEO
excerpt: "We booted the same kernel twice on one machine: once as a multikernel instance on dedicated cores, once as a KVM guest with every hardware assist enabled (EPT, APICv, IPI virtualization, unrestricted guest). Memory bandwidth and DRAM latency came out identical. The kernel's hot paths did not: context switches cost 2.5x more in the guest, pipe round-trips 2.2x. But that 2.5x is buyable, and the price is the real story. KVM closes almost all of it by polling (burning the idle CPU it exists to share) or by ceding exclusive mwait control of physical cores to the guest. Multikernel sleeps in hardware C-states and stays fast. And underneath every configuration we tried, about 30 ns of tax never comes off any kernel entry."
---

Hardware virtualization is supposed to be nearly free now. EPT removed shadow page tables. APICv moved interrupt delivery into silicon. Unrestricted guest mode erased the last software emulation from the boot path. The conventional wisdom is that a tuned KVM guest performs like bare metal, and for some workloads that is true.

We wanted the precise shape of "some." So we ran the same experiment twice on one machine: the same kernel build, the same lmbench binaries, the same benchmark script, two cores and memory to spare on each side. The only variable was the layer underneath: a [multikernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} instance running natively on partitioned hardware, versus a KVM guest with every acceleration feature the host offers.

The result has three layers. Where the hardware does the work, the VM matches multikernel exactly. Where the kernel does the work, the VM pays between 1.04x and 2.5x at default settings, and it pays the most on the paths modern software hits the hardest. The third layer is what happens when you try to fix that, and it is the one worth reading for.

One caveat changes how the numbers should be read. The 2x and 2.5x ratios below are measured against a guest at the default idle policy, HLT, and nearly all of that gap is one mechanism: a guest cannot execute mwait, so every wakeup of an idle vCPU is a VM exit and a re-entry, paid twice per ping-pong iteration. That gap is buyable, and the price is the real story. The guest closes it only by never sleeping, a core and up to 19 W spent on nothing, or by taking mwait control of physical cores away from the host; multikernel posts the same numbers while sleeping in real C-states. And underneath whichever option you pick, about 30 ns on every kernel entry never comes off at all.

## Benchmark Setup

The host is a dual-socket Intel Xeon Gold 5418Y (Sapphire Rapids, 24 cores per socket, 48 KB L1d and 2 MB L2 per core, 45 MB shared L3, SMT disabled). Both configurations booted the same kernel build, `7.0.0-mk1+`, out of one source tree and one config, packaged the two ways the two boot paths require: kerf takes the ELF `vmlinux`, QEMU's `-kernel` takes the `bzImage`. Both ran the identical statically-built lmbench binaries from the same root filesystem, driven by the same shell script. Neither configuration touches an I/O device during measurement: every benchmark runs from memory.

**Multikernel.** A spawn instance created with [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}, given two dedicated physical cores and 1 GB of reserved memory carved out of the host at boot. The root filesystem is a DAXFS image in shared memory. The spawn kernel owns its cores outright: real page tables, real APIC, real IPIs, no hypervisor underneath.

```
kerf load lmbench --kernel=vmlinux --rootfs-dir=/root/lmbench-rootfs \
    --entrypoint="/bin/bash /run-lmbench.sh"
kerf exec lmbench
```

**KVM.** The same kernel booted by QEMU with every hardware assist verified on: EPT, unrestricted guest, and APICv all enabled in `kvm_intel`. The guest gets `-cpu host`, two vCPUs pinned to two idle physical cores on the same socket, and its root filesystem as an initramfs (the kernel carries no virtio drivers, and for a pure CPU and memory benchmark it does not need any). The guest is given the same 1 GB.

```
taskset -c 10,12 qemu-system-x86_64 -enable-kvm -cpu host -smp 2 -m 1024 \
    -kernel bzImage -initrd lmbench-initrd.gz \
    -append "console=ttyS0 clocksource=tsc tsc=reliable rdinit=/vm-init.sh"
```

Both kernels use TSC as the clock source, so lmbench's timing loops read the same hardware counter at the same cost in both worlds. Both sides run their default idle policy: the multikernel instance on its native `intel_idle` driver with mwait C-states (C1/C1E/C6), the guest on HLT, since KVM does not expose mwait by default. Our guest kernel is a minimal config with no `haltpoll` cpuidle driver, so plain HLT is genuinely what it falls back to. A stock distribution guest whose hypervisor promises it dedicated cores would spin first, and we measure that behavior as its own configuration further down rather than folding it into the default. This is otherwise a deliberately clean KVM setup: no overcommit, no ballooning, no noisy neighbors, no emulated devices in the measured path.

## The Numbers at Default Idle

Every number in this post is the median of three full-suite runs per configuration.

| Benchmark | Multikernel | KVM guest | KVM / Multikernel |
|---|---|---|---|
| Null syscall | 0.070 µs | 0.099 µs | 1.42x |
| read() | 0.099 µs | 0.124 µs | 1.26x |
| write() | 0.082 µs | 0.114 µs | 1.39x |
| stat() | 0.354 µs | 0.379 µs | 1.07x |
| open()/close() | 0.554 µs | 0.586 µs | 1.06x |
| Signal handler install | 0.123 µs | 0.159 µs | 1.29x |
| Signal handler catch | 0.770 µs | 0.881 µs | 1.14x |
| Context switch (2 procs) | 1.37 µs | 3.42 µs | 2.50x |
| Pipe latency | 3.24 µs | 7.06 µs | 2.18x |
| AF_UNIX stream latency | 4.81 µs | 7.48 µs | 1.55x |
| fork + exit | 115 µs | 123 µs | 1.07x |
| fork + /bin/sh | 730 µs | 761 µs | 1.04x |

<svg viewBox="0 0 720 468" role="img" aria-label="Latency of common kernel operations under KVM relative to multikernel, multikernel equals 1x" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Latency under KVM, relative to multikernel</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Same kernel binary, default idle policy on both sides, median of three runs · longer bar = more VM overhead</text>
<line x1="350.5" y1="64" x2="350.5" y2="438" stroke="#e5e7eb" stroke-width="1"/>
<text x="350.5" y="454" font-size="11" fill="#9ca3af" text-anchor="middle">1×</text>
<line x1="493.0" y1="64" x2="493.0" y2="438" stroke="#e5e7eb" stroke-width="1"/>
<text x="493.0" y="454" font-size="11" fill="#9ca3af" text-anchor="middle">2×</text>
<line x1="635.5" y1="64" x2="635.5" y2="438" stroke="#e5e7eb" stroke-width="1"/>
<text x="635.5" y="454" font-size="11" fill="#9ca3af" text-anchor="middle">3×</text>
<line x1="350.5" y1="64" x2="350.5" y2="438" stroke="#a88428" stroke-width="1.5"/>
<text x="350.5" y="58" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="middle">multikernel = 1×</text>
<text x="198" y="88" font-size="12.5" fill="#1f2937" text-anchor="end">Context switch (2 procs)</text>
<path d="M208,74 L559.7,74 Q563.7,74 563.7,78.0 L563.7,90.0 Q563.7,94 559.7,94 L208,94 Z" fill="#2a78d6"><title>Context switch (2 procs): 1.37 µs multikernel vs 3.42 µs KVM (2.50x)</title></path>
<text x="570.7" y="88" font-size="12" font-weight="600" fill="#1f2937">2.50×</text>
<text x="198" y="118" font-size="12.5" fill="#1f2937" text-anchor="end">Pipe latency</text>
<path d="M208,104 L515.0,104 Q519.0,104 519.0,108.0 L519.0,120.0 Q519.0,124 515.0,124 L208,124 Z" fill="#2a78d6"><title>Pipe latency: 3.24 µs multikernel vs 7.06 µs KVM (2.18x)</title></path>
<text x="526.0" y="118" font-size="12" font-weight="600" fill="#1f2937">2.18×</text>
<text x="198" y="148" font-size="12.5" fill="#1f2937" text-anchor="end">AF_UNIX latency</text>
<path d="M208,134 L425.5,134 Q429.5,134 429.5,138.0 L429.5,150.0 Q429.5,154 425.5,154 L208,154 Z" fill="#2a78d6"><title>AF_UNIX latency: 4.81 µs multikernel vs 7.48 µs KVM (1.55x)</title></path>
<text x="436.5" y="148" font-size="12" font-weight="600" fill="#1f2937">1.55×</text>
<text x="198" y="178" font-size="12.5" fill="#1f2937" text-anchor="end">Null syscall</text>
<path d="M208,164 L405.7,164 Q409.7,164 409.7,168.0 L409.7,180.0 Q409.7,184 405.7,184 L208,184 Z" fill="#2a78d6"><title>Null syscall: 0.07 µs multikernel vs 0.10 µs KVM (1.42x)</title></path>
<text x="416.7" y="178" font-size="12" font-weight="600" fill="#1f2937">1.42×</text>
<text x="198" y="208" font-size="12.5" fill="#1f2937" text-anchor="end">write()</text>
<path d="M208,194 L402.3,194 Q406.3,194 406.3,198.0 L406.3,210.0 Q406.3,214 402.3,214 L208,214 Z" fill="#2a78d6"><title>write(): 0.08 µs multikernel vs 0.11 µs KVM (1.39x)</title></path>
<text x="413.3" y="208" font-size="12" font-weight="600" fill="#1f2937">1.39×</text>
<text x="198" y="238" font-size="12.5" fill="#1f2937" text-anchor="end">Signal handler install</text>
<path d="M208,224 L388.2,224 Q392.2,224 392.2,228.0 L392.2,240.0 Q392.2,244 388.2,244 L208,244 Z" fill="#2a78d6"><title>Signal handler install: 0.12 µs multikernel vs 0.16 µs KVM (1.29x)</title></path>
<text x="399.2" y="238" font-size="12" font-weight="600" fill="#1f2937">1.29×</text>
<text x="198" y="268" font-size="12.5" fill="#1f2937" text-anchor="end">read()</text>
<path d="M208,254 L383.1,254 Q387.1,254 387.1,258.0 L387.1,270.0 Q387.1,274 383.1,274 L208,274 Z" fill="#2a78d6"><title>read(): 0.10 µs multikernel vs 0.12 µs KVM (1.26x)</title></path>
<text x="394.1" y="268" font-size="12" font-weight="600" fill="#1f2937">1.26×</text>
<text x="198" y="298" font-size="12.5" fill="#1f2937" text-anchor="end">Signal handler catch</text>
<path d="M208,284 L367.1,284 Q371.1,284 371.1,288.0 L371.1,300.0 Q371.1,304 367.1,304 L208,304 Z" fill="#2a78d6"><title>Signal handler catch: 0.77 µs multikernel vs 0.88 µs KVM (1.14x)</title></path>
<text x="378.1" y="298" font-size="12" font-weight="600" fill="#1f2937">1.14×</text>
<text x="198" y="328" font-size="12.5" fill="#1f2937" text-anchor="end">stat()</text>
<path d="M208,314 L356.7,314 Q360.7,314 360.7,318.0 L360.7,330.0 Q360.7,334 356.7,334 L208,334 Z" fill="#2a78d6"><title>stat(): 0.35 µs multikernel vs 0.38 µs KVM (1.07x)</title></path>
<text x="367.7" y="328" font-size="12" font-weight="600" fill="#1f2937">1.07×</text>
<text x="198" y="358" font-size="12.5" fill="#1f2937" text-anchor="end">fork + exit</text>
<path d="M208,344 L356.6,344 Q360.6,344 360.6,348.0 L360.6,360.0 Q360.6,364 356.6,364 L208,364 Z" fill="#2a78d6"><title>fork + exit: 114.62 µs multikernel vs 122.71 µs KVM (1.07x)</title></path>
<text x="367.6" y="358" font-size="12" font-weight="600" fill="#1f2937">1.07×</text>
<text x="198" y="388" font-size="12.5" fill="#1f2937" text-anchor="end">open()/close()</text>
<path d="M208,374 L354.7,374 Q358.7,374 358.7,378.0 L358.7,390.0 Q358.7,394 354.7,394 L208,394 Z" fill="#2a78d6"><title>open()/close(): 0.55 µs multikernel vs 0.59 µs KVM (1.06x)</title></path>
<text x="365.7" y="388" font-size="12" font-weight="600" fill="#1f2937">1.06×</text>
<text x="198" y="418" font-size="12.5" fill="#1f2937" text-anchor="end">fork + /bin/sh -c</text>
<path d="M208,404 L352.5,404 Q356.5,404 356.5,408.0 L356.5,420.0 Q356.5,424 352.5,424 L208,424 Z" fill="#2a78d6"><title>fork + /bin/sh -c: 729.88 µs multikernel vs 760.75 µs KVM (1.04x)</title></path>
<text x="363.5" y="418" font-size="12" font-weight="600" fill="#1f2937">1.04×</text>
</svg>

The pattern is not random, but it is two patterns stacked. The operations at the top are the ones dominated by wakeups. The ones at the bottom do enough real kernel work to dilute a fixed per-entry cost that every operation on the list pays.

**Context switches pay 2.5x.** A two-process context switch that costs 1.37 µs on multikernel costs 3.42 µs in the guest. This is the single most executed path in a busy kernel: every scheduler decision, every lock handoff, every producer-consumer pair crosses it. It is also the line item the guest can buy back, and the next section is about what the receipt says.

**IPC pays 2x.** A pipe round-trip more than doubles, from 3.24 µs to 7.06 µs, and an AF_UNIX round-trip pays 55%. These are the primitives that shells, supervisors, async runtimes, and every microservice sidecar are built from. Both are buyable for the same reason context switching is.

**Even a null syscall pays 42%.** A syscall does not exit to the hypervisor; the guest kernel handles it directly. Yet every kernel entry carries about 30 ns of extra cost, in this guest and in the fastest guest we could assemble. This is the one number nothing bought back. It is the ambient cost of simply being a guest.

**fork rides nearly free.** fork+exit is a memory-management workload, thousands of page-table operations with few context switches, and it lands at 1.07x, down at the bottom of the chart with stat and open. EPT handles the page-table work in hardware, so what remains is mostly the per-entry tax. Which brings us to the other half of the story.

## Where There Is No Tax

If virtualization overhead were a general slowness, it would show up in the memory system first. It does not show up at all.

<svg viewBox="0 0 720 380" role="img" aria-label="Memory read latency versus working set size, multikernel and KVM curves overlap" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Memory latency: the two curves sit on top of each other</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">lat_mem_rd, stride 128, median of three runs · EPT with huge pages adds nothing measurable</text>
<line x1="56" y1="273.1" x2="700" y2="273.1" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="277.1" font-size="11" fill="#9ca3af" text-anchor="end">10 ns</text>
<line x1="56" y1="202.3" x2="700" y2="202.3" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="206.3" font-size="11" fill="#9ca3af" text-anchor="end">20 ns</text>
<line x1="56" y1="131.4" x2="700" y2="131.4" stroke="#e5e7eb" stroke-width="1"/>
<text x="48" y="135.4" font-size="11" fill="#9ca3af" text-anchor="end">30 ns</text>
<line x1="56" y1="344" x2="700" y2="344" stroke="#9ca3af" stroke-width="1"/>
<text x="163.2" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">4K</text>
<text x="270.5" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">32K</text>
<text x="377.9" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">256K</text>
<text x="485.3" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">2M</text>
<text x="592.6" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">16M</text>
<text x="700.0" y="362" font-size="11" fill="#9ca3af" text-anchor="middle">128M</text>
<text x="378" y="378" font-size="11.5" fill="#6b7280" text-anchor="middle">working set (bytes)</text>
<line x1="291.5" y1="90" x2="291.5" y2="344" stroke="#e5e7eb" stroke-width="1"/>
<line x1="485.3" y1="90" x2="485.3" y2="344" stroke="#e5e7eb" stroke-width="1"/>
<line x1="646.0" y1="90" x2="646.0" y2="344" stroke="#e5e7eb" stroke-width="1"/>
<text x="173.7" y="104" font-size="11" fill="#9ca3af" text-anchor="middle">L1</text>
<text x="388.4" y="104" font-size="11" fill="#9ca3af" text-anchor="middle">L2</text>
<text x="565.6" y="104" font-size="11" fill="#9ca3af" text-anchor="middle">L3</text>
<text x="673.0" y="104" font-size="11" fill="#9ca3af" text-anchor="middle">DRAM</text>
<polyline points="56.0,334.7 91.8,334.7 127.3,334.7 148.3,334.7 163.2,334.7 184.1,334.7 199.0,334.7 210.5,334.7 219.9,334.7 227.9,334.7 234.7,334.7 240.8,334.7 246.3,334.7 251.2,334.7 255.7,334.7 259.8,334.7 263.6,334.7 267.2,334.7 270.5,334.7 276.6,334.7 282.1,334.7 287.0,334.7 291.5,334.6 295.6,330.8 299.4,326.7 303.0,321.1 306.3,327.3 312.4,321.0 317.9,325.7 322.8,328.8 327.3,329.3 331.4,329.7 335.2,330.1 338.8,326.3 342.1,327.2 348.2,327.9 353.6,329.9 358.6,330.3 363.1,328.4 367.2,328.8 371.0,330.1 374.6,330.4 377.9,328.9 384.0,330.2 389.4,329.3 394.4,330.3 398.8,329.5 403.0,330.3 406.8,329.6 410.4,330.3 413.7,329.7 419.8,329.4 425.2,329.4 430.1,329.5 434.6,329.6 438.8,329.7 442.6,329.7 446.2,330.3 449.5,330.3 455.6,329.9 461.0,330.0 465.9,329.9 470.4,330.1 474.6,328.6 478.4,326.6 481.9,322.8 485.3,319.8 491.4,308.4 496.8,296.1 501.7,283.2 506.2,274.3 510.3,268.8 514.2,266.0 517.7,265.0 521.1,264.8 527.1,264.2 532.6,264.6 537.5,264.3 542.0,264.5 546.1,265.0 550.0,266.1 553.5,266.6 556.8,266.3 562.9,266.6 568.4,266.3 573.3,266.3 577.8,266.1 581.9,265.5 585.7,265.9 589.3,266.4 592.6,266.2 598.7,266.4 604.2,266.4 609.1,265.6 613.6,263.7 617.7,262.1 621.5,259.0 625.1,253.8 628.4,251.1 634.5,237.0 639.9,229.0 644.9,222.8 649.4,222.0 653.5,217.2 657.3,207.4 660.9,202.2 664.2,196.2 670.3,179.8 675.7,165.6 680.7,153.6 685.1,142.7 689.3,134.8 693.1,128.1 696.7,121.6 700.0,116.3" fill="none" stroke="#a88428" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
<polyline points="56.0,334.4 91.8,334.6 127.3,334.7 148.3,334.7 163.2,334.6 184.1,334.6 199.0,334.4 210.5,334.5 219.9,334.4 227.9,334.4 234.7,334.5 240.8,334.5 246.3,334.4 251.2,334.4 255.7,334.5 259.8,334.4 263.6,334.5 267.2,334.3 270.5,334.4 276.6,334.3 282.1,334.4 287.0,334.3 291.5,334.3 295.6,328.7 299.4,324.4 303.0,322.3 306.3,327.1 312.4,321.6 317.9,323.3 322.8,322.6 327.3,321.2 331.4,322.4 335.2,323.7 338.8,324.6 342.1,325.0 348.2,325.8 353.6,325.2 358.6,325.9 363.1,326.5 367.2,327.4 371.0,326.6 374.6,327.4 377.9,327.8 384.0,327.5 389.4,328.4 394.4,327.9 398.8,328.9 403.0,328.2 406.8,329.1 410.4,328.4 413.7,329.2 419.8,329.4 425.2,329.2 430.1,329.4 434.6,329.5 438.8,329.6 442.6,329.6 446.2,330.1 449.5,330.1 455.6,329.9 461.0,329.8 465.9,329.9 470.4,330.1 474.6,329.2 478.4,327.2 481.9,321.4 485.3,318.1 491.4,307.6 496.8,295.7 501.7,286.3 506.2,276.6 510.3,270.9 514.2,269.1 517.7,268.1 521.1,267.9 527.1,267.6 532.6,267.8 537.5,267.3 542.0,268.5 546.1,268.3 550.0,268.4 553.5,269.5 556.8,270.3 562.9,270.2 568.4,269.5 573.3,269.4 577.8,269.2 581.9,269.3 585.7,269.6 589.3,269.4 592.6,269.5 598.7,269.6 604.2,269.8 609.1,269.3 613.6,269.7 617.7,269.2 621.5,269.4 625.1,268.8 628.4,268.7 634.5,263.9 639.9,260.8 644.9,252.6 649.4,242.6 653.5,231.5 657.3,221.6 660.9,210.7 664.2,202.3 670.3,185.0 675.7,171.9 680.7,159.5 685.1,150.4 689.3,140.4 693.1,137.4 696.7,127.4 700.0,122.8" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<line x1="70" y1="126" x2="92" y2="126" stroke="#a88428" stroke-width="4" stroke-linecap="round"/>
<text x="100" y="130" font-size="12" fill="#1f2937">Multikernel · 32.1 ns at 128 MB</text>
<line x1="70" y1="148" x2="92" y2="148" stroke="#2a78d6" stroke-width="2" stroke-linecap="round"/>
<text x="100" y="152" font-size="12" fill="#1f2937">KVM guest · 31.2 ns at 128 MB</text>
</svg>

This is `lat_mem_rd` walking working sets from 512 bytes to 128 MB. Both curves trace the identical staircase: 1.3 ns in L1, about 2 ns in L2, 11 ns in the shared L3, climbing to 32 ns in DRAM. The KVM guest, running behind a second layer of address translation, loses nothing measurable. EPT with huge pages has made nested translation genuinely free for well-behaved working sets, exactly as advertised.

Bandwidth tells the same story:

<svg viewBox="0 0 720 430" role="img" aria-label="Memory bandwidth for six bw_mem operations, multikernel and KVM within noise of each other" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Memory bandwidth: parity</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">bw_mem, 64 MB working set, median of three runs · GB/s, longer is better</text>
<rect x="0" y="56" width="12" height="12" rx="3" fill="#a88428"/>
<text x="18" y="66" font-size="12" fill="#1f2937">Multikernel</text>
<rect x="108" y="56" width="12" height="12" rx="3" fill="#2a78d6"/>
<text x="126" y="66" font-size="12" fill="#1f2937">KVM guest</text>
<line x1="271.3" y1="90" x2="271.3" y2="400" stroke="#e5e7eb" stroke-width="1"/>
<text x="271.3" y="416" font-size="11" fill="#9ca3af" text-anchor="middle">5</text>
<line x1="374.7" y1="90" x2="374.7" y2="400" stroke="#e5e7eb" stroke-width="1"/>
<text x="374.7" y="416" font-size="11" fill="#9ca3af" text-anchor="middle">10</text>
<line x1="478.0" y1="90" x2="478.0" y2="400" stroke="#e5e7eb" stroke-width="1"/>
<text x="478.0" y="416" font-size="11" fill="#9ca3af" text-anchor="middle">15</text>
<line x1="581.3" y1="90" x2="581.3" y2="400" stroke="#e5e7eb" stroke-width="1"/>
<text x="581.3" y="416" font-size="11" fill="#9ca3af" text-anchor="middle">20</text>
<text x="158" y="118" font-size="12.5" fill="#1f2937" text-anchor="end">Sequential read</text>
<path d="M168,96 L596.1,96 Q600.1,96 600.1,100.0 L600.1,108.0 Q600.1,112 596.1,112 L168,112 Z" fill="#a88428"><title>Sequential read (rd): multikernel 20.91 GB/s</title></path>
<text x="607.1" y="108" font-size="11.5" fill="#1f2937">20.9</text>
<path d="M168,114 L593.5,114 Q597.5,114 597.5,118.0 L597.5,126.0 Q597.5,130 593.5,130 L168,130 Z" fill="#2a78d6"><title>Sequential read (rd): KVM 20.78 GB/s</title></path>
<text x="604.5" y="126" font-size="11.5" fill="#1f2937">20.8</text>
<text x="158" y="168" font-size="12.5" fill="#1f2937" text-anchor="end">Read-modify-write</text>
<path d="M168,146 L464.4,146 Q468.4,146 468.4,150.0 L468.4,158.0 Q468.4,162 464.4,162 L168,162 Z" fill="#a88428"><title>Read-modify-write (rdwr): multikernel 14.54 GB/s</title></path>
<text x="475.4" y="158" font-size="11.5" fill="#1f2937">14.5</text>
<path d="M168,164 L476.8,164 Q480.8,164 480.8,168.0 L480.8,176.0 Q480.8,180 476.8,180 L168,180 Z" fill="#2a78d6"><title>Read-modify-write (rdwr): KVM 15.14 GB/s</title></path>
<text x="487.8" y="176" font-size="11.5" fill="#1f2937">15.1</text>
<text x="158" y="218" font-size="12.5" fill="#1f2937" text-anchor="end">bzero</text>
<path d="M168,196 L398.8,196 Q402.8,196 402.8,200.0 L402.8,208.0 Q402.8,212 398.8,212 L168,212 Z" fill="#a88428"><title>bzero (bzero): multikernel 11.36 GB/s</title></path>
<text x="409.8" y="208" font-size="11.5" fill="#1f2937">11.4</text>
<path d="M168,214 L405.5,214 Q409.5,214 409.5,218.0 L409.5,226.0 Q409.5,230 405.5,230 L168,230 Z" fill="#2a78d6"><title>bzero (bzero): KVM 11.69 GB/s</title></path>
<text x="416.5" y="226" font-size="11.5" fill="#1f2937">11.7</text>
<text x="158" y="268" font-size="12.5" fill="#1f2937" text-anchor="end">Sequential write</text>
<path d="M168,246 L327.2,246 Q331.2,246 331.2,250.0 L331.2,258.0 Q331.2,262 327.2,262 L168,262 Z" fill="#a88428"><title>Sequential write (wr): multikernel 7.90 GB/s</title></path>
<text x="338.2" y="258" font-size="11.5" fill="#1f2937">7.9</text>
<path d="M168,264 L325.1,264 Q329.1,264 329.1,268.0 L329.1,276.0 Q329.1,280 325.1,280 L168,280 Z" fill="#2a78d6"><title>Sequential write (wr): KVM 7.80 GB/s</title></path>
<text x="336.1" y="276" font-size="11.5" fill="#1f2937">7.8</text>
<text x="158" y="318" font-size="12.5" fill="#1f2937" text-anchor="end">bcopy</text>
<path d="M168,296 L274.4,296 Q278.4,296 278.4,300.0 L278.4,308.0 Q278.4,312 274.4,312 L168,312 Z" fill="#a88428"><title>bcopy (bcopy): multikernel 5.34 GB/s</title></path>
<text x="285.4" y="308" font-size="11.5" fill="#1f2937">5.3</text>
<path d="M168,314 L361.7,314 Q365.7,314 365.7,318.0 L365.7,326.0 Q365.7,330 361.7,330 L168,330 Z" fill="#2a78d6"><title>bcopy (bcopy): KVM 9.57 GB/s</title></path>
<text x="372.7" y="326" font-size="11.5" fill="#1f2937">9.6</text>
<text x="158" y="368" font-size="12.5" fill="#1f2937" text-anchor="end">Array copy</text>
<path d="M168,346 L265.9,346 Q269.9,346 269.9,350.0 L269.9,358.0 Q269.9,362 265.9,362 L168,362 Z" fill="#a88428"><title>Array copy (cp): multikernel 4.93 GB/s</title></path>
<text x="276.9" y="358" font-size="11.5" fill="#1f2937">4.9</text>
<path d="M168,364 L279.6,364 Q283.6,364 283.6,368.0 L283.6,376.0 Q283.6,380 279.6,380 L168,380 Z" fill="#2a78d6"><title>Array copy (cp): KVM 5.60 GB/s</title></path>
<text x="290.6" y="376" font-size="11.5" fill="#1f2937">5.6</text>
</svg>

Sequential read, write, read-modify-write, and bzero agree within a few percent across all runs. The two copy variants consistently favor the guest (bcopy 9.6 vs 5.4 GB/s in the medians); we flag that as an open question rather than explain it away, but note its direction: a guest outrunning the native kernel is not virtualization overhead.

This parity is the interesting part. It rules out the lazy explanation for the latency numbers. The VM is not "slower hardware." The silicon delivers identical service to both kernels. Everything the VM loses, it loses in the seams between contexts, and those seams are exactly where operating systems spend their time.

## The Price of a Fast Wakeup

We said the gap is the idle loop. Here is the evidence, and the bill.

In a ping-pong benchmark like `lat_pipe` or `lat_ctx`, the partner process is blocked almost all the time, so its CPU is idle-waiting. On multikernel, that idle CPU executes mwait natively and a real IPI wakes it from C1 in a few hundred nanoseconds. Inside the guest, mwait is not available: idle means HLT, HLT means a VM exit, and every wakeup means the hypervisor re-entering the vCPU. That round trip, paid twice per ping-pong iteration, is most of the gap.

The evidence is that you can pay it off. KVM offers two ways, and we measured both:

<svg viewBox="0 0 720 386" role="img" aria-label="IPC latency across idle policies: multikernel sleeps and stays fast; KVM must choose" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">The price of a fast wakeup</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Four idle policies, median of three runs · microseconds, shorter is better</text>
<rect x="0" y="62" width="12" height="12" rx="3" fill="#a88428"/>
<text x="18" y="72" font-size="12" fill="#1f2937">Multikernel <tspan fill="#6b7280">&#183; sleeps in hardware C-states</tspan></text>
<rect x="360" y="62" width="12" height="12" rx="3" fill="#2a78d6"/>
<text x="378" y="72" font-size="12" fill="#1f2937">KVM, HLT idle (default) <tspan fill="#6b7280">&#183; sleeps, VM-exits on every wake</tspan></text>
<rect x="0" y="88" width="12" height="12" rx="3" fill="#1baf7a"/>
<text x="18" y="98" font-size="12" fill="#1f2937">KVM, idle=poll <tspan fill="#6b7280">&#183; never sleeps, burns the idle CPU</tspan></text>
<rect x="360" y="88" width="12" height="12" rx="3" fill="#4a3aa7"/>
<text x="378" y="98" font-size="12" fill="#1f2937">KVM, mwait passthrough <tspan fill="#6b7280">&#183; sleeps, needs dedicated cores</tspan></text>
<line x1="320.8" y1="120" x2="320.8" y2="360" stroke="#e5e7eb" stroke-width="1"/>
<text x="320.8" y="376" font-size="11" fill="#9ca3af" text-anchor="middle">2 &#181;s</text>
<line x1="445.6" y1="120" x2="445.6" y2="360" stroke="#e5e7eb" stroke-width="1"/>
<text x="445.6" y="376" font-size="11" fill="#9ca3af" text-anchor="middle">4 &#181;s</text>
<line x1="570.4" y1="120" x2="570.4" y2="360" stroke="#e5e7eb" stroke-width="1"/>
<text x="570.4" y="376" font-size="11" fill="#9ca3af" text-anchor="middle">6 &#181;s</text>
<text x="186" y="161.0" font-size="12.5" fill="#1f2937" text-anchor="end">Context switch (2 procs)</text>
<path d="M196,128 L277.5,128 Q281.5,128 281.5,132.0 L281.5,137.0 Q281.5,141 277.5,141 L196,141 Z" fill="#a88428"><title>Context switch (2 procs), Multikernel: 1.37 microseconds</title></path>
<text x="287.5" y="138.5" font-size="11" fill="#1f2937">1.37</text>
<path d="M196,143 L405.4,143 Q409.4,143 409.4,147.0 L409.4,152.0 Q409.4,156 405.4,156 L196,156 Z" fill="#2a78d6"><title>Context switch (2 procs), KVM, HLT idle (default): 3.42 microseconds</title></path>
<text x="415.4" y="153.5" font-size="11" fill="#1f2937">3.42</text>
<path d="M196,158 L285.0,158 Q289.0,158 289.0,162.0 L289.0,167.0 Q289.0,171 285.0,171 L196,171 Z" fill="#1baf7a"><title>Context switch (2 procs), KVM, idle=poll: 1.49 microseconds</title></path>
<text x="295.0" y="168.5" font-size="11" fill="#1f2937">1.49</text>
<path d="M196,173 L290.6,173 Q294.6,173 294.6,177.0 L294.6,182.0 Q294.6,186 290.6,186 L196,186 Z" fill="#4a3aa7"><title>Context switch (2 procs), KVM, mwait passthrough: 1.58 microseconds</title></path>
<text x="300.6" y="183.5" font-size="11" fill="#1f2937">1.58</text>
<text x="186" y="237.0" font-size="12.5" fill="#1f2937" text-anchor="end">Pipe latency</text>
<path d="M196,204 L393.9,204 Q397.9,204 397.9,208.0 L397.9,213.0 Q397.9,217 393.9,217 L196,217 Z" fill="#a88428"><title>Pipe latency, Multikernel: 3.24 microseconds</title></path>
<text x="403.9" y="214.5" font-size="11" fill="#1f2937">3.24</text>
<path d="M196,219 L632.6,219 Q636.6,219 636.6,223.0 L636.6,228.0 Q636.6,232 632.6,232 L196,232 Z" fill="#2a78d6"><title>Pipe latency, KVM, HLT idle (default): 7.06 microseconds</title></path>
<text x="642.6" y="229.5" font-size="11" fill="#1f2937">7.06</text>
<path d="M196,234 L400.4,234 Q404.4,234 404.4,238.0 L404.4,243.0 Q404.4,247 400.4,247 L196,247 Z" fill="#1baf7a"><title>Pipe latency, KVM, idle=poll: 3.34 microseconds</title></path>
<text x="410.4" y="244.5" font-size="11" fill="#1f2937">3.34</text>
<path d="M196,249 L409.9,249 Q413.9,249 413.9,253.0 L413.9,258.0 Q413.9,262 409.9,262 L196,262 Z" fill="#4a3aa7"><title>Pipe latency, KVM, mwait passthrough: 3.49 microseconds</title></path>
<text x="419.9" y="259.5" font-size="11" fill="#1f2937">3.49</text>
<text x="186" y="313.0" font-size="12.5" fill="#1f2937" text-anchor="end">AF_UNIX latency</text>
<path d="M196,280 L492.4,280 Q496.4,280 496.4,284.0 L496.4,289.0 Q496.4,293 492.4,293 L196,293 Z" fill="#a88428"><title>AF_UNIX latency, Multikernel: 4.81 microseconds</title></path>
<text x="502.4" y="290.5" font-size="11" fill="#1f2937">4.81</text>
<path d="M196,295 L659.0,295 Q663.0,295 663.0,299.0 L663.0,304.0 Q663.0,308 659.0,308 L196,308 Z" fill="#2a78d6"><title>AF_UNIX latency, KVM, HLT idle (default): 7.48 microseconds</title></path>
<text x="669.0" y="305.5" font-size="11" fill="#1f2937">7.48</text>
<path d="M196,310 L404.0,310 Q408.0,310 408.0,314.0 L408.0,319.0 Q408.0,323 404.0,323 L196,323 Z" fill="#1baf7a"><title>AF_UNIX latency, KVM, idle=poll: 3.40 microseconds</title></path>
<text x="414.0" y="320.5" font-size="11" fill="#1f2937">3.40</text>
<path d="M196,325 L504.4,325 Q508.4,325 508.4,329.0 L508.4,334.0 Q508.4,338 504.4,338 L196,338 Z" fill="#4a3aa7"><title>AF_UNIX latency, KVM, mwait passthrough: 5.01 microseconds</title></path>
<text x="514.4" y="335.5" font-size="11" fill="#1f2937">5.01</text>
</svg>

Latency is only half of each bar's story. We also measured what every configuration costs while the guest sits completely idle, host CPU utilization of the two cores and package power over the no-VM baseline:

| Idle policy | Ctx switch | Pipe | Host view of the idle cores | Idle power, alone on the socket |
|---|---|---|---|---|
| Multikernel, C-states | 1.37 µs | 3.24 µs | ceded, sleeping in C1-C6 | baseline |
| KVM, HLT (default) | 3.42 µs | 7.06 µs | ~0% busy | baseline |
| KVM, idle=poll | 1.49 µs | 3.34 µs | 100% busy, spinning | +19 W |
| KVM, mwait passthrough | 1.58 µs | 3.49 µs | 100% busy, though the silicon is in C1 | +12 W |

Only one row gets low latency and cheap idle at the same time.

Boot the guest with `idle=poll` and the vCPU never sleeps: pipe latency lands within 3% of multikernel, the context switch within 9%, and the AF_UNIX round-trip actually beats it (3.40 µs vs 4.81 µs). The price is not hypothetical. With the guest completely idle, we measured both host cores at 100% utilization and package power up 19 W over baseline, spent on nothing. That defeats consolidation, power management, and every reason the hypervisor wanted those cores back.

This is also, roughly, where a stock distribution guest lives once its hypervisor promises it dedicated cores. The `haltpoll` cpuidle driver spins for a few microseconds before halting, and for wakeups this fast it behaves like the poll column and spends the poll column's CPU for the duration of the ping-pong. It is the better-engineered version of the same bargain: because it halts once the guest goes properly idle, it does not hold 19 W forever, and because it only wins by spinning, it does not get you a fast wakeup and a free core at the same time. Nothing does. That is the point of this table, and it is why the 2.5x in the section above is a fact about one configuration rather than a fact about virtualization.

Or launch QEMU with `-overcommit cpu-pm=on`, which passes mwait through so the guest can sleep for real. Latency comes within 4 to 15% of multikernel, but the fine print is expensive. The guest only ever reaches C1, leaving package power 12 W over baseline, and no flag fixes that: the instruction is passed through, the knowledge of deeper states is not (no mwait sub-state CPUID leaf for intel_idle, no C-states in QEMU's ACPI tables), and every incentive says it stays withheld, because cores sleeping in C6 fund the whole socket's turbo budget, a lever no hypervisor hands to one tenant among many. Meanwhile the vCPU thread never exits on idle, so the host sees the cores as 100% busy even while the silicon sleeps: it cannot tell guest-idle from guest-work, cannot harvest idle cycles, and overcommitting such a vCPU is pointless, since the first co-tenant brings the scheduler back into every wakeup.

## Frequency Is Not Yours Either

C-states are only half of power policy; the other half is frequency, and there the guest holds even fewer cards. Inside our VM the cpufreq directory is simply empty: no driver, no governor, no P-state interface, and /proc/cpuinfo reports a constant nominal 2000 MHz whatever the silicon is doing. Frequency belongs to the host's governor, which steers by host-visible load: a polling vCPU reads as flat-out busy and is held at turbo, which is nearly all of the poll column's wattage, while a HLT-idle vCPU parks at its 800 MHz floor between wakeups, so the frequency ramp rides on top of the exit cost. We measured the frequency knob's whole trade by capping the polling guest's cores from the host:

| Polling guest clock | Package power over baseline | Pipe latency | Null syscall |
|---|---|---|---|
| 3.8 GHz (turbo, the default) | +13.7 W | 3.34 µs | 0.099 µs |
| 2.0 GHz (capped to base clock) | +9.5 W | 4.85 µs | 0.177 µs |
| 0.8 GHz (capped to the floor) | +0.7 W | not measured | not measured |

Capping to base saves 4 W and multiplies every clock-bound latency by exactly the clock ratio (1.9x, verified by L1 latency moving from 1.31 to 2.51 ns); capping to the floor erases the power cost along with the latency the polling existed to buy. A static frequency cap is the manual, always-on version of what a C-state does per microsecond; the native kernel gets the dynamic version, full clock at wakeup and floor power in idle, and the guest can only pick one half and keep it. The market rations this lever even more tightly than sleep: on EC2, P-state control remains confined to older whole-socket types and bare metal even where C-state control has spread, because turbo budget belongs to the whole package. The multikernel instance simply runs its own cpufreq governor on its own cores, though it partitions the control, not the physics. None of this skews our comparison: identical L1 latencies pin both sides at the same effective clock during the measured loops.

## What the Watts Are Worth

Do the watts matter, then? As electricity, barely: a lone polling guest costs 14 to 19 W (almost entirely turbo, as the table above shows), and stacking shows each additional one adds only 1 to 5 W, because multi-core turbo lowers everyone's clock as the socket fills, polling guests measurably stealing turbo budget from each other and from real work. At industrial rates behind a datacenter PUE that is about $20 a year in the worst case and a few dollars stacked. The watts earn their place here for a different reason: they are the only honest signal left. Host CPU accounting reads the same 100% for a spinning guest, a C1-sleeping guest, and a genuinely busy one; package power is how we could tell them apart at all. And what they point to is the actual bill: those cores read busy forever, so the host can never place another tenant on them, and each latency-tuned guest permanently strands capacity a cloud would sell as a 2-vCPU instance, $260 to $880 a year at retail, near $150 at amortized server cost. The wattage is the receipt; the stranded silicon is the price. The idle multikernel instance, meanwhile, draws baseline power because its cpuidle governor has the menu a native kernel has: C1's few-hundred-nanosecond wakeup during active ping-pong, C6 during long idle. The guest's menu has no such entry: HLT (cheap, but 2.5x), polling (fast, a core spent on nothing), or shallow mwait (a core the host can no longer account for).

## Where the Industry Sits

The industry has already seated itself around this menu, and the seating chart is in official documentation. Host-side, KVM ships its own polling layer: the host spins for up to a configurable window before scheduling out a halted vCPU ([halt polling](https://docs.kernel.org/virt/kvm/halt-polling.html){:target="_blank" rel="noopener noreferrer"}), trading host CPU for wakeup latency fleet-wide. Guest-side, the [haltpoll driver and governor](https://docs.kernel.org/virt/guest-halt-polling.html){:target="_blank" rel="noopener noreferrer"} do the same from inside the VM, and Ubuntu ships that driver as a module in its stock kernels. It loads itself only where the hypervisor advertises KVM's realtime hint, the flag whose defined meaning is that vCPUs are never preempted, which is to say: on dedicated cores. So a stock distribution guest on an ordinary shared instance idles in the HLT column, and moves to the poll column exactly when its cores stop being shared. Even the polling workaround is rationed by core ownership. And the mwait column is sold as a product feature under its own name: EC2 [processor state control](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/processor_state_control.html){:target="_blank" rel="noopener noreferrer"} hands C-state control to guests on bare metal instances, on the largest sizes of the older instance families, and on all sizes of the newest generations, where a tenant's vCPUs own their physical cores outright. The direction of that list is the point: sleep-state control is granted exactly as far as core ownership extends, and no further.

Notice what just happened. To make the VM fast we pinned its vCPUs to dedicated cores, then gave it exclusive control of their sleep states. Follow that ladder to the end and the guest is no longer sharing anything: it is a static hardware partition, hand-assembled from hypervisor exemptions. And even then the residue stays. A null syscall held near 1.4x and signal registration near 1.3x across the poll and mwait guests as well, with the entire virtualization stack still resident and still inside the trust boundary.

## Caveats

The medians above come from three full-suite runs per configuration, and the spread is worth stating. The multikernel side is strikingly stable across runs (its widest spread was the context switch, 1.01 to 1.38 µs); the guest's wakeup numbers swing more (pipe ranged 5.8 to 7.2 µs across its default-idle runs), which is itself a symptom of the machinery underneath. The two configurations ran on different physical core pairs of the same socket (we verified all four cores share package 0, minding that kerf takes physical APIC IDs while taskset takes logical CPU numbers). Two metrics are excluded because the two sides boot different root filesystems: fork+execve loads the binary through the filesystem, where the guest is consistently faster (214 µs on tmpfs vs 315 µs on DAXFS), and lat_pagefault faults against it (0.15 µs vs 1.74 µs). Both measure DAXFS against tmpfs, not virtualization. fork+/bin/sh crosses those same filesystems but lands at 1.04x regardless, so we kept it. And a production VM sharing an oversubscribed host pays the measured floor plus scheduling on top.

## Reproduce It Yourself

Everything runs from a stock lmbench built out of the `autubrew/lmbench` Docker image, exported once to a plain rootfs directory that both worlds share:

```bash
docker run --name lmbench-build --entrypoint /bin/bash \
    autubrew/lmbench -c 'cd /root/lmbench/src && make -j8'
docker export lmbench-build | tar -x -C /root/lmbench-rootfs
```

The multikernel side loads that directory with `kerf load --rootfs-dir` and reads results from the DAXFS overlay on the host. The KVM side packs the same directory into an initramfs and replays the result file over the serial console. One driver script, two boots, one diff.

The complete scripts are published as a [GitHub Gist](https://gist.github.com/congwang-mk/fc44d8bcca520c607255a93012e81874){:target="_blank" rel="noopener noreferrer"}, exactly as they ran: `lmbench-full-daxfs.sh` boots the multikernel instance, `lmbench-vm.sh` boots the KVM guest, both execute the shared `run-lmbench.sh` driver (the guest through `vm-init.sh`), and `run-matrix.sh` produced the three-run medians reported throughout.

We encourage you to run this on your own hardware. The absolute numbers will move with CPU generation, kernel version, and idle policy. The shape will not: the memory system reaches parity because that was a hardware problem and hardware solved it; the wakeup paths reach parity only when you stop sharing the hardware; and the kernel-entry residue never reaches parity at all, because that one is the price of having a hypervisor in the loop.

## The Itemized Bill

Add up what this post measured. A guest with every hardware assist of 2026 matches native memory to the nanosecond, then pays 2.5x on the context switch, 2.2x on the pipe, and about 30 ns at every kernel entry. It can buy the wakeups back: spin and spend a core, or take mwait and blind its host. But after every purchase the receipt reads the same. The fastest virtual machine we could assemble was one that had stopped sharing anything, slept in a single shallow state it could not deepen, ran at a clock it could not see, looked permanently busy to the host that owned it, and still arrived 30 ns late to every syscall. That is not a slow VM. That is the best one.

The multikernel instance, meanwhile, held every number the tuned guest was chasing while doing none of the chasing: idle in C6, waking at full clock, drawing baseline power, its cores honestly accounted, because every decision was made by a kernel that owned the hardware it was deciding about. Fast was not a configuration. It was the default.

So the finding fits in one sentence. In 2026, the virtualization tax is no longer paid in performance; it is paid in the sharing, the sleep, and the honesty you must surrender to get the performance back. A hypervisor's limit is a partition that pays rent. A multikernel starts as the partition, and keeps the rent.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}. If you are rethinking what isolation has to cost, we would love to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
