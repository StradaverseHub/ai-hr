# Kingdee onboarding and requisition comparison and implementation plan

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/research/2026-10-18-kingdee-onboarding-requisition-parity.md`. Verify current code and evidence before acting.

The V3.1 comparison called for Personnel-owned onboarding cases with checklist selection, assigned tasks, equipment/work-order requisitions, approvals, fulfilment and Day 1 acknowledgement. Requisitions here are IT/facilities requests, not hiring/headcount.

[ADR-0129](../adr/0129-kingdee-onboarding-v31.md) retains the resulting decisions: distinct process history, explicit submission/state transitions, existing identity/permission owners, assigned-work authorization, controlled configuration deletion, conversations and notifications. Review its verification obligations and the original supplied handoff before further parity work. Prototype behavior was not verified by the original comparison; implementation and deployment must be checked independently. Old branch paths, proposed work packages and “current gaps” are historical.
