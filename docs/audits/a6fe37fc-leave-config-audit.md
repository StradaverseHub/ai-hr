# Leave Configuration — Phase 1 Audit

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/audits/a6fe37fc-leave-config-audit.md`. Verify current code and evidence before acting.

The original audit recommended preserving the leave engine and customer configuration while reorganizing screens. Competing entitlement tables without eligibility rules were a configuration issue that a rewrite would carry forward.

Re-enumerate dependencies through `core/leave-type-refs.ts` and its constraint tests. Preserve request/ledger/encashment/recalculation/generation/replacement history and hand-built approval rules. A nullable approval scope may mean wildcard: removing its referenced data can silently broaden routing instead of failing a foreign key.

Prove new screens before removing old routes. Replay approval routing against the actual authorized configuration and compare winners, chains and fallbacks; verify all employee leave journeys. [Migration sequence](../design/a6fe37fc-migration-order.md) and the retained IA describe the original change. Old row counts and “nothing built” statements are not current facts.
