---
layout: post
title: "Multikernel Loves RISC-V Supervisor Domains"
date: 2026-10-06 10:00:00 -0700
categories: [multikernel, riscv, security, linux-kernel, architecture]
author: Cong Wang, Founder and CEO
excerpt: "Multikernel runs several Linux kernels side by side on one machine, each on its own cores and its own memory. Today that boundary holds because each kernel is only told about the resources it owns, not because the hardware stops it from touching anything else. Every mainstream way to make the hardware enforce it goes through a hypervisor. RISC-V's draft Supervisor Domains extensions are the first standard mechanism we know of that enforces page-granular memory isolation between operating system kernels without virtualizing any of them. This post explains what they are, why they are not virtualization, what x86 and ARM offer instead, and how multikernel would use them."
---

Multikernel runs several Linux kernels on one machine at the same time. Each kernel owns a set of CPU cores, a set of physical memory ranges, and whatever devices it has been given. The kernels are peers: they boot independently through kexec, they do not share a scheduler or a page allocator, and they communicate only through shared memory regions that were set up for that purpose.

That design gives each workload its own kernel without a hypervisor in the way, which is where its performance comes from. It also raises an obvious question. If there is no hypervisor, what stops one kernel from writing to another kernel's memory?

Today the answer is construction rather than enforcement. A spawned kernel is booted with a memory map that lists only its own ranges, so it never allocates, maps, or touches anything else in normal operation. That is enough to contain ordinary bugs. It is not enough against a kernel that has been compromised, because a kernel runs at the highest privilege the operating system has, and the hardware will let it map any physical address it likes.

Closing that gap needs hardware that can say "this kernel may touch these pages and no others" without turning the kernel into a virtual machine. On most architectures, that hardware does not exist in a form we can use. RISC-V is drafting it now, under the name Supervisor Domains.

## What Supervisor Domains are

[Supervisor Domains](https://github.com/riscv/riscv-smmtt){:target="_blank" rel="noopener noreferrer"} are a set of draft RISC-V privileged extensions for dividing a platform among isolated supervisor-mode software stacks. The specification describes the goal plainly: a supervisor domain "is allocated a set of resources, including memory and I/O regions, processing elements, devices, and interrupts, and is granted access only to those resources required to perform its function."

The pieces are:

- **`Smsd` and the Memory Protection Table (MPT).** Each hart carries a supervisor domain identifier (SDID) in a machine-mode CSR, `mmpt`, alongside the root of an in-memory Memory Protection Table. The MPT is a radix tree indexed by physical address that holds read, write, and execute permissions for every 4 KiB page. When supervisor domains are enabled, every memory access from S-mode or U-mode is checked against the active domain's table, and a violation traps to machine mode. Implementations cache MPT lookups in a TLB-like structure.
- **IO-MPT.** Binds an IOMMU, and the devices behind it, to a domain, so device DMA is checked against the same kind of table.
- **`Smsdia`.** Extends the RISC-V Advanced Interrupt Architecture so that individual IMSIC interrupt files and APLIC interrupt domains can be assigned to a supervisor domain, which lets a domain receive its device interrupts directly.
- **QoS, debug, and trace controls.** Keep cache and bandwidth monitoring, external debug, and trace from leaking information across domains.

All of it is managed by machine-mode firmware that the specification calls the Root Domain Security Manager (RDSM). The RDSM owns the MPTs, programs the SDID on each hart, and is the only software allowed to change which domain owns which page. Memory can be reassigned between domains at runtime, and two domains share memory simply by both having the same pages in their tables.

The specification is a draft. The repository is active, the extension names have changed during development (the MPT was originally called the Memory Tracking Table, hence `riscv-smmtt`), and we know of no shipping silicon that implements it.

## Access control, not virtualization

Supervisor Domains are easy to mistake for a virtualization feature, because the most cited use case is confidential computing for virtual machines. They are not one, and the difference is the reason multikernel cares about them.

Hardware virtualization, which on RISC-V is the H extension, exists to present a virtual machine to a guest. It adds new privilege modes for the guest (VS-mode and VU-mode), a second stage of address translation from guest physical to host physical addresses, traps that send the guest's privileged operations to the hypervisor, and virtual interrupt injection. The guest kernel never sees the real machine. Every one of those mechanisms has a cost, which is why VM exits, two-stage page walks, and emulated or paravirtual devices show up in our earlier comparisons of multikernel with KVM on [system call and process latency](/2026/08/16/multikernel-vs-kvm-lmbench/) and on [network throughput](/2026/09/06/multikernel-vs-kvm-iperf/).

Supervisor Domains do none of that:

| | Hardware virtualization (H extension) | Supervisor Domains (`Smsd`) |
|---|---|---|
| Purpose | Present a virtual machine to a guest | Restrict which physical memory a domain may access |
| Address translation | Two stages, guest physical to host physical | None; the MPT only checks permissions |
| Privileged instructions | Trapped to the hypervisor and emulated | Executed natively |
| Virtual CPU state | VS-mode CSRs, virtual interrupts | None |
| Managed by | Hypervisor in HS-mode | Firmware in M-mode |
| What the kernel sees | A virtual machine | The real machine, with some pages forbidden |

A kernel running inside a supervisor domain runs in ordinary S-mode, uses its own page tables directly, and handles its own traps. The only new event in its life is a permission check on the physical address of each access, which normally hits in a cache.

Supervisor Domains and virtualization are independent, and they compose. The specification leaves isolation within a domain to "the OS/hypervisor managing the supervisor domain," so a domain can run a hypervisor if its cores implement H. The confidential computing design built on top of Supervisor Domains, CoVE, does exactly that: a host hypervisor runs in one domain, and a security monitor in another protects confidential VMs from it. Because nothing in Supervisor Domains depends on H, they also work on cores that do not implement it, such as the AI cores on the [heterogeneous RISC-V chips](/2026/07/08/multikernel-heterogeneous-riscv/) we wrote about in July.

## Why multikernel needs memory protection

In a multikernel system, every kernel shares one physical address space with every other kernel. Each kernel's view of that space is limited by the resources it was booted with, but the limit lives in software. Three situations show where software is not enough.

**A compromised kernel.** An attacker who gains kernel privileges in one kernel can create a mapping for any physical address and read or write another kernel's memory, including its page tables and credentials. The [multikernel trust model](/faq.html) already states this: the kernel is the trust boundary, and a compromised kernel could affect its neighbors. Kernel signing, lockdown, and memory encryption reduce the risk. Only hardware enforcement removes it.

**Device DMA.** A misprogrammed device or a buggy driver can write anywhere in physical memory, and no kernel sees it happen. An IOMMU confines DMA today on platforms that have one, but it is configured by the kernel that owns the device, so it protects other kernels only as long as that kernel is correct.

**Shared regions.** Multikernel kernels cooperate through shared memory: IPI rings, the multikernel DMA heap, and [DAXFS](/2026/09/30/the-kernel-crashed-the-memory-didnt/) images that outlive the kernel that wrote them. Each region should be accessible to the kernels that use it and to no others, and ideally read-only where a kernel only reads. Without hardware support, every kernel can reach every region.

None of these require a virtual machine to fix. They require a mechanism below the kernel that holds a per-kernel list of physical pages and checks it on every access, from the CPU and from devices. That is a precise description of Supervisor Domains.

## What other architectures offer

Every major architecture has memory protection hardware. The question for multikernel is whether any of it can confine one operating system kernel to its own physical pages without virtualizing that kernel. The answer, outside RISC-V, is mostly no.

### x86-64

- **EPT and NPT.** Intel's Extended Page Tables and AMD's Nested Page Tables are a second stage of address translation, and they are the standard way to confine a kernel's physical accesses. They are only active when the kernel runs as a guest under VMX or SVM, so using them means installing a hypervisor, accepting VM exits, and paying for two-stage page walks. A minimal hypervisor that only programs EPT and otherwise stays out of the way is possible, but it is still virtualization.
- **Protection Keys for Supervisor (PKS).** PKS tags kernel page table entries with one of 16 keys and lets a per-CPU register disable access to each key. It is useful for hardening one kernel against its own bugs. It cannot confine a kernel, because the kernel writes both its page tables and the key register.
- **AMD SEV-SNP and Intel TDX.** SEV-SNP's Reverse Map Table and TDX's Secure EPT do enforce page ownership against privileged software. Both are built to protect virtual machines from their hypervisor, so the protected party has to be a VM.
- **Memory encryption (TME and MKTME).** Encryption keeps data confidential, but without integrity protection it does not stop a kernel from overwriting another kernel's memory with garbage.

### ARM

- **Stage-2 translation at EL2.** This is ARM's equivalent of EPT, and again it requires a hypervisor. Android's protected KVM is instructive: it confines even the host Linux kernel by placing it under a stage-2 table owned by a small hypervisor at EL2. It works, but it reaches access control through virtualization hardware.
- **Memory Tagging Extension (MTE).** MTE assigns a 4-bit tag to every 16-byte granule of memory and checks it against a tag carried in the pointer. The hardware performs the check, but the tags are set, and checking is enabled or disabled, by the same software it protects. With 16 tag values, a mismatch is also only detected probabilistically. MTE is an excellent tool for finding memory-safety bugs. It is not a boundary between two kernels, because a compromised kernel can simply retag the memory or turn checking off.
- **TrustZone and the Realm Management Extension (RME).** TrustZone divides the machine into two worlds, secure and non-secure. RME's Granule Protection Table, part of the Confidential Compute Architecture, is the closest ARM analogue to an MPT: firmware at EL3 assigns each physical granule to one of four physical address spaces (non-secure, secure, realm, root) and the hardware enforces it. Four is a fixed number of worlds, however, not one per kernel, and individual realms are separated from each other by stage-2 translation managed by the Realm Management Monitor. Isolation between realms is virtualization again.

### RISC-V before Supervisor Domains

- **PMP and Smepmp.** Physical Memory Protection lets machine-mode firmware restrict the physical ranges that S-mode and U-mode may access, without any virtualization. [OpenSBI domains](https://github.com/riscv-software-src/opensbi/blob/master/docs/domain_support.md){:target="_blank" rel="noopener noreferrer"} use it to partition harts and memory between separate payloads. The limitation is scale: hardware typically provides 16 PMP entries, sometimes 64, and each one describes a single contiguous range. That suffices for a few fixed partitions, not for kernels that grow and shrink their memory at runtime and share many small regions. The Supervisor Domains specification cites exactly this limitation as its motivation.

In summary:

| Mechanism | Enforced below the kernel | Needs virtualization | Granularity | Number of domains |
|---|---|---|---|---|
| x86 EPT / NPT | Yes | Yes | Page | Many |
| x86 PKS | No | No | Page | 16 keys, set by the kernel |
| SEV-SNP RMP / TDX | Yes | Yes, protects VMs | Page | Many VMs |
| ARM stage-2 | Yes | Yes | Page | Many |
| ARM MTE | No | No | 16 bytes | 16 tags, set by the kernel |
| ARM RME GPT | Yes | No for the four worlds, yes between realms | Granule | 4 worlds |
| RISC-V PMP | Yes | No | Range | Limited by 16 to 64 entries |
| RISC-V Supervisor Domains | Yes | No | Page | Many; each hart tags up to 64 |

Supervisor Domains are the only entry that is enforced below the kernel, independent of virtualization, page-granular, and scales beyond a handful of domains.

## How Supervisor Domains were meant to be used

Multikernel is not what the authors of Supervisor Domains had in mind. The task group's charter starts from confidential computing, with workloads that "require confidentiality and integrity protection of data in use against software and hardware adversaries," and the reference software it plans to prototype is a domain security manager such as the TEE Security Manager (TSM) of CoVE. Neither the charter nor the specification mentions running several general-purpose kernels side by side.

The specification's use cases point to two deployment patterns.

**Static partitions set up by firmware.** A trusted execution environment, a security service, or a service provider with exclusive access to some devices runs in its own domain next to the main operating system. Machine-mode firmware loads each domain's software at power-on, the way OpenSBI domains load one payload per domain today, and the set of domains does not change while the machine runs. This is TrustZone generalized beyond two worlds: Linux beside a trusted OS, or Linux beside a real-time OS on an embedded part.

**Confidential virtual machines.** CoVE, the main target, uses two long-lived domains. The host domain runs Linux and KVM. The confidential domain runs the TSM, a small security monitor rather than a general-purpose kernel. To launch a confidential VM, the host hypervisor donates pages through CoVE's SBI host interface, firmware moves them into the confidential domain's Memory Protection Table, and the TSM builds the VM's second-stage page tables and runs it with the H extension. Every confidential VM lives in the same confidential domain, and the TSM separates them from each other with second-stage translation.

In both patterns, a domain is a trust zone rather than a workload. There are a few of them, created at boot and kept for the life of the machine, and additional workloads are added inside a domain as virtual machines. The hardware reflects that: the SDID is at most six bits wide, it is local to each hart, and changing a hart's SDID costs a flush of the state cached under the old one.

Multikernel uses the same hardware with a different unit of isolation:

| | Intended use (TEE, CoVE) | Multikernel |
|---|---|---|
| What a domain holds | A trust zone: host, security monitor, or TEE | One kernel and its workload |
| Number and lifetime | A few, created at boot | Many, created and destroyed at runtime |
| How a new workload starts | As a VM inside an existing domain, using H | As a native kernel in a new domain, without H |
| Who starts it | Firmware at boot, or the TSM for VMs | kerf on the host kernel, through kexec |

Nothing in the specification rules this out. It notes that a hart's or a device's assignment to a domain may be static or dynamic, and it expects memory to be reassigned between domains at runtime through an interface to the RDSM. The six-bit SDID is not a constraint either: in a multikernel system each hart belongs to one kernel at a time, so it only ever needs the identifier of that kernel's domain, while the number of domains on the machine is limited only by the Memory Protection Tables firmware is willing to keep. What the specification leaves to software is starting a kernel on chosen cores from a running system, handing it resources and taking them back, connecting kernels to each other, and recovering when one of them fails. That is the part multikernel already provides.

## How multikernel would use Supervisor Domains

Multikernel already treats a kernel as a bundle of explicitly assigned resources: cores, physical memory chunks from a runtime memory pool, devices, and shared regions. Supervisor Domains enforce exactly that bundle. The mapping is close to one-to-one: one kernel becomes one supervisor domain.

<svg viewBox="0 0 720 384" role="img" aria-label="Three multikernel kernels, each in its own supervisor domain, with a shared region granted to two of them, all enforced by machine-mode firmware" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<defs><marker id="sdah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#6b7280"/></marker></defs>
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">One kernel, one supervisor domain</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">Every kernel runs natively in S-mode; firmware checks each physical access against its domain's table</text>
<rect x="0" y="64" width="228" height="140" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="114" y="88" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">Host kernel (SDID 0)</text>
<text x="114" y="106" font-size="11" fill="#6b7280" text-anchor="middle">harts 0-1</text>
<rect x="20" y="118" width="188" height="32" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="114" y="139" font-size="12" font-weight="600" fill="#1f2937" text-anchor="middle">private memory</text>
<rect x="20" y="158" width="188" height="32" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="114" y="179" font-size="12" font-weight="600" fill="#1f2937" text-anchor="middle">kerf: assigns resources</text>
<rect x="246" y="64" width="228" height="140" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="360" y="88" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">Kernel A (SDID 1)</text>
<text x="360" y="106" font-size="11" fill="#6b7280" text-anchor="middle">harts 2-5, NIC queue via IO-MPT</text>
<rect x="266" y="118" width="188" height="72" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="360" y="159" font-size="12" font-weight="600" fill="#1f2937" text-anchor="middle">private memory</text>
<rect x="492" y="64" width="228" height="140" rx="10" fill="#f3f6fb" stroke="#e5e7eb"/>
<text x="606" y="88" font-size="13" font-weight="600" fill="#2a78d6" text-anchor="middle">Kernel B (SDID 2)</text>
<text x="606" y="106" font-size="11" fill="#6b7280" text-anchor="middle">harts 6-7, no H extension needed</text>
<rect x="512" y="118" width="188" height="72" rx="6" fill="#ffffff" stroke="#2a78d6" stroke-width="1.2"/>
<text x="606" y="159" font-size="12" font-weight="600" fill="#1f2937" text-anchor="middle">private memory</text>
<rect x="246" y="220" width="474" height="44" rx="8" fill="#fbf3e3" stroke="#a88428" stroke-width="1.2"/>
<text x="483" y="240" font-size="12" font-weight="600" fill="#1f2937" text-anchor="middle">shared region: in the tables of kernels A and B only</text>
<text x="483" y="256" font-size="11" fill="#6b7280" text-anchor="middle">IPC ring, DMA heap buffer, or DAXFS image</text>
<line x1="114" y1="204" x2="114" y2="296" stroke="#6b7280" stroke-width="1.6" marker-end="url(#sdah)"/>
<text x="124" y="244" font-size="10.5" fill="#6b7280">SBI: create, grant,</text>
<text x="124" y="258" font-size="10.5" fill="#6b7280">revoke, assign</text>
<rect x="0" y="300" width="720" height="72" rx="10" fill="#fbf8f1" stroke="#a88428" stroke-width="1.2"/>
<text x="360" y="326" font-size="13" font-weight="600" fill="#a88428" text-anchor="middle">M-mode firmware (Root Domain Security Manager)</text>
<text x="360" y="346" font-size="11" fill="#6b7280" text-anchor="middle">one Memory Protection Table per domain · IO-MPT for device DMA · interrupt files per domain</text>
<text x="360" y="362" font-size="11" fill="#6b7280" text-anchor="middle">the only software that can change which domain owns a page</text>
</svg>

Walking through the life of a kernel shows where each piece fits.

**Spawning.** Today, kerf allocates memory for a new kernel from the runtime memory pool, loads the kernel image into it with `kexec_file_load()`, and starts the kernel on its assigned cores. With Supervisor Domains, the host kernel would additionally ask the RDSM to create a domain, place the new kernel's memory in that domain's table, remove it from its own, and start the assigned harts with the new SDID. From the first instruction, the new kernel can touch only what it was given. The host keeps access only to the small regions it needs to manage the kernel, such as the manifest page and the IPI ring.

**Growing and shrinking memory.** Multikernel already moves memory between kernels at runtime from a pool allocated through lazy_cma. Each transfer would become a pair of RDSM operations: revoke from the donor, grant to the recipient, with the pages scrubbed in between when they carry data that the recipient should not see. The specification anticipates this pattern and leaves the cache and TLB maintenance to the RDSM.

**Sharing.** A shared region is a set of pages present in more than one domain's table, with permissions chosen per domain. An IPI ring is writable by both ends. A DAXFS image can be writable by the kernel that owns it and read-only to kernels that only read it. A buffer from the multikernel DMA heap appears in the tables of exactly the kernels that imported it. For the first time, "shared memory between kernels" would mean a specific, enforced list rather than all memory.

**Devices and interrupts.** When a kernel owns a device, or a queue on one, IO-MPT binds that device's DMA to the kernel's domain, so a faulty device can only corrupt its own kernel. With `Smsdia`, each kernel gets its own IMSIC interrupt files, and device interrupts are delivered to it directly instead of trapping to machine mode first. This matters for performance: by default, interrupts during supervisor domain execution trap to the RDSM, and a design that leaves them there would add latency to every I/O completion.

**Crashing.** When a kernel panics, multikernel parks its CPUs and lets the host start a replacement on the same resources. With Supervisor Domains, the host can also revoke the dead kernel's access before anything else happens, so whatever a failing kernel does in its last moments stays inside its own pages. Regions it did not own, such as a DAXFS image held by another kernel, are untouched, which is the property our [crash recovery experiment](/2026/09/30/the-kernel-crashed-the-memory-didnt/) relies on.

The resulting trust model is much smaller than today's. Each kernel no longer has to trust every other kernel. It trusts the RDSM, which is a small piece of firmware, and the host kernel's resource assignment policy, which is the role the specification describes as a "host (operator) domain that manages resources on the platform, and may assign resources to other domains."

## What has to happen first

Three things stand between this design and a running system.

**Silicon.** Supervisor Domains are a draft specification without a hardware implementation we can buy. A design can be developed and validated on an emulator that models the MPT, but the performance of MPT caching and the latency of domain transitions can only be measured on real parts.

**A supervisor interface to the RDSM.** The specification expects that supervisor software will request domain changes through "an interface" to a trusted driver in the RDSM, but it does not define one. The CoVE host extension to SBI is the closest precedent. Multikernel needs a small, general set of calls: create and destroy a domain, assign harts, grant and revoke pages with permissions, and assign IOMMUs and interrupt files. We would rather see one standard SBI extension for this than a private interface per vendor, and we intend to contribute to that discussion.

**Multikernel on RISC-V.** Multikernel runs on x86-64 today. Bringing it to RISC-V involves kernel spawning on RISC-V boot flows, interrupt routing with AIA, and device tree descriptions of each kernel's resources. That work is needed regardless of Supervisor Domains, and it is the same platform work we described in our post on heterogeneous RISC-V.

## A boundary that belongs to the hardware

Multikernel's premise is that a single machine can host several independent kernels without a hypervisor, because modern hardware has more cores than one kernel can use well. The part of that premise that hardware has not supported is enforcement. On x86 and ARM, every general way to confine a kernel to its own memory passes through virtualization, which brings back the overhead multikernel exists to avoid.

Supervisor Domains are the first standard design we know of that provides the missing piece on its own terms: page-granular protection of physical memory, for CPUs and devices, enforced below the kernel, without a second stage of translation and without trapping a single privileged instruction. That is the exact shape of the boundary multikernel draws in software today. With Supervisor Domains, the hardware would draw it too.

If you are working on Supervisor Domains in silicon, firmware, or the SBI specification, we would like to work with you on making multikernel an early software stack for it. Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so is [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. You can reach us at [contact@multikernel.io](mailto:contact@multikernel.io).
