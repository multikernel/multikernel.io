---
layout: post
title: "Why Large VMs Take So Long to Start"
date: 2026-10-14 10:00:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, memory-management, virtualization]
author: Cong Wang, Founder and CEO
excerpt: "A VM user asked whether multikernel could shorten the wait for a large-memory instance. They suspected allocation or pinning. On our test machine, preparing a 32 GiB QEMU guest took 6.81 seconds before its CPUs ran. Creating a 32 GiB multikernel instance from an existing physical pool took 111 milliseconds. A separate pinning experiment explained the difference: pinning fresh memory took 6.40 seconds, while pinning already populated memory took 16 milliseconds. Most of the wait was preparing the pages. The opportunity is to prepare physical capacity once and assign it across many instance lifetimes."
---

A VM user came to us with a startup problem. Their instances took a long time to start, and the wait appeared to be in memory allocation or pinning. They were interested in multikernel because it gives each kernel physical memory directly. There is no QEMU address space whose backing pages have to be pinned before the instance can use them.

That sounded plausible. It also left the most important question unanswered: what was actually taking the time? Finding free memory, clearing it, pinning it, and making it accessible to a device are different operations. They can happen inside the same request, and a long wait attributed to the last one can mostly belong to the first two.

So we measured them separately. On our test machine, a QEMU guest configured with 32 GiB of preallocated RAM took 6.81 seconds to become ready with its CPUs still stopped. Creating a multikernel instance with the same amount of physical memory, from a pool prepared beforehand, took 111 milliseconds for the whole `kerf create` command. Neither kernel had booted. This was the work of setting up the instance before boot could begin.

Then we separated the work hidden inside a pin request. Pinning a fresh 32 GiB mapping took 6.40 seconds, including the work of populating its missing pages. Populating the memory beforehand took 6.51 seconds, after which pinning added only 16 milliseconds. These are two ways to reach the same state: populated, pinned memory. Both took about 6.5 seconds. The population cost was paid once in each path.

## Who Waits for This?

Consider an operator who keeps physical capacity available for workers, but creates their execution environments when jobs arrive. A worker might need tens of gigabytes for an in-memory index, an analytics job, or the CPU-side data of an accelerator workload. The capacity is available. The job is queued. Before useful work can start, the environment has to acquire its memory.

For a worker that lives for a week, a few seconds of preparation barely matter. For workers that are frequently created and replaced, those seconds recur. They contribute to the delay before a burst of jobs can run, the time to replace a failed worker, and the interval between requesting more capacity and getting something usable. This is the use case we wanted to evaluate: large memory grants, repeated instance creation, and physical capacity that can be prepared ahead of demand.

Device passthrough makes the question especially relevant. A physical GPU or NIC doing DMA needs stable backing memory for the addresses it can access. In a conventional VFIO configuration, establishing that backing can bring allocation, population, page pinning, and IOMMU mapping onto the setup path. A user can reasonably call the whole delay “pinning,” even when pin bookkeeping accounts for only a small part of it. The [Linux page-pinning documentation](https://www.kernel.org/doc/html/latest/core-api/pin_user_pages.html){:target="_blank" rel="noopener noreferrer"} explains the distinction between ordinary page references and pins used for DMA.

Our experiment did not assign a passthrough device. We wanted to establish how much delay memory preparation alone could produce, and then separate it from the pin operation. Device initialization and IOMMU mapping would be additional work to measure for that user's configuration.

## Asking for Memory and Having Memory

QEMU is a host process, and guest RAM is backed by memory mapped into that process. A request for a 32 GiB mapping does not necessarily make 32 GiB of physical RAM appear immediately. Linux can provide the backing as the mapping is used.

That distinction makes a large lazy allocation cheap. It also means the work is still ahead of the workload. As pages become writable, the host must supply physical backing with the appropriate initial contents and establish the mappings needed to access it.

Preallocation brings that work forward. QEMU populates the backing before proceeding, so subsequent use does not have to discover missing pages one at a time. It buys more preparation at launch in exchange for less preparation later. QEMU documents this choice through its [memory backend and preallocation options](https://www.qemu.org/docs/master/system/qemu-manpage.html){:target="_blank" rel="noopener noreferrer"}.

Pinning serves a different purpose: it keeps the physical backing stable for an operation such as device DMA. Preallocation alone does not provide that guarantee. But a pin request needs pages to pin, so if the mapping is still unpopulated, the request must obtain its backing first. If preallocation has already supplied those pages, pinning can use them directly. It does not allocate and zero another copy of the RAM.

At 32 GiB, clearing memory means writing 32 GiB. A fast allocator cannot turn those writes into a metadata update. This is why we needed to distinguish the cost of assigning a range from the cost of preparing its contents.

## The Experiment

We used the same dual-socket Intel Xeon Gold 5418Y machine as our [earlier KVM comparison](/2026/08/16/multikernel-vs-kvm-lmbench/): 48 physical cores, two NUMA nodes, and about 125 GiB of usable RAM. The host ran the `7.0.0-mk2+` multikernel build. There was ample available memory, and the runs did not increase swap usage.

For QEMU/KVM, we created a q35 machine with one vCPU and either lazy or preallocated anonymous RAM. The vCPU remained stopped throughout. We timed from process creation through a successful monitor status response, then destroyed the process. No guest operating system was loaded or booted, and no disk or passthrough device was involved.

For multikernel, we first prepared a 34 GiB physical pool on NUMA node 0 with [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. We then timed the complete `kerf create` command for an instance with one CPU and the requested amount of memory. Every instance reached `ready`. We checked that its assigned physical ranges summed to the requested byte count, then deleted it before the next run. Kernel loading and boot were outside the measurement.

Each size and configuration was measured three times. The numbers below are medians, and GiB means powers of two throughout.

Two setup details matter. The installed QEMU was 4.2.1, using its default preallocation behavior with one vCPU. This is a measurement of that configuration, not a claim about the best achievable startup time with a current QEMU release and parallel population. Transparent huge pages backed the preallocated guest RAM; we did not reserve an explicit HugeTLB pool. The multikernel pool was on node 0, while QEMU used default host placement, so this was not a controlled NUMA-placement comparison.

## The Cost Before Boot

| Assigned RAM | QEMU, lazy backing | QEMU, preallocated backing | Multikernel, existing pool |
| :--- | ---: | ---: | ---: |
| 1 GiB | 88 ms | 392 ms | 107 ms |
| 8 GiB | 101 ms | 1,986 ms | 105 ms |
| 32 GiB | 96 ms | 6,812 ms | 111 ms |

<svg viewBox="0 0 720 320" role="img" aria-labelledby="memory-setup-title memory-setup-desc" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<title id="memory-setup-title">Instance resource setup time before boot</title>
<desc id="memory-setup-desc">QEMU preallocation takes 392, 1986, and 6812 milliseconds for 1, 8, and 32 GiB. Multikernel creation from an existing pool takes 107, 105, and 111 milliseconds. The horizontal scale is linear, from zero to seven seconds. Pool initialization and guest boot are excluded.</desc>
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">More RAM, more work before boot</text>
<rect x="0" y="38" width="12" height="12" rx="2" fill="#a88428"/>
<text x="20" y="49" font-size="12" fill="#6b7280">QEMU, preallocated</text>
<rect x="210" y="38" width="12" height="12" rx="2" fill="#2a78d6"/>
<text x="230" y="49" font-size="12" fill="#6b7280">Multikernel, existing pool</text>
<line x1="110" y1="67" x2="110" y2="263" stroke="#e5e7eb"/>
<line x1="250" y1="67" x2="250" y2="263" stroke="#e5e7eb"/>
<line x1="390" y1="67" x2="390" y2="263" stroke="#e5e7eb"/>
<line x1="530" y1="67" x2="530" y2="263" stroke="#e5e7eb"/>
<line x1="600" y1="67" x2="600" y2="263" stroke="#e5e7eb"/>
<text x="0" y="103" font-size="13" font-weight="600" fill="#1f2937">1 GiB</text>
<rect x="110" y="78" width="27.44" height="16" rx="2" fill="#a88428"/>
<text x="145" y="91" font-size="12" fill="#6b7280">392 ms</text>
<rect x="110" y="100" width="7.49" height="16" rx="2" fill="#2a78d6"/>
<text x="125" y="113" font-size="12" fill="#6b7280">107 ms</text>
<text x="0" y="168" font-size="13" font-weight="600" fill="#1f2937">8 GiB</text>
<rect x="110" y="143" width="139.02" height="16" rx="2" fill="#a88428"/>
<text x="257" y="156" font-size="12" fill="#6b7280">1,986 ms</text>
<rect x="110" y="165" width="7.35" height="16" rx="2" fill="#2a78d6"/>
<text x="125" y="178" font-size="12" fill="#6b7280">105 ms</text>
<text x="0" y="233" font-size="13" font-weight="600" fill="#1f2937">32 GiB</text>
<rect x="110" y="208" width="476.84" height="16" rx="2" fill="#a88428"/>
<text x="595" y="221" font-size="12" fill="#6b7280">6,812 ms</text>
<rect x="110" y="230" width="7.77" height="16" rx="2" fill="#2a78d6"/>
<text x="125" y="243" font-size="12" fill="#6b7280">111 ms</text>
<line x1="110" y1="263" x2="600" y2="263" stroke="#9ca3af"/>
<text x="110" y="282" font-size="11" text-anchor="middle" fill="#6b7280">0</text>
<text x="250" y="282" font-size="11" text-anchor="middle" fill="#6b7280">2 s</text>
<text x="390" y="282" font-size="11" text-anchor="middle" fill="#6b7280">4 s</text>
<text x="530" y="282" font-size="11" text-anchor="middle" fill="#6b7280">6 s</text>
<text x="600" y="282" font-size="11" text-anchor="middle" fill="#6b7280">7 s</text>
<text x="0" y="310" font-size="11" fill="#6b7280">Median of three runs. Resource setup measured. Pool preparation and guest boot excluded.</text>
</svg>

The lazy QEMU column is essential to understanding the result. QEMU can already describe a large guest quickly. At 32 GiB, that guest had only about 42 MiB resident when it became ready. The preallocated guest had about 32 GiB resident. The two commands had done different amounts of work.

Multikernel's 111 ms includes assigning the full 32 GiB of physical ranges from the existing pool. Increasing the grant from 1 GiB to 32 GiB barely changed the full command time in these runs. It did not require populating a fresh userspace mapping across the assigned memory.

These are useful operating points, but they are not identical endpoints. QEMU initializes a virtual machine and its KVM state. `kerf create` assigns resources to an instance that still needs a kernel loaded and started. The table shows a difference in pre-boot resource setup, not a claim that an application starts 61 times faster.

## Two Paths to Populated, Pinned Memory

We tested those two paths with a helper derived from the Linux kernel's page-pinning benchmark, requesting writable, long-term pins on anonymous memory. Each run started with a fresh mapping.

In the first path, we immediately requested pins. The kernel had to populate the missing backing as part of that request, so the measured time includes both population and pinning.

In the second path, we populated the mapping ourselves before requesting pins. We timed population and the subsequent pin operation separately. Adding those two stages gives the preparation time for this path.

| RAM | Pin fresh memory, including population | Populate first, then pin: combined time |
| :--- | ---: | ---: |
| 1 GiB | 299 ms | 310 ms |
| 8 GiB | 1,812 ms | 1,582 ms |
| 32 GiB | 6,399 ms | 6,530 ms |

For 32 GiB, populating first and then pinning breaks down into 6,514 ms of population followed by 15.95 ms of pinning. The combined time is about 6.53 seconds. Adding the 6.40-second fresh-pin measurement to the 6.51-second population measurement would count population twice: those timings belong to separate runs, each of which prepared its own memory.

The combined column is the sum of the two stage medians, rounded to the nearest millisecond. These measurements exclude subsequent unpinning and the helper's other overhead. Huge-page advice was enabled. The paths use different ways to populate memory, so their totals need not match exactly.

These helper timings are also separate from the 6.81-second QEMU result above, which includes QEMU initialization and preallocation. We did not measure a QEMU guest with VFIO attached. Its pinning would operate on the backing established by preallocation, while IOMMU mapping and device setup would add their own costs.

The same distinction held when we explicitly requested ordinary 4 KiB pages. At 8 GiB, pinning fresh memory took 2.97 seconds; pinning populated memory took 79 milliseconds. Huge pages changed the costs, but did not change where most of the delay came from.

A separate profile of QEMU preallocating 8 GiB supplied the explanation. About 95.4% of sampled CPU cycles landed in `kernel_init_pages()`, reached through the page-fault and allocation path. That function clears newly allocated pages. The host kernel had initialization on allocation enabled through `CONFIG_INIT_ON_ALLOC_DEFAULT_ON=y`. The stock Ubuntu kernel on our own system also enables this setting. Disabling it would change where fresh anonymous pages are cleared: the fault handler must still provide zeroed contents before exposing them to userspace. We did not benchmark that alternative configuration.

This is why the user's original description needed unpacking. A pin request can spend seconds bringing memory into existence before it can hold that memory in place. Measuring the whole request and calling it “pinning overhead” hides the operation that dominates it. On this machine, the profile says that operation was clearing RAM.

## Prepare the Capacity Once

Multikernel separates acquiring physical capacity from assigning it to an instance. `kerf init` prepares a pool owned by the device-kernel. Later instances receive physical ranges from that pool, and deleting an instance returns its grant to the pool for reuse.

There is a real cost to preparing that capacity, and our test encountered it. The first request for one contiguous 34 GiB chunk failed on the running host. We then grew the pool in 2 GiB increments. All 17 increments succeeded, taking 19.2 seconds in total. The instance measurements began after that preparation completed.

That is an operational distinction, not free memory. A prepared pool commits capacity that the host cannot simultaneously use for unrelated allocations. Acquiring it from a running system can involve fragmentation, migration, and failed attempts. The pool has to be sized and prepared before the demand that is supposed to benefit from it.

Once it exists, however, its lifetime can span many instance lifetimes. The operator pays to acquire physical capacity when provisioning the machine or expanding the pool, then assigns that capacity as workers come and go. The measured 111 ms belongs to that second operation.

There is also a distinction between owning pages and preparing their contents. The instance creation path we inspected does not clear every byte of its grant. When memory changes owners and previous contents must not be exposed, sanitization still has to happen. Clearing in advance could move that work away from the launch path, but we did not implement or benchmark a background scrubbing policy here. These results should not be read as a measurement of sanitized allocation between unrelated tenants.

## Where This Fits

The strongest fit is an operator with predictable physical capacity and repeated demand for substantial memory grants: dedicated analytics workers, disposable execution environments for jobs under one administrative owner, or large service workers that are replaced often enough for setup latency to matter. The pool can outlive each worker. Memory acquisition becomes a capacity-management operation, while instance creation becomes an assignment operation.

For accelerator workloads, this gives a concrete hypothesis to test next. If a significant part of current startup is spent populating and pinning host RAM for a passed-through device, a kernel that already owns its physical memory can avoid the userspace backing and pinning path. Device setup and DMA mappings still need to be measured. This experiment establishes the memory-side opportunity; it does not measure a GPU or NIC becoming ready.

For the user who prompted the test, the next useful measurement is therefore the fraction of launch time spent preparing RAM. If that is the long pole, our experiment shows a way to remove much of it from repeated instance creation. If device reset, kernel boot, or application loading dominates, those need their own measurements.

The result is specific: 32 GiB assigned from an existing multikernel pool in 111 ms, against 6.81 seconds for the tested QEMU preallocation configuration. The explanation is equally specific. The VM setup path populated a large backing mapping and spent most of its sampled CPU cycles clearing pages. Multikernel assigned physical ranges it already owned. The opportunity is in making that ownership persist across the workers that use it.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so is [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. If memory preparation is keeping your next worker waiting, we would like to hear about your configuration at [contact@multikernel.io](mailto:contact@multikernel.io).
