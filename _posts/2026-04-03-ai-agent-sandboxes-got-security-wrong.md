---
layout: post
title: "AI Agent Sandboxes Got Security Wrong"
date: 2026-04-03 10:00:00 -0700
categories: [announcement, open-source, linux-kernel, ai-infrastructure]
author: Cong Wang, Founder and CEO
excerpt: "The industry is spending millions on microVMs and container runtimes to sandbox AI agents. But the threat model is wrong. Agents are not adversaries. Isolation is not security. Most agents never needed root. And one sandbox for all tools is no security at all."
---

The AI infrastructure industry has a sandbox problem, but it is not the one you think.

Over the past year, every major AI agent framework has adopted some form of sandboxing. The pattern is the same everywhere: wrap the agent in a container or a microVM, throw hardware isolation at the problem, and call it secure. Investors fund startups that promise "defense-grade isolation" for AI workloads. Engineering teams spend months integrating Firecracker, gVisor, or custom container runtimes into their agent pipelines.

And yet, the threat model behind all of this work is fundamentally wrong.

We have been building [Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"}, a lightweight process sandbox for AI agents, and have spent considerable time studying how agents actually fail, what they actually need, and what the real attack surface looks like. The conclusion is uncomfortable for the isolation-industrial complex: most of what the industry is building is solving the wrong problem.

Here are four arguments for why.

## 1. AI Agents Are Not Adversaries

The entire container and microVM security model was designed for one scenario: running untrusted, potentially malicious code from an adversary who is actively trying to escape confinement. This is the right model for multi-tenant cloud computing, where Tenant A must not be able to read Tenant B's data. It is the right model for running arbitrary user-submitted code on a shared platform.

It is the wrong model for AI agents.

An AI agent is not an adversary. It is a language model following a prompt. It does not have intent. It does not strategize escape routes. It does not probe kernel interfaces for zero-days. The code it generates and executes is a direct function of the instructions it receives.

**The question is not whether the agent is malicious. The question is whether the prompt is.**

In the vast majority of production deployments, the agent's prompt is authored by the developer or the platform operator. It is not exposed to end users. The user provides a task ("refactor this function", "analyze this dataset", "deploy this service"), and the platform constructs a prompt that includes system instructions, tool definitions, and context. The user does not write the prompt. The user does not control what tools the agent can call. The system prompt itself is as trusted as any other piece of application code. However, the agent's context window is not fully trusted: it includes retrieved documents, tool outputs, and user-provided inputs that can carry adversarial content.

This is precisely why the real threat surface is **prompt injection via external content**: a web page the agent fetches contains hidden instructions, a document it processes embeds adversarial text, an API response includes a payload designed to manipulate the model. These attacks are real, they are well-documented, and they are the primary vector through which an agent can be made to execute harmful actions.

But here is the critical insight: **prompt injection operates at the application level, not the kernel level.** A prompt injection attack convinces the agent to run a plausible command: `curl` to exfiltrate data, `rm` to delete files, `cat ~/.ssh/id_rsa` to read credentials. A more sophisticated attack might use the agent to download and execute an external payload. But even then, that payload runs as a normal unprivileged process. It is not going to chain a seccomp bypass with a Landlock vulnerability with a kernel exploit. It is going to call `open()` on a file, `connect()` to a host, or `unlink()` a path. These are exactly the operations that a filesystem allowlist and network policy are designed to control.

And prompt injection is not the only concern. Agents make mistakes on their own. A language model can misinterpret a task and delete the wrong directory, overwrite a config file it was supposed to read, or run a destructive command it hallucinated from training data. These errors are not attacks. There is no adversary. The agent simply got it wrong. But the damage is real, and the defense is the same: a policy that restricts what the agent can touch, so that a mistake in one area cannot cascade into unrelated parts of the system.

This changes the security requirements entirely. You do not need hardware-level isolation to stop `rm -rf /`. You need a filesystem allowlist. You do not need a hypervisor to prevent credential theft. You need to not mount the credentials into the sandbox in the first place. You do not need a separate kernel to block unauthorized network access. You need a policy that says which hosts the agent can reach.

The defense against both prompt injection and agent error is **policy, not isolation**. Fine-grained, per-tool, per-path, per-host access control is more effective than any amount of hardware isolation, because it operates at the right level of abstraction: the level at which agents actually work. Policy can even go further than containment. Sandlock's [sandbox pipeline]({% post_url 2026-03-26-sandlock-pipeline-xoa %}) architecture enables Execute-Only Agents (XOA), where the LLM generates code without ever seeing untrusted data. The generated code runs in a sandboxed pipeline stage whose outputs flow through kernel pipes directly to the user, never back into the LLM's context. This eliminates prompt injection structurally: not by filtering, not by instruction hierarchies, but by ensuring untrusted data never enters the context window in the first place.

The same policy-based approach naturally handles supply chain attacks. When an agent runs `pip install` and a malicious package executes arbitrary code in its `setup.py`, that code runs inside the same sandbox. It cannot read credentials, cannot exfiltrate data to unauthorized hosts, and cannot write outside the granted directories. The attack succeeds at the package level but fails at the system level, because the sandbox policy was never granted the permissions the attacker needs.

## 2. Isolation Is Not Security

This is the argument that makes infrastructure engineers uncomfortable.

You can run an AI agent inside a Firecracker microVM with a dedicated kernel, a minimal root filesystem, a virtio network device, and a jailer process that drops every capability. You have achieved hardware-level isolation. The agent runs on a separate virtual CPU with its own page tables. A kernel exploit in the guest cannot reach the host.

And the agent can still read your SSH private key.

Why? Because you mounted it. Or you passed it as an environment variable. Or the agent has access to `~/.ssh` because it needs to run `git clone`. Or the agent can reach your metadata service at 169.254.169.254 and retrieve IAM credentials. Or the agent can access a database connection string that was injected into its environment.

**Isolation answers the question: "Can the sandbox escape?" Security answers the question: "What can the agent access inside the sandbox?"**

The container and microVM ecosystem has spent a decade optimizing for the first question. But for AI agents, the second question is the one that matters. An agent that cannot escape its container but has read access to every file in the project directory, every environment variable, and every network endpoint is not secure. It is merely isolated.

This is why we built Sandlock around allowlists rather than isolation boundaries. Every path is denied by default. Every network host is denied by default. Every capability is denied by default. The developer explicitly grants what the agent needs: read access to the source tree, write access to a scratch directory, network access to the LLM API endpoint. Everything else is blocked at the kernel level by [Landlock](https://landlock.io){:target="_blank" rel="noopener noreferrer"} and seccomp, not by a hypervisor.

The result is that an agent sandboxed with Sandlock cannot read `~/.ssh/id_rsa` even though there is no VM boundary, no container boundary, no namespace boundary between the agent and that file. Landlock denies the access because the path was never granted. A container, by contrast, would need explicit configuration to exclude that path, and the default is to include everything in the bind mount.

To be clear, Landlock can be used inside containers too, and combining the two would be stronger than either alone. But in practice, nobody does this. Most container-based agent sandboxes mount the project directory, the home directory, or a broad working directory into the container. The agent needs access to files to do its job, and the coarse granularity of bind mounts means it gets access to everything in the directory tree. Landlock's path-based allowlist is strictly more precise: the agent gets read access to `/src` and write access to `/src/output`, but not read access to `/src/.env`.

## 3. You Probably Never Needed Root

The privilege argument has two sides, one inside the sandbox and one outside, and the industry gets both wrong.

**Inside the sandbox: agents do not need root.** An AI coding agent needs to read source files, write modified files, run a test suite, and call an LLM API. None of these require root. None of these require a separate kernel. None of these require a block device, a virtual NIC, or a cgroup hierarchy. Yet container-based sandboxes routinely run agents as root inside the container because it is the path of least resistance: package installation works, file permissions are not a problem, and the container boundary is supposed to contain the damage. This is unnecessary risk. Unless the container runtime is configured with user namespace remapping (which many production setups do not use), root inside the container is the same UID 0 on the host. Even with remapping, running as root inside expands the attack surface by granting capabilities and access to device nodes that a non-root process would never have.

**Outside the sandbox: privilege is a liability.** This is the argument that is rarely made. Containers and microVMs require privileged infrastructure *outside* the sandbox to set up the isolation. Docker's daemon runs as root. Kubernetes nodes run kubelet as root. Even rootless Podman requires `/etc/subuid` and `/etc/subgid` configuration by a system administrator. Firecracker requires `/dev/kvm` access (which requires the `kvm` group or root) and a jailer process that runs as root. These privileged components sit outside the sandbox boundary and shape the environment an escaped process lands in. A container escape typically exploits a kernel vulnerability via a syscall, landing you on a host where a root-owned daemon manages the infrastructure and the host is configured to support privileged container operations. Firecracker's jailer mitigates this by dropping privileges after setup, but the host must still grant `/dev/kvm` access and maintain the VMM process. The broader point holds: the privileged infrastructure required to *create* the isolation expands the blast radius when the isolation *fails*.

Sandlock requires zero privilege on both sides. No root inside, no root outside. It uses three kernel interfaces, all unprivileged:

- **Landlock** (Linux 6.12+, ABI v6): filesystem access control, TCP port restrictions, IPC and signal scoping, applied by any process to itself.
- **seccomp-bpf** (Linux 3.5+): syscall filtering, applied by any process to itself after setting `PR_SET_NO_NEW_PRIVS`.
- **User namespaces** (Linux 3.8+): optional UID mapping for container image compatibility, created by any unprivileged user.

The entire confinement is set up in the process itself, after `fork()`, before `exec()`. No external runtime. No daemon. No setup step. The sandbox is an attribute of the process, not a separate infrastructure component.

This matters for three reasons:

**Attack surface.** Every privileged component is an attack surface. Docker's daemon has had [multiple](https://cve.mitre.org/cgi-bin/cvekey.cgi?keyword=docker){:target="_blank" rel="noopener noreferrer"} privilege escalation CVEs. The more privileged infrastructure you add to "secure" an agent, the more you expand the attack surface of the overall system. An unprivileged sandbox has a strictly smaller attack surface than a privileged one. If a Sandlock sandbox is escaped, the attacker lands in the context of an unprivileged user process with no special capabilities, no daemon to compromise, and no privileged host services to pivot to.

**Deployment simplicity.** No root means no security review for privilege escalation. No daemon means no long-running process to monitor, restart, or patch. No images means no registry, no pull latency, no layer caching to configure. The agent's sandbox is part of the agent's process, not a separate piece of infrastructure.

**Defense in depth.** Sandlock's `--no-supervisor` mode is designed to be used as an outer sandbox wrapping an inner sandbox. The outer layer applies Landlock rules (filesystem, IPC, and signal isolation) plus a static seccomp deny filter that blocks dangerous syscalls like `mount`, `bpf`, and `io_uring`. The inner layer runs the full seccomp-supervised sandbox with resource limits, network policy, and filesystem virtualization. If the inner sandbox has a bug, the outer layer catches the escape. Two independent enforcement mechanisms, both unprivileged, both in-process. An escaped process hits a second wall of kernel-enforced restrictions, not a privileged daemon waiting to be exploited.

## 4. One Box for Everything Is No Security at All

There is a deeper architectural problem with how the industry sandboxes AI agents: everything runs in one box.

A typical agent has a dozen tools. A shell tool that executes commands. A file tool that reads and writes the project directory. A web tool that fetches URLs. A database tool that runs queries. A code execution tool that runs generated scripts. Each of these tools has a different risk profile, a different set of required permissions, and a different blast radius when something goes wrong.

Container-based sandboxes put all of these tools inside the same container. The shell tool and the web tool share the same filesystem view, the same network access, the same environment variables. If the web tool is tricked by a malicious web page into running a command, it has the same permissions as the shell tool. If the code execution tool runs a script that reads environment variables, it can see the database connection string that was injected for the database tool. The sandbox protects the host from the agent, but it does nothing to protect one tool from another.

This is not a minor oversight. It is a fundamental design error. **Agent security and tool security are different problems that require different granularity.**

Agent-level security is about confining the agent process: what files can the agent's orchestrator read, what network endpoints can it reach, what system resources can it consume. Tool-level security is about confining each individual tool invocation: the web fetch tool should have network access but no filesystem writes; the file write tool should have access to a specific directory but no network access; the shell tool should have a constrained set of executables and no access to credentials.

Mixing these two concerns into a single sandbox means you must grant the union of all permissions required by all tools. The sandbox policy becomes the least common denominator. If any tool needs network access, every tool gets it. If any tool needs write access, every tool gets it. The more tools an agent has, the more permissive the sandbox becomes, and the less useful it is as a security boundary.

Sandlock solves this with [per-tool-call sandboxing]({% post_url 2026-03-25-sandlock-mcp-per-tool-sandboxing %}). Each tool declares its capabilities: which paths it reads, which paths it writes, which hosts it can reach. When the agent invokes a tool, Sandlock forks a new process and confines it with a policy derived from that tool's declarations alone. The web fetch tool runs in a sandbox with network access and no filesystem writes. The file write tool runs in a sandbox with directory access and no network. Each tool invocation is independently confined, and a compromise of one tool does not grant the attacker the permissions of another.

This is the principle of least privilege applied at the right granularity. Not per-agent, not per-session, but per-tool-call. A container cannot do this without spinning up a new container for every tool invocation. Even lightweight runtimes like gVisor take ~100ms per container start. A process fork with Landlock confinement does it in under a millisecond, making per-tool-call isolation practical at the scale agents operate.

## What This Means for the Industry

We are not arguing that containers and microVMs have no place. For multi-tenant cloud platforms where tenants are adversarial, hardware isolation is appropriate. For air-gapped execution of completely untrusted code from unknown sources, a microVM is a reasonable choice.

But most AI agent deployments are not these scenarios. They are a company running an internal coding assistant, a startup building an automated QA pipeline, an enterprise deploying a document analysis agent. The threat is not a nation-state attacker probing the hypervisor. The threat is the agent running `pip install malicious-package` because a README told it to, or the agent deleting a production config because it misunderstood the task.

For these threats, the right tool is not more isolation. It is better policy: deny by default, allowlist by path, restrict by tool, enforce at the kernel level.

You should not be paying for infrastructure you do not need to defend against threats that do not exist. A microVM per agent invocation is not defense in depth. It is spending engineering hours and compute dollars on a security model designed for adversarial multi-tenancy, applied to a problem that requires fine-grained access control. The marginal security you gain from a hypervisor boundary is negligible when the actual attack, a prompt injection that runs `curl` with your credentials, succeeds entirely within the sandbox's granted permissions. The expensive part is not the isolation. The expensive part is getting the policy right. And no amount of hardware isolation compensates for a policy that grants too much access.

This is what Sandlock is built for. [Sandlock](https://github.com/multikernel/sandlock){:target="_blank" rel="noopener noreferrer"} is open source under Apache 2.0. It is a single binary with no external dependencies, no daemon, and no root requirement. It runs on any Linux system with kernel 6.12 or later.

Try it:

```bash
pip install sandlock
```

```python
from sandlock import Sandbox, Policy

policy = Policy(
    fs_readable=["/usr", "/lib", "/etc"],
    fs_writable=["/tmp/sandbox"],
    net_allow_hosts=["api.anthropic.com"],
)

result = Sandbox.run(policy, ["python3", "agent.py"])
```

The agent can read system libraries, write to a scratch directory, and reach the LLM API. It cannot read your SSH keys, your environment files, your credentials, or anything else that was not explicitly granted. No container required.
