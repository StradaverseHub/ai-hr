# Attendance: human-reviewed dated schedule correction

`attendance.day_schedule.correct` covers one other PERSON's employment and date, schedule mode only. The human supplies the date, native baseline, explicit nullable shift/day kind, reason (1–500 trimmed characters), and processed-payroll consent. The same `saveAttendanceDayEdit` owner validates and writes the correction, recalculates day figures, refreshes overtime and marks affected processed payroll stale. It does not substitute a calendar column or create captured clocks, payroll payments or TOIL credits.

## Native owner and authority

The actual native schedule form mounts `saveAttendanceDayScheduleAction`, an adapter that snapshots FormData, rejects other modes and delegates the original `saveAttendanceDayChangesAction`. The original scopedAdmin/listEmployees admission, business owner, error handling and revalidation remain in that path. The overtime form keeps the original composite. The inventory registers only the genuinely mounted schedule-only entrypoint; the composite remains backlog for overtime. No shared inventory classification was redesigned.

The Assistant repeats real USER/current principal, current native HR/legacy company authority, same-PERSON refusal, current Assistant/Attendance entitlement, allowance, tier and pause checks. A genuine unlinked USER works; SYSTEM cannot use the Assistant. Native default behavior remains unchanged. Financial evidence visibility may be narrower than native write visibility: missing, inaccessible or oversized evidence hands off instead of widening salary/earning access.

Native baseline, reason, shift eligibility and nullable reset semantics remain with the owner. Leave controls its day kind; dependent attendance credit and closed payroll refuse pending writes. Processed payroll requires human consent. Recorded completed receipts skip new-write closed-payroll checks and recover the original native event/financial revision.

## Preview, effects and privacy

Native access/leave/subject/day/source/payroll locks precede the SAVEPOINT. Preview calls the actual writer and rolls back every adjustment, calculated day, pattern, payroll and audit row. New earning-label locks are reacquired after rollback and displayed labels compared. Private digests bind current native inputs and the proposed header input/approval/reference/duration digests; ephemeral preview IDs and timestamps are excluded.

Default and ordinary event-return modes retain native audit order/payload and version-only default results. Explicit schedule reviewEffects mode marks native payroll first, captures its completed effects, then appends the same `attendance.day.corrected` event with a safe witness. Current proof checks that exact USER/event/adjustment/date, actual day figures and clock preservation, current pattern row identities/transaction, native related audits, and every processed run's own-subject stale mark are in the top transaction. Old or SAVEPOINT-only effects do not count.

Subject-readable witnesses contain safe day/own-run summaries and opaque non-financial tuple references. Financial-row hashes cover identity metadata only; `readOvertimePatternCalculationTx` independently validates the immutable financial contents in the same transaction. Full unrelated-payroll retention fingerprints stay transient in native memory and the private source commitment, never in audit payloads. No new crypto engine, secret store, ledger or financial read grant is added. Amounts, payable quantities and earning lines come solely from native owners; the UI uses existing display helpers. Earning names/codes are current authorized decorations; monetary/policy/version evidence is historical.

## Custody and provisional SQL

The action reuses `createReviewCustody`, its encryption/nonce/lifecycle engine, and the existing ledger. Typed date participates in AAD/commitments and a dedicated nomination column required only for this kind. Pending uniqueness is per caller/employment/date. Closed command operations are prepare, subject, read, discard, index and complete. Minimal nomination precedes native business locks and the custody NOWAIT lock. Public Prepared.parse and its48000-byte budget run inside custodyTx, so refusal also removes the inserted ciphertext. Shared five-pending/rate/expiry limits, audited erasure and private body/digest clearing remain in force. Index metadata is own, currently admitted and within30 days.

Migration0738 / idx717 / version7 / when1793330000075 / breakpoints:true is UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. It must be reconciled above the actual accepted ledger at integration freeze. Actor candidates are selected by column dependencies and exact prior markers before altering only the necessary actor/legacy-column/decision/receipt rules. Canonical eight-null new branches carry the complete prior predicate once; existing dedicated null rules and the0704 membership FK survive. No accepted SQL bytes are edited.

## Human UI and verification

The six-locale page shows employee/date, explicit schedule defaults/overrides, native before/after figures, legacy OT rows, pattern money or refusal, and processed run period/sequence/date/stale flags. Changing employee/date drops the loaded baseline. Expiry and separate confirmation are explicit. Lost commands reopen the same saved ID. Completed cards label effects at confirmation, rather than claiming later current state.

Native foundation d138e2a25e29c45c737a763114c45b9b627903f9: Actions41035307914 SUCCESS,35 selected cases plus whole compiler. This includes actual MYR2500 minor units/earning lines, same-parent preview→write, clock preservation, processed payroll and real native adapter routing. Earlier valid default native26 cases remain on their actual b306 source; they are not relabelled.

Full-slice authored coverage includes native owner/effects and14 custody cases (date AAD, replay, stale/revoked/foreign/self/SYSTEM refusal, expiry, erasure, hybrid/old-kind controls, old/wrong-date SQL proof, real encrypted native cash flow and oversized valid native output rollback), Attendance22 full-name role cases preserving every earlier partition/variant, strict packets/output budget/migration guards, six-locale UI/recovery/screenshots and affected native/transport regressions. Full action hosted results are pending. Screenshot fixtures use real components with scripted same-origin responses and fictional native-shaped values; they are not authenticated server journeys. No installed, accepted, full-phase or release claim is made.
