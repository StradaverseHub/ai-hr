# ADR-0068: Partial Leave Approval — single-request model

Status: Accepted
Supersedes: ADR-0131 (child-row split), migration 0131
Feedback: "Partial Leave Approval — single-request model (rebuild)" · references commit d827aa6

## Context

ADR-0131 shipped "partial leave approval" (approve some days of a multi-day request, reject others) by
**splitting** a multi-day WORKING-DAYS full-day request into one per-date **child leave_request row** at
submission — each child sharing a synthetic `parent_group_id`, reusing the Emergency-Leave decomposition.
Each child was an independent `pending` request decided via the existing `decideLeave` path.

The reporter **rejected** this: a 3-day request then appeared as **3 separate rows / 3 approval tasks** in the
approvals inbox. The requirement is the opposite — **one request stays one inbox row**, and per-date
approve/reject happens in the request **detail** view.

### Why the split was load-bearing (the crux)

Every leave "span consumer" reads a whole `leave_request` row filtered `status='approved'` and expands
`[start,end]` (or sums `days`) with **zero per-date awareness**:

- `core/attendance.ts` daily present/absent (`status='approved' AND start<=d AND end>=d`)
- `core/attendance.ts` monthly summary (`onLeave = leaves.some(l => l.start<=d && d<=l.end)`)
- `core/read.ts` `plannedAbsences` (renders the span)
- `core/roster.ts` `onLeave` (suppresses no-show)
- `core/payroll.ts` `unpaidDaysByEmployment` (`sum(leave_request.days)`)

The 0131 split was correct *because* each approved date was its own single-date `approved` row and a rejected
date had no approved row, so it dropped out of every consumer for free. **Collapsing to one spanning
`approved` row with interior rejected dates would silently regress all five consumers** — a rejected mid-span
date would still count as leave in attendance, the calendar, the roster, and unpaid-leave pay. This was the
first draft's biggest defect. **Non-contiguous approvals** (approve day1+day3, reject day2) cannot be expressed
by any single `start/end` envelope, so "narrow the aggregate's envelope" is not a viable general fix — per-date
sub-rows are load-bearing for the reads.

## Decision

### Sub-structure shape: a relational `leave_request_date` child table

Considered and rejected:
- **JSONB `per_date_decisions` column** — the per-date rows are queried **cross-request in aggregate** by the
  span consumers (§ rewire below joins them against a date window). JSONB cannot be indexed/joined for those
  date-range reads without expansion; a relational child table is required precisely because the rewire exists.
- **Overloading `leave_approval_step`** — steps are per-*approver-level*, not per-*date*; a request can have
  BOTH a chain and dates. Overloading conflates two orthogonal axes.

Chosen: **`leave_request_date`** (migration 0138), mirroring the `leave_request_attachment` child-table + RLS
pattern, with per-date `status`/`reject_reason`/`decided_by`/`decided_at`. `subject_employment_id` is
denormalized from the parent so RLS copies the `leave_approval_step` policy verbatim
(`can_see_employment OR can_decide_via_delegation`) — a tenant-only policy would let a manager see rows they
cannot decide, or hide rows they can (the "stricter RLS silently hides the breakdown" risk). Indexed on
`(subject_employment_id, leave_date)` for the span-consumer read path.

### Span consumers rewired to per-date reads (the central fix)

New shared helper `approvedLeaveDates(tx, empIds, from, to)` returns, per employment, the set of
**effectively-approved dates** in the window: a request WITHOUT per-date rows expands `[start,end]` where the
request is `approved` (unchanged, cheap); a request WITH per-date rows contributes the individual `leave_date`s
whose row is `approved`. All five consumers now read this set instead of expanding the raw span:
- attendance daily + monthly, roster `onLeave` (full-day; roster keeps its separate whole-span path for
  half/hourly leave, which has no per-date decomposition), `plannedAbsences` (an approved per-date request is
  rendered as its contiguous approved runs, not the raw span), and `unpaidDaysByEmployment` (sums the approved
  `leave_request_date.days` per request, else `leave_request.days`; keeps the "deduct in the month it starts"
  rule).

### Opt-in gate (single place)

Per-date rows are created only when: `durationType==='full_day'` && `counting==='working_days'` &&
`perDateApproval` && `code!=='REPLACEMENT'` && `start!==end` && `>1 working date` && the company is
**single-step** (`company.leaveMultiApproval===false`). REPLACEMENT is excluded to preserve the TOIL
consume-on-approve register invariant. Multi-step companies are excluded (per-date × the manager→HR chain is
deferred); such a request falls back to today's whole-request `decideLeave` chain with NO per-date rows, so
deployed multi-step data is never stranded. "Route by whether `leave_request_date` rows exist" is therefore
safe because rows are only ever created for single-step companies.

### Decision + finalization

`decideLeaveDate` updates one `leave_request_date` row (single-step `assertCanDecide`; reject requires a reason
→ `MissingRejectReasonError`) and appends `leave-request.date.decided` on the leave-request aggregate. No ledger
effect per date. When no `pending` dates remain:
- **all approved** → balance gate + single ledger debit for the full span, `status='approved'`;
- **all rejected** → `finalizeLeaveRejection` with the collected reasons, `status='rejected'`;
- **mixed** → balance gate + single ledger debit for `sum(approved days)`, `status='approved'`.

`finalizeLeaveApproval` takes an optional `daysOverride` (defaulting to `req.days`) so the debit reflects only
approved days; a guard asserts the override path never reaches the REPLACEMENT branch, so the TOIL register is
never under-consumed.

### Mixed-outcome status (no new enum this round)

The feedback requires "balance/calendar reflect only approved dates" — delivered by the span rewire regardless
of the top-level flag — and does NOT request a distinct "partially_approved" status. Mixed outcomes use
`approved` + per-date truth. A distinct mixed-status label is flagged as an optional follow-up.

### Deferred-gate / no-incremental-hold semantics

Because the debit is deferred to finalization, two concurrent multi-day per-date requests could each pass their
own finalization gate while together exceeding balance. Per-date approval does NOT place an incremental hold;
the terminal balance gate inside the finalizing transaction is the authority — identical to today's
whole-request model, which also only gates at approval. Characterized by test #7b (last-writer-loses at the
gate).

### Already-split data: check-first (no destructive backfill shipped)

The 0131 split only creates child rows at run time; `per_date_approval` defaults false and no production seed
sets it true, so the deployed instance has (verified) **zero** split groups. Migration 0138 therefore ships
**only the additive DDL** — no guarded collapse for data that does not exist. If a future instance is found to
hold real split groups (identified by provenance: `parent_group_id` set, single-date span, `full_day`, grouped
≥2, and NOT an Emergency-Leave group nor a cancellation group — both of which retain their original
`leave_type_id` and carry their own events), a follow-up migration performs the single-transaction guarded
collapse (survivor = earliest child; re-point `leave_ledger.source_request_id` and any register/FK referrers;
append one `leave-request.migrated` event rather than deleting historical child events). Per the plan, the
fixture-mimic backfill test is omitted because a scratch `ai_hr_test` rebuild has no d827aa6 runtime rows to
prove anything about a real collapse.

## Consequences

- One inbox row per multi-day leave request; per-date approve/reject in the detail expander.
- Balance, planned-absences/calendar, attendance (daily + monthly), roster `onLeave`, and unpaid-leave payroll
  all reflect ONLY the approved dates; a rejected mid-span date is not counted as leave anywhere.
- Non-contiguous approvals work.
- Fully-approved / fully-rejected requests behave as before; single-day, half-day/hourly, emergency leave, and
  every multi-step-chain request are unaffected.
- Per-date-approval requests are now single `parent_group_id=NULL` rows and thus cancellable; the cancellation
  service excludes interior-rejected dates from the cancel-eligible set (mirrors the effectively-approved-dates
  rule).

## Out of scope (flagged, not built)

- Per-date approval × multi-step chain (gated off; falls back to the whole-request chain in multi-step companies).
- Per-date approval for half/hourly/calendar-counted types.
- A distinct "partially approved" status enum value.
- Partial Leave Cancellation (ADR-0065) internals and Emergency-Leave `parent_group_id` are untouched.
