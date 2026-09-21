---
layout: post
title: "Every fork() Leaks Your File Descriptors: Why Linux Needs O_CLOFORK"
date: 2026-09-20 10:00:00 -0700
categories: [linux-kernel, open-source, ai-infrastructure]
author: Cong Wang, Founder and CEO
excerpt: "A test in Sandlock failed about one run in four with 'sandbox is already running' when nothing was running. The cause was a process we never forked, holding a copy of a socket we thought we had closed. Fixing it properly took us through every primitive Linux offers for keeping a file descriptor out of a child: close-on-exec, atfork handlers, close_range(), seccomp, private fd tables, record locks, io_uring, and finally an SCM_RIGHTS trick we are not proud of. Each one fails for a precise reason, and all of those reasons point at the same missing piece: a close-on-fork flag. POSIX standardized it in 2024. FreeBSD and NetBSD have it. Linux rejected it in 2020. Here is what that costs a library today, and a design that answers the objections."
---

Some bugs are small and teach you something large. This one began as a test that failed about one run in four.

[Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"} is our lightweight sandbox for AI agents. Every sandbox has a name, and a name can be reused as soon as its sandbox is gone. One of our tests checks exactly that: run a sandbox called `x`, wait for it to finish, run another sandbox called `x`. Under the full parallel test suite, the second run sometimes failed:

```
sandbox 'x' is already running
```

Nothing was running. The first sandbox had exited, its supervisor had closed every socket it owned, and `wait()` had returned. Yet the kernel insisted the name was taken.

This post is the story of that bug. It is also an argument. We tried every mechanism Linux has for keeping a file descriptor out of a child process, and every one of them fails for a reason that is worth writing down. The mechanism that would have fixed it in one line is in POSIX.1-2024, ships in FreeBSD and NetBSD, and was rejected for Linux in 2020. We think it deserves another look.

## How Sandlock names a sandbox

A sandbox name has to do four jobs. It must be exclusive, so that two sandboxes of one user can never share a name. It must clean up after itself, even when the supervisor is killed with SIGKILL. It must be listable, so `sandlock ps` can find every sandbox. And it must lead `sandlock kill` to the right processes, even when the supervisor is wedged and answers nothing.

Our first version kept all of this on disk, the way most tools do. Each sandbox got a directory, `/dev/shm/sandlock-<uid>/<name>/`, holding a pid file and a Unix socket. It worked, and it had three flaws:

- **Exclusive by accident.** A name was taken if its directory existed. That is a side effect of `mkdir`, not a statement about a live sandbox, and the two drift apart the first time anything crashes.
- **Stale by design.** A supervisor killed with SIGKILL leaves its directory and its pid file behind, and everything that reads them afterwards is reading about a process that no longer exists. `sandlock ps` had to prune, guessing from a pid whether it is still the same process. `sandlock kill` sends SIGKILL to a number it read from a file, and by then that number may belong to a stranger. Nothing ties a number on disk to a process that is alive.
- **It needs somewhere to write.** Sandlock can run inside another sandbox, including another sandlock, and the outer policy may grant no writable path at all. A sandbox that cannot create its runtime directory cannot be named, listed, or killed by name. Asking every outer policy to open up `/dev/shm` for us is exactly the kind of hole a sandbox should not need.

So we went diskless. Linux has a namespace for names that lives entirely in the kernel: abstract Unix sockets, whose address starts with a NUL byte and never touches a filesystem. The supervisor binds `\0sandlock/<uid>/<name>`, and each flaw above has an answer:

- **Exclusive by construction.** `bind()` on a taken name fails atomically, so only one sandbox can ever hold it, with no check-then-create race.
- **Nothing to go stale.** The name exists exactly as long as the socket does. When the supervisor dies, for any reason, the kernel closes its sockets and the name is gone, so there is nothing to prune. The pids work the same way. `listen()` makes the kernel record the caller's pid in the socket, and `SO_PEERCRED` hands it to anyone who connects. It is still a number, but it cannot be read after the fact: the only way to get it is to connect, and a connect succeeds only while the socket is held open. A process also cannot stamp any pid but its own, and none of this needs the supervisor to answer, so `sandlock kill` works on one that is wedged.
- **Nothing to write.** Binding an abstract name needs permission to create a socket and nothing else. A nested sandlock works under an outer policy that grants it no directory anywhere.

`/proc/net/unix` lists the names, so `sandlock ps` needs no registry either. We made this move a few weeks ago and were happy with it.

It has one property we had not thought hard enough about. **An abstract name stays bound for as long as any file descriptor, in any process, refers to the socket.** "The name exists exactly as long as the socket does" is the feature. It is also the bug.

## The process we never forked

Sandlock-core is a library. The supervisor is not a separate process. It is a set of tasks inside whatever process called `Sandbox::run()`: our CLI, a Python program, a Go service, or in this case our test binary.

```
  process P  (a Python app, a Go service, our test binary)
  |
  |   the supervisor lives in here and owns the named sockets
  |
  +-> sandbox child        forked by sandlock, which closes its copies
  +-> some subprocess      forked by the app's own code
  +-> another subprocess   forked by the app's own code
```

`fork()` copies the entire file descriptor table. Sandlock knew this and closed the copies in the child it forks. But the process has other code in it, and that code forks too. Our test binary runs hundreds of tests as threads in one process, and many of them spawn `sandlock ps` in polling loops. Each of those spawns is a fork followed by an exec, and between the two the new child holds a copy of every descriptor in the process, including the named sockets of whatever sandboxes happen to be alive at that instant.

We caught one in the act. At the moment of a failing bind, our own process held no descriptor for the name, the name could not be bound, and forty milliseconds later it could. A snapshot of our children showed a fork of the test binary that had not reached exec yet, holding the control sockets of a sandbox it had nothing to do with.

A deterministic reproduction takes ten lines: create a named sandbox, fork a child that sleeps for 300 milliseconds, finish the sandbox, reuse the name. It fails every time while the child is alive, and succeeds the moment it exits.

This is not only a test problem. Any program that embeds a sandbox library and also spawns processes has this race. And a forked worker that never execs at all, the normal case for Python's `os.fork()` or a preforking server, holds the name for its entire life.

## Nine dead ends

What we needed sounds modest: a file descriptor that a child does not get. Here is everything we tried, in roughly the order we tried it.

**1. Close-on-exec.** Our sockets were already `SOCK_CLOEXEC`. It acts at exec, and our problem happens at fork. It does nothing for the window between the two, and nothing at all for a child that never execs.

**2. Closing our descriptors in our own children.** This is what Sandlock did: a registry of live control descriptors, closed right after each fork that Sandlock makes. It is correct and it is useless here, because the fork that hurts is one we did not make.

**3. `pthread_atfork()`.** A child handler can close the descriptors in every `fork()` child of the process, including the ones the host makes. We built it and it works, for libc's `fork()`. Handlers do not run for `vfork()`, for `posix_spawn()`, for a raw `clone()`, or for `_Fork()`, which POSIX.1-2024 added precisely as a fork that skips them. Rust's `Command` and Python's `subprocess` take the `posix_spawn()` or `vfork()` route whenever they can, and Go's `os/exec` always uses a raw `clone()`, so most of the children a real program creates are ones no handler ever sees. That is exactly the population that was failing our test.

**4. `close_range(CLOSE_RANGE_CLOEXEC)`.** It marks a range of descriptors close-on-exec in the caller's own table. The caller is the code about to fork, which in our case is not us and does not know our sockets exist. It also still acts at exec. Even for code that controls its own fork it is racy: another thread can open a descriptor between the `close_range()` and the `fork()`.

**5. Seccomp on the host process.** Sandlock already supervises syscalls with seccomp user notification, so why not intercept the host's forks? Because a notification fires before the syscall runs, when the child does not exist yet, and once it exists there is no way to close a descriptor in another process. `pidfd_getfd()` can take one; nothing can remove one. We would also have to install an irreversible filter on the application that embeds us, and run a thread to answer it.

**6. Waiting for the last copy to die.** The kernel does know when the last copy goes away. A connection left unaccepted in a listener's backlog is hung up when the listener is truly released, which takes the last descriptor in any process. So the supervisor can connect to its own socket, close it, and wait for the hangup: no polling, exact to the microsecond. We built this too, and the failure disappeared from our test runs. Then we asked what happens when the host's child never execs. `wait()` hangs for as long as that child lives. A spurious error had become a possible deadlock, and the only cure is a timeout, because from the outside a child that is about to exec and a child that never will are indistinguishable.

**7. A thread with a private fd table.** `close_range(3, ~0U, CLOSE_RANGE_UNSHARE)` gives the calling thread its own, empty descriptor table. Sockets opened by that thread exist in no table that a fork from any other thread copies. This is a complete fix, including for children that never exec, and we ran it green. It costs an operating system thread that does nothing but hold two sockets, and it comes with a sharp edge: that thread must never touch an async runtime. A runtime wakes its workers by writing to an eventfd, by descriptor number, and in a private table that number means something else, possibly one of your own sockets.

**8. POSIX record locks.** `fcntl(F_SETLK)` locks belong to a process, not to an open file. No fork inherits them, the kernel releases them when the owner dies, and `F_GETLK` even reports the owner's pid. We verified that a raw `clone()` child holding a copy of the descriptor does not hold the lock. As a way to make a name exclusive it is exactly right, and it needs a file, which means a writable directory, which is the thing we left `/dev/shm` to get away from.

**9. io_uring direct descriptors.** A socket created with `IORING_OP_SOCKET` into a fixed file slot never enters the descriptor table, and recent kernels can bind, listen, and accept on it there. Fork copies the ring's descriptor, not the ring's file table, and closing the slot drops the socket at once. On paper this is close-on-fork by another name. In practice io_uring is disabled by sysctl or seccomp in much of the world we deploy into, and Sandlock itself denies it inside sandboxes, so a nested sandlock could not use it.

## What we shipped instead

Working through that list left us with one kernel object that holds a file reference and that fork does not multiply: a file descriptor in flight.

When a process sends a descriptor with `SCM_RIGHTS`, the file sits in the receiving socket's queue until someone receives it. A forked child gets copies of the descriptors that refer to the socketpair. It does not get a copy of what is queued inside it. The file in flight is a single reference.

So in [our current design](https://github.com/multikernel/sandlock/pull/244){:target="_blank" rel="noopener noreferrer"} the sandbox child creates the name socket, binds it, calls `listen()` on it, and sends it to the supervisor, and the supervisor never receives the message. The name is bound, clients can connect and read the pid stamp, and the socket is in no descriptor table that any fork can copy. To release the name, the supervisor receives the message with no control buffer. The kernel finds nowhere to put the descriptor, sets `MSG_CTRUNC`, and drops the file. The name is free at that instant, even while a child that never execs still holds a copy of everything else.

```
  BEFORE: the name socket is a file descriptor

  supervisor                         child forked by the host
  ┌────────────────────┐   fork()    ┌────────────────────┐
  │ fd table           │ ──────────> │ fd table (a copy)  │
  │   fd 7 ──────┐     │             │   fd 7 ──────┐     │
  └──────────────┼─────┘             └──────────────┼─────┘
                 │                                  │
                 v                                  │
          ┌─────────────┐                           │
          │ name socket │ <─────────────────────────┘
          └─────────────┘

  Two references. The supervisor closes fd 7 and the name is still bound,
  until the child execs or exits.
```

```
  AFTER: the name socket is a message that nobody receives

  supervisor                         child forked by the host
  ┌────────────────────┐   fork()    ┌────────────────────┐
  │ fd table           │ ──────────> │ fd table (a copy)  │
  │   fd 7 ──────┐     │             │   fd 7 ──────┐     │
  └──────────────┼─────┘             └──────────────┼─────┘
                 │                                  │
                 v                                  │
     ┌───────────────────────┐                      │
     │ socketpair            │ <────────────────────┘
     │   queue:              │
     │     [ name socket ]   │
     └───────────────────────┘

  fork() copied fd 7. It did not copy the queue, so there is still exactly
  one reference to the name socket. The supervisor empties the queue and
  the name is free at once, whatever the child does.
```

It works, it needs no thread, no timeout, and no disk, and it passes every test we have. We are also not proud of it. A socket held this way cannot be accepted on, so we had to split one socket into two: a name socket that only claims the name and carries the pid stamp, and a separate request socket whose name embeds the child's pid so that it is never reused. Clients now find the request socket through `/proc/net/unix`. The backlog of the name socket can never be drained, so each `kill` of a sandbox uses up one of 4096 slots. The name collision that used to be detected before the fork is now detected just after it. And descriptors in flight are charged per user against `RLIMIT_NOFILE`, so an unprivileged user with the common soft limit of 1024 can run about a thousand sandboxes at once, a ceiling that did not exist before.

That is a great deal of machinery, and a list of new limits, to express one sentence: *do not give this descriptor to a child.*

## The flag that says it

POSIX.1-2024 has that sentence. [`O_CLOFORK`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html){:target="_blank" rel="noopener noreferrer"} on `open()`, [`FD_CLOFORK`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/fcntl.html){:target="_blank" rel="noopener noreferrer"} through `fcntl()`, `SOCK_CLOFORK` on `socket()` and `accept4()`, `MSG_CMSG_CLOFORK` on `recvmsg()`: a descriptor so marked is closed in the child of a fork, the same way `O_CLOEXEC` closes one across an exec. Solaris and macOS have had it for years. FreeBSD added it in 2025 and NetBSD 11 has it.

On Linux, the function that builds a child's descriptor table is `dup_fd()` in `fs/file.c`, and its core is this:

```c
for (i = open_files; i != 0; i--) {
	struct file *f = rcu_dereference_raw(*old_fds++);
	if (f) {
		get_file(f);
	} else {
		__clear_open_fd(open_files - i, new_fdt);
	}
	rcu_assign_pointer(*new_fds++, f);
}
```

Every open file is copied, unconditionally. There is no per-descriptor test and no per-file test. The only flag a descriptor has is `FD_CLOEXEC`. We checked a current 7.0 tree to be sure nothing similar had arrived under another name. Nothing has.

With such a flag, every limit in the previous section disappears, because the design collapses back to the simple one: the supervisor binds its sockets before the fork, marks them close-on-fork, and no child of the process can copy them, however it was made. `fork()`, `vfork()`, `posix_spawn()`, raw `clone()`, and `_Fork()` all pass through `dup_fd()`. That is the property no userspace scheme can offer: there is no way around it.

## It has been proposed before

We are far from the first to want this. A patch was posted in [2011](https://lwn.net/Articles/441931/){:target="_blank" rel="noopener noreferrer"}. In [2017](https://www.mail-archive.com/linux-kernel@vger.kernel.org/msg1516378.html){:target="_blank" rel="noopener noreferrer"} a request described the cousin of our bug: one thread writes an executable and closes it, another thread forks in between and carries the write descriptor away, and the first thread's `execve()` fails with `ETXTBSY`. Go worked around that with sleeps and retries, and Java has carried a bug for it for years. We see the same errno, rarely, in our own suite, and we expect it is the same disease.

In [2020](https://lkml.iu.edu/hypermail/linux/kernel/2005.1/10221.html){:target="_blank" rel="noopener noreferrer"} a complete series was posted, by the same engineer who took the feature to the Austin Group as [bug 1318](https://www.austingroupbugs.net/view.php?id=1318){:target="_blank" rel="noopener noreferrer"}. It was not merged, and the objections were serious ones:

- **Cost on hot paths.** The series added a third bitmap beside `open_fds` and `close_on_exec`. Every `open()`, `socket()`, and `accept()` would touch one more word, and every fork would copy one more bitmap, in every process, whether or not it ever used the flag. For servers that live on accept and close, that is a real cache line.
- **Memory.** A third bitmap grows every descriptor table, which matters to processes holding millions of descriptors.
- **It is the application's bug.** The motivating case was `system()` in a multithreaded program, which POSIX already calls unsafe. Fix the application, not the kernel.
- **A workaround exists.** `close_range()` was suggested later, and the reply in that same thread was the race we listed above.

We think the first two are engineering problems with an engineering answer, and the third does not survive contact with libraries.

## A design that costs nothing unless you use it

In today's kernel the descriptor allocation path ends in `__set_open_fd(fd, fdt, flags & O_CLOEXEC)`, which updates the `open_fds` and `close_on_exec` words together. A third bitmap that is always present would add a third word to that path, exactly as the reviewers said.

So do not make it always present. Give `struct fdtable` a `close_on_fork` pointer that stays `NULL` until a process first sets the flag:

```c
struct fdtable {
	unsigned int max_fds;
	struct file __rcu **fd;
	unsigned long *close_on_exec;
	unsigned long *close_on_fork;	/* NULL until first used */
	unsigned long *open_fds;
	unsigned long *full_fds_bits;
	struct rcu_head rcu;
};
```

That pointer sits beside `close_on_exec`, which the allocation path has already loaded. A process that never uses the flag pays one predictable branch in descriptor allocation and one in `dup_fd()`, touches no new cache line, and allocates no new memory. A process that opts in pays for one more word, which is the bargain it asked for. Lazy allocation was in fact suggested by a reviewer in the 2020 thread, so this is less a new idea than an old one taken seriously.

We also looked at putting the flag on the open file instead of the descriptor, which needs no bitmap at all. It is the wrong tradeoff. In `struct file` the mode lives on the first cache line and the reference count that fork already writes lives on the third, so testing a per-file flag would add a cache miss per open file to every fork on the system. It would also not be what POSIX specifies, which is a property of the descriptor.

A few semantics need deciding, and a proposal should say which way it goes. Whether the flag survives exec is still being argued in the Austin Group, and FreeBSD clears it. `dup_fd()` is also what `unshare(CLONE_FILES)` and `close_range(CLOSE_RANGE_UNSHARE)` call, so the flag has to mean something there. And `dup()` clears it, as it clears close-on-exec.

## "Fix the application"

This is the objection that deserves the most respect, and we took it seriously enough to try everything above first. For `system()` in a threaded program it is simply right: the application owns the descriptor and the fork, and it can stop doing the unsafe thing.

A library owns neither. Sandlock cannot tell a Python program to stop calling `subprocess.run()`, and it cannot see the fork when it happens. The same is true of a language runtime: Go cannot stop one goroutine from forking while another holds a file open for writing, which is why its answer to `ETXTBSY` was to sleep and retry. The owner of the descriptor and the caller of fork are different parties, in different codebases, and only the kernel sits between them.

And to be fair to the objection, we did fix the application. The result is the section above titled "What we shipped instead". It is sound, it is tested, and it replaces one bit with a socketpair, a second socket, a `/proc` lookup, and a per-user limit. Close-on-exec exists because every program once had to find and close its descriptors by hand before exec, and the kernel was the only place that could do it without a race. Close-on-fork is the same argument, one system call earlier.

## The lesson

We set out to fix a flaky test and ended up with a catalog. Close-on-exec is too late. Atfork handlers are too high. `close_range()` belongs to the wrong party. Seccomp fires too early and cannot reach into the child. Waiting for the last copy cannot tell a slow child from a permanent one. A private fd table costs a thread, a record lock costs a directory, and io_uring costs a dependency most sandboxes forbid. What is left is a descriptor parked inside a message that nobody will ever read.

When nine different mechanisms each almost solve a problem, the problem is not exotic. It is a missing primitive. The standard now has it, the BSDs now have it, and the objections that stopped it on Linux were about cost, which a lazily allocated bitmap takes down to a branch.

## Linux should add close-on-fork

So this is a request, to the people who maintain the VFS and the networking stack, and to everyone who has hit this wall from the other side: **Linux should have a close-on-fork flag.**

Concretely, that means the interfaces POSIX.1-2024 already specifies, so that nobody has to invent anything: `FD_CLOFORK` through `fcntl()`, `O_CLOFORK` for `open()` and `dup3()`, `SOCK_CLOFORK` for `socket()`, `socketpair()` and `accept4()`, `F_DUPFD_CLOFORK`, and `MSG_CMSG_CLOFORK` for descriptors that arrive over a socket. All of it is honoured in one place, `dup_fd()`, which every kind of fork already goes through.

The case is stronger than it was in 2020, for three reasons:

- **It is a standard now.** The flag is in POSIX.1-2024, and FreeBSD and NetBSD have both implemented it since. Portable software will start to use it, and on Linux it will either fail to build or be compiled out and quietly protect nothing.
- **The cost objection has an answer.** A bitmap that is allocated on first use costs a process that never sets the flag one branch, no cache line, and no memory. Whoever wants the feature pays for it, and nobody else does.
- **The real users are libraries and runtimes, not `system()`.** A sandbox library, a language runtime, a database client, anything that owns a descriptor inside a process whose forks it does not control. For them "fix the application" is not available, and the workarounds look like ours.

If you maintain a runtime or a library and you carry one of those workarounds, a retry loop around `ETXTBSY`, a helper thread, a scan of `/proc/self/fd` after fork, say so where the kernel developers can see it. The last attempt had one motivating case and it was the easy one to dismiss. The next one should arrive with many.

For our part, Sandlock's current design is in [pull request 244](https://github.com/multikernel/sandlock/pull/244){:target="_blank" rel="noopener noreferrer"}, with its limits spelled out, and we would be glad to delete most of it. We are ready to write the patches along the lines above and to take the review that comes with them. One bit per descriptor is a small thing to ask of a kernel, and a great deal to ask of everyone else to live without.
