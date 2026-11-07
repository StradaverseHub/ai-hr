# AI Centre controls: implementation and source review

Date: 7 November 2026

Status: implementation candidate; exact provider-source approval pending. This record is not an approval or a release receipt.

## What is implemented

Administration > Workers contains a tenant stop-all control, unsettled provider-request count, complete function inventory and independent child controls. The inventory derives from the existing feature, worker, action, semantic read, Assistant/context tool, import and module registries; it does not become a competing source of authority. Existing switches link to their authoritative configuration. Recurring jobs use their existing job-type settings without raising their limits. Payroll learning retains its company settings.

| Function family | Configuration owner | Stop behaviour |
| --- | --- | --- |
| Gateway features, scheduled specialist agents and embedded AI | Existing feature/allowance settings | Fresh admission and returned results are fenced |
| Worker loops and payroll audit | Existing worker controls and company loop pauses | Native case/finding/action transactions are fenced |
| Individual AI actions | Existing action pause registry and native adjudication | No new action authorisation after a committed stop |
| Reads, explanation topics, guidance, import preparation and module tools | New tenant child restrictions | Disabled child cannot execute through its parent |
| Standalone drafts, analytics and Performance generation | 15 explicit operation child restrictions | Provider work and scoped native cache writes are fenced; cache-only viewing remains available |
| Provider connection tests | New connection-test child restriction | Diagnostic requests also honour stop |
| Recurring mandate jobs | Existing job-type enablement and mandate limits | Original generation rechecked before recording a completed result |
| Payroll learning | Existing company learning mode | Recompute is fenced; required erasure still runs |
| Monitoring, scheduling, manual validation, audit, retention and undo | Required infrastructure or native manual owners | Remain available; optional worker work still honours its controls |
| Platform feedback planning | Platform control plus operation child restriction | No tenant switch grants platform authority |

There are 84 registered child restrictions: 64 read/preparation/operation keys and 20 module keys. Future unknown keys fail closed until explicitly registered. Required infrastructure appears in the inventory with its role explained; it does not receive an unsafe off switch. Tenant child overrides do not introduce new company-specific read settings.

## Reliable stop boundary

The stop reuses the existing tenant mandate-control row and its monotonically increasing version. Stop writes, admission and native effects share a transaction lock. A stop waits for effects already authorised under that lock. After its commit, new AI effects cannot be authorised. Original generations are carried across asynchronous work, so stop followed by resume does not revive the old work. Stale browser resumes are refused.

Provider or SMTP traffic already authorised before stop may have left the process and cannot universally be recalled. No database transaction is held across that traffic. Late provider results are discarded and usage accounting still settles; unsettled requests remain visible. Pending optional AI notifications are held while stopped and old generations remain ineligible after resume. A private database delivery trigger independently enforces this boundary. Immutable companion metadata preserves exact event payloads and existing attribution policies; a past event cannot be restamped in a later transaction.

Missing or unreadable controls refuse execution. Group administrators are checked again at the command and database boundaries. Existing tenant/company scope, module permissions, quotas, automation ceilings and human decisions remain prerequisites.

## Exact source binding for owner review

Integration base: alpha `eb9411f24f74dc3ce02d1e3fa6a834c7e0ac2d6c`. Candidate implementation: `8c49ee14613ac493e98a67893116626e75d06f68`.

| Surface | Files | SHA-256 |
| --- | ---: | --- |
| Previously approved provider closure | 1,456 | `ddfdd95e41caa57e468007a7c97564ead57bfcf1d4a0c1b1f2aa3628edd81603` |
| Candidate provider closure | 1,458 | `ba8f8b5e200eba8fdfd61e189a7ccd0cf1c074fad2373bd794a8d050246d6dea` |
| Candidate module-agent surface | 472 | `25a460b13b1a727c43e7d554375f808d97e309d7c715123a143e69bcd698d55a` |

An independent import-closure walk over immutable baseline Git blobs reproduced the previous 1,456-file fingerprint. The candidate generator and independent hash agree. Two provider-closure files are added (`core/ai-centre-control.ts` and `lib/ai/centre-activity.ts`), 43 covered files change and none are removed. Changes add narrowing control checks, carry generation/function context, protect late effects and preserve accounting. Request data and session scope are copied before asynchronous control reads; server-issued permits keep their identity. Standalone module planning keeps the original stop generation through its proposal transaction. Module children are enforced at their canonical read owner, including governed plans outside chat. Both grouped topic tools and individual topics have controls. Each payroll cut-off reminder batch keeps the original generation and its SQL-generated event receives immutable generation metadata. Contract declarations, outgoing serializers, prompt shapes and literal provider approval records are unchanged. No new outgoing data field, provider purpose or contract is authorised by this candidate.

`lib/ai/provider-data-reviews.ts` requires actual human approval and immutable evidence before the literal records change. The existing 28 approved records still reference the previous fingerprint; the two pending contracts (`structured_canonical_records_v1`, `attendance_trend_analysis_v1`) remain pending. Consequently source-bound AI workloads remain unavailable on this candidate until the owner approves the exact new binding. Approval requested is renewal of the existing approved purposes for this exact provider fingerprint, preserving their scope and both pending contracts. It does not authorise production deployment. Updating literal records after approval also changes the generated module-agent fingerprint and requires regeneration and verification.

## Verification evidence

- Controller-only [run 42344390529](https://github.com/StradaverseHub/ai-hr/actions/runs/42344390529) refused an incorrect expected SHA before application tests. No pass evidence is claimed from it.
- Initial candidate `224181455b0cc500dbb7a11b144cbc1f84f48d08`: [focused run 42344402574](https://github.com/StradaverseHub/ai-hr/actions/runs/42344402574) passed 46 assertions and full typecheck.
- Expanded candidate `8578caaf7d7396c0a0bf290ce991a99b2881dd75`: [run 42345404604](https://github.com/StradaverseHub/ai-hr/actions/runs/42345404604) passed build and full typecheck. Selected tests retained 159 passing / 19 failing assertions. Failures exposed reminder-payload RLS compatibility, an audit UUID type and an existing isolation-error response contract. Repairs preserve original RLS and error semantics.
- Repaired candidate `e112156baf13db48a2f80f3778398d15891f6b58`: [27-file focused run 42346570051](https://github.com/StradaverseHub/ai-hr/actions/runs/42346570051), including production build and full typecheck; build and typecheck passed; selected checks retained 258 passing / 8 failing assertions. Six failures were isolated owner mocks missing the new control boundary; the expanded review also caught request capture timing that needed to be preserved. The other two failures were database collation versus JavaScript ordering and a probe fixture missing group scope.
- Same repaired candidate: [7-file payroll/scheduler/inventory run 42346662312](https://github.com/StradaverseHub/ai-hr/actions/runs/42346662312) passed all 118 assertions.

- Capture/standalone recovery `f9c3aba6015b0ee968124bee2f53201e488cba3c`: [30 affected-file recovery run 42347783852](https://github.com/StradaverseHub/ai-hr/actions/runs/42347783852), passed all 315 assertions, build and full typecheck. Four unaffected payroll-learning/inventory files retain their successful evidence at the preceding candidate; it is not relabelled onto this commit.

- Same candidate privacy custody/source gate: [run 42347897874](https://github.com/StradaverseHub/ai-hr/actions/runs/42347897874) passed; stale approvals remain blocked, and pending contracts are unchanged.
- Final boundary completion `8c49ee14613ac493e98a67893116626e75d06f68`: [10-file focused run 42348820102](https://github.com/StradaverseHub/ai-hr/actions/runs/42348820102), including cut-off reminders, canonical module reads, topic families, source/privacy gates: all 79 assertions passed. Build and full typecheck also passed. Prior successful evidence remains attached to its actual candidate. This packet is published in a documentation-only commit after the verified implementation; application, configuration, tests and migration bytes remain identical to that implementation.

These are development checks on standard GitHub-hosted runners using authorised fixtures and mocked provider transport. They do not establish an installed or accepted staging result, real-provider behaviour or a staffing target. Required release qualification and migration rehearsal remain separate. Migration 2700 / journal index 2000 is an unapplied reservation; recheck allocation, installed timestamp watermark and ordered ledger before release. No live environment has been changed.

## Low-headcount acceptance remains to be measured

These controls make selective automation and safe interruption possible. Staffing suitability still needs a pilot: measure active human minutes per case, exception arrival/backlog, overdue work, corrected/reversed actions and service quality across two payroll cycles. Retain an accountable operator and escalation cover. Decide the staffing target from observed workload and quality, without increasing sensitive-decision automation ceilings.

## Registered child keys

The runtime inventory and its database coverage test own completeness; this is a snapshot of the candidate migration.

- `module:approvals`
- `module:assistant`
- `module:attendance`
- `module:claims`
- `module:country-my`
- `module:employees`
- `module:ess`
- `module:knowledge_base`
- `module:leave`
- `module:lifecycle`
- `module:multi_cycle_payroll`
- `module:notifications`
- `module:org`
- `module:payroll`
- `module:performance`
- `module:rewards`
- `module:system_explorer`
- `module:system_testing`
- `module:toil`
- `module:typed_pay_components`
- `read:ai_quality_summary`
- `read:approval_queue`
- `read:available_actions`
- `read:company_setup`
- `read:correction_controls_guidance`
- `read:employee_profile`
- `read:explain_attendance_day`
- `read:explain_claim_limit`
- `read:explain_leave_entitlement`
- `read:explain_pay_difference`
- `read:explain_payslip_statutory`
- `read:explain_why`
- `read:import_attendance_clockings`
- `read:import_employee_records`
- `read:import_leave_balances`
- `read:import_payroll_history`
- `read:leave_entitlement_explain`
- `read:loops_overview`
- `read:my_claim_statuses`
- `read:my_leave_balances`
- `read:my_leave_requests`
- `read:my_module_work`
- `read:my_pay_change`
- `read:my_payroll_readiness`
- `read:my_payslip_summary`
- `read:my_policy_handbook`
- `read:my_reporting_line`
- `read:operation_career_plan`
- `read:operation_competency_insight`
- `read:operation_development_goals`
- `read:operation_domain_analysis`
- `read:operation_feedback_plan`
- `read:operation_manager_review_draft`
- `read:operation_pay_formula_draft`
- `read:operation_pay_rule_draft`
- `read:operation_payroll_comparison`
- `read:operation_performance_admin`
- `read:operation_performance_guide`
- `read:operation_performance_insight`
- `read:operation_performance_rewrite`
- `read:operation_report_spec_draft`
- `read:operation_workforce_analysis`
- `read:operations_status`
- `read:orchestrator_observe`
- `read:organisation_tagging_guidance`
- `read:password_policy_guidance`
- `read:pay_aggregates`
- `read:payroll_audit_status`
- `read:payroll_cycle_status`
- `read:payroll_learning_status`
- `read:payroll_loop_settings`
- `read:prepare_import`
- `read:product_capabilities`
- `read:product_destinations`
- `read:product_guidance`
- `read:provider_connection_test`
- `read:salary_payroll_checks`
- `read:setup_copilot`
- `read:setup_readiness`
- `read:suggest_action`
- `read:team_leave_summary`
- `read:upcoming_holidays`
- `read:who_is_away`
- `read:workforce_metrics`
