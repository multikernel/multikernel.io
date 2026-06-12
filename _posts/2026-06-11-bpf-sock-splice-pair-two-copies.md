---
layout: post
title: "Two Copies Beat One: Designing bpf_sock_splice_pair() for Fast TCP Loopback"
date: 2026-06-11 10:00:00 -0700
categories: [linux-kernel, networking, performance, ebpf]
author: Cong Wang, Founder and CEO
excerpt: "Our first design spliced two co-located TCP sockets with a single user-to-user copy, the theoretical minimum for an unmodified sockets API. It was elegant, and it was the wrong tradeoff. Throughput on real streaming workloads was capped by a synchronous rendezvous between sender and receiver. The fix was counterintuitive: add a second copy. A small in-kernel ring buffer decouples the producer from the consumer, enables batching, and delivers up to 6.7x higher TCP_RR throughput on loopback. Here is the design, the dead end we walked into first, and the numbers, including a comparison with AF_SMC."
---

A surprising amount of modern infrastructure talks to itself. A service mesh sidecar proxies every request to the application sitting next to it in the same pod. Microservices co-scheduled on one node exchange RPCs over loopback. A database and its connection pooler share a host. In all of these cases two processes on the same machine speak plain TCP, and every byte pays for a network stack it never needed: skb allocation, the socket memory accounting machinery, softirq processing, the loopback device, and the full TCP receive path.

We set out to remove that tax with a new BPF kfunc, `bpf_sock_splice_pair()`. A `SOCKMAP` program pairs two locally-connected TCP sockets at handshake completion, and from then on their bulk data takes a short in-kernel fast path instead of the full protocol stack. The connection stays a real TCP connection: sequence numbers freeze at their post-handshake values, so FIN, RST, and keepalive keep working through the normal code, and the pair tears down with an ordinary close. Applications need no changes. There is no new address family, no preload library, and no source modification.

The interesting part of this project was not the kfunc itself. It was a design lesson that runs against intuition. Our first implementation used a single copy, the fewest copies physically possible without changing the API. Our second implementation deliberately added a copy, and it was far faster on the workloads that matter. This post explains why.

## Version one: the single-copy design

The first version, `bpf_tcp_splice_pair()`, was built around a simple and appealing idea. If both endpoints are on the same machine, why buffer anything at all? Move the bytes straight from the sender's buffer into the receiver's buffer, one copy, with nothing in between.

Concretely, the receiver entering `recvmsg()` would pin its user pages and publish the resulting iovec on the paired socket. The sender entering `sendmsg()` would look for that published iovec and, if present, copy its payload directly into the receiver's pages. One memory copy, from one process's address space into the other's, with no skb, no socket queue, and no verdict program on the fast path.

To keep this from deadlocking, the sender waited briefly (a bounded 1 ms) for the receiver to publish a buffer. If the wait expired, the bytes fell back to the normal TCP send path. That fallback is what let handshake-style traffic survive: when both ends write before either reads, as in an SSH banner exchange or a TLS hello, the timeout breaks the standoff and TCP carries those bytes.

On paper this is the optimal design. It achieves the theoretical floor on copies. So why did we throw it away?

## Why true zero-copy is off the table

Before explaining what was wrong with one copy, it is worth being precise about why we could not simply use zero copies.

True zero-copy means the bytes are never copied at all: the receiver reads from the exact physical memory the sender wrote. With the standard sockets API, that is impossible, because the two processes live in separate address spaces and the API contract forces a crossing. `send()` hands the kernel a pointer into the sender's memory. `recv()` hands the kernel a pointer into the receiver's memory. The kernel's job is to get the bytes from the first region to the second. Those are different pages in different page tables. Something has to move the data across that boundary.

There are only three ways to avoid the copy, and each one changes the contract:

- **Shared memory.** If both processes `mmap()` a common region and agree on a layout, no copy is needed. But now the application is not using `send()` and `recv()` at all. It is using a shared-memory protocol you had to design and integrate. That is a different programming model, not a transparent acceleration of TCP.
- **Page remapping.** The kernel could unmap the sender's pages and map them into the receiver. This avoids the byte copy but replaces it with page-table surgery and TLB shootdowns across CPUs, which on small and medium messages costs more than the copy it removes. The sockets API also offers no hook to hand ownership of a page from `send()` to `recv()`; the receiver asked for its bytes in a buffer it already owns.
- **Pipe-based splicing.** `vmsplice()` and `splice()` can move pages by reference, but again the application must restructure itself around pipes. It is no longer a plain TCP socket.

Linux does ship genuine zero-copy facilities for TCP, and they are worth naming because they prove the rule rather than break it. On the send side, `MSG_ZEROCOPY` (enabled with `SO_ZEROCOPY`) pins the user's pages and transmits from them directly, but the application must opt in and then reap asynchronous completion notifications from the socket error queue to know when its buffer is reusable, and it only elides the send-side copy. On the receive side, `TCP_ZEROCOPY_RECEIVE` maps received pages into user space through `mmap()`, but it requires page-aligned, page-sized payloads and an application written to consume bytes from a mapping instead of a buffer. Both are real and useful, and both make the same point: zero-copy on TCP exists only as an explicit API extension the application must adopt, with constraints attached. Neither gives transparent zero-copy to an unmodified pair of `send()` and `recv()` callers, which is the case we care about.

The conclusion is firm: for an unmodified application using `send()` and `recv()`, at least one copy across the address-space boundary is mandatory. Version one hit exactly that floor. One copy is the best you can do.

And that is precisely the trap. We optimized for the wrong quantity.

## Why one copy is the wrong tradeoff

The single-copy design has a hidden requirement baked into it: the sender copies *directly into the receiver's buffer*, which means the receiver's buffer must exist at the instant the sender writes. Both endpoints have to be present at the same moment. The sender cannot make progress until the receiver has parked in `recvmsg()` and published its pages.

This is a synchronous rendezvous, and a rendezvous destroys batching.

Consider a streaming workload. The sender wants to push a series of messages as fast as it can. With a rendezvous, it cannot get ahead of the receiver by even a single message. Every message is a lockstep handshake: the sender writes, then must wait for the receiver to consume and re-publish before it can write again. If the receiver is busy doing anything else, parsing the previous message, computing a response, taking a scheduler tick, the sender stalls or times out and falls back to TCP. The throughput of the fast path is governed by the rendezvous latency and the slower of the two participants, not by how fast the CPU can copy memory.

Real workloads never have the two sides in perfect phase. They are bursty and asynchronous. A sender often produces a batch of small messages back to back while the receiver is still working through the previous one. The single-copy design has nowhere to put those in-flight bytes, so it cannot absorb the phase difference. It leaves throughput on the table exactly when there is throughput to be had.

This is the throughput lesson that queueing theory has taught for decades, applied to a kernel fast path: **to let a producer run ahead of a consumer, you need somewhere to hold the work in between. That somewhere is a buffer.** And a buffer means the bytes are written into it by the producer (copy one) and read out of it by the consumer (copy two). The second copy is not waste. It is the price of decoupling the two sides, and decoupling is what makes batching possible.

Batching, in turn, is what makes the fast path worth having. When a sequence of small sends accumulates in a buffer, the receiver can drain many of them in one wakeup instead of one wakeup per message. The per-message cost of scheduling and signaling amortizes across the batch. You cannot amortize a cost you refuse to let accumulate.

So the design question inverted. The goal was never "minimize copies." The goal was "maximize throughput on co-located TCP." Those are different objectives, and the single-copy design optimized the first at the expense of the second.

## Version two: a small ring buffer

The second version, `bpf_sock_splice_pair()`, is built around a per-direction byte ring. When the pair forms, the kernel allocates two rings, one for each direction, each a 16 KiB power-of-two buffer. `sendmsg()` copies the user payload into the ring at the head. `recvmsg()` copies it out at the tail. Two copies, with a queue in the middle.

```
  version one (single copy, rendezvous):

    sender sendmsg() ----------- copy ----------> receiver's pinned pages
                         (both must be present at the same instant)

  version two (two copies, decoupled):

    sender sendmsg() --copy--> [ ring ] --copy--> receiver recvmsg()
                                  ^ accumulates across calls,
                                    sender runs ahead of receiver
```

The ring is a single-producer, single-consumer structure, one socket on each side, so the head and tail cursors are updated with release and acquire stores and need no data-path lock. Each side keeps a private cache of the other's cursor and reads the real cross-CPU cursor only when its cache says the ring is full or empty, the standard cursor-caching trick that keeps the hot path off shared cache lines. The implementation is about a hundred lines on top of `include/linux/circ_buf.h`, which is the kernel's standard ring primitive, the same one used by tty and sound drivers.

Correctness lives in the boundaries. The sender defers to `tcp_sendmsg()` when the peer's receive queue already holds TCP-delivered bytes (so stream ordering is preserved against earlier fallbacks) or when the ring is full (so TCP's own backpressure, via the send window, absorbs the overflow). The receiver defers to `tcp_recvmsg()` when the TCP receive queue holds data and the ring is empty. The end-to-end invariant is that TCP-queued bytes are always older than any ring bytes drained alongside them, because the sender only writes to the ring while the peer's receive queue is empty. The ring itself is kept alive across a sender's copy by a per-pair `percpu_ref`, so the per-message cost stays off cross-CPU reference counting.

Because the ring is a real queue that accumulates across calls, a burst of small sends now coalesces. The sender fills the ring and returns; the receiver drains as much as it can in a single pass. The two sides no longer have to meet in the middle for every message. That is the entire point of the second copy.

## The payoff the ring unlocks: busy polling

Decoupling buys batching. It also buys something the single-copy design could never have: the receiver can busy-poll.

Latency-bound request-response traffic is dominated by the cost of going to sleep and being woken for every cycle. The usual kernel answer is `SO_BUSY_POLL`, which spins on a NAPI instance instead of parking. But loopback has no NAPI instance to poll. Loopback and the default veth path deliver through the per-CPU backlog, which exposes no pollable `napi_id`, so generic busy polling is a no-op there. This is exactly why co-located TCP has historically been hard to make low-latency.

The ring changes the situation. The data sits in an in-kernel structure the receiver already owns, so the receiver can spin on the ring directly. We added an optional bounded busy-poll that reuses the socket's `SO_BUSY_POLL` budget: before parking, the receiver spins on the ring for the configured number of microseconds. It is off by default, and a companion patch lets a BPF program set the budget per flow with `bpf_setsockopt()`, no sysctl and no application change required. Keeping the receiver hot lets a synchronous sender's small writes land and be picked up without a wakeup per message. This is the lever that turns the latency-bound case into a large win, and it is only reachable because the bytes live in a buffer rather than in a fleeting published iovec.

## The numbers

All measurements use netperf with sender and receiver pinned to adjacent CPUs, ten seconds per run, three runs averaged, on bare-metal loopback (`127.0.0.1`) and in a container setup (two network namespaces joined by a veth pair and a Linux bridge). We report TCP_RR at a 1 KB request and response, a representative RPC size, comparing the unmodified TCP baseline against the splice path.

| TCP_RR, 1 KB | baseline TCP | splice, no busy-poll | splice, 50 us busy-poll |
|---|---|---|---|
| Loopback | 105.8k tps | 235.1k tps (2.2x) | 713.0k tps (6.7x) |
| Container | 99.9k tps | 233.9k tps (2.3x) | 704.9k tps (7.0x) |

Without busy polling the ring already more than doubles TPS, because it removes the per-cycle kernel TCP receive-path cost. With a 50 microsecond busy-poll budget the win reaches 6.7x on loopback and 7.0x in the container. The advantage grows toward smaller messages (a 1-byte request-response reaches roughly 10x with busy polling) and narrows toward 64 KB, where both paths become bound by raw memory-copy bandwidth.

Bulk streaming (TCP_STREAM) tells a complementary story. On bare-metal loopback it is roughly neutral, because the kernel's loopback TSO already amortizes per-packet cost down to about 20 nanoseconds per message, below the ring's two-copy floor. But container-to-container, where every packet pays veth and bridge overhead, streaming wins decisively: up to 6x at 4 KB messages, because the per-skb cost that dominates the container path is exactly what the ring sidesteps.

It is worth noting that version one's published numbers, which showed very large TCP_STREAM multipliers, were measured on a single-CPU virtual machine where the TCP baseline is unusually slow due to VMEXIT, and are not directly comparable to these bare-metal results. The structural point stands on its own: version one's TCP_RR gains were modest, around 1.8x, precisely because the rendezvous prevented the sender from pipelining. Version two's ring removes that ceiling and the busy-poll budget pushes through it.

## A look sideways: AF_SMC

We are not the first to notice that co-located sockets can share memory. Linux already has AF_SMC (Shared Memory Communications), and its SMC-D variant now supports a loopback device. It is instructive to measure it on the same machine, because it both validates our central thesis and shows where our design is leaner.

SMC-D loopback is a shared-memory data path, and tellingly, it is built around a buffer: each connection has a remote memory buffer that is, in effect, a ring. SMC reached the same conclusion we did, that batching co-located traffic requires buffering. That is the thesis of this post, arrived at independently by a mature subsystem.

The differences are in the details. SMC-D moves a byte three times (sender's user buffer into its local send buffer, send buffer into the peer's shared buffer, peer's shared buffer into the receiver's user buffer), where our ring moves it twice. SMC also has no busy-poll path at all: its receiver always waits for a device interrupt from the ISM device, so it cannot collapse request-response latency the way a ring spin can. And SMC requires the application or an administrator to opt in (an AF_SMC socket or an `smc_run` preload, plus a configured user EID on non-mainframe hardware), whereas our path runs on ordinary TCP sockets that a BPF program pairs transparently.

Measured at 1 KB request-response on loopback, the progression is clear:

| TCP_RR, 1 KB, loopback | throughput |
|---|---|
| Baseline TCP | ~106k tps |
| AF_SMC (SMC-D loopback) | ~169k tps |
| `bpf_sock_splice_pair()`, no busy-poll | ~235k tps |
| `bpf_sock_splice_pair()`, busy-poll | ~713k tps |

Shared memory beats plain TCP, as expected. Our two-copy ring beats SMC-D's three-copy buffer by about 1.4x even before busy polling, and the busy-poll budget, which SMC has no equivalent for, extends the lead to roughly 4x. The two structural advantages, one fewer copy and a pollable in-kernel ring, show up exactly where the theory predicts.

## The lesson

The shortest version of this story is that we built the design with the fewest copies, proved it was the theoretical minimum, and then replaced it because minimizing copies was the wrong goal. The right goal was throughput on bursty, asynchronous, co-located traffic, and that goal is served by a buffer, even though a buffer costs an extra copy. The buffer decouples producer from consumer, decoupling enables batching, batching amortizes per-message overhead, and ownership of an in-kernel ring enables the busy polling that finally cracks loopback latency. One copy could give us none of that.

There is a general principle worth keeping. The most aggressive-looking optimization, the one that removes the most obvious cost, is sometimes a local optimum that blocks the path to a better global one. A copy is a visible, countable cost, so it is tempting to drive it to zero. Decoupling and batching are diffuse, structural benefits that do not show up in a single line of a profile. The work is in seeing that the second kind is worth paying the first kind for.

`bpf_sock_splice_pair()` is available at [github.com/multikernel/tcp_splice](https://github.com/multikernel/tcp_splice){:target="_blank" rel="noopener noreferrer"}. We would welcome your review and your benchmarks.
