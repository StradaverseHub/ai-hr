# ADR-0085 — Signed statutory deltas: letting a month correct itself before it is filed

- **Status:** Proposed (design + build order; nothing below is built)
- **Date:** 2026-09-22
- **Builds on:** [ADR-0024](0024-multi-cycle-payroll.md) (multi-cycle payroll — this lifts its §6
  exclusion), [ADR-0045](0045-scheduled-build-release-agent.md) (the human release gate this does not
  weaken),
  [ADR-0006](0006-event-and-audit-substrate.md) (every correction is an event).
- **Raised by:** item `23e7dac3` (process any payroll cycle in any order) — but it is **not** that item's
  feature. It is the precondition that item cannot be built without, and it fixes a figure that is
  already wrong today.
- **Deliberately not:** a licence to emit a negative line on a filed statutory return, and not a
  retrospective amendment engine. Both are named in §6 as out of scope.

---

## 1. Why this document exists

`localization/my/multicycle.ts` says, in its own header, that closing the gap below "needs the reversals
ADR, not a code change here". `test/epf-combined-month-bdf7d248.test.ts` says the case is pinned "so a
future reversals ADR (§6) has a concrete case to work from". **This is that document**, and the case is
already written down.

### 1.1 The figure that is wrong today

The EPF Third Schedule steps the EMPLOYER column DOWN from 13% to 12% at RM5,000. So a month can get
*bigger* and its employer contribution *smaller*:

| month | employer contribution |
|---|---|
| RM5,000 paid once | **RM650** (13% row) |
| RM5,050 paid once | **RM612** (12% row) |
| RM5,000 then RM50 in two runs | **RM650 + RM0 = RM650** |

`deltaStat` (core/payroll.ts) and `clampDelta` (localization/my/multicycle.ts) both floor every
contribution at `Math.max(0, …)`, so the second run cannot give the RM38 back. **The month ends RM38
over the table figure.** Nobody is short-paid — the excess lands in the employee's EPF account and is an
employer cost — but bdf7d248's plan promised the reporter, in plain words, that "an employee paid twice
in one month contributes exactly what they would have contributed had it all been paid once", and this
is the one case where that promise does not hold.

It is bounded (the size of the step, RM38 at this row) and reachable only when an additional payment
carries a month from at-or-below a step to above it. It is small. It is also **a statutory figure that
disagrees with the published table**, and the reason is a clamp rather than a rule.

### 1.2 The feature that is blocked by the same clamp

Item `23e7dac3` asks to process BONUS, Advance or Off-Cycle payroll **before** the Monthly run. The
statutory engine's contract is `v1 requires runs[0] to be the regular run (it supplies Y1); later runs
are additional remuneration` — LHDN MTD methodology, not an ai-hr invention. Relax the order and the
first run is taxed as though its payment were the employee's normal monthly pay; when the real salary
lands, the month must be **restated downwards**, which the clamp forbids. So the clamp is not merely
blocking a correction: it is what makes order-independence unbuildable.

**One clamp, two problems.** That is why this is an ADR and not a bug fix.

---

## 2. Why the clamp exists, stated fairly

It is not an oversight. A negative contribution is a real question nobody had answered:

- What does a **negative EPF line on a payslip** mean to the employee reading it?
- If EPF has already been **paid over** to the board for that month, what is being reversed, and by whom?
- Does a negative employee-side deduction **increase net pay** in a run the employee already banked?

ADR-0024 §6 excluded reversals precisely because shipping an unanswered question into a money document
is worse than a bounded, stated, tested over-contribution. That judgement was right. This ADR does not
overturn it — it answers the question.

---

## 3. The decision

**A statutory delta may be negative while the month is still being assembled, and may not be once the
month has been filed.** The clamp is replaced by that distinction rather than removed.

### 3.0 THREE CORRECTIONS TO THIS DOCUMENT, found while building step 2

Recorded here rather than silently edited, because the reasoning below was written from them.

1. **§3.2 and §5 keyed the predicate on `statutory_report.ack_ref`. That is the wrong mechanism.** The
   owned definition of "filed" is `STATUTORY_FILED_STATUSES` (`db/schema.ts:6514`, `['submitted',
   'amended']`), and the comment beside it says why it lives in the schema: so `core/reporting.ts` and
   `core/payroll.ts` resolve against ONE list, because *"two hand-kept copies of 'which statuses count as
   filed' is how a further status ships that only half the codebase believes in."* An ack_ref-keyed
   predicate would have been exactly that second copy. **Status decides; `ack_ref` corroborates.** The
   answer is identical today — `markReportFiled` sets both atomically — so this is wrong about what
   decides, not about which months.

2. **"No new state machine" understated what exists, and the gap it leaves is a real divergence.**
   `batchDownstreamWarnings` (`core/payroll.ts:874`) ALREADY computes `statutoryFiled` for company +
   month off the same table and the same status list, and it feeds the amber banner on Unlock, Reset,
   Remove-employee and the Individual Transaction screen. The step-2 predicate is deliberately WIDER —
   year-keyed returns and `pcb_payment` are outside the banner's reader. **So a month can read filed to
   the predicate and not-filed to the banner an operator is looking at.** ⚠️ DECISION REQUIRED at step 4:
   either the banner widens, or this document states why they differ. Not settled here.

3. **The two signals do not share a visibility rule, and §3.2 treated them as interchangeable.**
   `statutory_report` is RLS'd `tenant_id = current_tenant AND app.is_admin_for(company_id)` (migration
   0026); `pcb_payment` is **tenant-only** (migration 0476). A non-admin session sees payments but not
   returns — so a naive predicate would answer "not filed" from half the evidence and fail OPEN on a
   money guard. The predicate therefore refuses rather than answering when it cannot see returns.

A fourth thing was decided rather than assumed and belongs here: **the predicate answers per PERIOD, not
per statutory leg.** A filed Borang A strictly says nothing about a PCB increment, but splitting that way
needs a map from report type to the legs it asserts, and no such map exists in this repo. Inventing one
would be inventing the scope of someone else's form. Coarse errs toward refusing — and it has a cost step
4 must own: a filed Borang A will block a legitimate PCB correction. UNKNOWN, recorded, not settled.

### 3.1 The seam already exists

- `pay_period.status` is `open` or `closed`; `core/payroll.ts` ~1623 already refuses a new run on a
  closed period, and migration 0011 already makes closed batches immutable.
- `statutory_report` carries `ack_ref` — the acknowledgement for a filed return — and `pcb_payment`
  (r321, migration 0476) records what was actually paid, per month, split MTD/CP38.

So the system can already tell "still assembling" from "filed". **This ADR turns that existing fact into
the thing that decides whether a delta may go negative.** No new state machine.

### 3.2 The rule

1. **Period open and nothing filed for it** ⇒ deltas are **signed**. The month is one computation being
   assembled; a negative increment is arithmetic, not a reversal. The invariant ADR-0024 promised —
   *the runs sum to the month* — becomes true rather than aspirational, including across the EPF step.
2. **A return has been filed for the period** (a `statutory_report` with an `ack_ref`, or a recorded
   `pcb_payment`) ⇒ a negative delta is **refused**, loudly, naming what was filed and when. Correcting a
   filed return is an amendment to a statutory submission, with the agency's own process and timing. It
   is NOT a silent recompute, and it is out of scope here (§6).
3. **Period closed** ⇒ unchanged. Already refused.

### 3.3 What the employee sees

A negative increment is **not** a negative line on a payslip. The payslip shows the month's figure for
that employee as recomputed — the same number a single combined payslip would have shown, which is the
whole promise — and the per-run arithmetic lives in the run's own record and in `pcbMeta`-style stamped
working, as 45df860a already does for PCB. **No payslip ever prints a negative EPF, SOCSO, EIS or PCB
line.** If a restatement would reduce a deduction on a payslip already issued, that is a reissue with a
visible reason, not a silent edit — and `payslip-recompute` already has the disclosure machinery.

### 3.4 What must not become true

- **Net pay already banked is never retrospectively reduced.** A restatement that would take money back
  from an employee is refused and surfaced for a human, per CLAUDE.md §1: for anything money-affecting a
  model proposes and deterministic code the kernel already trusts adjudicates.
- **No new source of truth.** The month's figure stays `statutory()`'s cumulative answer. This changes
  only whether the *increment* may carry a minus sign.

---

## 4. Consequences

**Good.** The EPF step-down over-contribution closes — the runs sum to the month with no exception, and
`test/epf-combined-month-bdf7d248.test.ts` stops pinning an accepted defect and starts pinning a fixed
one. `23e7dac3` becomes buildable. The invariant becomes checkable as a property rather than a sentence.

**Costs, stated.** Every consumer of a contribution figure must tolerate a negative increment:
`DELTA_KEYS` in core/payroll.ts, the payslip renderers, the contribution reports (Borang A, Borang 8A,
CP39, CP8D), the EA, and the analytics reads. Each is a place a `Math.abs`, a `> 0` filter or an
unsigned column could silently swallow the sign. **That inventory is the work**, and it is why this is
Large.

**Risk if done wrong.** A negative that escapes into a filed return, or a reduced deduction on a payslip
the employee has already banked. Both are addressed by §3.2 and §3.4, and both must be tested as
refusals with the refusal proven non-vacuous.

---

## 5. Build order — and it is not negotiable

1. **The inventory.** Every reader of every `DELTA_KEYS` field, listed, with what each does with a
   negative. Read-only; no code changes. This is the deliverable that makes the rest safe.
2. **The filed-period predicate.** One function answering "has anything been filed for this
   company-period?", over `statutory_report.ack_ref` and `pcb_payment`. Tested both ways.
3. **Signed deltas behind the predicate**, clamp retained wherever (2) says filed. The EPF step-down case
   is the acceptance test: RM5,000 then RM50 must reach RM612, and `epf(5050, 0)` must agree.
4. **The refusal path** for a filed period, with the message naming what was filed.
5. Only then, `23e7dac3`'s order-independence — Y1 from the employment's salary record when no regular
   run exists yet, and the month restated when the regular run lands.

Steps 3 and 4 are money-affecting and are hand-written and hand-checked on the first pass (CLAUDE.md §8).
**Accountant sign-off of the §7 worksheet applies here exactly as ADR-0024 §5 required it for the
original multi-cycle release** — this changes the same figures.

---

## 6. Explicitly out of scope

- Amending a **filed** statutory return. Named, refused, and left to the agency's own process.
- Retrospective restatement across **month or year boundaries**. This ADR is about one month correcting
  itself before it is filed, nothing wider.
- **Negative net pay**, clawbacks, and any recovery of money already paid to an employee.
- Automated decisions about any of the above. A model may propose; deterministic code adjudicates; a
  human decides anything that moves money (CLAUDE.md §1, ADR-0084).
