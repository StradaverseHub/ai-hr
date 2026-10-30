# Attendance parity: native handoffs and owner inventory

Candidate starts at held 3a2a015683c0a1ad8ec6f341186f7fa12a5fcdad; fetched main/alpha are 2ab4f6c120a28692857e93adeed072d463713ab6. Development only; release hold remains.

## Implemented slice

Assistant Attendance now presents explicit native handoffs in both correction and overtime modes. Clock capture is always a native workflow; native eligibility resolves linked employment and evidence. Administrative navigation is visible only for an authenticated USER with native isAdmin role labels; this is discoverability, never command authority. No PERSON link is invented or required for navigation. Native destinations independently recheck current identity, company scope, permissions and business state. No selected employee, dates, evidence, confirmations or completion receipts are constructed by these links.

Six locale copy explains that opening a link changes no record and that the operator must review/save on the native form. Calendar navigation opens the employee list and explicitly instructs selection then Attendance tab; it does not use the legacy column setter. Focus styling and minimum 44px link targets follow existing controls.

## Source inventory (not an exhaustive runtime acceptance claim)

| Surface/effect | Existing native owner | Assistant status at baseline / next boundary |
| --- | --- | --- |
| Own correction request | packs/attendance/service requestAttendanceCorrection | Existing reviewed own action; keep distinct from administration |
| Own OT request | packs/attendance/service requestAttendanceCorrectionTx | Existing reviewed own action; no automatic approval |
| Assigned correction decision | packs/attendance/service decideAttendanceCorrection | Existing assigned review; not blanket HR power |
| Real clock capture | app/attendance/clock/actions.ts and native clock controls | Native evidence handoff only |
| Individual schedule/day-kind or OT rows | app/attendance/individual/[date]/actions.ts saveAttendanceDayChangesAction → packs/attendance/service saveAttendanceDayEdit | Native handoff; reviewed administrative command still missing |
| Existing application amendment | same surface adminCorrectAttendanceDayAction → amendExistingAttendanceApplication | Distinct staged baseline/expected-stage/payroll-confirmation operation; native handoff |
| Dated shift add/change/remove | app/admin/attendance/schedule-assignment/actions.ts → core/shift-arrangement assignEmployeeShiftDated/removeShiftArrangement | Native handoff; preserve effective-date and newest-period refusals |
| Current schedule group / bulk assignment | same surface → core/roster setEmploymentScheduleGroup / setEmploymentScheduleGroupBulk | Native handoff. Current group differs from dated shift; unchanged is no-op, changed group validates existing shift compatibility, emits employment.schedule-group.changed |
| Roster cells/rows/bulk/copy/generate | app/roster/actions.ts → core/roster owners | Native handoff; multi-row/date and TOIL policy require individual effect inventory |
| TOIL accrual | app/roster/actions.ts accrueToilAction → core/toil accrueToil | Native handoff; preserve per-election first-schedule consent |
| Holiday-calendar dated assignment/replacement | Personnel employee Attendance tab → holiday-calendar-actions.ts saveHolidayCalendarAssignmentAction → core/holiday-calendar-assignment saveEmploymentHolidayCalendarAssignment | Native handoff. Replacement reconciliation, closed payroll/credit refusals, attendance recomputation and processed payroll stale marking belong to this exact owner |
| Legacy holiday setter | Personnel actions.ts setEmploymentHolidayCalendarAction | Redirect only to dated native owner; never restore column write |

Personnel's Attendance-tab save also invokes schedule-group section handling; do not infer authority from the card title. Native schedule-assignment uses requireAdmin; roster uses its own assertRosterAdmin/date controls; individual edits use scopedAdmin + visible employee selection. Future commands need fresh DB authority matching their own native owner and SYSTEM/unlinked USER/self cases, not this navigation predicate.

## Verification and shared changes

Shared changes: additive Assistant Attendance page composition and one new six-locale namespace. No registry/contract/custody/migration changes and no native owner changes. Test source covers six locale rendered handoffs, role exclusions, unlinked admin navigation, missing USER, session failure and revoked role rendering. Hosted focused checks plus whole typecheck are required; no local tests/build/compiler/database were run. A DOM fixture is not an authenticated browser journey or installed acceptance.

## Next command dependency

Smallest prospective reviewed mutation: one employment current schedule-group change/clear, using setEmploymentScheduleGroupTx in the same transaction. Requires current native permission investigation, explicit no-op receipt semantics, group/shift dependency digest and locking, exact row/event proof, encrypted generic assigned custody and role cases. Request one coordinator-allocated migration for unique action-kind registration and narrowly scoped subject/proof custody capability (private prefix assistant_attendance_schedule_group_*); final SQL requirements must be checked against native authority before implementation. No numeric migration position claimed. This command is NOT implemented by the handoff slice.


## Current mutation slice (supersedes next-command pending description above)

Implemented source: `attendance.schedule_group.maintain`, route `/assistant/schedule-group`, for another person's employment only. This is an explicit Assistant narrowing: native0017 and mounted HR surfaces permit administered own-employment changes. Generic assigned same-PERSON refusal stays unchanged, including a second employment of the same person. No native policy gap is repaired or widened.

Current real USER + current principal snapshot + mounted isAdmin admission + legacy administered company write authority are required before private preview. No positive non-HR Workforce capability is treated as HR. Unlinked USERs remain eligible when native authority holds; SYSTEM and null USER are refused. Existing native Workforce-deny differences remain an integration finding, not a policy change.

The owner `setEmploymentScheduleGroupTx` gains only opt-in `{returnEventId:true}`. Existing default changed:true object shape is unchanged; changed:false still performs no update/event. Assistant rejects unchanged proposals before custody. Confirmation calls this exact writer in its current top transaction, preserving current-shift reverse-check and rollback. The review digest binds employment revision, access generation, current date, group records, pool/rotation rows, today's roster, dated arrangements and effective/cache shifts. A native incompatibility may still refuse confirmation; prepare does not simulate compatibility or promise acceptance.

Exact event UUID and top-level row/event xmin are required by the closed SQL proof and shared custody verifier; no lookalike audit lookup or fabricated no-op event. Receipt recovery rechecks current scope and reads the historical native event; later group changes do not rewrite the completed receipt. Shared encrypted body lifecycle, stale/revoked/foreign actor refusal, pause switches and human confirmation remain in their existing owners.

Shared edits are additive registry/browser packet/result/owner/completed-outcome entries, source manifest, a new disjoint 11-role Attendance probe partition and guard, six-locale namespace, page navigation, and two Attendance facade exports. Provisional migration0729 / idx709 / when1793330000066 is the only allocated entry; predecessor SQL and journal identities are preserved. No sibling placeholders. Requires installation reconciliation; source is not installed/accepted.

Authored focused coverage: strict contracts and forged fields; six-locale review/recovery and expiry; disjoint role offer/prepare/confirm/cross-user cases; native own-admin contrast; native default/no-op shape; real unlinked USER and SYSTEM; NULL clear/inactive group; exact same-topTx proof and outer rollback; incompatible-shift reverse-check; stale group/employment/policy; concurrent replay. Hosted results must be recorded before any pass claim.


## Preserved failed rehearsals and authorized provisional-prefix composition

Original b5 runs41020827581/41020831019 retained a real PostgreSQL OOM at0729's copied predicate. Recovery4c runs41022192069/41022195538 retained a second real OOM even with the0729 predecessor once; this was not fixed by the first bounded source patch. Both4c whole compilers passed; UI/shared45passed with one inherited archive category failure, and all new panel/guard tests passed. Native/role cases never executed; do not claim them passed.

After every planned4c job finished, coordinator explicitly authorized isolated shared commits9bd8a6d10cbd31a765a8dcb035db65ea6286b63f (one-line UNAPPLIED0724 pay seed),22a725050b6cb0eaa42a41c2928ce017ddff0e04 (guard comment/count), and f82a06b6f806cd424b0531799350c8337bc189a9 (ONLY seven-line UNAPPLIED0726 generic branch plus six-line bounded note). Adopted as46a9789ce/eebadff43/d13b58fe6. Conflict resolution reapplied ONLY authorized diffs to held source; no parent cost feature, alias or native authority changes imported. Previously adopted d7 compiler source remains92354ae03. These are explicit provisional-source exceptions; accepted historical SQL is unchanged.

The0726 bounded branch removes one inherited expression doubling before0729. It is source-reviewed and remains runtime-unproven until composed hosted migration succeeds. If it still OOMs, preserve exact diagnostics and return to coordinator review; no guessed compaction or runner/memory-cap increase. Static coverage checks both bounded branches. Preserve unaffected4c rendered UI evidence on4c, rerun only registry/static/native/custody areas affected or previously unexecuted, plus required whole compiler.
