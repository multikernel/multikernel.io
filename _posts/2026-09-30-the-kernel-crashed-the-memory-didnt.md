---
layout: post
title: "The Kernel Crashed, but the Memory Didn't"
date: 2026-09-30 12:00:00 -0700
categories: [multikernel, daxfs, linux-kernel, reliability, filesystem]
author: Cong Wang, Founder and CEO
excerpt: "A kernel panic is a memory-loss event: every process on the machine loses everything it held in RAM, and every cache, index, and working set starts over cold. This year's SOSP has a paper that attacks the storage half of that problem by running two kernels instead of two caches. We ran the other half. An app-kernel wrote a file on DAXFS through a plain mmap, then panicked itself mid-write, four times in a row. Each time, a fresh kernel booted on the same memory and found every byte exactly where the dead one left it, down to a single half-written page. There was no log to replay and nothing to reload. Recovery was a boot."
---

A kernel panic does not only stop a machine. It erases it. Every process loses every byte it kept in RAM: the cache that took an hour to warm, the index that took ten minutes to load, the model weights that took a minute to page in. When the machine comes back, all of it is rebuilt from somewhere slower, and the somewhere slower usually has other customers.

That is why stateful software is so defensive about memory. Databases write logs before they touch their pages. Caches treat a restart as a thundering herd waiting to happen. And a paper at this year's SOSP shows how far the defense has to go when the operating system cannot help.

This post is about removing one of the reasons for that defense. We ran an application in a multikernel app-kernel, let it write a file on [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"} through an ordinary `mmap`, and panicked its kernel in the middle of a write. Four times in a row. Each time a fresh kernel booted on the same memory, and each time it found every byte exactly where the dead kernel left it, down to one page caught halfway through being rewritten. The application picked up where it stopped. There was no log to replay and nothing to reload. Recovery was a boot.

## Two Kernels Instead of Two Caches

The SOSP '26 paper is [VoliStorM: A Crash-Consistent I/O Cache with Two Kernels Instead of Two Caches](https://dl.acm.org/doi/10.1145/3830418.3843887){:target="_blank" rel="noopener noreferrer"}, by Jana Toljaga et al. of Inria and Télécom SudParis. It is worth reading in full. Its argument goes like this.

Applications that must keep data consistent across crashes need two things: a cache in DRAM, mapped into their address space, because storage is still an order of magnitude slower than memory; and failure-atomic sections, so that a crash in the middle of an update leaves either all of it or none of it. The Linux page cache provides the first and cannot provide the second. It writes dirty pages back whenever its LRU decides to, in whatever order, so after a crash an application cannot know which half of its update reached the disk. Enforcing consistency through the file system works, but slowly: the authors measured 89 µs to persist one modified page with ext4 in data journaling mode and 337 µs with btrfs, against a 10.5 µs NVMe round trip.

So applications leave. Redis, PostgreSQL, MySQL, and RocksDB each build a second cache in user space with their own logging, and the paper counts more than 3,400 lines of Redis dedicated to persistence alone. Worse, the authors argue this is not a Linux defect that tuning can fix. A general-purpose kernel's page cache is shared with the LRU, NUMA balancing, readahead, KSM, and copy-on-write, and every write that passes through it pays to synchronize with all of them. Mapping one file page costs Linux 5.1 µs, of which 0.7 µs is the fault and the page table update. The rest is the price of generality.

Their answer is to stop asking one kernel to be good at everything. VoliStorM keeps Linux as the general-purpose kernel that owns the cache, and adds a second, latency-oriented kernel with its own page table that tracks exactly which pages a failure-atomic section dirtied and logs them. The second kernel is a small library OS: using KVM, it moves the application into a lightweight virtual machine, in the style of Dune, and forwards system calls back to Linux. Ported applications beat their own hand-built persistence, by up to 74% on Redis, with a small fraction of the code.

We read this paper with a lot of recognition. "A general-purpose kernel is the wrong place for this path, so give the path its own kernel" is the multikernel thesis applied to storage. But the two kernels in VoliStorM share one fate: the second kernel lives inside a process on the first, so when Linux panics, both go down together, and the memory with them. That raised the question this post answers. What happens to an application's memory when its kernel is a real, independent kernel, and that kernel is the one that crashes?

## Change the Failure, Change the Problem

In VoliStorM's world, and in every database's, there are two copies of the data. The cache is volatile and the disk is durable, and a crash throws away the cache and leaves the disk in whatever state writeback got it to. That is why failure-atomic sections are needed: the durable copy is an arbitrary mix of old and new pages, and only a log can say which mix is valid.

A multikernel machine changes that failure. One kernel, the device-kernel, is the one firmware booted. It owns the hardware and the memory pool, and in the configuration we care about it runs no applications at all. It does run every device driver, historically the largest source of kernel crashes, and that split is deliberate: an app-kernel runs no hardware drivers, only virtio front-ends served by the device-kernel, so a buggy NIC or storage driver cannot panic it. Driver crashes are contained in the device-kernel, and what an app-kernel has left to crash on is its own workload. Applications run in app-kernels, each on its own cores and memory. When an app-kernel panics, its CPUs stop and park, and the device-kernel is still running. Memory the device-kernel owns is not touched. If the application's data lives there, nothing is lost and nothing is torn by writeback, because there is no writeback: there is one copy, and it holds exactly what the application had written when its CPU stopped.

That shrinks the problem from "survive power loss" to "survive being stopped at an arbitrary instruction with your memory intact". It is a much easier problem. It is also the one behind the routine ways a machine with redundant power loses its memory, which are software: kernel panics, kernel updates, reboots. Each of those is a cold restart today.

## Where the Memory Lives

DAXFS is our shared-memory filesystem for exactly this layout. An image lives in a region of physical memory, and any kernel on the machine can mount it by address. For this test we used the path [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} already uses to give an app-kernel its root filesystem: kerf allocates the region from the multikernel memory pool through a DMA heap, writes a DAXFS image into it, mounts it on the device-kernel, and boots the app-kernel with that region as its root. Four properties of that arrangement do all the work.

**The device-kernel owns the memory.** The region is a dma-buf allocated on the device-kernel, and the device-kernel's mount holds the reference. It is not part of the app-kernel's memory grant, so tearing down a crashed app-kernel never frees it.

**Mounting attaches; it never formats.** DAXFS's mount path validates the superblock and points at the regions already there: the overlay hash table, the page pool, the inode entries, the directory entries. Only `mkdaxfs` writes a fresh image. A second mount of the same region sees the same filesystem as the first.

**All filesystem state is in the region.** File data lives in overlay pages, file sizes in overlay inode entries, names in overlay directory entries. What each kernel keeps privately, the inode cache and the page tables, is a cache of the region, rebuilt on lookup and on fault.

**`mmap` is the memory itself.** A write fault on a shared DAXFS mapping copies the page from the base image into the overlay once and maps that physical page straight into the process. From then on every store the application makes lands directly in the shared region. There is no page cache in between, no dirty bit for anyone to write back, and no second copy.

<svg viewBox="0 0 720 360" role="img" aria-label="A DAXFS region owned by the device-kernel survives an app-kernel panic and is mapped again by the next app-kernel" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<defs><marker id="dah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#6b7280"/></marker></defs>
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">One region, two generations of app-kernel</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">The device-kernel owns the DAXFS region; app-kernels come and go on top of it</text>
<rect x="0" y="64" width="330" height="130" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="165" y="86" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">App-kernel, generation 1</text>
<rect x="30" y="100" width="270" height="36" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="165" y="123" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">application, stores through mmap</text>
<rect x="30" y="146" width="270" height="36" rx="6" fill="#fdecec" stroke="#c0392b" stroke-width="1.2"/>
<text x="165" y="169" font-size="12.5" font-weight="600" fill="#c0392b" text-anchor="middle">panic: CPUs stop and park</text>
<rect x="390" y="64" width="330" height="130" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="555" y="86" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">App-kernel, generation 2</text>
<rect x="420" y="100" width="270" height="36" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="555" y="123" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">same loaded kernel, booted again</text>
<rect x="420" y="146" width="270" height="36" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="555" y="169" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">mount by address, map the same pages</text>
<line x1="330" y1="129" x2="390" y2="129" stroke="#6b7280" stroke-width="1.6" stroke-dasharray="5,4" marker-end="url(#dah)"/>
<text x="360" y="120" font-size="10.5" fill="#6b7280" text-anchor="middle">kerf start</text>
<rect x="0" y="214" width="720" height="130" rx="10" fill="#fbf8f1" stroke="#e5e7eb"/>
<text x="360" y="236" font-size="13" font-weight="600" fill="#a88428" text-anchor="middle">Device-kernel (runs no applications, owns the memory pool)</text>
<rect x="150" y="250" width="420" height="78" rx="6" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="360" y="272" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">DAXFS region (dma-buf held by the device-kernel's mount)</text>
<text x="360" y="292" font-size="11" fill="#6b7280" text-anchor="middle">superblock · overlay hash table · page pool · inodes · dirents</text>
<text x="360" y="310" font-size="11" fill="#6b7280" text-anchor="middle">file pages mapped straight into the application, no page cache</text>
<line x1="165" y1="194" x2="250" y2="250" stroke="#6b7280" stroke-width="1.6" marker-end="url(#dah)"/>
<line x1="555" y1="194" x2="470" y2="250" stroke="#6b7280" stroke-width="1.6" marker-end="url(#dah)"/>
</svg>

Put those together and the claim follows: when an app-kernel dies, its files on DAXFS are still there, including the bytes it stored a nanosecond before it died, and the next kernel to mount the region will see them. That is a claim you should not believe from a description. So we tried to break it.

## The Experiment

The machine is the dual-socket Intel Xeon Gold 5418Y from our previous posts, running the `7.0.0-mk2+` multikernel build. The app-kernel got two dedicated cores and 1 GB, and its root filesystem was a DAXFS image created by kerf in the device-kernel's memory pool:

```
kerf create dt --cpus=2,4 --memory=1024MB
kerf load dt --kernel=/boot/vmlinuz-7.0.0-mk2+ --initrd=daxfs-initrd.img \
    --rootfs-dir=/root/dt/rootfs --entrypoint='/daxtest cycle /state 256 10'
kerf start dt
```

The test program is a small static C binary that serves as the app-kernel's entrypoint. It maps a file on the DAXFS root, a header page plus 256 data pages, and writes it in rounds. In round *r*, every 8-byte word of data page *i* gets the stamp `(r << 20) | i`, pages in ascending order and words within a page in ascending order, and when a round is complete the header records its number:

```c
for (r = h->done + 1;; r++) {
	for (i = 0; i < npages; i++)
		for (w = 0; w < WORDS; w++)
			data[i * WORDS + w] = stamp(r, i);
	h->done = r;
}
```

Those stamps make the file self-describing. If the memory holds exactly what the application wrote up to the instant its CPU stopped, the file must read as a clean frontier: pages before it carry round *done*+1, pages after it carry round *done*, and at most one page, the one being written, holds a prefix of new words followed by a suffix of old ones. A lost store, a stale page, a page from the wrong round, or new data appearing after old data would each break that pattern, and the verifier counts every word that does.

Each boot runs one cycle. The entrypoint first verifies whatever file survived the previous boot and appends the verdict to a log on the same DAXFS root. Then it forks the writer, sleeps ten seconds, and panics its own kernel with `echo c > /proc/sysrq-trigger`: a real panic, in the middle of the writer's stores. On the device-kernel, a script waits for the instance to park, verifies the file through the device-kernel's own mount of the region, and boots the same loaded app-kernel again with `kerf start`. It did that four times.

## Four Panics

Every round ended the same way on the device-kernel: `Instance 1 (dt) halted, CPUs parking in pool`, and the instance went back to the loaded state, ready to boot again.

| Panic | Last complete round | Frontier | Torn page | Verified by the device-kernel | Verified by the next app-kernel |
|---|---|---|---|---|---|
| 1 | 395,012 | 197 of 256 | page 197, 468 of 512 words new | pass, 0 bad words | identical, pass |
| 2 | 841,890 | 1 of 256 | page 1, 115 of 512 words new | pass, 0 bad words | identical, pass |
| 3 | 1,289,978 | 49 of 256 | page 49, 94 of 512 words new | pass, 0 bad words | identical, pass |
| 4 | 1,736,965 | 45 of 256 | page 45, 505 of 512 words new | pass, 0 bad words | not booted again |

<svg viewBox="0 0 720 260" role="img" aria-label="The state of the 256-page file at each of four panics: new pages up to a frontier, one torn page, old pages after" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">What the memory held at each panic</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">256 data pages, left to right · every page is exactly one of three states</text>
<rect x="120" y="52" width="12" height="12" rx="2" fill="#2a78d6"/><text x="137" y="62" font-size="12" fill="#1f2937">rewritten in the round in progress</text>
<rect x="352" y="52" width="12" height="12" rx="2" fill="#c0392b"/><text x="369" y="62" font-size="12" fill="#1f2937">torn: new prefix, old suffix</text>
<rect x="548" y="52" width="12" height="12" rx="2" fill="#d1d5db"/><text x="565" y="62" font-size="12" fill="#1f2937">last complete round</text>
<text x="100" y="101" font-size="12.5" fill="#1f2937" text-anchor="end">Panic 1</text>
<rect x="110" y="86" width="461.7" height="22" fill="#2a78d6"/><rect x="571.7" y="86" width="2.3" height="22" fill="#c0392b"/><rect x="574.1" y="86" width="135.9" height="22" fill="#d1d5db"/>
<text x="100" y="141" font-size="12.5" fill="#1f2937" text-anchor="end">Panic 2</text>
<rect x="110" y="126" width="2.3" height="22" fill="#2a78d6"/><rect x="112.3" y="126" width="2.3" height="22" fill="#c0392b"/><rect x="114.7" y="126" width="595.3" height="22" fill="#d1d5db"/>
<text x="100" y="181" font-size="12.5" fill="#1f2937" text-anchor="end">Panic 3</text>
<rect x="110" y="166" width="114.8" height="22" fill="#2a78d6"/><rect x="224.8" y="166" width="2.3" height="22" fill="#c0392b"/><rect x="227.2" y="166" width="482.8" height="22" fill="#d1d5db"/>
<text x="100" y="221" font-size="12.5" fill="#1f2937" text-anchor="end">Panic 4</text>
<rect x="110" y="206" width="105.5" height="22" fill="#2a78d6"/><rect x="215.5" y="206" width="2.3" height="22" fill="#c0392b"/><rect x="217.8" y="206" width="492.2" height="22" fill="#d1d5db"/>
<text x="110" y="248" font-size="11" fill="#9ca3af">page 0</text>
<text x="710" y="248" font-size="11" fill="#9ca3af" text-anchor="end">page 255</text>
</svg>

Four things are worth reading out of that table.

**Nothing was lost.** Every image is a clean frontier with exactly one torn page, and not a single word in 1 MB was foreign, stale, or out of order. That is the memory image at the instant of the panic, with every store the application made before it and none after.

**Nothing changed across the remount.** The next app-kernel mounted the region from scratch and saw the file word for word as the device-kernel did: same completed round, same frontier, same count of new words in the torn page. Mount attached to the memory. It did not format it, repair it, or replay anything into it.

**The application resumed.** The writer starts from the header's round counter, and the counter climbed across boots: 395,012, then 841,890, then 1,289,978, then 1,736,965. Each generation of the application continued the work of the one before it, on state it never had to load.

**The hardware kept the last stores, not software.** The writer made about 40,000 passes over the 1 MB file a second, more than one core can push to DRAM, so the file was living in the core's private cache. When the panic hit, the newest lines were dirty in the cache of a core that would never run this kernel again. They were not lost, because caches on one machine are coherent: those lines were either served to the reader by the coherence protocol or written back when the parked core dropped into deep idle. Either way, no flush instruction, no `msync`, and no kernel code on the dying side was involved.

## Does It Have to Be Transactional?

The torn page is the honest part of the result. DAXFS gives back exactly the memory the application had. It does not make a half-finished update atomic, and it should not pretend to. Whether an application can use that image depends on whether it can survive being stopped at an arbitrary instruction with its memory intact, and a surprising amount of software already can.

| Application | What it needs from the memory | Needs transactions from DAXFS? |
|---|---|---|
| Lock-free data structures, where each update commits with one compare-and-swap | Nothing more: they tolerate a thread dying anywhere by design | No |
| Software with its own write-ahead log or commit protocol | Stores that become visible in program order | No |
| Code written for persistent memory, such as PMDK | A mapping that behaves like persistent memory whose flushes are free | They bring their own |
| Caches | Per-item checksums; rebuild the index and drop torn items at startup | No |
| Legacy code with no persistence logic | Consistency at arbitrary instants | Yes, or snapshots at quiescent points |

The second row deserves a note. On x86, stores to coherent memory become visible to other CPUs in program order, so an application that writes a log record and then a commit flag with plain stores already gets the ordering it needs against a kernel crash, with no system call and no cache flush. On Arm the same code needs a barrier instruction between the two, which it already has if it was written for persistent memory. DAXFS itself is in the first row: its overlay is a lock-free hash table built on compare-and-swap, which is why a kernel that dies in the middle of creating a file leaves the filesystem structurally valid.

Only the last row needs what VoliStorM builds, and for that row VoliStorM's failure-atomic sections are a fine design. The difference is where the durable copy lives and what kind of crash it has to survive.

## Side by Side

| | VoliStorM | Multikernel with DAXFS |
|---|---|---|
| Second kernel | Library OS in a KVM guest inside the application's process | An independent kernel on its own cores and memory |
| Failure domain | Shared: if Linux panics, both kernels and the cache go down together | Separate: an app-kernel panic leaves the device-kernel and the memory intact |
| After a crash | The cache is lost; committed data is replayed from the log | After an app-kernel panic, the memory is still there, every store up to the panic |
| Durability | Committed data is logged to PMEM or NVMe | Not today; the region is DRAM and does not survive power loss |
| Application changes | Failure-atomic sections, 137 lines for Redis | None to keep memory across a crash; consistency is the application's, as in the table above |
| Recovery | Replay the committed log, then restart the application | Boot the app-kernel and map the file |

These systems are not really competitors. VoliStorM answers "how do I make storage writes consistent and fast" and ends up needing a second kernel. We answer "how do I keep a crash from destroying memory" and end up with a filesystem that looks like the cache VoliStorM wants. A combination is easy to imagine: VoliStorM's logging for power loss, running on top of memory that already survives the far more common failure.

## Before You Quote These Numbers

This is a correctness experiment, not a benchmark, and its limits are specific.

It covers app-kernel crashes and nothing else. The region is DRAM, so power loss or a crash of the device-kernel itself takes it away. The device-kernel runs no applications, but it does run every device driver, so a driver crash there is exactly the case this experiment does not cover. The path for it is a standby app-kernel that fences a crashed device-kernel and adopts its CPUs and memory; that work is in progress and has not been tested with DAXFS. Surviving a device-kernel update means preserving the region across a kexec of the device-kernel, which is separate work.

Reattaching is only safe once the dead kernel is really dead. A CPU of the crashed kernel that is still running, or a device assigned to it that is still writing by DMA, could corrupt the region after the next kernel mounts it. Our force-halt path confirms every CPU of an instance is parked before its resources are reused. Blocking the dead kernel's devices in the IOMMU is the other half, and the reattach path should enforce both.

A crash in the middle of a filesystem operation, rather than a store to a mapped page, can leak a little: a page allocated from the pool but never published, or an inode created halfway. DAXFS publishes after it initializes, so these are leaks, not corruption, and reclaiming them needs the device-kernel to know which instance owned what.

Data that contains pointers must be mapped at the same virtual address after the restart, or use offsets instead of pointers. Our test used offsets implicitly: page numbers and stamps.

And it is one machine, one test program, and four panics. The program's pattern is designed to expose loss and reordering, not to model a database. The next experiment is a real one: a cache with a large working set, crashed under load, measured from the panic to full throughput and compared with a cold restart.

## Reproduce It Yourself

Build the [multikernel kernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} and [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}, load the DAXFS module on the device-kernel, and put it in the app-kernel's initrd. With [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}, `--rootfs-dir` gives the app-kernel a DAXFS root held by the device-kernel, and `kerf start` boots a loaded instance again on the same region after it panics. Any program that writes a recognizable pattern through a shared `mmap` and can verify it later will do. The one we used is the loop above plus a verifier that walks the pages looking for the frontier.

To see the same thing without an app-kernel restart in between, read the file from the device-kernel's mount of the region right after the panic. Drop the device-kernel's caches first with `echo 2 > /proc/sys/vm/drop_caches`, because its inode cache does not yet notice sizes and names changed by another kernel. The page contents, being the shared memory itself, are always current.

## Memory That Outlives Its Kernel

VoliStorM's authors started from a storage problem and concluded that one general-purpose kernel is the wrong place to solve it. We agree, and this experiment shows what the conclusion buys once the second kernel is real. When an application's kernel is independent and its memory belongs to a kernel that does not run applications, a kernel crash stops being a memory-loss event. The application's state is still there, complete up to its last store, and the next kernel maps it and carries on.

That turns the worst part of a panic, the cold restart, into a boot. It does not replace logging for power loss, and it does not make a torn update whole. But against the software failures that routinely wipe a machine's memory, the fastest recovery is having nothing to recover.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so are [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} and [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}. If you run stateful services that cannot afford a cold start, we would love to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
