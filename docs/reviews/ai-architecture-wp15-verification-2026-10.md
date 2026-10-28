# WP15 — retention, threat model, naming and documentation (R12–R14)

Source rechecked at fetched matching main/alpha `b5758c54c431765461d84235ad19c72ad71cf578`.

| Finding | Verified state / change |
| --- | --- |
| R12 retention installation unknown | Read-only SSH through the documented staging alias on 29 October: is-enabled `not-found`, is-active `inactive`, show `LoadState=not-found`, empty trigger times. Timer absent. Documented in DEPLOY.md; release owner must install/verify it. No installation or deployment performed. |
| R12 no AI threat model | Confirmed: original Slice-0 model excluded AI. Added `docs/architecture/ai-threat-model.md` with assets, actors, trust boundaries, abuse cases, source owners, test obligations and explicit remaining gaps. |
| R13 naming | Owner approved Assistant, Control Tower, HR work queue, scheduled agent in this chat. Six locale values updated; stable keys retained. Canonical read-capability names and `rollbackAssistantPromotion` added with compatibility exports for concurrent callers. Removed duplicate Administration → AI navigation entry; retained bookmark redirect. |
| R14 stale comments | Rechecked review §9 against source and dispatch. Updated pause, mounted source/custody, twelve tools, strategy-specific caching, sequential execution, current scheduled-model limits, multiple candidate kinds, partial human-plan read coverage, payroll explanation, varied setting defaults, unused feedback env flag, gateway features and six timer pairs. Protected review-sweep/action files receive comments only under the owner's explicit exception. |
| R14 ADR facts | Added implementation amendments to ADR-0082 and ADR-0151: implemented status, retention, absent budget file/search tool, source counts (23 declared IDs including one Handoff, 22 prepared), current inventory vocabulary, production vs test-only harness, sequential tools, per-author promotion and remaining rollback/independence gaps. |

Already fixed at this base: claim cancellation's header already named generic SQL functions (not the generic TS implementation); clarified its dedicated TS custody. Most reviewed stale comments remained. The old `controlTower.agents` locale keys have no discovered production reader; they remain compatibility copy, not evidence of an additional capability.

Remaining outside scope: retention installation/service/backlog acceptance by release owner; WP1 scheduled-status behavior; WP5 prompt/budget hardening; WP7 registry unification; WP8 generic parity; WP11 learning; WP12 complete inventory/provider data register. None is claimed implemented. No permission, switch default, automatic authority, provider or HR effect is changed.

Focused checks, six-locale rendered desktop/mobile evidence and exact-candidate gate results belong to the PR evidence after source freeze; authored translations are not claimed independently language-reviewed. The bundled guide source is updated; no old translation hash is stamped and no tenant KB refresh/deployment is performed. No migration. Next package: none in the authorized scope; other work packages remain held.
