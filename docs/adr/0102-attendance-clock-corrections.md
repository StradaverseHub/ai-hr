# ADR-0102: Correct attendance punches without destroying their evidence

Date: 2026-10-12
Status: Accepted for the approved clock-data round (c15086a4, revision 2)

## Context

Previously a correction changed the attendance aggregate while leaving its punch children unchanged.
A raw-data editor must preserve what an employee or import sent while making effective punches agree
with the corrected day. Those figures affect pay, and the existing request/decision authority remains
applicable.

## Decision

`attendance_punch` owns the original clocking and its source. Removal adds actor, timestamp and reason;
restoration clears these current-state fields. Append-only domain events retain every transition.
Editing voids the original and inserts a separate `admin` punch. It never moves or rewrites a capture's
photo, location or import-log reference. Effective readers exclude removed punches. The dedicated raw
reader requires administrative authority over the subject and retains all originals.

The correction request carries a versioned proposed punch set and a fingerprint of the original raw
set. Approval checks the fingerprint again, applies the complete set and recalculates the day in one
transaction. A changed baseline requires a new review. Employee, manual and import writers share the
employment advisory lock with approval; imports take locks in stable employment order before deciding
lines. An approved correction continues to own the day, including remove-all. Further ordinary
clockings are refused; HR must submit another correction.

A proposed correction cannot contain duplicate time/direction pairs or restore a pair already in use.
The database unique index covers active punches without a capture ID. Separately accepted web captures
can legitimately share a wall-clock second, so the index must not reject those existing command
semantics or discard either original receipt. The correction boundary validates the full proposed set
under the subject lock, including captured originals. This narrows the approved plan's proposed global
index without weakening its duplicate-restore refusal.

Payroll batches are locked before changing attendance, using the payroll pack's period coverage.
Closed payroll refuses the change; processed payroll receives its existing reprocessing mark. Approval
still refuses self-decision. Actor attribution is text to represent a service actor where there is no
app-user identity; interactive sessions retain their internal app-user ID.

## Consequences

Removing every punch clears worked and overtime figures and marks the retained day absent, using the
existing absence rules. An out-only day remains an incomplete present day. Existing days are not rewritten or recalculated by the migration. Legacy pair corrections now also
reconcile their effective punches when a new correction is approved. Raw evidence remains readable,
while the live clock view displays only effective entries. Clock-data saves are separate from overtime
requests and from the later Shift/Day Type, manual overtime, allowance and whole-page Save rounds.
