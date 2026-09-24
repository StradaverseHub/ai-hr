# ADR-0085 — Signed statutory deltas: letting a month correct itself before it is filed

- **Status:** PARTLY BUILT. Steps 1, 2, 4 and 5 are shipped (r330, r337); **step 3 — signed deltas — is
  not started**, and §7.4 states exactly which figure is still wrong because of it.
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
   ✅ **DONE** (r330) — `docs/audits/0085-delta-keys-sign-inventory.md`.
2. **The filed-period predicate.** One function answering "has anything been filed for this
   company-period?", over `statutory_report.ack_ref` and `pcb_payment`. Tested both ways.
   ✅ **DONE** (r330) — `core/statutory-filed.ts`, deliberately unconsumed until step 4.
3. **Signed deltas behind the predicate**, clamp retained wherever (2) says filed. The EPF step-down case
   is the acceptance test: RM5,000 then RM50 must reach RM612, and `epf(5050, 0)` must agree.
   ⛔ **NOT STARTED.** r337 did not do this and the clamp is untouched. §7 below records the one figure
   that is still wrong because of it, with its direction and its bound.
4. **The refusal path** for a filed period, with the message naming what was filed.
   ✅ **DONE** (r337) — `refuseIfPeriodFiled` / `PeriodAlreadyFiledError` in core/payroll.ts, at three
   doors; `test/23e7dac3-filed-refusal.test.ts`.
5. Only then, `23e7dac3`'s order-independence — Y1 from the employment's salary record when no regular
   run exists yet, and the month restated when the regular run lands.
   ✅ **DONE** (r337) — `restatesMonth` in `generatePayslips`; `test/23e7dac3-cycle-order.test.ts`.

**r337 TOOK 4 AND 5 BEFORE 3, DELIBERATELY, AND THE ORDER WITHIN THAT MATTERS.** The refusal was built,
committed and proven before the cycle order was relaxed by a single line — because the refusal is the
only reason relaxing the order is safe, and a branch that relaxed first would have had a window, however
short, in which an out-of-order run could restate a lodged return. Step 3 was skipped rather than
deferred silently: §7 states exactly what remains wrong without it.

**§1.2 OVERSTATED THE DEPENDENCY, AND THE SOURCE IS WHY.** This document says order-independence is
"unbuildable" while the clamp stands, reasoning that the first run would be taxed as though its payment
were the employee's normal monthly pay. Measured against the kernel, that is not what happens: `wagesExOt`
in `generatePayslips` is recomputed per employee from the COMPENSATION record on every run, so the
month's normal wage is in the statutory base whether or not the regular run has been processed. Y1 was
never taken from the runs. What genuinely had to be built was the other half of §5 step 5 — the month
restated when the regular run lands — and that needs no signed delta, because the regular run's charge
carries the whole normal-wage base and is a large positive number. The clamp still bites in exactly one
shape, and §7 measures it.

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


---

## 7. THE ACCOUNTANT SIGN-OFF WORKSHEET FOR OUT-OF-ORDER RUNS (r337)

> **A correction to how this document has been cited.** ADR-0085 had no §7. The "§7 worksheet" §5 above
> refers to is **ADR-0024 §7**, the RM5,000 + RM10,000 scenario signed off on 2026-06-20 and restated on
> 2026-08-20. That worksheet answers "do two runs in a month sum to the month?" — it does not answer
> "does it matter which one goes first?", because in it the regular run always goes first. This section
> is the second question, and it is numbered §7 here so that the citation in §5 resolves to something.

**What a reviewer is being asked to confirm:** that paying a bonus, an off-cycle amount or an advance
salary BEFORE the monthly salary produces the same EPF, SOCSO, EIS and PCB for the month as paying them
the usual way round. Not that it ran. That the figures are the same.

### 7.1 The rule, in one line each

The statutory month is ONE computation. Write `S(W, A, T)` for the month's statutory figures on a normal
wage `W`, additional remuneration `A` and overtime `T` — `W` comes from the employment's compensation
record, so it is in the base from the first run of the month regardless of which run that is.

| Run | What it is charged |
|---|---|
| an **additional** run (bonus / off-cycle / adjustment) | its own marginal: `S(W, A≤, T≤) − S(W, A<, T<)` |
| the **regular** run | its marginal **plus the normal-wage base it pays**: `S(W, A≤, T≤) − S(W, A<, T<) + S(W, 0, 0)` |

`A<` / `T<` are what this month's earlier runs already paid; `A≤` / `T≤` include this run. The two lines
telescope to `S(W, A_total, T_total)` — the month as one computation — **in whatever order the runs
land**. When the regular run is the month's first, `A< = T< = 0` and its charge collapses to `S(W, A≤,
T≤)`, which is literally the call it has always made: an ordinary single monthly run is unchanged.

### 7.2 The worked example, both ways round

Resident employee, PCB Category 1, no children, no prior months in the year. **Basic RM5,000**,
**overtime RM500** keyed on the monthly run, **bonus RM3,000** on a separate run. Pay month **May 2026**,
2026.1 ruleset. Every figure below is produced by the kernel through a real database and pinned as a
literal in `test/23e7dac3-cycle-order.test.ts`; re-run `pnpm vitest run test/23e7dac3-cycle-order.test.ts`
after any statutory-table change to refresh them.

**(i) The conventional order — Monthly, then Bonus.**

| Leg | Monthly run (seq 1) | Bonus run (seq 2) | Month |
|---|---:|---:|---:|
| EPF employee | 550.00 | 330.00 | **880.00** |
| EPF employer | 650.00 | 310.00 | **960.00** |
| SOCSO employee | 27.25 | 0.00 | **27.25** |
| SOCSO employer | 95.35 | 0.00 | **95.35** |
| EIS employee | 10.90 | 0.00 | **10.90** |
| EIS employer | 10.90 | 0.00 | **10.90** |
| PCB (MTD) | 10.00 | 90.00 | **100.00** |

**(ii) The reporter's order — Bonus first, then Monthly.**

| Leg | Bonus run (seq 1) | Monthly run (seq 2) | Month |
|---|---:|---:|---:|
| EPF employee | 330.00 | 550.00 | **880.00** |
| EPF employer | 310.00 | 650.00 | **960.00** |
| SOCSO employee | 0.00 | 27.25 | **27.25** |
| SOCSO employer | 0.00 | 95.35 | **95.35** |
| EIS employee | 0.00 | 10.90 | **10.90** |
| EIS employer | 0.00 | 10.90 | **10.90** |
| PCB (MTD) | 50.00 | 50.00 | **100.00** |

**(iii) The same month paid as ONE run.** RM5,000 + RM500 overtime + RM3,000 bonus on a single monthly
run: EPF 880.00 / 960.00, SOCSO 27.25 / 95.35, EIS 10.90 / 10.90, PCB 100.00. **Identical to both.**

### 7.3 Reading the trace — where each figure comes from

- **EPF** reads the Third Schedule ONCE for the month, on RM5,000 + RM3,000 = RM8,000 (overtime is
  outside the EPF base). 11% employee → 880, 12% employer → 960. The bonus run is charged the difference
  between the RM8,000 lookup and the RM5,000 lookup — 880 − 550 = 330 and 960 − 650 = 310 — **and that
  difference is the same whichever run goes first**, because the RM5,000 side of it comes from the
  compensation record, not from a payslip. This is why the EPF rows are byte-identical between (i) and
  (ii).
- **SOCSO and EIS** are charged ONCE for the month (Act 4 s.6(7)/6(9); Act 800), on wages + overtime =
  RM5,500, and a bonus is outside the s.2(24) wage. So the whole charge sits on whichever run pays the
  wage — the monthly run — and the bonus run adds RM0.00 in both orders. **The band is never entered
  twice.**
- **PCB is the leg that MOVES, and this is the part that needs reading.** The month's MTD is RM100.00
  either way, but the split differs: 10 / 90 conventionally, 50 / 50 reversed. That is not an error. In
  the conventional order the bonus run's additional-remuneration step is computed on a month that already
  contains the RM500 overtime; in the reversed order the bonus run cannot see overtime that has not been
  keyed yet, so it is charged a smaller additional leg, and **the monthly run restates the month when it
  lands** and picks up the remainder. The employee's total deduction for May is RM100.00 in both cases.
  **Without that restatement the reversed order pays RM60.00** — proven by reverting it (`restatesMonth =
  false` fails with "expected 60 to be 100"). A RM40 under-remittance to LHDN is what this change
  prevents; it is not a risk it introduces.

### 7.4 The one figure that is still wrong, with its direction and its bound

**This is the whole of what step 3 has not fixed, and it is not new.** The EPF Third Schedule steps the
EMPLOYER column DOWN from 13% to 12% at RM5,000, so a month can get bigger and its employer contribution
smaller. `deltaStat` floors every increment at zero (ADR-0024 §6), so whichever run carries the month
across that step contributes RM0.00 rather than handing the difference back.

Measured, on basic **RM4,990** with **RM40** of bonus-bucket money inside the salary run and a **RM30**
bonus run beside it (the month is RM5,060, a 12% row):

| Order | EPF employer for the month |
|---|---:|
| the single Third Schedule lookup for RM5,060 | **612.00** |
| Monthly (with its RM40) then Bonus RM30 | **612.00** |
| Bonus RM30 then Monthly (with its RM40) | **650.00** |

- **Bound:** RM38.00 — the size of the step at this row, not an open-ended drift.
- **Direction:** the clamp can only ever REMOVE a negative increment, so an out-of-order month is
  **never under-remitted, only over**. The excess is an employer cost that lands in the employee's own
  EPF account. Nobody is short-paid and no agency is short-paid.
- **Every other leg** (EPF employee, SOCSO, EIS, PCB) agrees exactly between the two orders in this
  shape; only the employer EPF column moves.
- **Reachability:** only when an additional payment carries a month from at-or-below RM5,000 to above it
  AND the runs land in the order that crosses the step in the earlier run.

Pinned in `test/23e7dac3-cycle-order.test.ts` ("the ONE case the order still changes"). It closes when
ADR-0085 step 3 ships and not before.

### 7.5 What to tick

| # | Assertion | Authority | Manual figure | System figure | ✓ |
|---|---|---|---|---|---|
| 1 | Bonus-before-Monthly gives the SAME month's EPF as Monthly-before-Bonus | EPF Act, Third Schedule | | 880.00 / 960.00 both ways | ☐ |
| 2 | SOCSO and EIS are charged ONCE for the month in EITHER order, on wages + overtime, bonus excluded | Act 4 s.6(7)/6(9), s.2(24); Act 800 | | 27.25 / 95.35 and 10.90 / 10.90 both ways | ☐ |
| 3 | The month's MTD is the same in either order, even though the per-run split is not | LHDN spec (the month is one computation) | | 100.00 both ways (10/90 vs 50/50) | ☐ |
| 4 | Both orders equal the same month paid as ONE run | ADR-0024 §4 | | identical | ☐ |
| 5 | A month whose returns have been FILED refuses the out-of-order run, naming the filing | ADR-0085 §3.2 / §6 | n/a | refused; releases when the filing is reversed | ☐ |
| 6 | The EPF employer step case in §7.4 is accepted as a bounded over-contribution until step 3 | ADR-0024 §6 | | RM38.00, upward only | ☐ |

### 7.6 What this worksheet does NOT cover

- **Anything on a filed month.** That is refused outright (§3.2, step 4), not computed.
- **A negative statutory delta.** Step 3 is not built; the clamp stands; §7.4 is its residue.
- **Part E (citizen aged 60–<75).** ADR-0024 §7's 2026-08-20 note left Part E banding the normal wage on
  its own. Nothing in r337 changed that, and nothing here says anything about it.
- **Restating across a month or year boundary.** Out of scope (§6) and unchanged.
- **The `payroll_statutory_adjustment` path.** A hand-set statutory figure is not a computation and this
  worksheet says nothing about a month containing one.
