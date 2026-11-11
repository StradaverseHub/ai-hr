# ADR-0118: Separate allowed shift membership from calculation defaults

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Status: Accepted — approved board items 25468aa3 and ba0dfca1, 2026-10-15.

## Context

A shift's `rule_id` formerly represented both its fallback calculation group and the group's allowed shift pool. Reusing one shift moved that pointer and silently detached the former group. Employment already has an explicit `attendance_rule_id`, and dated rotations already freeze their allowed pool. The calculation owner is therefore unambiguous without a one-group membership restriction.

## Decision

`attendance_rule_shift` owns undated allowed membership. An effective rotation version owns its frozen allowed IDs from that date. A group pool change affects only that group, and a rotation save never changes `shift.rule_id`. The calculation precedence remains employment group, the date's selected shift default, then Standard. Backfill the junction from existing shift defaults. Refuse unknown IDs, duplicate selections and newly selected archived shifts. Retain immutable rotations and their source shifts; resolve assignment eligibility against the target date. Lock the group while validating or changing its pool so concurrent changes cannot create an unchecked assignment.

Copying a group snapshots its current pool, retains the phase anchor of its applicable cycle from tomorrow, and copies upcoming versions. Past versions remain with the source. New copied cycles require active sources and the same group-wide authority as rotation writes. Assignment pickers resolve the pool again when their effective date changes.

A separate label is presentation only; legacy blanks fall back to the existing name. The name retains its identity and uniqueness behavior.

Enable Exception has exactly three decisions: Absent, Late In and Early Out and their attendance-based deductions. Immutable revisions take effect no earlier than tomorrow, stamped by the service. They do not rewrite recorded history. Raw clocks and stored statuses, measured late/early/short minutes, incomplete entries, working time, leave, overtime, statutory calculations and independent allowance measurements remain factual inputs. The calculation trace identifies the applied exception revision separately. The absence owner exposes an explicit raw measurement read for consumers that need factual missing attendance rather than exempted judgments. Processed/closed payroll continues through its existing protection and correction owners.

Duty Roster Control is Off for new groups. Migration explicitly backfills existing groups On to preserve their previous manual override capability. Every public manual roster primitive checks the applicable group, actor/company authority and exact-date payroll protection. No posted purpose bypasses the check. Automatic rotations remain derived schedules; individual rows never mutate the default rotation. Audit events retain per-employee dates and before/after values with actor and timestamp.

Full Flexi owns a required positive duration and may have no fixed clock anchors. Existing anchors can remain as historical configuration but do not define arrival/departure judgments. Completed recorded intervals, after applicable breaks once, own working time. An open or malformed session is incomplete; elapsed time never completes it automatically. The business cutoff anchors imported and corrected intervals without fabricating working clock windows. Nonworking Full Flexi days still measure closed intervals while carrying no normal-hours shortfall target. Fixed and Semi-Flexi behavior retain their existing paths.

## Consequences

Membership and default calculation are distinct concepts with distinct consumers. New readers must use the membership owner instead of reverse-reading `shift.rule_id`. Future rotation changes preserve old pools, and archived historical sources remain available without becoming new picker choices. Database/schema, attendance and pay-facing verification require full release verification and a migration rehearsal. New exception scopes or historical recomputation require a further explicit decision; this flag is not a general formula bypass.

## Amendment, 12 November 2026 (board item 2f803985): one Working Day / Schedule Pattern section

The General tab's read-only working-day summary, Shift Allowed and the separate Duty Roster block are one
section in three steps: Shift Allowed, Schedule Rotates Based On, and a Day Type and Shift per day. The three
methods are presentation over the existing dated rotation version: Working Week = week × 1, Weekly Pattern =
week × N, Daily Pattern = day × N. No method is stored beside `unit`/`length`, no schema changes, and the
calculation precedence (explicit roster row, rotation version, shift arrangement plus legacy week) is unchanged.
A group with no version shows its legacy week as a Working Week and writes nothing until a future-dated version
is saved (no backfill). The Standard group cannot rotate, so it offers Working Week only and keeps saving its
day types through the legacy week writer.

The Duty Roster Control switch is no longer drawn. Its stored semantics and every manual-writer guard remain.
`saveScheduleRotation` turns the control on in the same transaction when it saves a version for a group whose
control is Off, with an `attendance-rule.duty-roster-control.changed` event (reason `schedule-pattern-saved`).
It never turns the control off. A group with a saved pattern is therefore roster-controlled; a new group with no
pattern still refuses individual roster changes until one is saved.
