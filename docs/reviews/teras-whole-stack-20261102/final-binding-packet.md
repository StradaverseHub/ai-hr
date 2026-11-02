# Final binding packet: `claude/teras-review-fixes`, 2 November 2026

**PREPARED ONLY.**
- No approval record, `sourceDigest` literal or manifest has been written.
- This document grants nothing; Codex confirms it conveys no new digest approval.
- The rebind patch could not be produced, because the permission check refused the approval write; see "Refusal".

## Candidate
- **Candidate source:** `24febe13fe8dfd28e42d8763712efe166631379a`.
- **CI run 41369628436 (focused, AIHR_CI_HEAD matched):** typecheck, 64 selected test files and linux-build at the canonical 6144 MB all green. Earlier heads ran out of memory at 6144 MB and keep those recorded failures.
- **The commit adding this packet** adds only documents outside both digest scopes. Both candidate values below are therefore unchanged on that commit; this was checked after committing.

## Digests

### Provider-data closure
- **Approved baseline (released main 50ea2471):** `adbd370dd31e429d8090b935c4dbaa730a840d50506aa4443b70269205ca1055`, 1150 files.
- **Candidate:** `9912948cae6aea43d6431745e4e6df8416264e25cda3e5c0287b9207c1449a47`, 1247 files.
- **Check:** `scripts/ai-provider-data-source-manifest.mjs --check` reports stale on 24febe13 as expected. The value comes from a write-disabled copy of that script.

### Module-agent scope
- **Accepted-source baseline (the actual bytes of main 50ea2471):** `5c20fc595467c167a9dbd2dae60cfdf6ee72fc0175680e9aa3261f18ea8d0040`, 456 files.
- **Recorded on main (stale):** `2e96d752dfe314bf33eb449ab842a2b39577a67a4e07e5cc9645f122b3181274`.
  - **Root cause** (Entra's review packet): the value was hashed before the final provider-approval `sourceDigest` literals were updated. The provider digest `adbd370d` is unaffected.
  - **Governance impact:** main's `ai-agent-source-manifest.mjs --check` fails on main itself, so main's recorded module-agent value does not describe main's bytes. Any module-agent approval naming `2e96d752` describes a tree that never existed.
  - **Repair:** Entra's isolated repair `d8e29ff71` changes that one generated line to `5c20fc59` and adds a review packet. On a detached checkout, `--check` passes with 456 files; this was verified independently here and in the coordinating session.
  - **That repair is separate, unapproved and not installed.** It is not merged or cherry-picked into this branch.
  - **Merge order:** d8e29ff71 and the Teras rebind both rewrite the same generated line in `lib/ai/module-agent-source-manifest.ts`. Whichever lands second must regenerate it, after its own approval literals are written.
  - MOBILE's `8b676f25c` carries its own consistent module manifest; it is neither used nor referenced here.
- **Candidate before the rebind (24febe13 as it stands):** `6a64fbaa148bcea1b3b2659b155a98381179d096667cf9119fc36ebb978baf59`, 457 files.
- **Candidate after the rebind: not computed.**
  - `lib/ai/provider-data-approvals.ts` and `lib/ai/provider-data-source-manifest.ts` are inside the module-agent scope, so the value depends on the rebind's own bytes.
  - It must be generated last, after the provider manifest and every approval literal are written. That order is the one main got wrong.
  - Producing it needs the approval write that was refused.

## Per-file delta, by commit (50ea2471..24febe13, merges excluded)

### Provider-data closure (against main 50ea2471): 5 changed, 97 added, 0 removed

**Changed**

- `core/approvals.ts`: 7b57b2884 fix(leave): H4 the assigned-leave queue reads its no-step subjects in one statement
- `core/leave.ts`: 7b57b2884 fix(leave): H4 the assigned-leave queue reads its no-step subjects in one statement
- `core/module-agent-releases.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotio
- `lib/ai/provider-task-registry.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `scripts/ai-provider-data-source-manifest.mjs`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa

**Added**

- `components/attendance-format.ts`
- `core/agent-registry/controls.ts`: df7f9f1f4 fix(teras): first-time worker switch changes serialise, so the audit trail chains; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; afb04c12d feat(ai-centre): switch approver recommendations and explainers from Workers; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/agent-registry/workers.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/approvals-inbox.ts`
- `core/assistant-actions/module-action-server.ts`
- `core/assistant-actions/multi-cycle-run-choices.ts`
- `core/assistant-actions/own-leave-browser.ts`
- `core/assistant-actions/own-leave-server.ts`
- `core/employee-user-activation.ts`
- `core/employment-review.ts`
- `core/explainers/attendance.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/capabilities.ts`: 2e98df23d fix(teras): H1 explainers are offered only while the explainers worker gate is open; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored laten; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/entitlement.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/outcome.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/statutory.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/harness/disclosure.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip ; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/fence.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/memory.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/model-client.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/permit.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `core/harness/reply-checks.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip ; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; a87dc4180 fix(teras): identifier check treats a full stop after a number as punctuation; type script; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/restore.ts`: 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/runner.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip ; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the r; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-01; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/spec.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 0d9e99016 fix(teras): gate another person's statutory record named by possessive (step 4 run 4130813; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the r; 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-01; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/task-memory-store.ts`: b6ab60d6b fix(teras): L4 overlapping turns of one conversation both count in task memory; f2d01f799 feat(db): 0906 teras review services migration (M4, M17, low items); 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-o; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/harness/tools.ts`: 39c1301a0 fix(teras): refuse decision suggestions on skip-review or bulk wording; point an approver'; 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip ; 2e98df23d fix(teras): H1 explainers are offered only while the explainers worker gate is open; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/trace-persistence.ts`: 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to ; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/harness/trace.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/leave-config-health-input.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaim
- `core/letter-automation-sources.ts`
- `core/letter-notifications.ts`
- `core/letter-stage-clock.ts`
- `core/letters.ts`
- `core/mandates/job-types.ts`: d870657db fix(teras): M1/M5 mandate run limit holds under overlap and counts only prepared runs; one; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/mandates/mandates.ts`: d870657db fix(teras): M1/M5 mandate run limit holds under overlap and counts only prepared runs; one; 075feb23d fix(teras): scope check typing; recommender reject fixture forbids negative balance (run 4; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/notice.ts`
- `core/notification-email-delivery.ts`
- `core/offboarding.ts`
- `core/outcome-record/record.ts`: 71323d25d fix(teras): bind recommendation agreement to the leave decision event; keep record.ts clea; 89df6ff1d fix(teras): outcome record trace is bounded to its declared groups and short values; 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to ; c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-o; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/outcome-record/rule-versions.ts`: c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-o; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/outcome-record/types.ts`: 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `core/payslip-employer-borne.ts`
- `core/product-context/actions.ts`: b3876deb8 feat(assistant): make every parity action suggestable from the Assistant
- `core/product-context/approval-queue.ts`: ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer
- `core/product-context/company-setup.ts`: 87acf695f fix(assistant): leave readiness is the one verdict on earning methods; negated sentences a; 293e706ea feat(assistant): company setup read of configured leave types and schedule groups
- `core/product-context/coverage-readiness.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/product-context/guides.ts`: 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/product-context/module-readiness.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaim
- `core/product-context/setup-readiness.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaim; 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/product-context/tools.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 87acf695f fix(assistant): leave readiness is the one verdict on earning methods; negated sentences a; 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaim; 293e706ea feat(assistant): company setup read of configured leave types and schedule groups; ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer; b3876deb8 feat(assistant): make every parity action suggestable from the Assistant; 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/proposals/leave-cancel.ts`: 5726b44ad fix(teras): step 2 review fixes from run 41304727035; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/proposals/leave-decide.ts`: 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 5726b44ad fix(teras): step 2 review fixes from run 41304727035; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/proposals/proposal.ts`: 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/proposals/suggested.ts`: 39c1301a0 fix(teras): refuse decision suggestions on skip-review or bulk wording; point an approver'; f3d70afbc fix(teras): the chooser reads assigned choices through the assigned-leave action's read-on; ab67334a3 fix(teras): M2 approvals chooser lists only the native assigned set; M3 the person's own w; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/recommenders/leave-decision.ts`: 71323d25d fix(teras): bind recommendation agreement to the leave decision event; keep record.ts clea; fb298f899 fix(recommender): one recorded recommendation per approver, request, step and HR day while; 6c4bcd811 fix(teras): H3 own-overlap reads the applicant's own requests; M4 agreement follow-ups bou; 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/recommenders/recommendation-dedupe.ts`: fb298f899 fix(recommender): one recorded recommendation per approver, request, step and HR day while
- `core/semantic-model/entities-explain.ts`: 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored laten; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/semantic-model/entities-recommend.ts`: da4743404 fix(teras): keep harness paths out of semantic-model comments; rename duplicate test bindi; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/semantic-model/entities-setup.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/semantic-model/entities.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/semantic-model/generate.ts`: 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); fcf81ef9c feat(teras): step 5c improvement engine (ADR-0170 §3.12); 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored laten; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 5726b44ad fix(teras): step 2 review fixes from run 41304727035; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/semantic-model/types.ts`: da4743404 fix(teras): keep harness paths out of semantic-model comments; rename duplicate test bindi; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/setup-copilot/copilot.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/statutory-explain.ts`
- `core/teras-wiring/history.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `core/teras-wiring/model-client.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `core/teras-wiring/switch.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `core/teras-wiring/turn.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `db/teras-schema.ts`: f2d01f799 feat(db): 0906 teras review services migration (M4, M17, low items); 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to ; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-o; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work
- `deploy/identity-email/attendance-cc.ts`
- `deploy/identity-email/notification-message.ts`
- `deploy/identity-email/notifications.ts`
- `deploy/identity-email/service.ts`
- `lib/ai/teras-harness-policy.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotio; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa
- `lib/approvals-focus.ts`
- `lib/assessment-reminder-message.ts`
- `lib/assigned-approval-focus.ts`
- `lib/assistant-actions/module-action-http.ts`
- `lib/assistant-actions/multi-cycle-run-browser-contract.ts`
- `lib/assistant-actions/offboarding-case-cancel-browser-contract.ts`
- `lib/assistant-actions/offboarding-step-browser-contract.ts`
- `lib/assistant-actions/offboarding-step-undo-browser-contract.ts`
- `lib/assistant-actions/people-general-policy-http.ts`
- `lib/assistant-actions/rewards-return-http.ts`
- `lib/attendance-cc-mail.ts`
- `lib/email-design/render.ts`
- `lib/internal-auth/notification-mail.ts`
- `lib/leave-config-health.ts`
- `lib/letter-editor.ts`
- `lib/letter-verification.ts`
- `lib/nav-entitlements.ts`
- `lib/notice-upload-policy.ts`
- `lib/notification-email-ipc.ts`
- `lib/product-context/destinations.ts`: f322302e3 fix(product-context): linkable /admin/settings/entra in derived order; d4aeec9e8 fix(product-context): the destination registry and linkable pages include main's /admin/se; 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip ; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `lib/product-context/request-gate.ts`: d358b54a3 fix(teras): B2 and M14 the pre-read gate routes Thai and Tamil, assault, abuse, paraphrase; 0d9e99016 fix(teras): gate another person's statutory record named by possessive (step 4 run 4130813; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the r; fc4445e8b fix(teras): keep the harness path out of the gate's comment (switch test); 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-01; b3cadb7fe fix(assistant): other-person gate note no longer pushes admin change requests to refuse; ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer
- `lib/real-auth.ts`
- `lib/security-center-navigation.ts`

### Module-agent scope (against the accepted-source bytes of main 50ea2471, 5c20fc59): 2 changed, 1 added, 0 removed

**Changed**

- `core/module-agent-releases.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotio
- `lib/ai/provider-task-registry.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa

**Added**

- `lib/ai/teras-harness-policy.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotio; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (defa

## Governance basis (verbatim)

- **ADR-0169 privacy review: owner sign-off, 2 November 2026.**
  - Final answer, verbatim: "Go ahead, signed off".
  - Source: `docs/reviews/evidence/adr-0169-owner-answers-2026-11-02.md` (exported 2026-11-01T18:24:01.789Z), committed at `1a5f21086` on `claude/assistant-onyx-phase1-20261031`. That file is not on this branch.
  - Other answers from the same export, verbatim:
    - processor route: "It can be any, direct upstream, OpenRouter, UnifyAPI. Depending on which provider the customer chooses.";
    - third-party reads: "Proceed";
    - pay reads: "Proceed but only based on the user's access".
- **Module-agent digest: owner decision, 2 November 2026.**
  - Verbatim: "Yes, let it move".
  - The decision came with the fix that stale-digest promotions fall back to the standard strategy (`core/module-agent-releases.ts`, d316b11d).
  - It was given in the coordinating session and recorded in `TERAS-RELEASE-STATUS.md`.
- **Staging exception (ADR-0169 §5.1).**
  - Verbatim: "Can switch on for every company in staging. Its all fictional data."
  - It covers fictional staging data only. Counsel's advice on cross-border transfer and the data processing agreement is still required before real tenant data reaches a provider.
- **Codex provenance labels.**
  - **Option (a), type-cost repair:** "selected by the Codex ORCHESTRATOR under the owner's existing routine-repair and staging authorisation. The owner did not choose these files in a new direct message." It does not grant "a new AI digest approval, a retrospective human review, or a capacity-policy change."
    - Result: `claude/teras-type-hotspots` (11930f14) saved no memory and is **not** merged into this branch.
  - **Capacity:** "The 6144 cap stays required, and its failures are not relabelled." The review-only packet, draft PR 201, "authorises preparation only: no adoption, no deployment, no AI binding."
    - It stays unadopted. There is no retry-until-green. If the final canonical build on the frozen candidate fails, it is classified and reported, and a bounded capacity action is put forward separately.

## Draft rebind addendum (for `docs/reviews/ai-provider-owner-approval-2026-10.md`; not written)

```markdown
## Noveri conversation wiring

Wiring the live chat through the Teras turn harness (ADR-0169 §5.1, ADR-0170 §11.3 change 4) adds one provider-data
contract, `teras_harness_turn_v1` (lib/ai/teras-harness-policy.ts), registered for `hr_assistant` conversations only
(lib/ai/provider-task-registry.ts), and makes `core/teras-wiring/switch.ts` and `core/teras-wiring/turn.ts` roots of
the provider-data closure, together with the whole-stack review fixes (PR 202). The closure moves from 1150 files /
`adbd370dd31e429d8090b935c4dbaa730a840d50506aa4443b70269205ca1055` (released main 50ea2471) to 1247 files /
`9912948cae6aea43d6431745e4e6df8416264e25cda3e5c0287b9207c1449a47` (candidate 24febe13); the per-file delta is in
docs/reviews/teras-whole-stack-20261102/final-binding-packet.md.

Owner sign-off of the ADR-0169 privacy review, 2 November 2026: "Go ahead, signed off" (exported answers,
2026-11-01T18:24:01Z). Processor route is the tenant's choice among existing adapters; a direct route must be
attested for zero retention and no training, and OpenRouter requests carry data_collection=deny and zdr=true; UnifyAPI
needs its own approval. Pay reads only as the caller ("Proceed but only based on the user's access").

Remaining conditions: counsel's advice on PDPA cross-border transfer and the data processing agreement before any real
tenant data reaches a provider; no tenant switch is on; the staging exception covers fictional data only; a
production-path ceiling rerun must show this gate passing for the approved contract with 0 errors.

The 24 approved records receive only the new sourceDigest (status, reviewer, evidence and timestamps preserved; both
pending records byte-identical), and one record is added: `teras_harness_turn_v1`, approved, reviewer
human:zenlam repository-owner provisional, evidence #noveri-conversation-wiring, reviewedAt 2026-11-01T18:24:01Z.

The module-agent manifest is regenerated last, after these literals, from the accepted-source baseline
`5c20fc595467c167a9dbd2dae60cfdf6ee72fc0175680e9aa3261f18ea8d0040` (456 files; main recorded the stale
`2e96d752dfe314bf33eb449ab842a2b39577a67a4e07e5cc9645f122b3181274`), under the owner's "Yes, let it move".

This record is not a runtime PASS, staging acceptance or deployment authorisation.
```

## Exact bytes the rebind would change (described; the patch was refused)
Run these in order on the frozen candidate:
1. **`lib/ai/provider-data-source-manifest.ts`:** the generated digest line `adbd370d…` becomes `9912948cae6aea43d6431745e4e6df8416264e25cda3e5c0287b9207c1449a47`. Generate it with `node scripts/ai-provider-data-source-manifest.mjs`.
2. **`lib/ai/provider-data-approvals.ts`:**
   - exactly 24 occurrences of `"sourceDigest": "adbd370dd31e429d8090b935c4dbaa730a840d50506aa4443b70269205ca1055"` become `"sourceDigest": "9912948cae6aea43d6431745e4e6df8416264e25cda3e5c0287b9207c1449a47"`;
   - one record is appended for `teras_harness_turn_v1` with the values in the addendum;
   - the two pending records stay unchanged.
3. **`docs/reviews/ai-provider-owner-approval-2026-10.md`:** the addendum above is appended. Its `## Noveri conversation wiring` heading provides the evidence anchor.
4. **`lib/ai/module-agent-source-manifest.ts`:** regenerated last with `node scripts/ai-agent-source-manifest.mjs`. The value is not known in advance, because it hashes steps 1-2.
5. **Checks:** `--check` passes for both scripts. Then focused CI on the rebind head: the provider gate tests, `test/teras-conversation-turn.test.ts`, the boundary tests, typecheck and the canonical build. Then the production-path ceiling rerun with 0 errors.

## Refusal
On 2 November 2026 I tried to produce `side-session-notes/teras-rebind.patch` in a throwaway detached worktree off 24febe13 (`~/Projects/ai-hr-builders/teras-rebind-prep-20261102`). Step 1 had been applied there. Step 2, the approval literals and the new record, was refused by the session's permission check with this exact text:

> Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Security Weaken].

The worktree was reset to a clean 24febe13 and no patch was written. The same check refused the original rebind on PR 197. The approval write needs a decision from the user, who would perform it or grant it.
