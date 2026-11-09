# Read-only 36-migration / staging compatibility map

Compared architecture0c7a66144f688d51fb193fe75c09d97df64f8a3c against staging29d9edcbc4368be871688e9fdf35347676a7841c, commonb7c0393aa3c7606a33dd15103426e5c535324065. Static SQL/native catalogue contract analysis only; no app/DB execution, deployment, migration acceptance or production absence proof. Root owns prefix/journal/allocation.

| Original draft SQL | Native/object interaction after immutable3100/3101/3110 prefix |
| --- | --- |
| 2103_system_performance_read_guards.sql | Home role/visible-ID replacement; frozen-actor indexes and task precheck. 3101 keeps the indexed actor JSON shapes; does not replace these owners. |
| 2104_contract_navigation_role_guards.sql | Contract-role necessary-only prechecks. Staging changes no contract objects or role/grant catalogues. |
| 2105_authorization_navigation_plans.sql | visible_employment_ids + login_blocked_on; original current-identity semantics. Shared-workflow reads call these transitively; their definitions are not changed by staging. |
| 2124_ai_control_navigation_candidates.sql | AI-control discovery function. Superseded internally by2131/2138 in original dependency order; no staging AI-control changes. |
| 2125_approval_subject_batch.sql | Introduces bounded delegated approval projection;2141 guards this exact predecessor. No staging replacement of either owner. |
| 2129_personnel_native_paging.sql | Workforce list rows/facts and navigation owners;2139 guards internal row projection. Shared-company table does not change Employment/Assignment schema. |
| 2131_ai_read_only_metadata_locks.sql | AI-control and generic review read-only locks. No staging targets. |
| 2132_ai_metadata_claim_preview_index.sql | Assigned/reward metadata helper factoring and Claim preview index. No staging targets. |
| 2133_ai_action_read_only_lock.sql | AI action read-only shared barrier; no staging targets. |
| 2134_claim_visibility_set_membership.sql | Exact Claim policy USING guard before membership rewrite. Staging changes only Attendance workflow template policies, not Claim policy. |
| 2135_profile_presentation_read_lock.sql | New profile presentation lock API; staging introduces no access/profile lock owner. |
| 2136_grant_admin_role_precheck.sql | Exact grants_admin_for predecessor guard; staging merely calls its administration authority. |
| 2137_home_peer_cohort_batch.sql | Exact _home_peer_cohort fingerprint guard/replacement; no staging replacement. |
| 2138_ai_pause_company_discovery.sql | Exact AI-control/action predecessors and owner-preserving dynamic ALTER of new purpose helper; no staging target. |
| 2139_workforce_bounded_read_plan.sql | Exact internal workforce row reader body/ABI/ACL guard; staging does not alter that function. |
| 2141_approval_nonadmin_visibility_batch.sql | Guards delegated_approval_subjects and visible_employment_ids/can_see_employment/delegated scalar dependency fingerprints; staging does not replace them. Preserve2105 before2141. |
| 2212_payroll_audit_claim_lookup_indexes.sql | Two Claim lookup indexes; no shared table/index names with staging. |
| 2252_probation_navigation_capability_probe.sql | Exact Probation navigation/config-admin guard; no staging replacement. |
| 2301_attendance_workflow_submission_shared_lock.sql | INCOMPATIBLE: exact old trigger body MD5 4d4757fe139a597cc028772f0effade9 differs from3101 b383b0524878d7b82c58ec374146f75a. Running old guard after staging refuses; running it before staging has shared lock overwritten. Supersede this unapplied reservation with3210. |
| 2302_company_ancestry_early_exit.sql | Guards/replaces company ancestry owner; shared approver eligibility calls this transitively, unchanged dated semantics. No staging replacement. |
| 2303_admin_grant_direct_scan.sql | Guards/replaces is_admin_for;3101 assignment/eligibility and3110 RLS-on paths depend on it. No changed signature/ACL or staging owner definition. |
| 2304_payroll_grant_direct_scan.sql | Guards/replaces payroll administrator predicate;3100 uses saved formula source, not this definition. |
| 2403_personnel_bounded_overview.sql | Requires canonical Personnel projection owner and exact immediate Assignment exclusion constraint. Staging adds only workflow-company constraints, not Assignment. |
| 2503_attendance_pending_visible_headers.sql | Exact Attendance CORRECTION read-policy catalogue comparison incl v2/v3/delegate function identities, then pending header reader. 3101 changes workflow TEMPLATE policies and v3 participant/resolver bodies, not the guarded correction policy expressions. |
| 2504_notification_event_processing.sql | New notification processing table/policies/enqueue trigger/index; staging new workflow-company triggers use separate relations and names. |
| 2505_workforce_picker_facts.sql | New workforce picker facts owner; staging selected approver path remains independent. |
| 2506_notification_receipt_retention.sql | ALTER notification-processing retention fields; requires2504; no staging target. |
| 2507_attendance_header_column_grants.sql | Exact2503 header-reader fingerprint before column-grant-aware replacement. Staging does not redefine this reader or correction grants. |
| 2508_notification_receipt_grants.sql | Notification processing grants; requires2504; staging no grant interaction. |
| 2509_principal_statement_plan_reuse.sql | Exact principal/principal_snapshot SQL predecessors to PL/pgSQL plan reuse. 3101 shared eligibility/admin calls these transitively but does not replace them;3110 only changes five shared-workflow helper proconfig values. |
| 2510_capability_statement_plan_reuse.sql | Exact access_allowed_for_tenant SQL predecessor; native statement-cache change only. No staging override. |
| 2701_personnel_typed_overview_filter_fields.sql | Exact2403 narrow projection body/owner/ACL and Assignment constraint guards. No staging override. |
| 2903_notification_receipt_cycle_authority.sql | Notification projection receipt-cycle authority replacement; requires prior notification tables/functions; staging no target. |
| 3001_employment_membership_initplan.sql | Exact Employment USING/WITHCHECK/role policy and visible-ID fingerprint before two positive-term substitutions. Staging changes no Employment policy. |
| 3102_assignment_membership_initplan.sql | Exact Assignment USING/WITHCHECK/role policy and visible-ID fingerprint before one positive-term substitution. Staging changes no Assignment policy. |
| 3103_access_editor_presentation.sql | Exact access_install_defaults complete body/ABI/postgres owner/effective owner-only ACL before factoring; staging changes no bootstrap owner/catalogue. Keep existing strict guard; do not generalize it as part of3210. |

## Explicit guarded bridge proposal

Replace only the still-unapplied2301 reservation at its original relative position with reserved3210_attendance_shared_workflow_submission_lock.sql (root allocation idx2528/when1793330002828); preserve original2301 file/branch/history and all other35 SQL bytes. Do not run old2301 then append a later fix: its obsolete native predecessor guard would already fail.

Guard the complete literal3101 attendance_workflow_links body (source MD5 b383b0524878d7b82c58ec374146f75a, SHA256 664713382cf276a27526612d2a34d3ad78e445ca45d525e52c8a107eb22b0a79), exact trigger-return ABI/language/SECURITY DEFINER/volatility/parallel/strict/leakproof/default/cost/config fields, native relation/function owner identity, effective ACL and expected original trigger binding. Require actual3101 shared-company owner objects with3110 row_security=on for all five corrected helpers, without weakening their native policy authority. Unknown body/attributes/owner/ACL refuse55000 atomically before any write.

Obtain pg_get_functiondef only AFTER those guards; replace exactly the single PERFORM pg_advisory_xact_lock( call with pg_advisory_xact_lock_shared(. Require one occurrence and compare expected complete post body. Execute with same owner, retaining function OID/signature/ACL/all other attributes. Postquery must independently assert exact complete union body (source MD5 46e046f4a175a420c44748f3419094a3, SHA256 124fea7f798b14985067910890714c7fa4ff2c319abb55b0c9689aca818ba795), same owner/ACL/metadata and every shared-company/dynamic-resolution/current-template/decision-link predicate. These source hashes are expectations requiring real native proof, not observed installation facts.

## Required native proof

- Actual installed3101+3110 predecessor and exact post body/metadata/ACL, with non-superuser ai_hr_owner and separate nonowner LOGIN/native RLS identity; no fake renamed postgres positive or permissive test policies.
- Wrong old2301 predecessor, changed body, wrong language/volatility/config/cost/owner/ACL and missing/mutated shared-company dependency refuse before changing any function/catalogue. Transaction rollback leaves every catalogue fact equal to before.
- Native canonical request insert succeeds while another transaction retains shared company/type submission lock; two real overlapping submissions both finish without lock upgrade. Configuration/retirement writer still waits for those readers and resumes afterward.
- Foreign tenant, partial-company administrator, modified immutable assignment, wrong subject/template version/route, stale/retired template and ineligible approver still refuse through native triggers/RLS.
- Combined source retains existing architecture attendance-workflow-v4-owner shared-submit/config-writer tests plus staging shared-company tests, actual populated706/707-prefix upgrade and empty shadow migration. Full ordered ledger+hash proof must establish35 byte-identical copies plus the explicit3210 supersession; no skipped underwatermark receipts or broad guard waiver.

No further static3100/3101/3110 collision was found in35 other drafts. This is not a claim their native guards already passed the new prefix; the combined populated/empty rehearsals remain mandatory.
