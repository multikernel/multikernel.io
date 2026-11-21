---
layout: post
title: "96 Cores Launch Fewer Containers Than 48"
date: 2026-11-20 10:00:00 -0800
categories: [benchmark, multikernel, linux-kernel, performance, scalability, containers]
author: Cong Wang, Founder and CEO
excerpt: "On a 96-core server, one Linux kernel launched 18 user-namespaced containers per second. With half the cores taken away it launched 43. The cause is the kernel's global mount locks, the same ones Netflix reported last year, and containerd 2.2 now avoids most of them in userspace: one kernel went from 18 launches per second to about 250. We measured two kernels on the same cores before and after that fix. Before it, two kernels launched 2.3 times as many containers in a controlled comparison and 7 to 8 times as many against a stock Ubuntu host. After it, 1.4 times, and a profile shows the mount locks are only a small part of what remains."
---

We gave a Linux kernel 96 cores and asked it to launch containers as fast as it could. It launched 18 per second. Then we took half the cores away, and it launched 43.

Nothing else changed between those two runs: the same kernel, the same containerd, the same image, one worker per core in both. The 48 extra cores were not idle, either. They were busy the whole time, spinning on a lock that only one of them could hold.

That lock was reported a year ago. In November 2025, Netflix published [Mount Mayhem at Netflix: Scaling Containers on Modern CPUs](https://netflixtechblog.medium.com/mount-mayhem-at-netflix-scaling-containers-on-modern-cpus-f3b09b68beac){:target="_blank" rel="noopener noreferrer"}, describing nodes that stalled for tens of seconds when hundreds of containers started at once. The cause was the kernel's mount locks, which are global to the machine. Netflix then worked with containerd upstream on a change that avoids most of the mount operations, and it shipped in containerd 2.2.

This post reports three measurements on our own hardware. First, the ceiling on one kernel, reproduced with containerd's own stress tool. Second, what the userspace fix does to it. Third, what happens when the same cores are split between two kernels, both before and after the fix. The third is the one we care about, and its answer is smaller after the fix than before: two kernels launch 2.3 times as many containers as one on the older containerd, and 1.4 times as many on the current one.

## What a Container Launch Asks of the Kernel

A container's root filesystem is an overlayfs mount stacked from the image's layers. When each container runs in its own user namespace, with its own range of host user IDs, the files in those layers have to appear to be owned by that range. The kernel feature for this is the idmapped mount.

Up to containerd 2.1, containerd created one idmapped bind mount per image layer, built the overlayfs on top of them, and then unmounted them again. Each layer costs three system calls (`open_tree`, `mount_setattr`, `move_mount`) plus an unmount, and each of those takes locks that cover every mount namespace on the machine. Netflix worked out the arithmetic for 100 containers with 50-layer images: 20,200 mount operations, all serialized.

## The Setup

The machine is a single-socket Intel Xeon 6731E: 96 cores, no SMT, one NUMA node, 250 GB of memory, running Ubuntu 24.04 with the [multikernel](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"} kernel, version 7.0.

The benchmark is `containerd-stress`, the stress tool that ships in the containerd source tree. Each of its workers loops: create a container from an image, start it, wait for it to exit, delete it. The container runs `true`, so the work is almost entirely setup and teardown. The score is containers completed per second.

The stock tool has no way to ask for user namespaces, so we added one; the change is described under Reproduce It. The image is an Alpine base layer plus 50 layers that each add one small file. containerd's state lives on tmpfs, so the disk is not a factor. The runtime is runc 1.5.3. Unless noted, each number is from a 20-second run with one worker per core, and each configuration was run twice.

## One Kernel: 20 Launches per Second at Any Core Count

<svg viewBox="0 0 720 380" role="img" aria-label="Container launches per second against worker count on one kernel with 96 cores; with per-layer idmapped mounts throughput stays near 20, without them it reaches about 280" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">One kernel, 96 cores: containers launched per second</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">containerd 2.1.4, 50-layer image, 10 s per point · higher is better</text>
<line x1="64" y1="320.0" x2="640" y2="320.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="324.0" font-size="11" fill="#9ca3af" text-anchor="end">0</text>
<line x1="64" y1="236.7" x2="640" y2="236.7" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="240.7" font-size="11" fill="#9ca3af" text-anchor="end">100</text>
<line x1="64" y1="153.3" x2="640" y2="153.3" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="157.3" font-size="11" fill="#9ca3af" text-anchor="end">200</text>
<line x1="64" y1="70.0" x2="640" y2="70.0" stroke="#e5e7eb" stroke-width="1"/>
<text x="56" y="74.0" font-size="11" fill="#9ca3af" text-anchor="end">300</text>
<text x="64.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">1</text>
<text x="160.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">4</text>
<text x="256.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">8</text>
<text x="352.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">16</text>
<text x="448.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">24</text>
<text x="544.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">48</text>
<text x="640.0" y="338" font-size="11" fill="#9ca3af" text-anchor="middle">96</text>
<text x="352.0" y="360" font-size="11.5" fill="#6b7280" text-anchor="middle">concurrent workers</text>
<polyline points="64.0,315.8 160.0,304.2 256.0,290.0 352.0,233.3 448.0,165.0 544.0,83.3 640.0,93.3" fill="none" stroke="#6b7280" stroke-width="2.5"/>
<circle cx="64.0" cy="315.8" r="3.5" fill="#6b7280"><title>stock mounts, 1 workers: 5 containers/s</title></circle>
<circle cx="160.0" cy="304.2" r="3.5" fill="#6b7280"><title>stock mounts, 4 workers: 19 containers/s</title></circle>
<circle cx="256.0" cy="290.0" r="3.5" fill="#6b7280"><title>stock mounts, 8 workers: 36 containers/s</title></circle>
<circle cx="352.0" cy="233.3" r="3.5" fill="#6b7280"><title>stock mounts, 16 workers: 104 containers/s</title></circle>
<circle cx="448.0" cy="165.0" r="3.5" fill="#6b7280"><title>stock mounts, 24 workers: 186 containers/s</title></circle>
<circle cx="544.0" cy="83.3" r="3.5" fill="#6b7280"><title>stock mounts, 48 workers: 284 containers/s</title></circle>
<circle cx="640.0" cy="93.3" r="3.5" fill="#6b7280"><title>stock mounts, 96 workers: 272 containers/s</title></circle>
<text x="650" y="97.3" font-size="11.5" font-weight="600" fill="#6b7280">272</text>
<polyline points="64.0,317.5 160.0,312.5 256.0,307.5 352.0,305.0 448.0,304.2 544.0,302.5 640.0,305.0" fill="none" stroke="#b91c1c" stroke-width="2.5"/>
<circle cx="64.0" cy="317.5" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 1 workers: 3 containers/s</title></circle>
<circle cx="160.0" cy="312.5" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 4 workers: 9 containers/s</title></circle>
<circle cx="256.0" cy="307.5" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 8 workers: 15 containers/s</title></circle>
<circle cx="352.0" cy="305.0" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 16 workers: 18 containers/s</title></circle>
<circle cx="448.0" cy="304.2" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 24 workers: 19 containers/s</title></circle>
<circle cx="544.0" cy="302.5" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 48 workers: 21 containers/s</title></circle>
<circle cx="640.0" cy="305.0" r="3.5" fill="#b91c1c"><title>one idmapped mount per layer, 96 workers: 18 containers/s</title></circle>
<text x="650" y="309.0" font-size="11.5" font-weight="600" fill="#b91c1c">18</text>
<text x="442.0" y="153.0" font-size="11.5" font-weight="600" fill="#6b7280" text-anchor="end">stock mounts</text>
<text x="352.0" y="293.0" font-size="11.5" font-weight="600" fill="#b91c1c" text-anchor="middle">one idmapped mount per layer</text>
</svg>

Without user namespaces, one kernel scales acceptably: 5 containers per second with one worker and about 280 with 48. With user namespaces on containerd 2.1.4, it reaches 18 per second at 16 workers and stays there. Eighty more cores add nothing.

A profile at 96 workers shows where the time goes. 21% of all CPU cycles are spent spinning for a write lock on `namespace_sem`, reached from `open_tree`, `move_mount` and `umount` in nearly equal parts. Another 13% is spinlock contention, about half of it under `mntput_no_expire`. This is the same picture as the flame graph in the Netflix post.

"Add nothing" understates it. The extra cores make the machine slower. We took cores 48 to 95 away from the host by handing them to a multikernel instance that we left idle, and ran the same workload on the remaining 48. The host launched more than twice as many containers.

<svg viewBox="0 0 720 156" role="img" aria-label="The host kernel launches 43 containers per second with 48 cores and 18 with 96" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Half the cores, more than twice the launches</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">containers launched per second on the host kernel · containerd 2.1.4, user-namespaced containers</text>
<text x="254" y="99" font-size="11.5" fill="#374151" text-anchor="end">host kernel, 48 cores</text>
<rect x="262" y="86" width="272.3" height="18" fill="#6b7280" fill-opacity="0.85"><title>host kernel, 48 cores: 43 containers/s</title></rect>
<text x="540.3" y="99" font-size="11" font-weight="600" fill="#6b7280">43</text>
<text x="254" y="125" font-size="11.5" fill="#374151" text-anchor="end">host kernel, 96 cores</text>
<rect x="262" y="112" width="114.0" height="18" fill="#b91c1c" fill-opacity="0.85"><title>host kernel, 96 cores: 18 containers/s</title></rect>
<text x="382.0" y="125" font-size="11" font-weight="600" fill="#b91c1c">18</text>
</svg>

Each core past the point of saturation is one more contender for the same lock, and a lock with more contenders is handed over more slowly. The machine does less work with more cores.

## The Userspace Fix

containerd 2.2 maps the common parent directory of all the layers once, so the number of mount operations per container no longer depends on the number of layers. We confirmed it by counting system calls: with user namespaces, containerd 2.1.4 makes about 155 `move_mount` calls per container with our image, and containerd 2.2.10 makes 3.

The effect on one kernel is large. With containerd 2.2.10, the host with all 96 cores launches about 250 user-namespaced containers per second, where it launched 18 before. That is a factor of 14 from a change in userspace, on the same kernel.

Anyone running containerd 2.2 or later does not have the 20-per-second ceiling. Everything in the previous section describes software that has since been fixed, and we want that stated before any two-kernel number appears.

## Two Kernels, Before and After the Fix

A multikernel instance is a second Linux kernel booted on a subset of the machine's cores and memory, beside the host kernel, with no hypervisor between it and the hardware. It has its own mount table and its own `namespace_sem`.

The comparison an operator would make is the machine as it is against the machine split in two. The single kernel is the Ubuntu host with all 96 cores, running two containerd instances pinned to 48 cores each. For two kernels, [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"} moves cores 48 to 95 and 32 GB of memory into an instance, which runs one containerd; the host keeps cores 0 to 47 and runs the other. Both halves run at the same time, and each number is the total for the machine.

<svg viewBox="0 0 720 252" role="img" aria-label="As deployed, two kernels launch 140 containers per second against 18 on containerd 2.1.4, and 360 against 252 on containerd 2.2.10" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">As deployed: the host alone, or the host plus one instance</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">containers launched per second, whole machine, user-namespaced containers</text>
<text x="0" y="72" font-size="12.5" font-weight="600" fill="#374151">containerd 2.1.4: one idmapped mount per layer</text>
<text x="254" y="99" font-size="11.5" fill="#374151" text-anchor="end">one kernel: host, 96 cores</text>
<rect x="262" y="86" width="17.1" height="18" fill="#b91c1c" fill-opacity="0.85"><title>one kernel: host, 96 cores: 18 containers/s</title></rect>
<text x="285.1" y="99" font-size="11" font-weight="600" fill="#b91c1c">18</text>
<text x="254" y="125" font-size="11.5" fill="#374151" text-anchor="end">two kernels: host 48 + instance 48</text>
<rect x="262" y="112" width="133.0" height="18" fill="#2a78d6" fill-opacity="0.85"><title>two kernels: host 48 + instance 48: 140 containers/s</title></rect>
<text x="401.0" y="125" font-size="11" font-weight="600" fill="#2a78d6">140</text>
<text x="0" y="168" font-size="12.5" font-weight="600" fill="#374151">containerd 2.2.10: one idmapped mount per container</text>
<text x="254" y="195" font-size="11.5" fill="#374151" text-anchor="end">one kernel: host, 96 cores</text>
<rect x="262" y="182" width="239.4" height="18" fill="#b91c1c" fill-opacity="0.85"><title>one kernel: host, 96 cores: 252 containers/s</title></rect>
<text x="507.4" y="195" font-size="11" font-weight="600" fill="#b91c1c">252</text>
<text x="254" y="221" font-size="11.5" fill="#374151" text-anchor="end">two kernels: host 48 + instance 48</text>
<rect x="262" y="208" width="342.0" height="18" fill="#2a78d6" fill-opacity="0.85"><title>two kernels: host 48 + instance 48: 360 containers/s</title></rect>
<text x="610.0" y="221" font-size="11" font-weight="600" fill="#2a78d6">360</text>
</svg>

On containerd 2.1.4, two kernels launch 140 containers per second where one launches 18. On containerd 2.2.10, they launch 360 where one launches 252, a factor of 1.4.

The two halves do not disturb each other. On containerd 2.1.4 the host half launched 43 per second alone and 40 beside the busy instance; the instance launched 104 alone and 101 beside the busy host.

## How Much of That Is the Kernel

The comparison above is not symmetric. The host runs systemd, AppArmor and a full distribution, and an instance runs a minimal Alpine userland. To separate the effect of splitting the kernel from the effect of a leaner environment, we ran a second comparison in which both sides are instances. The host keeps 8 cores and does nothing. One kernel is a single 88-core instance running two containerd instances pinned to 44 cores each. Two kernels are two 44-core instances running one containerd each. Same kernel build, same root filesystem, same cores.

<svg viewBox="0 0 720 252" role="img" aria-label="Like for like, two kernels launch 196 containers per second against 84 on containerd 2.1.4, and 381 against 270 on containerd 2.2.10" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;width:100%;height:auto;display:block;margin:2rem auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<text x="0" y="22" font-size="16" font-weight="600" fill="#1f2937">Like for like: one 88-core instance, or two of 44</text>
<text x="0" y="42" font-size="12.5" fill="#6b7280">containers launched per second, whole machine, user-namespaced containers</text>
<text x="0" y="72" font-size="12.5" font-weight="600" fill="#374151">containerd 2.1.4: one idmapped mount per layer</text>
<text x="254" y="99" font-size="11.5" fill="#374151" text-anchor="end">one kernel: one 88-core instance</text>
<rect x="262" y="86" width="79.8" height="18" fill="#b91c1c" fill-opacity="0.85"><title>one kernel: one 88-core instance: 84 containers/s</title></rect>
<text x="347.8" y="99" font-size="11" font-weight="600" fill="#b91c1c">84</text>
<text x="254" y="125" font-size="11.5" fill="#374151" text-anchor="end">two kernels: two 44-core instances</text>
<rect x="262" y="112" width="186.2" height="18" fill="#2a78d6" fill-opacity="0.85"><title>two kernels: two 44-core instances: 196 containers/s</title></rect>
<text x="454.2" y="125" font-size="11" font-weight="600" fill="#2a78d6">196</text>
<text x="0" y="168" font-size="12.5" font-weight="600" fill="#374151">containerd 2.2.10: one idmapped mount per container</text>
<text x="254" y="195" font-size="11.5" fill="#374151" text-anchor="end">one kernel: one 88-core instance</text>
<rect x="262" y="182" width="256.5" height="18" fill="#b91c1c" fill-opacity="0.85"><title>one kernel: one 88-core instance: 270 containers/s</title></rect>
<text x="524.5" y="195" font-size="11" font-weight="600" fill="#b91c1c">270</text>
<text x="254" y="221" font-size="11.5" fill="#374151" text-anchor="end">two kernels: two 44-core instances</text>
<rect x="262" y="208" width="361.9" height="18" fill="#2a78d6" fill-opacity="0.85"><title>two kernels: two 44-core instances: 381 containers/s</title></rect>
<text x="630.0" y="221" font-size="11" font-weight="600" fill="#2a78d6">381</text>
</svg>

On containerd 2.1.4, two kernels launch 2.3 times as many containers as one. On containerd 2.2.10, 1.4 times.

So of the factor of 7 to 8 in the as-deployed comparison on the older containerd, 2.3 comes from splitting the kernel. The rest is the host environment, which is four to five times slower than a minimal instance on the mount-heavy path. We have not isolated why. A host that watches its mount table, propagates mounts and runs a security module on every operation has more to do per mount, and all of it happens under the same locks. On containerd 2.2.10 the penalty is gone: the host and the 88-core instance perform about the same, and the as-deployed and like-for-like factors agree at 1.4.

The single 88-core instance also shows the interference directly. On containerd 2.1.4, one containerd running alone on its 44 cores launched 115 containers per second. Starting the second containerd on the other 44 cores brought the total for both down to 84. With two kernels, one half alone launched 106 and both together launched 196.

## What Is Left After the Fix

To see where the remaining factor of 1.4 comes from, we profiled the like-for-like pair on containerd 2.2.10 from inside the instances, sampling CPU cycles and tracing where tasks sleep.

| | One 88-core instance | Two 44-core instances |
|---|---|---|
| Containers per second | 262 | 377 |
| Time per container, per worker | 336 ms | 233 ms |
| CPU busy | 42% | 59% |
| CPU seconds per container | 0.143 | 0.138 |
| Lock spinning, share of busy cycles | about 10% | about 5% |
| Tasks asleep on kernel semaphores, whole machine | 3.4 | 1.2 |

A launch costs the same CPU time on one kernel as on two. The single kernel is not short of cycles: more than half of its cores are idle. It is slower because each launch spends longer waiting.

The mount locks are still in the profile. Tasks spin and sleep on `namespace_sem` in `mount`, in overlayfs setup and when reading the mount table. Path lookups and mount reference counts contend on `mount_lock`. `tasklist_lock` shows up on fork and exit. All of these are about twice as costly on one kernel as on two.

But they are a small part of the difference. The gap between the two columns is about 103 ms per container. By our arithmetic from the averages above, sleeping on kernel locks accounts for about 10 ms of it and spinning on them for about 7 ms. That is roughly one sixth.

The rest appears as the processes in the launch chain (containerd, its shim, runc) waiting on each other in futex, epoll and sleep calls. Sampling the whole system does not tell us which step takes longer on the larger kernel, and we have not found out yet. So the factor of 1.4 is a measurement, and attributing it to the mount locks would be a claim the profile does not support.

## Two Remedies

The fix and the split work at different levels.

A userspace fix reduces the demand for one lock, in one application, after someone has found the lock in a flame graph. Netflix had to notice stalled nodes, trace them to the mount table, compare instance types, and work with upstream on a redesign. The result is excellent, and it is specific: `namespace_sem` is still one lock for the whole machine, and the next application that mounts heavily will find it again.

Partitioning does not reduce demand at all. It reduces how many cores share each lock, and it does that for every kernel-wide lock at once, including the ones nobody has profiled yet.

On this workload the first remedy was worth far more than the second: a factor of 14 against a factor of 2.3. They also add up: the best result we measured, 381 launches per second, is the fixed containerd on two kernels. What the profile above adds is a limit on the claim. After the fix, the locks we can name explain about a sixth of what two kernels gain, and the rest is still unidentified.

## What This Does Not Show

This machine has one socket, and that is the largest gap. Netflix's most striking result was that a two-socket instance failed where a one-socket instance of the same CPU generation did not, because a contended lock costs more when its cache line crosses sockets. We could not test that here. We would expect a single kernel to do worse on a two-socket machine, and the gap to two kernels to be wider.

The benchmark is a launch loop, not a service. Containers that start once and run for days do not notice any of this. The result matters for nodes that fill up in bursts, for batch and CI systems, and for platforms that start a container per request.

The runs are short: 20 seconds each, two per configuration, with no variance estimate beyond the two values agreeing. The sweep chart used 10-second points.

The profile of containerd 2.2.10 is one trace of 6 to 8 seconds per configuration, taken in one of the two 44-core instances and doubled for the machine. The split of the latency gap is derived from averages, not measured per launch.

We modified the benchmark. The user-namespace option is ours, not upstream's, and every number for user-namespaced containers depends on it.

## Reproduce It

Everything here is public except our 30-line patch to `containerd-stress`, and the core of the patch is three lines. Each worker gets its own 65,536-ID host range and requests its snapshot with the same ID-mapping labels that the Kubernetes runtime interface uses:

{% raw %}
```go
idmap := []specs.LinuxIDMapping{{ContainerID: 0, HostID: uint32(1<<20 + w.id<<16), Size: 1 << 16}}
snapshot = containerd.WithNewSnapshot(id, w.image, containerd.WithUserNSRemapperLabels(idmap, idmap))
specOpts = append(specOpts, oci.WithUserNamespace(idmap, idmap))
```
{% endraw %}

The rest of the patch lets the tool use an image that is already imported, since the stock tool always pulls from a registry. Use the static containerd release tarballs for 2.1.4 and 2.2.10, build the stress tool from the matching source tree so that the client and the daemon mount the same way, and put containerd's root on tmpfs.

The instance's root filesystem is an Alpine minirootfs with the same containerd, runc and image copied in. kerf builds it into the instance's root and boots it:

```
kerf init --cpus=<physical IDs of cores 48-95> --memory=40GB
kerf create half --cpus=<the same IDs> --memory=32GB
kerf load half --kernel=/boot/vmlinuz --rootfs-dir=./rootfs --entrypoint=/init.sh
kerf start half
kerf exec half containerd-stress <options>
```

To find the ceiling on your own machine, you do not need multikernel at all. Run the user-namespace workload on containerd 2.1 with one worker per core, then run it again with half the cores taken offline. Pinning to half the cores without removing them shows the effect too, though less of it: one containerd pinned to 44 of our 96 cores launched 33 containers per second.

## Summary

Containers launched per second, whole machine, both halves busy.

| Configuration | 2.1.4, user namespaces | 2.2.10, user namespaces | 2.2.10, no user namespaces |
|---|---|---|---|
| One kernel: host, 96 cores | 16 to 20 | 242 to 262 | 292 to 324 |
| Two kernels: host 48 + instance 48 | 140 | 359 to 362 | 444 |
| One kernel: one 88-core instance | 84 | 266 to 275 | 317 to 331 |
| Two kernels: two 44-core instances | 196 | 381 to 382 | 459 to 460 |

| Two kernels over one | 2.1.4, user namespaces | 2.2.10, user namespaces | 2.2.10, no user namespaces |
|---|---|---|---|
| As deployed | 7 to 8x | 1.4x | 1.4x |
| Like for like | 2.3x | 1.4x | 1.4x |

## Conclusion

A single Linux kernel launching user-namespaced containers with containerd 2.1 is held by its mount locks to about 20 launches per second on our 96-core server, and it launches more with 48 cores than with 96. containerd 2.2 removes most of the mount operations and lifts that to about 250.

Two kernels on the same cores do not share those locks. They launched 2.3 times as many containers as one kernel before the fix and 1.4 times as many after it. After the fix the mount locks explain about a sixth of that gap, and we have not yet identified the rest.

We went looking for a workload where one kernel collapses and two do not, and we found one that a userspace fix had already rescued. We think that is the normal life cycle of a kernel-wide lock: it is found in production, worked around in the application that hit it, and left in place for the next application. Splitting the machine is the remedy that does not depend on finding the lock first.

Multikernel is [open source](https://github.com/multikernel/linux){:target="_blank" rel="noopener noreferrer"}, and so is [kerf](https://github.com/multikernel/kerf){:target="_blank" rel="noopener noreferrer"}. If your nodes launch containers in bursts, or if a profile of yours ends in a kernel lock you cannot configure away, we would like to hear from you at [contact@multikernel.io](mailto:contact@multikernel.io).
