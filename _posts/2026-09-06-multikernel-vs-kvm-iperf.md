---
layout: post
title: "Same Wire, Ten Times the CPU"
date: 2026-09-06 18:30:00 -0700
categories: [benchmark, multikernel, linux-kernel, performance, virtualization, networking]
author: Cong Wang, Founder and CEO
excerpt: "Last month we measured what a KVM guest pays on the paths inside a kernel. This time we gave both a network card. We booted the same kernel twice on one machine, once as a multikernel app-kernel served by mk_vnet, our new in-kernel virtio-net backend, once as a KVM guest with vhost-net and pinned vCPUs, and pushed iperf through a 1 Gbit link to a server across the campus router. Both hit line rate on every test. The machine's bill did not agree: sending cost the VM twice the CPU, receiving cost it ten times, and its round trip was 0.3 ms longer. Most of the receive gap is one KVM default that spins a vCPU thread whenever interrupts arrive faster than the poll window closes. Turn it off and the VM still costs 2.6x. This post explains how mk_vnet works, and why an app-kernel's network path has none of the machinery that bill pays for."
---

The [previous post](/2026/08/16/multikernel-vs-kvm-lmbench/) kept I/O off the table on purpose. It measured what a KVM guest pays on the kernel's own hot paths, context switches and pipes and syscalls, and found that the memory system reaches parity while the wakeup paths do not. Every number ran from RAM.

Networking is where a hypervisor earns its keep, though, and where the VM stack has had fifteen years of engineering poured in: paravirtual devices, vhost, multiqueue, offload negotiation, interrupt posting. It is also the part of the multikernel story we had not built. An app-kernel that owns two cores and a gigabyte is not much use if it cannot talk to anything.

So we built it. [mk_vnet](https://github.com/multikernel/linux/tree/multikernel-virtio){:target="_blank" rel="noopener noreferrer"} is a virtio-net backend that lives in the host kernel and serves an unmodified virtio driver in an app-kernel over shared memory. Then we ran the experiment the previous post could not: the same kernel booted twice on one machine, once as a multikernel app-kernel with mk_vnet, once as a KVM guest with vhost-net and pinned vCPUs, both pushing iperf through the same 1 Gbit NIC to the same server one router hop away.

Both saturated the wire on every test. That is the boring result, and it is the reason a gigabit link was the right instrument: with bandwidth pinned, the only thing left to measure is what each side spends to get there. Sending cost the VM about twice the CPU. Receiving cost it ten times. And the guest itself reported that it was 94% idle while doing it.

## How an App-Kernel Gets a NIC

The design starts from a decision about what kind of kernels exist. There are exactly two. The **device-kernel** is the one firmware booted: it owns the PCI bus, the IOMMU, ACPI, and every physical device. An **app-kernel** is a spawn that runs one workload on cores and memory the device-kernel lent it, and it owns no hardware at all. Every device an app-kernel sees is a virtio device, driven by the unmodified virtio driver already in the Linux tree, served by the device-kernel.

That sounds like a VM's device model, and the frontend half deliberately is. The backend half is where it stops being one.

<svg viewBox="0 0 720 400" role="img" aria-label="Data path of mk_vnet: virtio rings in app-kernel memory served by a host netdev, XDP to the NIC" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#6b7280"/></marker><marker id="ah2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#b45309"/></marker><marker id="as2" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M8,0 L0,4 L8,8 Z" fill="#b45309"/></marker></defs>
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">How the spawn reaches the wire</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Unmodified virtio-net driver in the app-kernel, mk_vnet backend in the device-kernel, no hypervisor in between</text>
<rect x="0" y="64" width="300" height="300" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="150" y="86" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">App-kernel (spawn, its own CPUs)</text>
<rect x="330" y="64" width="390" height="300" rx="10" fill="#fbf8f1" stroke="#e5e7eb"/>
<text x="525" y="86" font-size="13" font-weight="600" fill="#a88428" text-anchor="middle">Device-kernel (host, owns the NIC)</text>
<rect x="30" y="100" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="122.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">TCP/IP stack</text>
<text x="150.0" y="137.0" font-size="11" fill="#6b7280" text-anchor="middle">unchanged</text>
<rect x="30" y="160" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">virtio_net driver</text>
<text x="150.0" y="197.0" font-size="11" fill="#6b7280" text-anchor="middle">unchanged</text>
<rect x="30" y="220" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">virtio_mk transport</text>
<text x="150.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">device table, kick = bit + IPI</text>
<rect x="30" y="290" width="240" height="56" rx="6" fill="#e8f0fb" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="317.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">RX ring · TX ring · device table</text>
<text x="150.0" y="332.0" font-size="11" fill="#6b7280" text-anchor="middle">in the spawn's own memory</text>
<rect x="360" y="100" width="330" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="525.0" y="122.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">XDP programs, attached by kerf</text>
<text x="525.0" y="137.0" font-size="11" fill="#6b7280" text-anchor="middle">demux by IP on ingress, NIC's MAC on egress</text>
<rect x="360" y="160" width="150" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="435.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">mk_vnet netdev</text>
<text x="435.0" y="197.0" font-size="11" fill="#6b7280" text-anchor="middle">NAPI + XDP</text>
<rect x="540" y="160" width="150" height="46" rx="6" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="615.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">igb NIC driver</text>
<text x="615.0" y="197.0" font-size="11" fill="#6b7280" text-anchor="middle">native XDP</text>
<rect x="360" y="220" width="150" height="46" rx="6" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="435.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">doorbell handler</text>
<text x="435.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">IPI scans pending bits</text>
<rect x="540" y="220" width="150" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="615.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">mk_vring</text>
<text x="615.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">range-checked split ring</text>
<line x1="150" y1="146" x2="150" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="150" y1="206" x2="150" y2="220" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="150" y1="266" x2="150" y2="290" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="435" y1="146" x2="435" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="615" y1="146" x2="615" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="435" y1="220" x2="435" y2="206" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<text x="447" y="216" font-size="10.5" fill="#6b7280">napi_schedule</text>
<line x1="510" y1="190" x2="540" y2="228" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="270" y1="243" x2="360" y2="243" stroke="#b45309" stroke-width="1.6" stroke-dasharray="5,4" marker-end="url(#ah2)" marker-start="url(#as2)"/>
<text x="315" y="236" font-size="10.5" fill="#b45309" text-anchor="middle">kick / call</text>
<line x1="270" y1="318" x2="560" y2="266" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<text x="430" y="312" font-size="11" fill="#6b7280" text-anchor="middle">one copy per direction, plain pointers</text>
<text x="360" y="380" font-size="11" fill="#6b7280" text-anchor="middle">solid: data · dashed: doorbells, a pending bit in shared memory plus a bare IPI, never the message ring</text>
</svg>

**The transport is a table in shared memory.** Each app-kernel has a device table in a control block the host carves from the instance's own memory before it boots. Each entry holds the feature bits, a status word, a fixed configuration area, and per-queue slots for the ring addresses the driver chooses. A device tree node points the spawn at each entry, and a 329-line platform driver, `virtio_mk`, plays the role `virtio_mmio` plays for a VM: it reads and writes the table and registers a `virtio_device`. The virtio-net driver above it does not know it is not in a VM.

**The virtqueues live in the app-kernel's memory.** The driver allocates its descriptor, available, and used rings from its own RAM and writes their physical addresses into the table. There is no DMA API, no IOMMU mapping, and no address translation of any kind: both sides are CPUs on the same machine, and the host already has every byte of the spawn's memory in its direct map. The host side is a 286-line split-ring implementation, `mk_vring`, that checks each address the driver hands over against the instance's memory ranges once, when it walks the chain, and then works on plain pointers. A bad descriptor breaks that ring and nothing else.

**Doorbells are a bit and an IPI.** When the driver kicks a queue it sets a pending bit in the table entry and sends the bare multikernel IPI to the host CPU named in the table. The host's IPI handler runs a 48-line scan over registered doorbells and calls the backend's kick callback. Calls back to the driver go the same way in reverse. Nothing about the data plane touches the existing multikernel message ring, which stays what it was designed to be, a control plane with 64 four-kilobyte slots.

**The backend is a netdev.** `mk_vnet` is 562 lines in `drivers/net`, on the [multikernel-virtio branch](https://github.com/multikernel/linux/tree/multikernel-virtio){:target="_blank" rel="noopener noreferrer"} until it lands in the main tree. It registers with a small built-in device model that runs the status handshake and dispatches doorbells, and for every net entry it creates a host network device named after the instance, `mk-iperf-0` in this test. That netdev is peered with the spawn's `eth0` the way one end of a veth pair is peered with the other. When the host stack transmits on it, `mk_vnet` writes the frame into the spawn's receive ring in the caller's context and rings the doorbell. When the spawn transmits, its kick schedules NAPI and the poll loop pulls frames out of the transmit ring into skbs in softirq. One copy per direction, done by whoever is already running, with no worker thread in between. The netdev outlives kill and re-exec, so addresses and routes configured on it survive an app-kernel reboot, and its carrier follows the spawn's driver coming up and going down.

**Offloads negotiate like real hardware.** The backend offers checksum and TCP segmentation in both directions with 64 KB frames and mergeable receive buffers, and the host netdev's own feature flags follow whatever the spawn accepted. A spawn that negotiates TSO hands the host one 64 KB frame per burst; the host stack segments it, or hands it to a NIC that will.

**XDP takes the host stack out of the path.** `mk_vnet` implements `ndo_xdp_xmit` and runs an attached XDP program on frames from the spawn. That lets [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} attach a pair of BPF programs when you ask for `--virtio=net:ens7f1`. On the NIC, the program looks up the destination IPv4 address of each arriving frame and, if it belongs to an app-kernel, redirects the frame straight into that spawn's receive ring: no skb, one copy, done by the CPU that polled the NIC queue. On the app-kernel's netdev, the program rewrites the source MAC to the NIC's own and redirects the frame to the NIC's transmit path. The switch sees one MAC per port, which is what campus ports, cloud instances, and wireless networks enforce, and the NIC does not need to be dedicated, put in promiscuous mode, or bridged. The cost of that speed is that an XDP program sees raw frames, so while one is attached the backend withdraws the spawn's transmit offloads, exactly as `virtio_net` does in a VM.

Now list what is not in that description. There is no vhost worker thread, so no thread to schedule and no eventfd to signal it through. There is no tap device, because the backend is already a netdev. There is no bridge. There is no VM exit on a kick, because a kick is a store and an IPI, and no interrupt injection on a call, because a call is an IPI to a CPU that will take it natively. There is no vCPU scheduler between the interrupt and the driver, because the driver runs on a CPU it owns. And there is no daemon: `kerf create` makes the netdev, `kerf exec` boots the spawn, and the two find each other through the table.

For comparison, here is the same picture for the KVM guest we benchmarked. The top two boxes on the left are the same code. Everything under them is different, and every box on the right except the NIC driver is a component the app-kernel's path does not have.

<svg viewBox="0 0 720 400" role="img" aria-label="Data path of a KVM guest with vhost-net: virtio rings in guest memory, vhost worker, tap, bridge, VM exits for kicks" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<defs><marker id="vah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#6b7280"/></marker><marker id="vah2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#b45309"/></marker><marker id="vas2" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M8,0 L0,4 L8,8 Z" fill="#b45309"/></marker></defs>
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">How the KVM guest reaches the wire</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Same virtio-net driver, but every step below the transport is a hypervisor component</text>
<rect x="0" y="64" width="300" height="300" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="150" y="86" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">KVM guest (vCPU threads on the host)</text>
<rect x="330" y="64" width="390" height="300" rx="10" fill="#fbf8f1" stroke="#e5e7eb"/>
<text x="525" y="86" font-size="13" font-weight="600" fill="#a88428" text-anchor="middle">Host (KVM, vhost, QEMU)</text>
<rect x="30" y="100" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="122.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">TCP/IP stack</text>
<text x="150.0" y="137.0" font-size="11" fill="#6b7280" text-anchor="middle">unchanged</text>
<rect x="30" y="160" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">virtio_net driver</text>
<text x="150.0" y="197.0" font-size="11" fill="#6b7280" text-anchor="middle">unchanged</text>
<rect x="30" y="220" width="240" height="46" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">virtio_pci transport</text>
<text x="150.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">kick = MMIO write, traps to the host</text>
<rect x="30" y="290" width="240" height="56" rx="6" fill="#e8f0fb" stroke="#2a78d6" stroke-width="1.2"/>
<text x="150.0" y="317.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">RX ring · TX ring · PCI config</text>
<text x="150.0" y="332.0" font-size="11" fill="#6b7280" text-anchor="middle">guest memory, reached through EPT</text>
<rect x="360" y="100" width="330" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="525.0" y="122.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">Linux bridge or IP forwarding</text>
<text x="525.0" y="137.0" font-size="11" fill="#6b7280" text-anchor="middle">an skb per frame through the host stack</text>
<rect x="360" y="160" width="150" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="435.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">tap device</text>
<text x="435.0" y="197.0" font-size="11" fill="#6b7280" text-anchor="middle">queue between stack and vhost</text>
<rect x="540" y="160" width="150" height="46" rx="6" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="615.0" y="182.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">igb NIC driver</text>
<rect x="360" y="220" width="150" height="46" rx="6" fill="#ffffff" stroke="#a88428" stroke-width="1.2"/>
<text x="435.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">KVM</text>
<text x="435.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">VM exits, halt polling, irqfd</text>
<rect x="540" y="220" width="150" height="46" rx="6" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="615.0" y="242.0" font-size="12.5" font-weight="600" fill="#1f2937" text-anchor="middle">vhost-net worker</text>
<text x="615.0" y="257.0" font-size="11" fill="#6b7280" text-anchor="middle">a thread per device, copies</text>
<line x1="150" y1="146" x2="150" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="150" y1="206" x2="150" y2="220" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="150" y1="266" x2="150" y2="290" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="435" y1="146" x2="435" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="615" y1="146" x2="615" y2="160" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="500" y1="206" x2="570" y2="220" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<line x1="270" y1="243" x2="360" y2="243" stroke="#b45309" stroke-width="1.6" stroke-dasharray="5,4" marker-end="url(#vah2)" marker-start="url(#vas2)"/>
<text x="315" y="236" font-size="10.5" fill="#b45309" text-anchor="middle">kick / call</text>
<line x1="510" y1="243" x2="540" y2="243" stroke="#b45309" stroke-width="1.6" stroke-dasharray="5,4" marker-end="url(#vah2)" marker-start="url(#vas2)"/>
<text x="525" y="282" font-size="10.5" fill="#b45309" text-anchor="middle">eventfd / irqfd</text>
<line x1="560" y1="266" x2="270" y2="318" stroke="#6b7280" stroke-width="1.6" marker-end="url(#ah)"/>
<text x="440" y="308" font-size="11" fill="#6b7280" text-anchor="middle">one copy, guest addresses translated</text>
<text x="360" y="380" font-size="11" fill="#6b7280" text-anchor="middle">solid: data, an skb through bridge and tap, then one copy · dashed: kick = VM exit + eventfd, call = irqfd + injected interrupt</text>
</svg>

Put the two diagrams side by side and the differences fall into five places, each one a layer the VM has and the app-kernel does not.

| | KVM with vhost-net | Multikernel with mk_vnet |
|---|---|---|
| Transport | Emulated PCI; kicks trap | Shared table; a kick is a store |
| Ring memory | Guest addresses, translated by EPT and vhost | Host direct map, plain pointers |
| Kick | VM exit, eventfd, wake a thread | Pending bit, IPI |
| Call | irqfd, interrupt injection, wake the vCPU | IPI into a CPU the driver owns |
| Data path | skb, bridge, tap, worker thread, copy | XDP redirect, one copy, no skb |
| Idle | HLT exit, poll, sleep, scheduler wakeup | C-state, woken by the IPI |

Every row on the left is a piece of software between the driver and the wire, and every one of them shows up in the numbers below as CPU the guest cannot see.

## Benchmark Setup

Same host as before: a dual-socket Intel Xeon Gold 5418Y with SMT off, and now an Intel 1 Gbit NIC driven by `igb` with native XDP. The iperf server, iperf 2 listening on TCP, is a campus host one router hop away; the host kernel itself reaches it with a 0.43 ms round trip and 942 Mbit/s of TCP, which is the wire. The kernel is one build, `7.0.0-mk2+`, from the multikernel tree with mk_vnet, and both sides boot the identical `bzImage` and the identical root filesystem, an Ubuntu 20.04 image with iperf 2.0.13, driven by the same shell script. Both get two CPUs and 1 GB, on socket 0, and the same static address, so from the server's point of view the two runs are indistinguishable.

**Multikernel.** One kerf instance on two dedicated cores, with a virtio-net device routed through the NIC by XDP:

```
kerf create iperf --cpus=2,4 --memory=1024MB --virtio=net:ens7f1
kerf load iperf --kernel=bzImage --rootfs-dir=/root/iperf-rootfs \
    --entrypoint='/bin/bash /run-iperf.sh' \
    --nic=eth0 --ip=198.51.100.99 --netmask=255.255.255.0 --gateway=198.51.100.1
kerf exec iperf
```

The spawn's `eth0` is the unmodified `virtio_net` driver over `virtio_mk`. Because XDP is attached, the spawn ran without transmit checksum or segmentation offload: every TCP segment it sent was checksummed and sized in software inside the app-kernel. Keep that handicap in mind when reading its CPU numbers.

**KVM.** The same `bzImage` under QEMU/KVM with `-cpu host`, two vCPUs pinned one-to-one to two idle cores, QEMU's I/O threads and the vhost-net worker pinned to a third core so they never compete with the guest, and the guest's memory bound to the same NUMA node. The device is `virtio-net-pci` with `vhost=on`, the fast path every cloud runs:

```
numactl -m 0 taskset -c 10,12,14 qemu-system-x86_64 -name iperf,debug-threads=on \
    -enable-kvm -cpu host -smp 2 -m 1024 -kernel bzImage -initrd iperf-initrd.gz \
    -append "console=ttyS0 ip=198.51.100.99::198.51.100.1:255.255.255.0::eth0:off rdinit=/vm-init.sh" \
    -netdev tap,id=n0,ifname=tap0,script=no,downscript=no,vhost=on \
    -device virtio-net-pci,netdev=n0,mac=52:54:00:53:00:63
```

The guest negotiated checksum and TSO with vhost, so unlike the spawn it did have its transmit offloads. Its tap could not be bridged onto the NIC, because the campus port drops frames from a second MAC, which is the same constraint mk_vnet's XDP masquerade exists to satisfy. So the VM sits behind a routed tap: the host answers ARP for the guest's address on the NIC with proxy ARP and forwards between tap and NIC through its own IP stack. This is libvirt's routed mode, and it is the fair analog: on both sides the host mediates the address, XDP on one, forwarding on the other.

**Measurement.** iperf reports throughput. For CPU we did not trust either guest. Each guest logs its own `/proc/stat` around every test, and the host samples every CPU's `/proc/stat` once a second and correlates by timestamp. For the VM the host view includes the two vCPU threads, the QEMU and vhost threads, and the forwarding softirqs. For multikernel the spawn's cores are offline on the host, so its cost is the spawn's own accounting plus what the host spent redirecting frames. CPU cost below is given as a percentage of one core: 100% is one core saturated for the whole test, 215% is a little more than two cores. Every number is the median of three 15-second runs.

## Line Rate, Two Bills

Every TCP test on both sides landed between 941 and 942 Mbit/s. Here is what each side spent to get there.

| Test (CPU as % of one core) | Multikernel: spawn | Multikernel: host | Multikernel: total | KVM: guest sees | KVM: host total | KVM / MK |
|---|---|---|---|---|---|---|
| Upload, 1 stream | 9.3% | 3.8% | 13% | 5.2% | 26% | 2.0x |
| Upload, 4 streams | 9.1% | 3.7% | 13% | 4.7% | 100% | 7.7x |
| Upload, 256-byte writes | 20.5% | 3.4% | 24% | 40.4% | 61% | 2.5x |
| Download, 1 stream | 12% | 9.0% | 21% | 9% | 215% | 10x |

<svg viewBox="0 0 720 356" role="img" aria-label="CPU consumed at line rate for four iperf tests, multikernel versus a stock KVM guest" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">CPU consumed to move 942 Mbit/s, as a percentage of one core</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Whole-machine CPU while iperf runs at line rate, 100% = one core saturated · median of three 15 s runs</text>
<line x1="292.0" y1="66" x2="292.0" y2="318" stroke="#e5e7eb" stroke-width="1"/>
<text x="292.0" y="334" font-size="11" fill="#9ca3af" text-anchor="middle">50%</text>
<line x1="384.0" y1="66" x2="384.0" y2="318" stroke="#e5e7eb" stroke-width="1"/>
<text x="384.0" y="334" font-size="11" fill="#9ca3af" text-anchor="middle">100%</text>
<line x1="476.0" y1="66" x2="476.0" y2="318" stroke="#e5e7eb" stroke-width="1"/>
<text x="476.0" y="334" font-size="11" fill="#9ca3af" text-anchor="middle">150%</text>
<line x1="568.0" y1="66" x2="568.0" y2="318" stroke="#e5e7eb" stroke-width="1"/>
<text x="568.0" y="334" font-size="11" fill="#9ca3af" text-anchor="middle">200%</text>
<line x1="660.0" y1="66" x2="660.0" y2="318" stroke="#e5e7eb" stroke-width="1"/>
<text x="660.0" y="334" font-size="11" fill="#9ca3af" text-anchor="middle">250%</text>
<rect x="200" y="52" width="12" height="12" rx="2" fill="#2a78d6"/><text x="217" y="62" font-size="12" fill="#1f2937">Multikernel (spawn + host)</text>
<rect x="449" y="52" width="12" height="12" rx="2" fill="#a88428"/><text x="466" y="62" font-size="12" fill="#1f2937">KVM, stock defaults</text>
<text x="190" y="95.0" font-size="12.5" fill="#1f2937" text-anchor="end">Upload, 1 stream</text>
<text x="190" y="111.0" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">KVM 2.0x</text>
<path d="M200,76 L219.9,76 Q223.9,76 223.9,80 L223.9,88 Q223.9,92 219.9,92 L200,92 Z" fill="#2a78d6"><title>Upload, 1 stream, Multikernel (spawn + host): 13%</title></path>
<text x="230.9" y="88.5" font-size="12" font-weight="600" fill="#1f2937">13%</text>
<path d="M200,96 L243.8,96 Q247.8,96 247.8,100 L247.8,108 Q247.8,112 243.8,112 L200,112 Z" fill="#a88428"><title>Upload, 1 stream, KVM, stock defaults: 26%</title></path>
<text x="254.8" y="108.5" font-size="12" font-weight="600" fill="#1f2937">26%</text>
<text x="190" y="155.0" font-size="12.5" fill="#1f2937" text-anchor="end">Upload, 4 streams</text>
<text x="190" y="171.0" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">KVM 7.7x</text>
<path d="M200,136 L219.9,136 Q223.9,136 223.9,140 L223.9,148 Q223.9,152 219.9,152 L200,152 Z" fill="#2a78d6"><title>Upload, 4 streams, Multikernel (spawn + host): 13%</title></path>
<text x="230.9" y="148.5" font-size="12" font-weight="600" fill="#1f2937">13%</text>
<path d="M200,156 L380.0,156 Q384.0,156 384.0,160 L384.0,168 Q384.0,172 380.0,172 L200,172 Z" fill="#a88428"><title>Upload, 4 streams, KVM, stock defaults: 100%</title></path>
<text x="391.0" y="168.5" font-size="12" font-weight="600" fill="#1f2937">100%</text>
<text x="190" y="215.0" font-size="12.5" fill="#1f2937" text-anchor="end">Upload, 256-byte writes</text>
<text x="190" y="231.0" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">KVM 2.5x</text>
<path d="M200,196 L240.2,196 Q244.2,196 244.2,200 L244.2,208 Q244.2,212 240.2,212 L200,212 Z" fill="#2a78d6"><title>Upload, 256-byte writes, Multikernel (spawn + host): 24%</title></path>
<text x="251.2" y="208.5" font-size="12" font-weight="600" fill="#1f2937">24%</text>
<path d="M200,216 L308.2,216 Q312.2,216 312.2,220 L312.2,228 Q312.2,232 308.2,232 L200,232 Z" fill="#a88428"><title>Upload, 256-byte writes, KVM, stock defaults: 61%</title></path>
<text x="319.2" y="228.5" font-size="12" font-weight="600" fill="#1f2937">61%</text>
<text x="190" y="275.0" font-size="12.5" fill="#1f2937" text-anchor="end">Download, 1 stream</text>
<text x="190" y="291.0" font-size="11.5" font-weight="600" fill="#a88428" text-anchor="end">KVM 10x</text>
<path d="M200,256 L234.6,256 Q238.6,256 238.6,260 L238.6,268 Q238.6,272 234.6,272 L200,272 Z" fill="#2a78d6"><title>Download, 1 stream, Multikernel (spawn + host): 21%</title></path>
<text x="245.6" y="268.5" font-size="12" font-weight="600" fill="#1f2937">21%</text>
<path d="M200,276 L591.6,276 Q595.6,276 595.6,280 L595.6,288 Q595.6,292 591.6,292 L200,292 Z" fill="#a88428"><title>Download, 1 stream, KVM, stock defaults: 215%</title></path>
<text x="602.6" y="288.5" font-size="12" font-weight="600" fill="#1f2937">215%</text>
</svg>

Read the two KVM columns against each other first, because they are the story in miniature. During the download the guest believed it was using 9% of one core. The host was spending 215%, more than two full cores. That gap is not measurement noise; it is the definition of a hypervisor. The work of being a VM happens in the host, on the guest's behalf, and the guest's own accounting cannot see it. A team sizing this workload from inside the VM would have provisioned it at a twentieth of its real footprint.

**Upload is a 2x story.** A single TCP stream costs the app-kernel 13% of a core all in, and the VM 26%. The spawn's own share, 9.3%, is higher than the guest's visible 5.2% because the spawn had no TSO: it built and checksummed every 1500-byte segment itself while the guest handed vhost 64 KB frames. Even so, the host side of mk_vnet was 3.8%, the cost of XDP redirecting about 80,000 frames a second, and it is the only host cost there is. The VM's host total is what remains after you take the guest's 5.2% and add the vCPU threads' exits and polling, vhost copying from the guest, and the forwarding softirqs.

**Four streams is a 7.7x story.** Multikernel does not move: 13% whether the traffic is one stream or four, because the work is the same bytes through the same ring. The VM climbs to a full core. Four streams means four sockets' worth of ACKs arriving and four kicks interleaving, and each of those is an exit, a wakeup, or a poll.

**Small writes are a 2.5x story, and the one place the guest looked expensive to itself.** With 256-byte writes and Nagle off, iperf makes about 460,000 send calls a second. The guest's own accounting jumped to 40%, twice the spawn's 20%, because many of those sends ended in a kick to the device, and a kick from a guest is a trapping instruction. The spawn's kick is a store and an IPI.

**Download is a 10x story.** Receiving 941 Mbit/s cost the app-kernel 21% of a core in total: 12% in the spawn and 9% on the host to redirect frames into its ring. It cost the KVM guest 215%, with both pinned vCPU threads at essentially 100% on the host while the guest reported itself 94% idle. That number was suspicious enough to deserve its own experiment.

## Where Two Cores Went

We reran only the download test, three times in one guest, changing one host setting between runs and snapshotting KVM's own counters from debugfs at every phase boundary.

| Download at 941 Mbit/s (% of one core) | Host total | vCPU 0 thread | vCPU 1 thread | QEMU + vhost | Guest sees |
|---|---|---|---|---|---|
| KVM, stock defaults | 220% | 98% | 99% | 10% | 6% |
| KVM, `kvm.halt_poll_ns=0` | 54% | 8% | 24% | 17% | 14% |
| KVM, stock defaults again | 221% | 76% | 89% | 11% | 9% |
| Multikernel | 21% | | | 9% host | 12% spawn |

<svg viewBox="0 0 720 224" role="img" aria-label="CPU spent receiving at line rate under three configurations" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Receiving 941 Mbit/s: what the machine actually spends</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Second half of the iperf tradeoff test, host-side accounting of every CPU involved, 100% = one core</text>
<line x1="372.0" y1="54" x2="372.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="372.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">50%</text>
<line x1="444.0" y1="54" x2="444.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="444.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">100%</text>
<line x1="516.0" y1="54" x2="516.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="516.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">150%</text>
<line x1="588.0" y1="54" x2="588.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="588.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">200%</text>
<line x1="660.0" y1="54" x2="660.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="660.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">250%</text>
<text x="290" y="80" font-size="12.5" fill="#1f2937" text-anchor="end">KVM stock, guest sees itself 6% busy</text>
<path d="M300,64 L612.8,64 Q616.8,64 616.8,68 L616.8,82 Q616.8,86 612.8,86 L300,86 Z" fill="#a88428"><title>220% of a core</title></path>
<text x="623.8" y="80" font-size="12" font-weight="600" fill="#1f2937">220% of a core</text>
<text x="290" y="120" font-size="12.5" fill="#1f2937" text-anchor="end">KVM with halt_poll_ns=0, guest sees 14%</text>
<path d="M300,104 L373.8,104 Q377.8,104 377.8,108 L377.8,122 Q377.8,126 373.8,126 L300,126 Z" fill="#a88428"><title>54%</title></path>
<text x="384.8" y="120" font-size="12" font-weight="600" fill="#1f2937">54%</text>
<text x="290" y="160" font-size="12.5" fill="#1f2937" text-anchor="end">Multikernel, 12% spawn + 9% host</text>
<path d="M300,144 L326.2,144 Q330.2,144 330.2,148 L330.2,162 Q330.2,166 326.2,166 L300,166 Z" fill="#2a78d6"><title>21%</title></path>
<text x="337.2" y="160" font-size="12" font-weight="600" fill="#1f2937">21%</text>
</svg>

The setting is KVM's halt polling, and it is worth being precise about what it is, because it is neither of the two idle policies the previous post measured. The guest here runs the default HLT idle throughout; nobody passed `idle=poll`. When a vCPU executes HLT it exits to the host, as it must. The question is what the host does next. By default, before putting the vCPU thread to sleep, KVM spins for up to `halt_poll_ns`, 200 µs on every distribution we know of, checking whether an interrupt for that vCPU has become pending. If one arrives during the spin, the thread re-enters the guest without ever sleeping, and KVM counts a successful poll. The window is adaptive: it grows on success, up to the cap, and shrinks only on failure.

Now put 941 Mbit/s of incoming TCP through that. After the host's GRO and vhost's batching, each vCPU still gets an interrupt roughly every hundred microseconds, comfortably inside a 200 µs window. So every poll succeeds. In 30 seconds KVM attempted 464,000 halt polls and 458,000 of them succeeded, which means the vCPU threads reached the sleep step about 6,000 times. From the host's view both threads are pegged. From the guest's view it is idling in HLT, 94% of the time. Halt polling was designed to skip the scheduler round trip on an occasional wakeup, and under a sustained interrupt stream it degenerates into `idle=poll` implemented on the host side, invisible to the tenant, with the host paying the bill.

Disable it and the threads actually sleep: `halt_wakeup` climbs from 34,000 to 245,000, meaning the scheduler woke them a quarter of a million times, and the host total drops from 220% to 54% of a core at the same bandwidth. The guest's visible CPU rises to 14%, because each real wakeup now carries the full exit, sleep, wake, and entry that polling was hiding.

That 54% is the honest floor for this VM, and it is worth itemizing, because "is the rest just VM exits?" is the natural question. The guest saw 14% of work; its two vCPU threads consumed 32% on the host. The 18% between those numbers is the host acting on the vCPUs' behalf, and KVM's counters say what it was: about 8,200 HLT exits and 4,600 other exits per second, the latter mostly the guest's kicks on the virtio queues, which trap. That is roughly 14 µs per exit episode, far more than the 1 to 2 µs a bare exit and entry cost, because with polling off each HLT exit now drags the whole wake path behind it: the thread sleeps, the host core drops into idle, vhost's irqfd fires, the scheduler wakes the thread, an IPI wakes the core, and the VM entry finally happens. The other 17% is the vhost worker and QEMU moving the bytes, and the last 5% is the host forwarding between tap and NIC.

| Receiving 941 Mbit/s, halt polling off (% of one core) | KVM | Multikernel |
|---|---|---|
| The guest kernel's own receive work | 14% (guest-visible) | 12% (spawn) |
| Host time inside the vCPU threads beyond guest work: exits and the sleep and wake path around them | 18% | 0 |
| Moving the bytes into the guest | 17% (vhost worker + QEMU, through a tap and an skb) | 9% (XDP redirect, one copy, no skb) |
| Host forwarding softirqs | 5% | 0 |
| Total | 54% | 21% |

Line the two columns up and the shape is clear. The two kernels do about the same work receiving TCP, 14% against 12%. Everything else on the VM side is machinery the app-kernel does not have: the exit and wakeup path, a longer copy path with a thread hop in it, and the forwarding. The multikernel number required no tuning at all. The spawn's idle cores were in real C-states through `intel_idle`, and each doorbell IPI woke one of them directly into the driver. The split of the 18% between the exits themselves and the sleep and wake path around them is inferred from the counters and the accounting rather than measured with a profiler; the total is measured.

## The Round Trip

Bandwidth was a tie by construction. Latency was not.

<svg viewBox="0 0 720 224" role="img" aria-label="Ping round-trip time from the host, the multikernel spawn, and the KVM guest" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Round trip to the iperf server across the campus router</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">ping -c 200 -i 0.02, average RTT, median of three runs</text>
<line x1="352.5" y1="54" x2="352.5" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="352.5" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">0.25 ms</text>
<line x1="455.0" y1="54" x2="455.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="455.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">0.5 ms</text>
<line x1="557.5" y1="54" x2="557.5" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="557.5" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">0.75 ms</text>
<line x1="660.0" y1="54" x2="660.0" y2="186" stroke="#e5e7eb" stroke-width="1"/>
<text x="660.0" y="202" font-size="11" fill="#9ca3af" text-anchor="middle">1 ms</text>
<text x="240" y="80" font-size="12.5" fill="#1f2937" text-anchor="end">Host kernel itself</text>
<path d="M250,64 L422.3,64 Q426.3,64 426.3,68 L426.3,82 Q426.3,86 422.3,86 L250,86 Z" fill="#9ca3af"><title>0.43 ms</title></path>
<text x="433.3" y="80" font-size="12" font-weight="600" fill="#1f2937">0.43 ms</text>
<text x="240" y="120" font-size="12.5" fill="#1f2937" text-anchor="end">Multikernel spawn</text>
<path d="M250,104 L463.3,104 Q467.3,104 467.3,108 L467.3,122 Q467.3,126 463.3,126 L250,126 Z" fill="#2a78d6"><title>0.53 ms (+0.10)</title></path>
<text x="474.3" y="120" font-size="12" font-weight="600" fill="#1f2937">0.53 ms (+0.10)</text>
<text x="240" y="160" font-size="12.5" fill="#1f2937" text-anchor="end">KVM guest, vhost-net</text>
<path d="M250,144 L586.3,144 Q590.3,144 590.3,148 L590.3,162 Q590.3,166 586.3,166 L250,166 Z" fill="#a88428"><title>0.83 ms (+0.40)</title></path>
<text x="597.3" y="160" font-size="12" font-weight="600" fill="#1f2937">0.83 ms (+0.40)</text>
</svg>

The host kernel reaches the server in 0.43 ms. The app-kernel adds about 0.10 ms to that round trip: an XDP redirect on the way in, a doorbell IPI, the spawn's stack, and a redirect on the way out. The KVM guest adds 0.40 ms, four times as much, through vhost, the tap, the host's forwarding path, and an interrupt injection and exit at each end. Under load the difference vanishes into the queue; iperf's own TCP round-trip estimate during a full-rate upload was 1.54 ms for the spawn and 1.57 ms for the guest, both dominated by the buffering in front of a saturated gigabit link. It is the unloaded number that describes the path, and the path is four times longer for the VM.

## Before You Quote These Numbers

A gigabit NIC is the instrument that made bandwidth a constant, and it also caps what this post can claim: we have not measured what either side does at 25 or 100 Gbit/s, where the host CPU per byte becomes the throughput limit rather than a footnote to it. The ratios above are per-byte costs at 1 Gbit/s; the tests that scale with packet rate rather than bytes, four streams and small writes, are the best hint of what faster links will show.

The spawn ran without transmit offloads because XDP was attached, and every one of its CPU numbers includes software checksumming and segmentation that the guest did not do. A spawn without XDP, or with a NIC program that preserves offload metadata, would post lower spawn numbers than these.

The VM's host cost includes the host's IP forwarding between tap and NIC, which a bridged VM would not pay. We could not bridge, for the same reason mk_vnet masquerades, so both sides carry a host-mediated address path. In the run with halt polling off, everything outside the vCPU, QEMU, and vhost threads, which is where forwarding lands, came to 5% of a core, so it cannot explain the difference between 54% and 220%.

The kernel under test routed every doorbell from every app-kernel to one host CPU; a per-instance doorbell CPU landed after this build. And as before, medians of three runs: the multikernel side was steady to the third digit; the VM's tradeoff runs, upload and download together, ranged from 118% to 127% of a core across the full matrix, and the download half from 220% to 221% in the focused experiment.

## Reproduce It Yourself

Build the [multikernel-virtio branch](https://github.com/multikernel/linux/tree/multikernel-virtio){:target="_blank" rel="noopener noreferrer"} of the kernel with `CONFIG_MK_VNET` and `CONFIG_VIRTIO_MULTIKERNEL`, create an instance with `--virtio=net:<your NIC>`, and give it an address with `--ip`. Anything with a virtio-net driver boots against it.

For the VM side, the iperf rootfs is any image with iperf 2 packed as an initramfs, booted with the kernel's `ip=` parameter and a routed or bridged tap with `vhost=on`. Pin the vCPU threads by name (`-name debug-threads=on` makes them `CPU 0/KVM` and `CPU 1/KVM`) and put QEMU's other threads and the `vhost-<pid>` worker somewhere else. Sample `/proc/stat` per CPU on the host for the whole run; the guest's own numbers are the least informative thing you will collect.

We would like to see this repeated against an iperf server that also listens on UDP, at 25 Gbit/s and above, and with the guest's `haltpoll` cpuidle driver enabled, which moves the polling from host to guest and makes it visible to the tenant without making it cheaper.

## The Second Bill

The previous post ended with an itemized bill for the kernel's own paths: a tuned guest matches native memory, then pays 2.5x on a context switch and 30 ns at every kernel entry, and can buy the wakeups back only by spinning or by seizing mwait.

This post is the second bill, for the wire, and it reads the same way. Both kernels moved the same bytes at the same speed. One did it for 13% to 24% of a core and a tenth of a millisecond, without a hypervisor, a worker thread, a tap, a bridge, or an exit anywhere in the path, because the driver in the app-kernel writes a ring the host reads by pointer and rings a bell the host answers with an interrupt. The other did it for 26% to 215% of a core and four tenths of a millisecond, and hid nine tenths of that cost from the only party that could have seen it.

The mechanism this time was not mwait. It was 200 µs of host-side halt polling, a default that every cloud runs and no tenant can observe, turning two pinned vCPUs into two spinning cores under a gigabit of incoming traffic. Turn it off and the VM is honest and still 2.6x, and the remainder is itemized above: exits and the wakeups they force, a copy path with a thread in it, and forwarding. That is the shape we keep finding. Virtualization has moved its cost out of the throughput column and into the sharing, the sleep, and the accounting, and mk_vnet exists because an app-kernel should not have to pay it to reach the network.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so is [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. If you are rethinking what isolation has to cost, we would love to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
