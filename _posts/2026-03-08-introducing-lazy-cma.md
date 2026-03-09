---
layout: post
title: "Introducing Lazy CMA: Runtime Contiguous Memory Allocation for Linux"
date: 2026-03-08 10:00:00 -0700
categories: [announcement, open-source, linux-kernel, memory-management]
author: Cong Wang, Founder and CEO
excerpt: "Today we are open-sourcing Lazy CMA, a Linux kernel module that allocates physically contiguous memory at runtime without boot-time reservation, enabling flexible memory management for kdump, multikernel, and DAXFS workloads."
---

Today we are releasing [Lazy CMA](https://github.com/multikernel/lazy_cma){:target="_blank" rel="noopener noreferrer"}, an open-source Linux kernel module that allocates physically contiguous memory on demand. No boot-time reservation, no kernel rebuild, no reboot. It is available now under GPL-2.0 on GitHub.

## The Problem with Existing Approaches

Linux CMA is the standard mechanism for reserving large, physically contiguous memory regions. DMA subsystems, GPU drivers, and multimedia pipelines all rely on it. However, CMA has a fundamental limitation: the reservation size must be decided before the system is running.

There are two ways to configure CMA. You can set `CONFIG_CMA_SIZE_MBYTES` at kernel compile time, which requires a rebuild to change. Or you can pass `cma=256M` as a boot parameter, which requires a reboot. In both cases, the reservation is static. If your workload demands more contiguous memory than you planned for, you must reboot to adjust.

This creates real operational friction. Cloud operators must predict memory needs ahead of time. Developers working with heterogeneous memory (CXL, PMEM) often cannot use CMA at all, because their memory is onlined post-boot and was never available during early reservation. And anyone using kdump must decide the crash kernel reservation size at boot, even though the optimal size depends on runtime conditions.

The DMA-BUF system heap (`/dev/dma_heap/system`) takes a different approach and avoids boot-time reservation entirely. However, it relies on `alloc_pages()`, which is constrained by the buddy allocator's maximum order (typically MAX_ORDER pages, around 4MB to 8MB per allocation). To fulfill a large request, the system heap must issue many separate `alloc_pages()` calls and assemble the results into a scatter-gather list. For allocations of hundreds of megabytes or more, this becomes slow and prone to failure under memory pressure. Use cases like kexec, multikernel, and DAXFS need a single contiguous physical range far exceeding what the buddy allocator can provide in one shot.

## How Lazy CMA Works

Lazy CMA addresses both limitations. Instead of reserving memory at boot, it uses the kernel's `alloc_contig_range()` API to migrate existing pages out of any zone on demand. When you request an allocation, the module scans memory zones from top down, starting with ZONE_MOVABLE (where pages are easiest to relocate), then falling back to ZONE_NORMAL, ZONE_DMA32, and ZONE_DMA.

The module exposes a simple interface through `/dev/lazy_cma` with three ioctl operations: allocate, resize, and free. Allocations are identified by physical address, persist across processes, and are registered in `/proc/iomem` for visibility.

```bash
insmod lazy_cma.ko          # creates /dev/lazy_cma

# Allocate 256 MB of contiguous memory
lazy_cma_tool -a 256

# Allocate from a specific NUMA node (e.g., CXL memory on node 2)
lazy_cma_tool -a 256 -N 2

# Grow an existing allocation to 512 MB
lazy_cma_tool -r 0x100000000 512

# Free the allocation
lazy_cma_tool -f 0x100000000
```

Resize deserves special mention. When growing an allocation, Lazy CMA first attempts to extend it in place by claiming adjacent pages. If that fails, it transparently reallocates the entire buffer to a new contiguous range. Shrinking releases tail pages back to the system immediately.

## Key Advantages Over CMA

| Capability | CMA | Lazy CMA |
|---|---|---|
| Configuration time | Compile time or boot time | Runtime |
| Resizable | No | Yes |
| NUMA-aware | Limited (boot-time only) | Yes, any online node |
| Works with hotplug memory | No | Yes |
| Physical address visibility | No | Yes, via /proc/iomem |

One important tradeoff: CMA guarantees allocation success because it reserves a dedicated region where only movable pages are placed. Lazy CMA is best-effort and may fail on heavily fragmented systems. In practice, it works reliably on systems with sufficient free memory, which is the common case for the workloads we target.

## Use Cases

**Kdump without the crashkernel= boot parameter.** Reserving memory for the crash kernel at boot time has been a long-standing pain point in Linux operations. The `crashkernel=` parameter forces administrators to choose a reservation size before the system is running. Setting it too large wastes memory; setting it too small risks failing to capture a crash dump. Changing it requires a reboot. The kernel community has introduced increasingly complex heuristics over the years to work around this, but the core problem remains: you should not have to predict crash kernel memory needs at boot. Lazy CMA eliminates this by allocating the crash kernel's memory region at runtime, sized to actual needs. By specifying a custom `/proc/iomem` name (e.g., "Crash kernel"), the allocation integrates seamlessly with existing kdump and kexec tooling.

**Multikernel memory pool.** Spawning a secondary kernel in our multikernel architecture requires a large contiguous region for the spawned kernel's memory pool. Lazy CMA lets the primary kernel allocate this region on demand, sized precisely for the workload, with no boot-time planning required.

**DAXFS memory backend.** Our disaggregated filesystem, [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}, operates directly on DAX-capable memory via load/store access, providing a shared filesystem across multiple kernels or CXL-connected hosts. DAXFS requires physically contiguous backing memory for its image regions: superblock, base image, overlay hash table, and shared page cache. Lazy CMA provides this memory at runtime with NUMA node selection, allowing DAXFS images to be placed on specific CXL memory nodes. Because Lazy CMA registers each allocation in `/proc/iomem`, the physical addresses needed for DAXFS mount operations are always discoverable.

## Design Philosophy

Lazy CMA is intentionally minimal. The kernel module is a single C file with no configuration parameters and no dependencies beyond core memory management APIs. It registers a misc device, handles three ioctls, and does nothing else.

We built this as a loadable module rather than modifying the CMA subsystem directly. This means Lazy CMA works with any standard Linux kernel that supports `alloc_contig_range()`, with no kernel patches required. Load it when you need it, unload it when you do not.

Exposing physical addresses and registering allocations in `/proc/iomem` reflects the needs of our multikernel use case, where physical addresses are the common currency between kernel instances. It also aids debugging: you can always inspect exactly where your contiguous allocations reside in the physical address space.

## Getting Started

Lazy CMA is available now on [GitHub](https://github.com/multikernel/lazy_cma){:target="_blank" rel="noopener noreferrer"}. Building is straightforward:

```bash
git clone https://github.com/multikernel/lazy_cma.git
cd lazy_cma
make
insmod lazy_cma.ko
```

The repository includes a userspace tool (`lazy_cma_tool`) for command-line allocation management and documented C API examples for integration into your own applications.

## Get Involved

Lazy CMA is the latest open-source project from Multikernel, joining our [Multikernel Linux](https://github.com/multikernel/linux/){:target="_blank" rel="noopener noreferrer"} and [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}. It is a building block in our broader multikernel architecture, and we believe it has standalone value for anyone working with contiguous memory allocation, heterogeneous memory, or kdump.

We welcome contributions, bug reports, and feedback.

- Browse the source on [GitHub](https://github.com/multikernel/lazy_cma){:target="_blank" rel="noopener noreferrer"}
- File issues or submit pull requests
- Follow us on [YouTube](https://www.youtube.com/@multikernel-tech){:target="_blank" rel="noopener noreferrer"} for technical deep dives
- Reach out at [contact@multikernel.io](mailto:contact@multikernel.io)
