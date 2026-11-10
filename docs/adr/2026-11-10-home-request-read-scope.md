# Home reads: one snapshot per page render, sliced date windows and barrier-free payroll hints

Source candidate on `claude/home-round-trips-20261110`, not accepted or installed. It continues the shared read
snapshot of the Home stream (db/shared-read.ts) and changes how data reaches the existing owners; no owner's
calculation, authority, ordering or failure changes.

## Decisions

1. **One read-only snapshot per page render and identity.** The Today sections, the shell's approvals badge, the
   Performance block, the Ask gate, the greeting identity and the team-workspace identity of one server render pass the
   render's scope (`lib/request-read-scope.ts`, React `cache`) to `withSharedReadSnapshot`. Compositions of the same
   identity join one REPEATABLE READ READ ONLY carrier; the carrier commits whenever no composition and no owner is
   inside it, so it never holds a connection between them, and a later composition opens a fresh snapshot. A different
   identity in the same scope gets its own session. Outside a React render (route handlers, jobs, tests) there is no
   scope and every composition keeps its own snapshot exactly as before. Every refusal and fallback rule of the shared
   snapshot is unchanged: a barrier, read-committed probe, setting, write or savepoint still reruns that owner alone.

2. **Date-local facts are read once for the widest window and sliced.** The Home stream declares the widest own window
   its cards need (`declareSharedReadWindow`). Original holiday calendars, retained replacement days, leave calendar
   presence and dated company proof give each date an answer that depends only on that date, so inside that stream's
   carrier each is read once for the window and each caller receives its own slice, copied. A request outside the
   window, for another employment or outside a carrier reads exactly as before; a failed wide read falls back to the
   caller's own read.

3. **Home payroll hints need no history barrier.** The barrier (`core/payroll-history-lock.ts`) stops a multi-statement
   READ COMMITTED calculation from consuming half of a history correction. The Home hints read one bounded metadata
   statement in a REPEATABLE READ READ ONLY snapshot. One statement in one snapshot is atomic against every writer
   transaction, and a history writer releases its exclusive hold at each commit, so the barrier could only delay the
   read until an in-flight writer committed. The hints keep the Payroll module gate and their own-subject proof, read
   no amount, statutory snapshot or bank fact, and write nothing. Calculations, reports and every other Payroll owner
   keep the barrier.

4. **The Rewards access observation stays a write, and runs only when due.** The native observation is an audit write
   committed before the Rewards presentation, and its failure blocks the presentation (2026-11-08 Rewards
   configuration presentation). It is therefore not deferred or batched. A read-only definer probe
   (`app.reward_access_observation_due`, unallocated draft migration 9850) answers exactly whether the write would
   record anything for the current login; the task source runs the unchanged write whenever it would. The probe reads
   inside the caller's snapshot, so a suspension that begins within the few milliseconds after a Home stream's snapshot
   is recorded by the next observation rather than this one.

5. **Proofs and held settings are answered once per snapshot.** The repeatable-read-only and current-principal proofs on
   the Home path use one statement text each (`core/read-only-snapshot.ts`), so the snapshot's statement memo answers
   them once. The carrier answers a `SET LOCAL jit` or `SET TRANSACTION READ ONLY` it already holds without sending it.

6. **Time Off and Today each read their inputs in one statement** (`claude/home-bundle-timeoff-20261110`).
   - *Time Off.* `core/own-leave-inputs.ts` reads, in one statement under the caller's RLS, every row the current
     leave calculators aggregate for the own employment: the visible leave catalogue, the ledger, the requests (and
     any request a ledger row names), the employment, person and company columns they select, the shared group
     members, the entitlement table validity windows and the next approved date (the owner's own statement,
     embedded). `leaveBalancesTx`, the My Leave dashboard, `leaveEntitlementBreakdowns`,
     `leaveTypeApplySummaries` and the Apply entry point keep every line of arithmetic and take the bundle as an
     optional input. Each staged statement is answered by a method that computes exactly its result: the same
     predicates and joins, `numeric` sums as exact text at the widest scale (`lib/pg-numeric.ts`), `LIKE` with its
     wildcards, and the statement's own order. Every staged statement whose row order reaches a result now orders
     deterministically on both paths (leave type id for the balance rows, pending rows and active catalogue, which
     fixes the order of a pool's `contributingLeaveTypes`; ledger id after the date for the breakdown walk). The bundle answers only the
     employment and transaction it was read for; any other request, and any leave type with an entitlement table in
     force on the asked date (whose resolver still reads its rules live), reads exactly as before. The cards'
     principal proof is asked before the bundle is read.
   - *Today.* `app.home_own_clock_day` (unallocated draft migration 9870, SECURITY INVOKER) returns the open-day
     probe, both candidate days and their unvoided punches with each capture's true instant, the switches, the work
     location names and every schedule input of yesterday and today (policy row, adjustments, roster, arrangements,
     every shift and rule they can name with OT rows, exception revisions and OT windows, rotation versions). The
     own-subject proof runs first and unchanged; the unchanged clock logic then runs on the rows, and the schedule
     owner runs on a `ScheduleMemo` built from them (`ownClockScheduleMemo`). The holiday calendar and approved
     leave presence keep their own date-local reads, which a Home stream answers from its shared window. Clock writes
     are untouched.
   - Equivalence: every calculator runs on its staged statements and on the bundle inside one snapshot, and must
     match to the byte (test/home-own-leave-inputs.test.ts, test/home-own-clock-day.test.ts, and the hosted
     diagnostic's `bundle:*` comparisons).

## Not done here

Per-card set-based bundles for Tasks (one UNION ALL across workflow owners) and Before payroll (another branch).
Within Time Off, a leave type with an entitlement table in force still builds its template resolver live (its
eligibility rules and their organisation matches): the bundle could carry the rule rows and the dated assignment,
but `resolveOrgCriteriaTargets` would first need the same preloaded-input refactor and equivalence proof.

## Read models worth maintaining

- **Assigned work index**: one row per open decision and assignee, maintained by each workflow owner's writer and
  rechecked by the owner on open. Home's task count and first page, the shell badge and Needs you would read one
  indexed statement instead of a dozen owner queries, at every queue size.
- **Own leave balance snapshot**: per employment and leave type, the current cycle's balance, pending and Apply figures,
  rewritten by the ledger and request writers. Time Off and At a glance would read one row set; the calculators stay
  the writer-side owner. *Measured against the bundle (decision 6), it is not clearly better yet.* The bundle already
  costs one statement and reads only one employment's own rows, which grow by a few dozen a year. A snapshot would
  remove the calculator CPU but add a writer obligation to every ledger, request, leave type, entitlement table,
  eligibility rule and employment profile writer, plus a date-driven refresh at every cycle boundary (the current
  cycle is a function of today), and a stale row would be a wrong balance on screen. Build it only if hosted
  measurement shows the calculator CPU (not the statements) dominating Home at fleet scale. Its design then:
  `own_leave_balance(tenant_id, employment_id, leave_type_id, cycle_start, cycle_end, balance, pending, available,
  inputs_digest, computed_at)` written by `leaveBalancesTx`/`leaveTypeApplySummaries` inside each writer's
  transaction and by a nightly cycle roll; readers recompute and compare `inputs_digest` (ledger, request and
  configuration revision counters) and fall back to the live calculators on any mismatch, so a stale row can delay
  but never change a figure.
- **Holiday calendar by company and calendar period**: resolved original holidays per (company, calendar, year),
  refreshed by holiday and assignment writers, replacing the per-year resolution chain on every view.
