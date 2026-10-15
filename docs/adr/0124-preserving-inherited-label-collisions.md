# ADR-0124: Preserve inherited System Label collisions without permitting new ambiguity

Status: Accepted implementation direction; runtime verification pending
Date: 2026-10-16
Deciders: Product architect / board integration owner

## Context

Approved board item 6d26c915 requires existing IDs, codes and availability to survive the common System Labels owner, while refusing new collisions. The production read-only 0550 preflight identified four active pairs: three between three Cost Centre HQ identities and one between two Position Machine Operator identities. Two pairs are Global/Global; two are Global/scoped. Strictly refusing all inherited duplicates would block that preservation requirement. Renaming, merging, deleting, picking a preferred creation company or narrowing availability would change business data without authorization. Usage counts do not prove an identity is unused.

Migration 0550 remains unapplied (production prefix 0542). This changes only that unapplied migration and its canonical owner; applied history and journal numbering are unchanged. Migration captures the actual incumbent rows, not production UUID constants.

## Decision

Capture one baseline row per **tenant + kind + normalized code + ordered exact ID pair**. Normalization remains the existing `lower(trim(code/name/title))`. Each baseline is either:

- Global/Global: an unbounded overlap, including future companies because Global already has that meaning.
- Any other overlapping pair: the sorted, distinct incumbent intersection of company availability. Global/scoped captures only the scoped member's incumbent set; scoped/scoped captures their intersection.

The baseline is an observation of inherited ambiguity, not a new label master or configurable permission. Disjoint labels need no exemption. New identities, another normalized code/kind/tenant, restored retired pairs or an additional overlap cannot borrow it. Same normalized spelling changes do not create a distinct code identity, but workbook metadata saves retain the actual stored spelling, including outer whitespace stripped by workbook parsing.

An invoker, read-only SQL predicate decides whether a projected or actual pair is disjoint or contained in its exact active baseline. The deferred database constraint, canonical service save and batched workbook preview call it. Preview arguments grant no authorization; the database constraint independently rereads actual final rows. Existing actual administrator scope, group-only Global changes, reference guards and canonical epoch locking remain mandatory.

App role has tenant-scoped SELECT only on the baseline and no INSERT/UPDATE/DELETE/TRUNCATE. A private SECURITY DEFINER **trigger**, with fixed search path and exact actual relation allowlist, can only update existing baseline rows by intersection or permanent retirement. App/PUBLIC cannot execute it or attach it to a fabricated table. There is no GUC exemption, client flag, public privileged mutator or callable seeder. The migration owner captures the incumbent pairs once under table locks before installing epoch triggers.

Reduction triggers are deferred to observe the final batch state, so replacing junction rows does not temporarily retire an unchanged pair. They only shrink a Global cap to a finite final intersection, intersect an existing finite cap, or retire on final archive/deletion/rename/disjoint availability. Retired rows remain tombstones; they are never revived or deleted. Reduction and retirement append a domain event in the same transaction. A refused write rolls back both baseline changes and events. A transaction's intermediate, uncommitted states are not separate business resolutions; final persisted state determines the transition.

## Alternatives and tradeoffs

Strict preflight refusal preserves safety but unnecessarily blocks unchanged incumbents. Removing the preflight without a bounded baseline leaves metadata edits blocked or admits new ambiguity. A code-wide allowlist, any caller opt-out, or current creation-company preference would exempt unrelated identities or silently change resolution. The exact pair cap is narrower and can only diminish.

This retains known ambiguity: a company may still see multiple labels with the same display code/name. Interactive pickers submit exact IDs. Personnel import's canonical lookup accepts exact IDs and refuses ambiguous code/name aliases; it must not choose the first result. System Labels workbooks use kind + creation Company + Code; multiple matches to that identity now refuse explicitly. The four observed pairs have distinct creation companies. UI disambiguation and any explicit business cleanup of inherited labels remain separate work; this repair does not choose a survivor.

## Consequences and verification

No existing label, assignment, availability, code or ID is rewritten. Each inherited exception has exact provenance and an irreversible retirement boundary. Existing criteria epoch rows continue to serialize reference/criteria writers and force stale repeatable-read writers to restart. Baseline reducers run under the same writer transaction and cannot widen it.

Prepared restricted-role DB regressions cover generic four-pair capture, metadata and workbook round trips, future companies, scope reduction, expansion refusal, rename/archive/delete retirement, exact code/kind/tenant/ID binding, direct app forgery, fake GUC, concurrent new IDs, and alias refusal. Existing criteria/reference/concurrency tests remain required. Non-DB contracts cover shared predicate use, private reducer shape, bounded projected pairs and ambiguous workbook refusal.

**Not verified yet:** SQL compilation/migration rehearsal, actual restricted-role policies/triggers, transaction/concurrency behavior, semantic TypeScript, regression execution and real app pickers/workbook journeys. Source inspection and syntax parsing are not runtime proof. Parent must run these in the coordinated disposable DB/check window, then repeat production preflight/shadow migration without writing production data until the release gate permits it.
