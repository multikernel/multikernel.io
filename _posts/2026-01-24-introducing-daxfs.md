---
layout: post
title: "Introducing DAXFS: A Shared Filesystem for Multi-Kernel and Multi-Host Environments"
date: 2026-01-24 10:00:00 -0700
categories: [announcement, open-source, filesystem]
author: Cong Wang, Founder and CEO
excerpt: "We are open-sourcing DAXFS, a disaggregated filesystem designed for multi-kernel and multi-host shared memory. Built on CAS-based lock-free coordination, DAXFS enables multiple kernel instances and CXL-connected hosts to share data with zero-copy access and no central coordinator."
---

Today we are open-sourcing [DAXFS](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}, a disaggregated filesystem for multi-kernel and multi-host shared memory. DAXFS is the storage layer that connects kernel instances in the Multikernel split-kernel architecture, and it is designed from the ground up to work across CXL-connected hosts sharing a common memory pool.

## The Problem

Modern infrastructure faces a fundamental storage sharing problem at two levels.

**Within a single machine**, the split-kernel architecture runs multiple Linux kernels in parallel, each with its own CPU cores and memory. These kernels need to share data: container root filesystems, model weights, application state, and I/O buffers. Traditional filesystems do not solve this well. tmpfs and overlayfs are per-instance, requiring N copies of the same data for N kernels. erofs is read-only, and its fscache layer is per-kernel, so N kernels still mean N cache copies. Network filesystems add latency and serialization overhead that defeats the purpose of running on the same machine.

**Across multiple machines**, CXL memory pooling is creating a new tier of shared, byte-addressable memory between hosts. Servers connected through CXL switches can access a common memory region with load/store semantics, but there is no filesystem designed to take advantage of this. Existing shared storage solutions rely on network protocols, distributed consensus, or single-master coordination, none of which are necessary when you have physically shared memory with atomic operations.

We needed a filesystem that serves shared data to multiple kernels and multiple hosts simultaneously, with zero-copy reads, lock-free writes, and no network round trips.

## What is DAXFS

DAXFS is a Linux kernel filesystem that operates directly on DAX-capable memory: persistent memory (pmem), CXL-attached memory, or DMA buffers. It provides a standard POSIX interface so applications run unmodified, while the underlying storage is physically shared across all participants that mount the same memory region.

The key properties:

- **Zero-copy reads.** Data is served directly from shared memory via load/store access. No page cache copy, no intermediate buffering.
- **Lock-free writes.** All coordination uses compare-and-swap (`cmpxchg`) operations on shared memory. No kernel locks, no distributed consensus, no message passing between hosts.
- **Multi-kernel and multi-host.** Multiple kernels on the same machine, or multiple hosts connected via CXL, can mount the same DAXFS region concurrently with full read/write access.
- **Overlay-on-read architecture.** A read-only base image is combined with a CAS-based hash overlay for writes. Copy-on-write at page granularity.
- **Cooperative shared page cache.** A demand-paged cache in DAX memory that is automatically visible to all kernels and hosts, with clock-based eviction and no coherency protocol.
- **Security by simplicity.** Flat directory format with fixed-size entries, bounded validation, and no pointer chasing. Safe for untrusted images.

DAXFS is not for traditional disks. It requires byte-addressable memory with DAX support. The entire design assumes direct memory pointer access and synchronization with `cmpxchg`.

## Why Not Existing Filesystems

| Filesystem | Limitation |
|------------|------------|
| **tmpfs/ramfs** | Per-instance; N containers = N copies in memory |
| **overlayfs** | No multi-kernel/multi-host support; copy-up on write; page cache overhead |
| **erofs** | Read-only; fscache is per-kernel so N kernels = N cache copies |
| **cramfs** | Block I/O + page cache; no direct memory mapping |
| **FamFS** | Single-writer metadata; no shared caching; no CAS coordination |

The closest comparison is [FamFS](https://github.com/cxl-micron-reskit/famfs){:target="_blank" rel="noopener noreferrer"}, which also targets CXL shared memory. But the two projects differ fundamentally in architecture:

| | DAXFS | FamFS |
|---|---|---|
| **Coordination** | Peer-to-peer via `cmpxchg` | Single master; clients replay metadata log |
| **Writes** | Lock-free CAS overlay; any host writes concurrently | Master creates files; clients default read-only |
| **Shared caching** | Cooperative page cache across all hosts | None; each node manages its own access |
| **File operations** | Create, read, write (COW), delete | Pre-allocate only (no append, truncate, or delete) |
| **CXL atomics** | Core design primitive for all metadata and cache transitions | Not used; relies on single-writer log |
| **Layered storage** | Base image + overlay (shared base with per-instance COW) | No layering concept |

FamFS is a thin mapping layer that exposes pre-allocated files on shared memory. DAXFS is a general-purpose shared in-memory filesystem that uses CXL shared memory atomics for lock-free multi-host coordination: concurrent writes, cooperative caching, and layered storage without a central coordinator.

## How It Works

DAXFS organizes shared memory into up to four regions, depending on the mode:

| Mode | Layout | Description |
|------|--------|-------------|
| **Static** | `[Super][Base Image]` | Read-only; base image embedded in DAX |
| **Split** | `[Super][Base Image][Overlay][PCache]` | Writable; metadata and overlay in DAX, file data in backing file |
| **Empty** | `[Super][Overlay][PCache]` | Writable; no base image, all content via overlay |

### Base Image

An optional read-only snapshot of a directory tree, embedded directly in DAX memory. The base image uses a flat format with fixed 64-byte inodes and fixed 271-byte directory entries with inline names (up to 255 characters). This flat structure is important for security: no linked lists, no pointer chasing, no cycle attacks, and bounded iteration for trivial validation. When serving container root filesystems, the base image is created once and shared across all kernels and hosts.

### Hash Overlay

All writes go to a lock-free hash table built on open addressing with linear probing. Each bucket is 16 bytes: a 63-bit key and a pool offset, packed with a single state bit. Inserting an entry is a single `cmpxchg` on the bucket, transitioning it from FREE to USED. If two kernels or two CXL hosts race on the same bucket, one wins and the other retries with linear probing. This works identically whether the competing writers are kernels on the same machine or separate hosts accessing CXL shared memory.

The overlay supports three types of entries through the same CAS mechanism:

- **Data pages** (4KB COW): keyed by `(ino << 20) | pgoff`, supporting up to 1M pages (4GB) per file
- **Inode metadata** (32 bytes): keyed by `(ino << 20) | 0xFFFFF` as a sentinel
- **Directory entries** (~280 bytes): keyed by `FNV-1a(parent_ino, name)`, with per-directory linked lists for efficient readdir

Pool entries are allocated via an atomic bump allocator (`fetch-and-add` on `pool_alloc`) and recycled through per-type free lists with generation counter tagging to prevent ABA races. The read path resolves data in order: overlay first, then base image, then page cache for backing store mode. The write path performs copy-on-write from the base image into overlay data pages.

### Shared Page Cache

For deployments where file data lives on a backing store (NVMe, network storage), DAXFS includes a shared page cache directly in DAX memory. This is where the multi-host design becomes particularly powerful.

Because DAX memory is physically shared across kernel instances and CXL hosts, the cache is automatically visible to all participants without any coherency protocol. When one host fills a cache slot from its local backing store, every other host can immediately read that data.

Cache slots use a three-state machine with all transitions via `cmpxchg`:

- **FREE to PENDING**: A host claims a slot to fill from backing store
- **PENDING to VALID**: The fill completes and data is available to all
- **VALID to FREE**: The slot is evicted by the clock algorithm

The eviction algorithm (MH-clock) is designed for multi-host operation. A single clock hand advances atomically across all hosts. Each sweep clears the reference bit on VALID slots; slots that have been accessed since the last sweep are spared, while untouched slots become eviction candidates. Only slots with zero refcount can be evicted, which prevents data from being reclaimed while another host is actively reading it.

The page cache supports multiple backing files per cache, with O(1) lookup via a backing array indexed by inode number. The `mkdaxfs` tool can pre-warm cache slots at image creation time, so data is immediately available on first access.

## CXL Multi-Host: A First-Class Target

CXL (Compute Express Link) is enabling a new class of memory architectures where multiple servers share a common pool of byte-addressable memory through CXL switches. This memory supports standard load/store access with hardware-guaranteed atomics, making it possible to coordinate across hosts without network messages.

DAXFS treats CXL multi-host sharing as a first-class use case, not an afterthought. Every coordination mechanism in DAXFS, from overlay writes to page cache management to directory operations, is built on `cmpxchg` as the sole synchronization primitive. This means the same code path works whether two competing writers are kernels on the same machine or servers on opposite ends of a CXL fabric.

What this enables in practice:

- **Shared datasets across a cluster.** Multiple servers mount the same DAXFS region through CXL memory and see a unified namespace. Any server can read or write files concurrently with lock-free coordination.
- **Cooperative caching.** When one server reads data from its local NVMe into the shared page cache, that data becomes instantly available to every other server. The cache is shared physically, not replicated, so total cache capacity equals the DAX region size, not divided by the number of hosts.
- **No master node.** Unlike FamFS or traditional distributed filesystems, DAXFS has no master, no metadata server, and no log to replay. All hosts are peers. Any host can create files, write data, or modify directories. Coordination is entirely through atomic memory operations.
- **Disaggregated storage.** Each host can export its local storage into the shared DAXFS namespace. The combination of CXL shared memory for metadata and caching with local storage for bulk data creates a disaggregated storage architecture where compute and storage can scale independently.

## Use Cases

### LLM Inference Serving

Large language models require tens or hundreds of gigabytes of weight data. In a multi-kernel deployment, each GPU kernel instance needs access to the same weights. With DAXFS, model weights are loaded once into shared memory and served to every kernel instance simultaneously. Cold start drops from minutes to seconds. In a CXL-connected cluster, the same weights can be shared across multiple physical servers, eliminating redundant copies entirely.

### Shared Container Root Filesystem

A base container image is embedded in DAXFS as a read-only base image. Each kernel mounts the same memory region and gets an identical view of the filesystem. Per-container writes go to the overlay with page-granularity copy-on-write. One copy of the base image serves all containers on the machine, or across CXL-connected machines. This is particularly effective for large-scale deployments where hundreds of containers share the same base image.

### CXL Memory Pooling

As CXL memory fabrics become available, organizations need a way to manage shared memory as a common resource. DAXFS provides the filesystem abstraction over CXL pooled memory: a standard POSIX interface for applications, lock-free coordination for concurrent access, and cooperative caching for efficient use of the shared memory pool. Applications do not need to be rewritten to take advantage of CXL; they simply access files through DAXFS.

### Zero-Copy I/O

Because DAXFS data has known physical addresses, NIC and NVMe DMA descriptors can reference DAXFS buffers directly. Combined with io_uring fixed buffers, this enables true zero-copy networking and storage I/O. Applications mmap DAXFS buffer pools, register them with io_uring as fixed buffers, and perform I/O with `IORING_OP_READ_FIXED` and `IORING_OP_WRITE_FIXED`. The data never needs to be copied between user and kernel space.

### GPU and Accelerator Integration

DAXFS supports DMA-buf as a memory source, enabling direct integration with GPU and accelerator memory. Data stored in DAXFS can be accessed by GPUs without copying through the CPU. This is particularly valuable for AI/ML pipelines where training data, model weights, and intermediate results all benefit from zero-copy access across multiple accelerators.

## Built on Linux

DAXFS is implemented as a standard Linux kernel module with no out-of-tree dependencies. It uses:

- The Linux VFS interface for standard filesystem operations
- The new mount API (`fsopen`/`fsconfig`/`fsmount`) for flexible mount configuration
- `memremap` for DAX memory mapping
- The DMA-buf framework for device memory integration
- Standard kernel atomics (`cmpxchg`, `smp_wmb`, `READ_ONCE`) for lock-free coordination

The project includes two userspace tools:

- **mkdaxfs**: Creates DAXFS filesystem images from directory trees, with support for static, split, and empty modes, custom overlay sizing, DMA heap allocation, and physical address targeting
- **daxfs-inspect**: Examines live DAXFS state, including memory layout, overlay hash table utilization, entry types, and pool usage

## Get Started

```bash
# Build
make    # builds kernel module + tools

# Create a read-only image from a directory
mkdaxfs -d /path/to/rootfs -o image.daxfs

# Create a writable image with overlay (split mode)
mkdaxfs -d /path/to/rootfs -H /dev/dma_heap/mk -m /mnt -o /data/rootfs.img

# Create an empty writable filesystem
mkdaxfs --empty -H /dev/dma_heap/mk -m /mnt -s 256M

# Mount at a physical address
mount -t daxfs -o phys=0x100000000,size=0x10000000 none /mnt

# Inspect a mounted filesystem
daxfs-inspect status -m /mnt
daxfs-inspect overlay -m /mnt
```

Requires Linux 5.11+ with `CONFIG_FS_DAX` enabled.

- Source code on [GitHub](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"}
- See the [Getting Started guide](/getting-started.html) for integration with the Multikernel platform

## Looking Forward

DAXFS is a core piece of the Multikernel split-kernel architecture, and we believe it addresses a gap in the Linux storage stack that will only grow as CXL memory pooling becomes mainstream. The ability to share a filesystem across kernels and hosts with lock-free coordination, cooperative caching, and zero-copy access opens up new possibilities for how we architect large-scale systems.

We welcome feedback, contributions, and collaboration. If you are working on multi-kernel systems, CXL memory architectures, or shared storage infrastructure, we would love to hear from you. Join us on [GitHub](https://github.com/multikernel/daxfs){:target="_blank" rel="noopener noreferrer"} or reach out at [contact@multikernel.io](mailto:contact@multikernel.io).
