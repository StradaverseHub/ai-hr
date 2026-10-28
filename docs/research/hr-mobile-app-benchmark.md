# Win the clock-in, not the feature list

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/research/hr-mobile-app-benchmark.md`. Verify current code and evidence before acting.

Research prioritized reliable clocking and recovery from GPS/network failures over a broad feature list. Preserve attempted-punch evidence, clear failure states, session continuity and content-free lock-screen notifications.

OS mock-location flags can indicate suspected spoofing but do not prove genuine location; device attestation and online/offline trust are separate. Distinguish selfie capture from face matching and its privacy implications. Evaluate offline timestamps and evidence against actual platform behavior rather than treating a client clock as authoritative.

Store ratings, competitor capabilities and platform claims in the full report are historical. Recheck current primary platform documentation for implementation decisions. ADR-0088 and later mobile/auth decisions govern the product; the old WorkOS-only login description is superseded by ADR-0117.
