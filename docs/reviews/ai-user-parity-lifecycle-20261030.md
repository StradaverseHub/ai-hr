# Lifecycle: bounded native offboarding handoff

Baseline 3a2a015683c0a1ad8ec6f341186f7fa12a5fcdad. This slice adds navigation from canonical lifecycle read presentation to `/lifecycle/offboarding`. It does not implement Assistant execution parity. The action-shaped handoff identifier is navigation metadata only, absent from the executable registry and nomination parser. No migration, custody row or effect receipt is introduced.

## Native inventory and boundaries

- V3.1/V9 onboarding: `packs/lifecycle/onboarding/service.ts`, accepted ADR-0129; tasks, group assignment, requisition generations and acknowledgement use a separate aggregate. Preserve the Onboarding owner's redesign. Personnel owns draft activation.
- Legacy onboarding/offboarding: `core/lifecycle-cases.ts`, exposed through `packs/lifecycle/service.ts`; native `app/lifecycle/actions.ts` owns create/update, tick/undo, outcome, cancellation and reopen entry points.
- Existing Assistant execution: `lifecycle.acknowledgement.submit` uses native one-shot acknowledgement owner, shared custody and exact event references. `lifecycle.step.chase` sends reminders only, never completes work.
- Missing composite chosen for handoff: offboarding outcome. `setOutcome` locks the case, requires company lifecycle agent authority; changing a recorded outcome requires admin and a reason. Accepted creates an IT Return; rejected after acceptance cancels the open return. Completion is derived and history/domain events share the transaction. This does not terminate employment (resignation workflow owns that fact).

## Actor, date, delegation and confirmation handling

Navigation grants no access, including to unlinked USER or SYSTEM actors. The destination resolves the actual session and lifecycle gate; native services/RLS decide row/company authority. No HR-only policy is invented. No case, employment, company, effective date, last working day, assignee, delegation claim or decision travels in the link. The person selects the case and uses native controls. Native configuration and allowed transitions remain authoritative; no task delegation is inferred from a link. The handoff has no completion audit or success claim; only the native transaction can produce those facts. Assistant confirmation/replay remains unavailable for this composite.

## Shared changes and verification

Only `lib/ai/module-human-handoffs.ts` changes shared code: strict literal schema union and lifecycle-only fixed navigation, using existing canonical read admission and rendered review-link presentation. No registry, provider, authentication, native transaction, locale or migration changes. Existing generic localized module card labels remain in use. Authored focused tests exercise tampering, data rejection, module separation, immutability and inability to nominate execution. Hosted evidence will be recorded separately; no local tests/compiler/build/database commands are permitted.
