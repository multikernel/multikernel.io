---
layout: post
title: "Multikernel Goes Open Source: Community-First Innovation"
date: 2025-09-18 10:00:00 -0700
categories: [announcement, open-source, linux-kernel]
author: Cong Wang, Founder and CEO
excerpt: "We're excited to announce that Multikernel is officially open-sourcing our Linux kernel implementation, engaging with the Linux kernel community early in our process."
---

We're excited to announce that Multikernel is officially open-sourcing our Linux kernel implementation. Our initial patches are now available on [GitHub](https://github.com/multikernel/linux/commits/multikernel-part-1/) and submitted for review on the [Linux Kernel Mailing List](https://lore.kernel.org/lkml/20250918222607.186488-1-xiyou.wangcong@gmail.com/).

## Community-First Development

At Multikernel, we believe the most impactful systems innovations emerge from collaborative development. We're engaging with the Linux kernel community early in our process, ensuring our work benefits from collective expertise and contributes meaningfully to the broader Linux ecosystem.

## Building on Proven Foundations

Our multikernel architecture builds upon open research and existing Linux infrastructure, particularly the proven kexec subsystem. By leveraging kexec's battle-tested kernel switching capabilities, we implement spawned kernel functionality using well-understood mechanisms that have been part of Linux for over two decades.

Our kexec-based approach draws inspiration from pioneering work in replicated-kernel systems, notably [Popcorn Linux](https://popcornlinux.org/), which has demonstrated innovative approaches to multi-kernel architectures and cross-ISA execution environments.

This reflects our commitment to standing on the shoulders of giants. Rather than reinventing fundamental mechanisms, we're extending existing infrastructure validated by the community, ensuring robustness and compatibility.

## 100% Transparency

We're committed to complete transparency. All kernel modifications, architectural decisions, and implementation details are shared and discussed with the Linux kernel community openly.

While we're proud to open-source our work, we recognize that innovation thrives through diverse perspectives and collaborative evolution. We remain receptive to alternative approaches and welcome superior solutions from the community. Our goal is not to establish a definitive answer, but to contribute meaningfully to the ongoing dialogue around kernel architecture and inspire creative exploration of new possibilities in operating system design.

## Technical Deep Dives

Beyond open-sourcing our code, we're preparing a series of educational videos that will explain both our multikernel solution and the underlying Linux kexec infrastructure that makes it possible. Please subscribe to our [YouTube channel](https://www.youtube.com/@multikernel-tech).

## Looking Forward

This release begins what we hope will be ongoing collaboration with the Linux community. We're seeking feedback and partnerships with developers who share our vision of advancing OS architecture for cloud computing. We will be open sourcing more projects!

## Get Involved

- Obtain our source code on [GitHub](https://github.com/multikernel/linux/commits/multikernel-part-1/)
- Join the discussion on [LKML](https://lore.kernel.org/lkml/20250918222607.186488-1-xiyou.wangcong@gmail.com/)
- Stay tuned for technical videos and documentation

The future of kernel development is collaborative and transparent. We're proud to contribute to this tradition and give our best to the entire world. Please join our efforts!
