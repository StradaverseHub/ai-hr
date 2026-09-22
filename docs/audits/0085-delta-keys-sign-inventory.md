# ADR-0085 step 1 — every DELTA_KEYS consumer, and what each does with a negative

**Measured 2026-09-22 against `main@ddf6506f`. READ-ONLY: this document changes no code.**

ADR-0085 §5 puts this first, and says why: *"a `Math.abs`, a `> 0` filter or an unsigned column could
silently swallow the sign"*. Forty non-test files reference at least one `DELTA_KEYS` field. Most simply
carry the number through. The fourteen sites below are the ones where a negative would change an answer
or a document, sorted by how badly.

`DELTA_KEYS` (core/payroll.ts ~540): `epfEmployee`, `epfEmployer`, `socsoEmployee`, `socsoEmployer`,
`socsoSkbbk`, `eisEmployee`, `eisEmployer`, `pcb`, `pcbBonus`.

---

## Class B — A NEGATIVE MAKES A LINE VANISH FROM A MONEY DOCUMENT (worst; fix first)

Four sites render a statutory line only when it is `> 0`. Under signed deltas the money would move and
the document would not say so — the employee's payslip would silently omit the leg that changed. This is
worse than printing a negative, because there is nothing for the reader to question.

| # | Site | Expression |
|---|---|---|
| 1 | `lib/payslip-pdf.ts:675` | `...(d.socsoSkbbk > 0 ? [{ label: t.skbbk, amount: d.socsoSkbbk }] : [])` |
| 2 | `app/me/payslip/[payslipId]/page.tsx:218` | `{Number(st.socsoSkbbk) > 0 && <Row … />}` |
| 3 | `app/payroll/individual-payslip/page.tsx:750` | `{Number(b.st.socsoSkbbk) > 0 && <Row … />}` |
| 4 | `app/payroll/transaction-view/history-table.tsx:279` | `{Number(st.socsoSkbbk) > 0 && <Row … />}` |

⚠️ All four are `socsoSkbbk`, and that is not a coincidence: SKBBK is OPTIONAL per employee, so `> 0`
was being used to mean "this employee does not have it" rather than "this figure is zero". **The
predicate is wrong for the question even today** — an employee who HAS SKBBK and contributed 0.00 this
run is indistinguishable from one who does not have it at all. The fix is to test the ELECTION, not the
amount. ADR-0085 §3.3 says no payslip prints a negative statutory line, so these four must render the
restated month's figure, never a raw increment.

## Class C — A NEGATIVE CHANGES A COMPUTATION, AND SOMEBODY MUST DECIDE WHETHER THAT IS RIGHT

| # | Site | Expression | The question |
|---|---|---|---|
| 5 | `core/payroll-anomaly.ts:258-262` | `if (socsoEmployee > 0) caps.socsoEmployee = …` (×4: socso EE/ER, eis EE/ER) | A negative sets NO cap, so the anomaly detector silently stops watching that leg — on exactly the run that is unusual enough to have gone negative. Almost certainly wrong. |
| 6 | `core/payroll.ts:3954` | `Math.min(Number(st.epfEmployee ?? 0), Math.max(0, EPF_RELIEF_CAP − acc.epfClaimed))` | A negative `epfEmployee` REDUCES the claimed EPF relief. That is arguably correct — less EPF was contributed — but it is a tax-relief figure and must be decided, not inherited. |
| 7 | `localization/my/multicycle-worksheet.ts:851` | same shape as #6 | Must give the same answer as #6 or the worksheet and the kernel disagree. |
| 8 | `core/pcb-explain.ts:411` | `Math.min(delta ? delta.cumulativeBonus : n(st.pcbBonus), figures.pcbSystem)` | Feeds the explanation shown beside a deducted amount. 45df860a already separates "what the working explains" from "what was deducted"; check the separation still holds when one is negative. |
| 9 | `localization/my/payroll.ts:964` | `pcbBonus: Math.min(pcbBonusOnly, pcbAll)` | Inside the engine, before any delta. Listed because `Math.min` with a negative silently picks it. |

## Class A — THE CLAMPS THEMSELVES (the change)

| # | Site | Expression |
|---|---|---|
| 10 | `localization/my/multicycle.ts:146` | `const clampDelta = (now, before) => Math.max(0, round2(now − before))` |
| 11 | `core/payroll.ts` `deltaStat` (~546) | `Math.max(0, round2(Number(now[k] ?? 0) − Number(before[k] ?? 0)))` |
| 12 | `localization/my/multicycle-worksheet.ts:499` | `ownAdditional.push(Math.max(0, delta))` |

These are what ADR-0085 replaces with the filed/unfiled predicate. **#12 is in the WORKSHEET**, i.e. the
document an accountant signs off — if it keeps clamping while #10/#11 stop, the sign-off document will
disagree with the payroll it is certifying.

## Class D — ALREADY SIGN-AWARE (no change; copy these)

| # | Site | Why it is already right |
|---|---|---|
| 13 | `app/admin/personnel/[employmentId]/page.tsx:2782-2785` | Renders `+`/`−` with colour: `r.delta > 0 ? '+…' : r.delta`. **This is the display pattern the rest should follow.** |
| 14 | `core/ea-override.ts:211` | `Math.abs(delta) > MONEY_TOL` — a divergence test, deliberately sign-agnostic. Correct as written. |

---

## What this inventory changes about the ADR's build order

Nothing in the order, but it sharpens step 3. **Class B must be fixed BEFORE the clamps are lifted**, not
alongside: lifting first means a payslip can silently drop a line in the window between. And Class B's
real defect (`> 0` standing in for "has this election") exists TODAY, independent of signed deltas — it
is worth fixing on its own merits whatever happens to ADR-0085.

**Not found, and worth recording as a negative result:** no unsigned database column and no `CHECK (… >= 0)`
on any statutory amount, so the schema does not need to change to store a negative. No `Math.abs` outside
#14. No `.filter(x => x.amount > 0)` over a statutory collection.
