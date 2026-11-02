# Binding-impact inventory: claude/teras-review-fixes against released main 50ea2471

Computed from git objects and write-disabled copies of the manifest scripts. No manifest or approval was written.
Measured on head e8d894689. Regenerate on the final head before the single rebind. Finding outside this stack: released main's own module-agent manifest records 2e96d752… but its --check computes 5c20fc59… over the same 456 files, so it is stale on main itself.


## Provider-data closure

Approved baseline (released main 50ea2471): `adbd370dd31e429d8090b935c4dbaa730a840d50506aa4443b70269205ca1055`. Candidate on this head: `9912948cae6aea43d6431745e4e6df8416264e25cda3e5c0287b9207c1449a47`.

1150 → 1247 files: 5 changed, 97 added, 0 removed.

### Changed

- `core/approvals.ts`: 7b57b2884 fix(leave): H4 the assigned-leave queue reads its no-step subjects in one statement
- `core/leave.ts`: 7b57b2884 fix(leave): H4 the assigned-leave queue reads its no-step subjects in one statement
- `core/module-agent-releases.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotions fall ba
- `lib/ai/provider-task-registry.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `scripts/ai-provider-data-source-manifest.mjs`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)

### Added

- `components/attendance-format.ts`
- `core/agent-registry/controls.ts`: df7f9f1f4 fix(teras): first-time worker switch changes serialise, so the audit trail chains; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); afb04c12d feat(ai-centre): switch approver recommendations and explainers from Workers; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/agent-registry/workers.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/approvals-inbox.ts`
- `core/assistant-actions/module-action-server.ts`
- `core/assistant-actions/multi-cycle-run-choices.ts`
- `core/assistant-actions/own-leave-browser.ts`
- `core/assistant-actions/own-leave-server.ts`
- `core/employee-user-activation.ts`
- `core/employment-review.ts`
- `core/explainers/attendance.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/capabilities.ts`: 2e98df23d fix(teras): H1 explainers are offered only while the explainers worker gate is open; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored lateness; type ; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/entitlement.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/outcome.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/explainers/statutory.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/harness/disclosure.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip purpose; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/fence.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/memory.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/model-client.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/permit.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `core/harness/reply-checks.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip purpose; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; a87dc4180 fix(teras): identifier check treats a full stop after a number as punctuation; type scripted steps; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/restore.ts`: 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/runner.ts`: 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip purpose; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the route (spec; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-0170 step 3); 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/spec.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 0d9e99016 fix(teras): gate another person's statutory record named by possessive (step 4 run 41308136839); spe; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the route (spec; 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-0170 step 3); 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/task-memory-store.ts`: b6ab60d6b fix(teras): L4 overlapping turns of one conversation both count in task memory; f2d01f799 feat(db): 0906 teras review services migration (M4, M17, low items); 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-only grant ; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/harness/tools.ts`: 39c1301a0 fix(teras): refuse decision suggestions on skip-review or bulk wording; point an approver's 'pending; 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip purpose; 2e98df23d fix(teras): H1 explainers are offered only while the explainers worker gate is open; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/harness/trace-persistence.ts`: 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to the asker; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/harness/trace.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 48c75556b feat(teras): step 1 turn harness as product code, off and unwired
- `core/leave-config-health-input.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaimed changes
- `core/letter-automation-sources.ts`
- `core/letter-notifications.ts`
- `core/letter-stage-clock.ts`
- `core/letters.ts`
- `core/mandates/job-types.ts`: d870657db fix(teras): M1/M5 mandate run limit holds under overlap and counts only prepared runs; one digest ma; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/mandates/mandates.ts`: d870657db fix(teras): M1/M5 mandate run limit holds under overlap and counts only prepared runs; one digest ma; 075feb23d fix(teras): scope check typing; recommender reject fixture forbids negative balance (run 41320483109; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/notice.ts`
- `core/notification-email-delivery.ts`
- `core/offboarding.ts`
- `core/outcome-record/record.ts`: 71323d25d fix(teras): bind recommendation agreement to the leave decision event; keep record.ts clear of the h; 89df6ff1d fix(teras): outcome record trace is bounded to its declared groups and short values; 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to the asker; c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-only grant ; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/outcome-record/rule-versions.ts`: c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-only grant ; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/outcome-record/types.ts`: 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `core/payslip-employer-borne.ts`
- `core/product-context/actions.ts`: b3876deb8 feat(assistant): make every parity action suggestable from the Assistant
- `core/product-context/approval-queue.ts`: ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer
- `core/product-context/company-setup.ts`: 87acf695f fix(assistant): leave readiness is the one verdict on earning methods; negated sentences are not ove; 293e706ea feat(assistant): company setup read of configured leave types and schedule groups
- `core/product-context/coverage-readiness.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/product-context/guides.ts`: 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/product-context/module-readiness.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaimed changes
- `core/product-context/setup-readiness.ts`: 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaimed changes; 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/product-context/tools.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 87acf695f fix(assistant): leave readiness is the one verdict on earning methods; negated sentences are not ove; 3e76d8df0 feat(assistant): leave, holiday, attendance and onboarding setup readiness; fail overclaimed changes; 293e706ea feat(assistant): company setup read of configured leave types and schedule groups; ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer; b3876deb8 feat(assistant): make every parity action suggestable from the Assistant; 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `core/proposals/leave-cancel.ts`: 5726b44ad fix(teras): step 2 review fixes from run 41304727035; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/proposals/leave-decide.ts`: 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 5726b44ad fix(teras): step 2 review fixes from run 41304727035; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/proposals/proposal.ts`: 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/proposals/suggested.ts`: 39c1301a0 fix(teras): refuse decision suggestions on skip-review or bulk wording; point an approver's 'pending; f3d70afbc fix(teras): the chooser reads assigned choices through the assigned-leave action's read-only owner; ; ab67334a3 fix(teras): M2 approvals chooser lists only the native assigned set; M3 the person's own words pick ; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects
- `core/recommenders/leave-decision.ts`: 71323d25d fix(teras): bind recommendation agreement to the leave decision event; keep record.ts clear of the h; fb298f899 fix(recommender): one recorded recommendation per approver, request, step and HR day while unchanged; 6c4bcd811 fix(teras): H3 own-overlap reads the applicant's own requests; M4 agreement follow-ups bound to the ; 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/recommenders/recommendation-dedupe.ts`: fb298f899 fix(recommender): one recorded recommendation per approver, request, step and HR day while unchanged
- `core/semantic-model/entities-explain.ts`: 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored lateness; type ; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/semantic-model/entities-recommend.ts`: da4743404 fix(teras): keep harness paths out of semantic-model comments; rename duplicate test binding; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 1efac1951 feat(teras): the recommender never recommends reject (owner decision, 2 November 2026); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5)
- `core/semantic-model/entities-setup.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/semantic-model/entities.ts`: 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 088b1bbe5 feat(teras): step 2 leave cards as signed proposal objects; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/semantic-model/generate.ts`: 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); fcf81ef9c feat(teras): step 5c improvement engine (ADR-0170 §3.12); 962575257 feat(teras): apply ADR-0170 §3.15 integration decisions; spec v5; 80022d7a6 fix(teras): step 4 comments name no harness path; attendance test asserts the stored lateness; type ; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 5726b44ad fix(teras): step 2 review fixes from run 41304727035; f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/semantic-model/types.ts`: da4743404 fix(teras): keep harness paths out of semantic-model comments; rename duplicate test binding; 98680b57f fix(teras): close the ADR-0169 §5.1 disclosure defects in the harness; 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); f34af33f2 feat(teras): step 0b semantic model and signed proposal objects
- `core/setup-copilot/copilot.ts`: 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired)
- `core/statutory-explain.ts`
- `core/teras-wiring/history.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `core/teras-wiring/model-client.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `core/teras-wiring/switch.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `core/teras-wiring/turn.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
- `db/teras-schema.ts`: f2d01f799 feat(db): 0906 teras review services migration (M4, M17, low items); 1a7d32588 fix(teras): B1 a routed or refused turn's outcome record names no topic and is private to the asker; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off); 4b328e2c3 feat(teras): approver recommendations, daily digest and agent registry (ADR-0170 step 5); c60aed8fc fix(teras): keep step 5a outside the harness import guard; readonly record inputs; table-only grant ; 693fe0f49 feat(teras): step 5a outcome record, rule-version labels, task-memory persistence and work-job manda
- `deploy/identity-email/attendance-cc.ts`
- `deploy/identity-email/notification-message.ts`
- `deploy/identity-email/notifications.ts`
- `deploy/identity-email/service.ts`
- `lib/ai/teras-harness-policy.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotions fall ba; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)
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
- `lib/product-context/destinations.ts`: f322302e3 fix(product-context): linkable /admin/settings/entra in derived order; d4aeec9e8 fix(product-context): the destination registry and linkable pages include main's /admin/settings/ent; 39e05ea14 fix(teras): M6 M15 M16 identifier formats, scoped names for HR administrators, My Payslip purpose; 41bcb073a fix(teras): B3 H2 H5 M7 M8 harness spec v7; 6cdbab997 feat(teras): step 4 "Why?" explainers and go-live setup co-pilot (off, unwired); 3fd05d8ff feat(assistant): add the ADR-0169 phase B context and capability layer
- `lib/product-context/request-gate.ts`: d358b54a3 fix(teras): B2 and M14 the pre-read gate routes Thai and Tamil, assault, abuse, paraphrased crisis, ; 0d9e99016 fix(teras): gate another person's statutory record named by possessive (step 4 run 41308136839); spe; 5dfc76501 fix(teras): crisis turns answered by the harness alone; gate note no longer mentions the route (spec; fc4445e8b fix(teras): keep the harness path out of the gate's comment (switch test); 7855e5ee4 feat(teras): sensitive-topic routing and workplace-harms rule in the pre-read gate (ADR-0170 step 3); b3cadb7fe fix(assistant): other-person gate note no longer pushes admin change requests to refuse; ce82ed7b0 feat(assistant): fixed pre-read gate and approval-queue read for the phase B layer
- `lib/real-auth.ts`
- `lib/security-center-navigation.ts`

## Module-agent scope

Approved baseline (released main 50ea2471): `2e96d752dfe314bf33eb449ab842a2b39577a67a4e07e5cc9645f122b3181274 (recorded on main; main itself computes 5c20fc595467c167a9dbd2dae60cfdf6ee72fc0175680e9aa3261f18ea8d0040)`. Candidate on this head: `6a64fbaa148bcea1b3b2659b155a98381179d096667cf9119fc36ebb978baf59`.

456 → 457 files: 2 changed, 1 added, 0 removed.

### Changed

- `core/module-agent-releases.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotions fall ba
- `lib/ai/provider-task-registry.ts`: 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)

### Added

- `lib/ai/teras-harness-policy.ts`: d316b11d1 fix(teras): contract type narrowing; unreadable switch is off; stale conversation promotions fall ba; 474cde620 feat(teras): wire the live chat through the Teras harness behind a per-tenant switch (default off)

