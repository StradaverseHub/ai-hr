# Assistant personnel compensation parity

Source-only package on `codex/ai-user-parity-personnel-comp-20261030`, based on
`3d8a12d01b518eaefc18d3d828ac74ccc03a609c`. Freshly fetched main and alpha were both
`2f81373e5e18fb2b734dba0ded94866446afc065`; the owned base includes them. No release,
installation, executed verification or acceptance is claimed by this record.

## Native effect map

| Personnel entry | Native owner | Effect and failure paths |
| --- | --- | --- |
| `setCompensationAction` | `core/comp.ts#setCompensation` | Closes the open predecessor and inserts a salary revision. Carries monthly allowance, validates currency/mode/rate, finite nonnegative basic salary, zero-basic reason and period-boundary mode changes. Database date/range constraints adjudicate overlap. |
| `editCompensationAction` | `core/comp.ts#updateCompensation` | Only an open, non-superseded row. Changes exact submitted fields, may move the adjacent predecessor boundary; refuses history collisions, swallowed predecessor, closed-period date moves, processed-period mode changes and invalid amounts/structure. |
| `supersedeCompensationAction` | `core/comp.ts#supersedeCompensation` | Soft-removes an existing revision and reopens/extends its adjacent predecessor. Closed payroll overlap is refused by both the native service and database trigger; records are never erased. |

These are three unique native effects behind one typed operation union. All three screen entries require
HR administrator admission. The native salary owner then requires `can_admin_employment` or
`can_admin_perfcomp_employment` under the caller's current context. The Assistant retains that HR screen
admission and refuses the actor's own person for every role; native partners who cannot enter this HR
screen do not gain Assistant access through this package. Non-HR Workforce editing remains outside it.

## Transaction and review ownership

`updateCompensation` gains only the optional enclosing transaction already supported by set and supersede.
Its ordinary call path continues to own its original payroll-history transaction. The native owner holds
Access, a non-waiting shared payroll-history barrier, leave configuration and employment dependencies before
private reads. Relevant visible payroll batch rows are locked outside the preview savepoint.

Preparation calls the same native command inside a savepoint, captures its exact before/after history
strings (including closure, reopening and removal of the adjacent record), then rolls back that savepoint.
The inspected native writers and `markRunsAffectedByEmploymentChangeTx` / `markBatchNeedsRecalc` perform only
database writes and domain events in the supplied transaction: no provider, notification dispatch, outbox
write or independently committed transaction. A savepoint may consume an event sequence value, but no salary,
event, payroll stale marker or outgoing work from its preview survives. Failed previews also roll back.

Fresh native events are identified relative to the locked subject's pre-command event boundary because a
savepoint uses a subtransaction xmin. Actual completion independently requires both the compensation tuple
and its canonical event to have the enclosing transaction xmin, actor, tenant, employment and matching state.
A previous event cannot complete a review.

Only the human supplies salary, currency, rate, remarks, operation and effective date. Exact decimal strings
with two fractional digits are converted to the native numeric input; no model calculates money or supplies
values. The local review shows native amounts, currency, monthly allowance, pay structure, dates, removal
status and all affected records. The private digest binds human inputs, complete source history revisions,
subject identity and visible payroll statuses/markers. Confirmation re-previews, compares and runs the
native command once in the enclosing encrypted assigned-ledger transaction. Lost responses reopen that same
review and its committed canonical receipt; they never blindly repeat a salary change.

`employees.compensation.maintain` is Approve / pay, never Automatic. It reuses the existing single encrypted
ledger, erasure targets, ownership checks, pauses and native-outcome capture. No private value or ID is sent
to a model or provider. Completion means changed salary history; it does not mean payroll was generated,
approved or paid. Existing native processed-run recalculation marking remains unchanged and applies only to
runs this actor administers.

Migration0715 / idx696 / when1793330000044 is an unapplied provisional source claim, requiring fresh ordered
ledger allocation at integration freeze. Earlier SQL bytes and journal entries remain unchanged. Release
hold, human-only access/termination/rollback handoffs and separate deployment authority remain in force.

## Verification scope

Focused tests are authored for native preview rollback, exact before/after and adjacent history consequences,
set/edit/supersede receipts and replay, stale history/payroll/authority, self/company/tenant isolation,
injected input refusal, legacy custody and six-locale desktop/mobile human review and recovery. The registry
role matrix exercises the same native screen admission and salary service. Execution belongs exclusively to
the parent's frozen exact-SHA `alpha-focused-checks` run with whole typecheck enabled on standard runners.
