# ADR-0046 — EPF five-category UI labels (addendum to ADR-0035 §4)

Status: Accepted
Date: 2026-06-25
Supersedes: nothing. Refines: ADR-0035 §4 (EPF "5 modes", #2).

## Context

The consultant re-requested five EPF contribution categories — *Auto / Manual (by percentage) /
Manual (by fixed amount) / Semi-Auto / No-contribution* — observing that the statutory card only
surfaced three options. ADR-0035 §4 already reconciled the consultant's intent against the EPF Act
Third Schedule and KWSP i-Topup rules and concluded **three lawful modes**, fully surfaced, are
sufficient. This addendum records how the five *named* categories are presented in the UI without
introducing any unlawful mode, schema change, or enum value.

This is a **label / presentation** task, not a model change. The component docstring
(`components/epf-election.tsx`) already anticipated it.

## Decision

The internal enum stays at exactly three values — `auto | voluntary_excess | exempt`. The five
consultant categories are surfaced as five **named UI options**, each mapped to a lawful internal
enum value at the boundary (server action), so the client never decides the persisted enum:

| UI option (consultant)        | Internal enum                  | Rates persisted                                              |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------- |
| **Auto**                      | `auto`                         | both `null` (statutory Third Schedule banding)              |
| **Manual (By Percentage)**    | `voluntary_excess`             | employee% + employer% elected (each ≥ statutory floor)      |
| **Semi-Auto**                 | `voluntary_excess`             | employee% elected; employer rate `null` (stays statutory)   |
| **Manual (By Fixed Amount)**  | **DEFERRED** (see below)       | —                                                           |
| **No Contribution**           | `exempt`                       | both `null` (zeroes both sides; exempt employees only)      |

**Semi-Auto is not a new mode** — it is the already-shipped per-side election behaviour of
`voluntary_excess`: `localization/my/statutory.ts:resolveEpfElection` keeps a side statutory when its
rate is `null` (`payroll.ts` honours that at calculation time). The UI simply names the
"employee-elected, employer-statutory" shape "Semi-Auto".

### Manual (By Fixed Amount) — DEFERRED

> ⚠️ **REVERSED by [ADR-0087](0087-epf-manual-amount-categories.md) (item 70b14723, r365, migration 0491).**
> This section is left standing verbatim below rather than edited, so the reversal is auditable. What is now
> false: that KWSP having no fixed-amount FORM means the system must not be able to state a fixed amount
> (a pre-1998 grandfathered member's lawful contribution is below today's schedule and nothing here can
> compute it), and both engineering objections. Kₜ has not been `rate × bonus` since item bdf7d248 — it is
> the month's lookup minus the same lookup on the normal wage alone, which is 0 for a constant — and the
> multicycle mis-application is avoided by substituting the amount INSIDE the pack's EPF computation rather
> than after the kernel's `stComputed`. What remains TRUE: KWSP recognises no below-statutory *rate*
> election, and `voluntary_excess` still cannot go below the Third Schedule. ADR-0087 carries the working.


ADR-0035 §4 already ruled that a fixed RM amount is expressible as the i-Topup *excess* (a **rate**
election); KWSP has no fixed-amount election. Beyond the legal point, a fixed monthly RM amount has
real correctness holes in the current kernel: `epfContribution` returns `employeeOnBonus` computed as
*rate × bonus* in every branch (`core/payroll.ts`), feeding the PCB relief split Kₜ and the annual
`EPF_RELIEF_CAP`; a fixed amount has no rate, so that term is undefined for any fixed-amount employee
with a bonus, and the additional-run / off-cycle multicycle paths would mis-apply the monthly amount.

A true fixed-RM affordance (if the client insists) needs sourced sign-off against the EPF Act and
would be a **thin UI converter** (RM → rate = amount ÷ wage on submit) storing nothing new — explicitly
out of this slice. Until then the option renders **disabled ("coming soon")** with a label only.

### Why no schema / migration

- No new enum values. The enum literal `voluntary_excess` is unchanged, so closed payslips, domain
  events, and audit records keyed on it remain stable — no dual-string problem, no backfill.
- No new columns. The two existing rate columns (`epfEmployeeRate`, `epfEmployerRate`) already express
  Manual-% and Semi-Auto. The category is **not** losslessly recoverable from those two columns
  (a `null` on either side means "that side stays statutory"), which is exactly why we do **not**
  attempt to persist a category column or backfill one — the UI derives its selection from the
  enum + rate shape at render time.
- RLS is unaffected: no new compensation-sensitive column is added, so the ABAC base-comp visibility
  concern (#129) is moot under this scope.

### Substrate

The `statutory.my.updated` / `statutory.my.created` domain event payload now carries the resolved
`epfMode`, `epfEmployeeRate`, `epfEmployerRate` (previously `{ personId }` only) so an EPF-mode change
is reconstructable from the event log, per CLAUDE.md substrate discipline.

## Consequences

- The consultant sees all five intents named in the UI; three map onto lawful enum values today, one
  (Semi-Auto) is the already-shipped per-side election, and one (Manual Fixed) is visibly deferred.
- No migration risk: a single-transaction migrate-from-zero harness (and `ALTER TYPE … ADD VALUE`
  in-transaction) is avoided entirely because no enum value is added.
- The CSV importer still defaults to `auto`; surfacing the five labels there is out of scope.
