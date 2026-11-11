---
layout: post
title: "Why kdump Should Be Obsolete"
date: 2026-11-11 10:00:00 -0700
categories: [kmorph, multikernel, linux-kernel, reliability]
author: Cong Wang, Founder and CEO
excerpt: "When a Linux server panics, kdump boots a capture kernel, saves the dead kernel's memory, and then reboots the machine through firmware back into the regular kernel. That is two reboots, one of them slow, before the server serves again, and a crashkernel= reservation sized at boot that is either wasted or too small. kdump treats the dump as the goal and recovery as an afterthought. kmorph reverses the order. A successor kernel is already running beside the machine's kernel, detects the crash from outside, fences the dead kernel's CPUs and takes over its CPUs, memory and devices in about a second, with no reboot. It can still write a vmcore that crash and makedumpfile read directly."
---

When a Linux server panics in production, the operator has two questions. The first is when the server will be back. The second, usually asked days later and only if the crash keeps happening, is why it crashed.

kdump is built around the second question. Its name says so: it exists to dump the crashed kernel's memory, and everything else about it follows from that goal. The machine eventually comes back, but only after the dump is done and after a full reboot through firmware.

We think the order is wrong. The first job of whatever runs after a kernel crash is to bring the machine back into service, as fast as the hardware allows, unless the machine truly cannot continue. Saving the dump is the second job. It matters, and it should not be lost, but it should never sit on the critical path of recovery.

This post compares kdump with [kmorph](https://github.com/multikernel/kmorph){:target="_blank" rel="noopener noreferrer"}, built on [multikernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} Linux, on five questions: how long the machine is down, what happens to the dump, what memory is set aside, who starts the recovery, and when the recovery path is tested.

## What kdump Does

kdump has been the standard answer to kernel crashes on Linux for almost twenty years. It works in four steps.

1. **At boot,** the `crashkernel=` parameter reserves a region of memory. The regular kernel never uses it.
2. **While the machine runs,** a second kernel and its initramfs are loaded into that region with `kexec`, but not started.
3. **On a panic,** the crashing kernel stops the other CPUs and jumps straight into the loaded capture kernel. No firmware runs. This is the fast reboot.
4. **In the capture kernel,** a minimal user space reads the dead kernel's memory through `/proc/vmcore`, filters and compresses it with makedumpfile, and writes it to disk or the network. Then it reboots the machine. This is the slow reboot: through firmware, POST, the bootloader, and the regular kernel, followed by every service on the machine starting from scratch.

Only after step 4 does the server serve again.

## How kmorph Does It Instead

On a multikernel machine, several kernels can run at the same time, each on its own CPUs and memory. kmorph uses that to keep a **successor** kernel booted and running beside the machine's kernel, the **predecessor**, on a small slice of the machine, one CPU and a few hundred megabytes for example. The successor runs kmorphd, which watches the predecessor and takes the machine over when it dies.

1. **Watch.** kmorphd probes the predecessor ten times a second over vsock. A live kernel answers each probe by itself, with no user space involved. Five unanswered probes in a row, half a second with the defaults, mean the predecessor is dead.
2. **Fence.** The successor stops every CPU it does not own, by NMI and INIT on x86 and by a stop IPI and PSCI on arm64, and confirms that each one stopped.
3. **Adopt.** It takes every PCI device and resets it, so that any DMA the dead kernel left running stops, switches the IOMMUs to page tables of its own, puts the machine's network addresses back on the same NICs, and hot-adds the CPUs and the memory.
4. **Continue.** It mounts the root disk and starts the system's own init. The successor is now the machine's kernel, and arms a successor of its own.

The kernel that runs after a crash is the one that runs the machine. Each of the five questions below follows from that.

## Time Back to Service

**kdump** needs two reboots. The first is cheap: kexec skips firmware, and a capture kernel with one CPU and a small initramfs boots in seconds. The second is not. A server's firmware initializes memory, enumerates PCIe, runs option ROMs and trains links before it hands control to a bootloader, and on a large machine with many DIMMs this commonly takes minutes. Then the regular kernel boots, the init system starts, the network comes up, DHCP runs, disks are mounted, and every service warms up again from cold.

Between the two reboots sits the dump, and its cost grows with the machine. The capture kernel has to walk the dead kernel's memory, and on a host with hundreds of gigabytes or terabytes of RAM that walk takes a long time even when makedumpfile discards most pages. The capture kernel typically runs with a single CPU, so the walk does not get faster on a bigger machine. It gets slower.

**kmorph** needs none. No firmware runs and no kernel boots after the crash, because the kernel that takes over booted long before it. From detection to a running successor that owns the whole machine takes about a second. The machine answers on its own addresses again before its memory is even adopted, so neighbors need no new ARP and DHCP hands back the same lease. Services that must not wait even for init can run in the successor before the crash, as [standby services](https://github.com/multikernel/kmorph#standby-services){:target="_blank" rel="noopener noreferrer"}, and keep running through the takeover.

| Step after the crash | kdump | kmorph |
|---|---|---|
| Detection | panic path, immediate | half a second of silence |
| Into the recovery kernel | kexec, seconds | none, already running |
| Dump | grows with RAM, often minutes | optional |
| Fence and adopt the machine | none | about a second with detection |
| Firmware reboot | often minutes on a server | none |
| Regular kernel boot | tens of seconds | none |
| User space | full boot from cold | init from disk, or standby services already up |

## The Dump

**kdump** treats the dump as the goal. The capture kernel boots, writes a file and reboots, and everything it learned about the machine, every driver it loaded and every device it reset, is thrown away by the firmware reboot that follows. Most of the downtime in the table above is spent on a dump the operator may never open.

**kmorph** keeps the dump and makes it a choice rather than a precondition. With `dump` set in `kmorph.conf`, kmorphd writes the predecessor's memory to a file before it reclaims it. The file is an ELF core in the format of kdump's `/proc/vmcore`, with the registers of every CPU at the moment it stopped and the crashed kernel's VMCOREINFO, so the existing tools read it directly:

```
crash /boot/vmlinux /var/crash/predecessor.vmcore
crash> bt -a
makedumpfile -c -d 31 predecessor.vmcore predecessor.small
```

The dump is written by a kernel that already owns every CPU and every device of the machine and already answers on its network addresses, not by a single-CPU capture kernel that will throw everything away when it is done. A successor without a disk can stream it to a collector through a FIFO. And if a crash is well understood, you can turn the dump off and let the successor reclaim the memory at once.

## Memory Reservation

**kdump** needs its memory before the regular kernel starts, because after a crash there is no allocator left to ask. That reservation is the `crashkernel=` boot parameter, and choosing its size is a well-known source of pain.

Reserve too much, and that memory sits idle for the whole life of the machine. It holds a kernel that is never meant to run unless something goes wrong. On a fleet, a few hundred megabytes per host multiplies into terabytes of RAM that no workload can use.

Reserve too little, and the capture kernel runs out of memory at the one moment it has to work. The amount it needs is not fixed: it depends on the drivers it loads for the disk or NIC it writes to, on the size of the initramfs, and on the bitmaps and page tables makedumpfile builds, which grow with the RAM of the crashed machine. An OOM in the capture kernel means no dump and, often, a machine that hangs until someone power cycles it.

Distributions have tried to automate the guess. There have been `crashkernel=auto`, tables that pick a size from the amount of RAM, separate low and high reservations, and tools that measure a running system and recommend a value. Each helps, but none removes the underlying problem: the size has to be decided at boot, and changing it needs another reboot. We wrote about this when we introduced [Lazy CMA](/2026/03/08/introducing-lazy-cma/), which lets kdump allocate its region at runtime instead.

**kmorph** also sets memory aside, the successor's slice, but the reservation differs from `crashkernel=` in every way that made sizing it painful.

- **It is not a boot parameter.** `kmorph arm` creates the multikernel pool at runtime. To change the size, edit `memory` in `kmorph.conf`, disarm and arm again, which takes about a second.
- **It does not grow with the machine.** The successor's slice only has to hold its kernel and its image while it waits. The memory it needs to run the machine afterwards is the machine's own, which it adopts at the takeover. No capture kernel has to process terabytes of RAM in a few hundred megabytes.
- **It is not idle.** The successor is a running kernel. It can host standby services while it waits, and after the takeover its memory is simply part of the machine's kernel, which sets aside a slice for the next successor and arms it.

## Who Starts the Recovery

**kdump** is started by the crashed kernel. The jump into the capture kernel is the last thing a kernel does after it has already gone wrong: stop the other CPUs, save their registers, and transfer control to the loaded image. If the crash corrupted the structures that path depends on, or the kernel is not panicking but simply hung, with interrupts off or CPUs deadlocked, there is no jump. A hang only reaches kdump if a watchdog first turns it into a panic, and only if the watchdog is configured, still running, and able to fire.

**kmorph** is started by a kernel that is still healthy. The successor detects the predecessor's death from outside, by its silence. A panic and a hard hang look the same from there, and nothing depends on the dying kernel doing one more thing correctly. A slow predecessor is not mistaken for a dead one: a probe counts only when it goes unanswered past the next one, and it takes five in a row.

## When the Recovery Path Is Tested

**kdump** is tested when the machine crashes. The capture kernel boots on hardware the dead kernel left in an unknown state: devices still doing DMA into memory the dead kernel owned, IOMMUs pointing at its page tables, interrupt controllers with pending state. It has its own initramfs, its own minimal user space and, usually, its own set of drivers: a second operating system to build, configure and keep working, exercised far less often than the system it protects. A kdump configuration that silently stopped working after a kernel or driver update looks exactly like a working one, until it is needed.

**kmorph** is tested twice before any crash. First, when it is armed: the successor boots on a healthy machine and answers `kmorph status` from then on, so a successor that fails to boot is found at arm time, not at crash time. Second, at every kernel upgrade:

```
dnf upgrade kernel
systemctl restart kmorph    # arm a successor running the new kernel
kmorph upgrade
```

`kmorph upgrade` freezes the filesystems and hands the machine to the successor, which takes over exactly as after a crash, except that no dump is written. The kernel is upgraded without a reboot, and the code that will save the machine on its next crash is the code that just ran on the last upgrade.

## Recovering Around Bad Hardware

Not every crash is a software bug. An uncorrected memory error in kernel memory panics the kernel that owns it, and so does a fatal error in a CPU core. Most such errors are narrow: one page of memory, or one core. The rest of the machine is fine, and the hardware usually says exactly where the fault is. On x86, the machine check reports the physical address of the bad memory, and an error in a core's own logic is reported in that core's error banks. On arm64, firmware reports the same information as a CPER record, with the physical address and the MPIDR of the core.

**kdump** cannot act on this, by construction. The capture kernel does not run the machine. It saves the dump and reboots, and the regular kernel then boots onto the same hardware and uses the same page and the same core again, unless firmware or an operator maps them out first. The Linux MCE handler even marks the bad page so that kdump does not read it again while dumping, but that knowledge is gone after the firmware reboot. The best kdump can do is note where the fault was before it reboots the machine onto it.

**kmorph** decides what to take. A takeover is not a reboot onto whatever hardware is there; it is a list of CPUs and memory ranges that the successor chooses to adopt. Leaving out the page the machine check named, or the core whose banks reported the error, is one more entry in that list. The machine continues on everything else, the bad memory and the bad core never come back into use, and the operator replaces the DIMM or the CPU at the next maintenance window, not in the middle of an outage.

kmorph does not do this yet. The successor has to survive the machine check that kills the predecessor, and the predecessor has to hand over the error record before it goes silent. Both are kernel work, and both are on our list. But the structure is there: only a recovery that keeps a running kernel on the machine can recover around the hardware that failed.

## Side by Side

| | kdump | kmorph |
|---|---|---|
| Reboots after a crash | two: kexec, then firmware | none |
| Time back to service | dump plus a firmware reboot plus a full boot | about a second to a running kernel, then user space |
| vmcore for crash and makedumpfile | yes, on the critical path | yes, optional |
| Memory reservation | `crashkernel=`, fixed at boot, scales with RAM | runtime pool, resized without reboot, does not scale with RAM |
| Who starts recovery | the crashed kernel | a kernel that is still healthy |
| Hangs | only if a watchdog turns them into a panic | detected the same as a panic |
| Recovery path tested | at crash time | at arm time, and at every upgrade |
| Kernel upgrade without reboot | no | yes |
| Faulty page or core | rebooted onto again | can be left out of the takeover (planned) |

## What kmorph Does Not Cover

kmorph replaces kdump for kernel crashes and hangs. It does not help when the machine itself is lost, as in a power loss, or when a fault cannot be pinned to one page or one core, such as an error in a memory controller or an interconnect. It needs a multikernel kernel built with `CONFIG_MULTIKERNEL`, and while armed it holds a CPU and a slice of memory for the successor. A device with neither function level reset nor power state reset can only be quiesced, not reset, before the successor's driver meets it.

## Conclusion

kdump answered a real question at a time when one kernel per machine was the only option: how do we keep the evidence after that kernel dies? It answers it well. But it pays for the evidence with two reboots, a boot-time memory guess, and a recovery path that depends on the kernel that just failed and is tested only when it is needed.

Once a machine can run a second kernel beside the first, none of that is necessary. The successor is already booted, already checked, and ready to take the machine over the moment the first kernel goes silent. The machine comes back in about a second instead of minutes, and the dump, if you still want it, comes along with it.

That is why we think kdump should be obsolete. [kmorph](https://github.com/multikernel/kmorph){:target="_blank" rel="noopener noreferrer"} is open source and runs on [multikernel Linux](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} on x86-64 and arm64. For production fleets, [Multikernel LiveUpdate](/products/liveupdate.html) offers reboot-free kernel upgrades as a supported, per-node subscription. Reach us at [contact@multikernel.io](mailto:contact@multikernel.io).
