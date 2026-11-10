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

7. **Home's account tasks are one statement** (`core/account-task-bundle.ts`, branch
   `claude/home-bundle-tasks-20261110`). The Tasks card and the Summary count read every workflow owner of
   `core/approvals-inbox.ts` and Home's personal owners through one statement of sub-selects. Each sub-select is built
   beside the owner it reproduces and shares that owner's SQL text, and it runs in the caller's own session, so
   row-level security, delegation, organisation scope and the self-approval ban are the owner's own. Leave decides each
   candidate's current step in SQL (`leaveApproverDecisionSql`, the branches and order of `assertCanDecideAsApprover`);
   Leave Credit and the Claims preview with its exact count decide subjects with `decisionEmploymentAuthoritySql`, the
   SQL twin of `decisionEmploymentAuthorityTx`; Notices, standard feedback and the performance review queue return the
   owner's rows and the owner's TypeScript combines them. Every other owner contributes its own first probe, and an empty
   probe is its empty result. Whatever the statement cannot answer exactly leaves that owner alone to read as before in
   the same snapshot: an alternate approver, an unordered `limit 1` among several rows (a manager's manager, a subject
   head), any candidate that needs a live decision proof (decision headers, Attendance, Profile, Rewards, assessment,
   calibration, OneHR feedback, onboarding), a module gate that would refuse or an AI Centre activity. Without a login,
   a failed principal proof or a failed statement, every owner reads as before. Module entitlements stay the caller's
   decision. Every preview (`pendingTaskSummary`: Needs you, the shell badge, My tasks, Before payroll's approvals) reads
   the same statement with each owner's own company filter, without the Notice owner where the list leaves it out, and
   with a count-only Claims read answered by the same exact total. Full lists (`listPendingTasks`) still read the
   owners.

8. **Before payroll's payroll reads need no history barrier, and its claim rules no balances.** TP1 and the two TP3 reads
   (`listMyTp1DeclarationsSnapshot`, `myTp3EmploymentsSnapshot`, `myTp3HistorySnapshot`) keep the Payroll module gate,
   statements and projection and read one REPEATABLE READ READ ONLY snapshot without `lockPayrollHistoryReadTx`. The
   barrier keeps a multi-statement READ COMMITTED read from straddling a history correction; a repeatable-read snapshot
   is taken at the transaction's first statement, so every later statement, and any wait for the lock, sees the same
   state, and the barrier could only delay the read (decision 3's reasoning, now for two statements). The TP1 owner check
   reads the login without `FOR SHARE`: a read-only snapshot cannot take a row lock and needs none. They join the shared
   snapshot instead of three transactions of their own. Calculations, reports, writers and every other caller keep the
   barrier and the lock. The checklist used only each claim type's receipt rule and receipt-age window from
   `getEmployeeClaimTypes`, which also computes every limit, balance, item and form field; `claimTypeReceiptRules` reads
   those two facts for the same types in the same order behind the same Claims gate.
9. **One calendar window statement, one shared own leave inputs read and a preloaded entitlement resolver**
   (branch `claude/home-bundles-today-leave-20261110`).
   - *Calendar window* (`core/calendar-window-inputs.ts`). One statement for one employment and window reads every row
     the date-local owners could read inside it: the employment, its dated entity rows (`entityRowsFor`'s predicate)
     and holiday calendar periods, the companies and holiday groups they name with each group's parent, every holiday
     row of the window's calendar years in those companies' countries together with the companies its subtree check
     (`app.is_company_descendant`, the resolver's own definer helper) accepts, the ticks of those groups, the retained
     replacement rows, dated company proof (`app.proven_company_date_points`) for every date of the window and every
     replacement date, and approved and pending presence (`app.leave_calendar_presence`). The original-calendar
     resolution runs its one code path over either its live statements or these rows (`OriginalCalendarReads` in
     core/holidays.ts), each statement answered by its own predicate, so a window anywhere inside the read is answered
     exactly, not sliced; replacement coverage and presence keep their own logic over their own rows and functions.
     It answers only the transaction, employment and a window inside its own, and declines a group whose states are not
     all text (which the live statement binds as text). Inside a Home stream the declared window (decision 2) is read
     once by it and answers every card's holidays, replacement days, presence and in-window company proof. Today reads
     its two days beside the clock day statement (draft 9870) unless a stream window covers them; the Summary
     (lookahead) and the Calendar (grid) read their own window when alone. A failed window read leaves each owner to
     its previous path.
   - *Own leave inputs, shared.* Inside a shared carrier the own leave inputs are read once per employment and date
     (`sharedOwnLeaveInputsTx`) and each card decodes its own copy: Time Off, the Summary's next approved leave and Apply
     entry point and the Calendar's Apply entry point answer from the same rows of the same snapshot. Outside a carrier
     each call reads its own.
   - *Entitlement resolver.* The bundle carries every entitlement table version and eligibility rule this login may read
     (rules in `created_at, id` order). `buildTemplateEntitlementResolver` takes them as `TemplateResolverInputs`
     (in-force tables, ruled types, defaults and rules, each its statement's predicate over those rows), and asks the
     rules' organisation matches by `resolveOrgCriteriaTargets`' own predicate builder, every candidate rule of one
     resolver in one statement (`resolveOrgCriteriaTargetsBatch`, one sub-select per rule in its place). A leave type
     with an entitlement table in force now costs one further statement when a rule is in force, none otherwise.
   - `withStagedHomeReads` keeps every previous path reachable; the hosted diagnostic, test/home-calendar-window.test.ts,
     test/home-read-window.test.ts, test/home-own-clock-day.test.ts and test/home-own-leave-inputs.test.ts compare the
     two paths to the byte.

10. **The deferred task owners are decided in the account task statement** (`claude/home-bundles-task-owners-20261110`).
   Every owner decision 7 left to read whenever it had a candidate is now a section beside that owner, sharing its SQL
   text and run in the caller's session, so its result is the owner's own:
   - *Leave and leave cancellations.* `leaveStepDecisionSql` (core/leave.ts) decides the current step as
     `assertCanDecideLeaveStep` does: the primary approver, then the stored alternates kept exactly as
     `sanitizeApprovalLevels` keeps them (known kinds only, a fixed kind with its named employment, a dynamic kind's id
     cleared), tried in order; the first approver that allows decides, refusals are skipped and a non-refusal error
     stops. An unordered `limit 1` (the manager's manager line, the head of a subject's current assignment) is decided
     for every row it could return, and rows that agree answer exactly; an approver whose rows disagree is still exact
     when a later approver allows. (Only the manager's-manager lines can disagree in valid data: `assignment_no_overlap`
     leaves a subject one current assignment.) The subject's self ban and assertCanDecide answer are read once per
     candidate (`leaveSubjectFactsSql`) and the session's roles choose each kind's branches when the text is built, as
     the TypeScript gate reads them from the session, so the statement plans each table once per section. A cancellation's copied steps use the same decision with its own
     'leave.cancellation' task type over the owner's unchanged header query; both owners' candidates share one
     sub-select and one copy of the decision (`pendingLeaveDecisionTasksBundleSql`).
   - *Resignations and employment reviews.* The owners' header queries unchanged, kept where their authority checks
     return (`canDecideSql`, the admin role, the stored manager's person): every throw of those checks is a refusal.
   - *Attendance.* The owner's candidates, a frozen workflow request of routing version 2, 3 or 4 decided by its own
     native function, every other candidate by `decisionEmploymentAuthoritySql`.
   - *Rewards* (when no access observation is due, decision 4), *assessment and calibration work*, *OneHR feedback* and
     *onboarding*: the owner's own rows (with a calibration session's routing work, each onboarding case's update time by
     its JSON id, and the claimant directory when an item carries a claim), and the owner's TypeScript runs on them
     (`combineRewardTasks`, `parseAssessmentRows`/`assessmentSources`, `calibrationTaskOf`, the cycle and window checks,
     `interpretOnboardingTasks`).
   - *Profile.* The owner's first transaction (probe and candidate query). No candidate is its empty result; candidates
     still pass its locked decision transaction (`pendingProfileTasksFromCandidates`).
   - *One read of the caller's own employments.* Every test of an employment against the caller's person (the self ban,
     the administrative manager, a named approver, a review's stored manager, assessment work's own employments) reads
     one RLS-filtered set per statement (`callerOwnEmploymentIdsSql`, a materialised CTE); membership is exactly the row
     test it replaces. Each employment reference otherwise evaluated the employment policy's visible-employment set on
     its own: with ten more of them the statement took about 290 ms on the hosted fixture (55-70 ms before) and
     concurrent Home reads exhausted the 2 GB test database. With the set read once the statement plans in about 45 ms
     and executes in about 70 ms for the fixture's manager, and the Tasks card is back to its earlier time.
   Each remaining case leaves only that owner to read on its own, as before: a step whose `limit 1` rows disagree with no
   later allowing approver; an alternate whose named id, trimmed exactly as `sanitizeApprover` trims it, is not plain UUID text (the gate would
   cast another spelling, such as braces, or fail the cast); an unknown step kind or a named-person step naming nobody, and an Attendance request whose
   frozen subject differs from its candidate (the owner throws its own non-refusal error, which a statement cannot
   reproduce as the same error object from inside the owner's transaction); a Rewards observation that is due (a write
   that must commit first); Profile candidates (the decision takes the exclusive profile-write barrier, re-resolves the
   policy after it and locks routed subjects FOR UPDATE, which a read-only statement can neither take nor reproduce); a
   cycle, policy or case id the owner's own parse would refuse, a claimed onboarding item without a preloaded directory, a
   module gate that refuses or an AI Centre activity. test/performance/home-manager-card-reads.test.ts seeds candidates
   for each section after its traces and compares every section, scoped and unscoped, and every composed result with the
   owners; the focused Performance, Rewards, onboarding and OneHR feedback tests compare their sections on real
   fixtures.

11. **Before payroll reads its own owners in one statement** (`core/pre-salary/before-payroll-bundle.ts`, branch
   `claude/home-bundles-before-payroll-20261110`). The checklist (`readMyPayrollReadiness`) read about fifteen owners in
   some fifty-five statements. After the own-subject proof (unchanged) it now sends one statement of sections, each built
   beside its owner and sharing that owner's select, joins, predicate, order and page, evaluated in the caller's own
   session, so row-level security is the owner's own. The period owner's cut-off day (`app.own_payroll_cut_off_day`) is
   one of them; because it decides the Attendance windows, those sections are read for windows covering every window the
   period owner can choose (a pay period is this month or the next, and `anchorWindowFor` opens every input type's window
   on or after the first of the previous month; the checklist reads no day after yesterday), and are then narrowed to the
   exact windows computed from the returned row by the same lines as before: the range's dated rows filtered to the
   window, the OT plans to their own lower bound (those rows lead the owner's newest-first order, so the filtered page is
   the owner's page), the overtime cap taken from the cap date's month. A window outside what was covered reads its
   owner. Each owner's own proof is a value of the same
   statement: the TP1 owner check, the letters' presentation proof (`aiPresentationPrincipalSql`, the statement
   `isAiPresentationPrincipalCurrentTx` sends) and the profile's own-person check. The checklist then runs each owner's
   TypeScript on its section:
   - *Attendance Records range* (`attendanceRangeChecklistFromBundle`): the owner's own day loop
     (`attendanceRangeRowsFrom`, now shared by both paths) over the employment, days, policy, roster, live arrangements,
     absence-deduction switch, arranged shifts, Schedule Group weeks, rotations and exception lookups, each from the
     owner's select. Day adjustments that name a shift or day kind resolve through `scheduleFor` on `ownClockScheduleMemo`
     (the Today memo, decision 6) fed by draft migration 9873 (`app.home_own_schedule_range`), the range-shaped twin of
     9870's schedule inputs; the memo's holiday entry is the range's own holiday set (for a visible employment
     `holidayDatesByEmployment` is `holidayDatesFor`'s originals and retained replacements). Every row equals the owner's
     except `formulaOvertime`, the stored overtime-formula record, which the checklist never reads and the statement does
     not read.
   - *Approved leave presence and the holiday calendar* reach the day loop through `AttendanceRangeDatedFacts`. The
     statement carries decision 9's calendar window (`calendarWindowSql`) for the covering window as one more section, and
     `calendarWindowDatedFacts` answers both facts from it with their owners' own projections: the presence owner
     (`approvedLeavePresenceByEmploymentTx` with the window) kept to its full days, which is `approvedLeaveDates`' own
     filter, and `holidayDatesFor` with the window, the same originals and retained replacements
     `holidayDatesByEmployment` unions for a visible employment. A request the window does not answer, or a section
     that fails to decode, reads `LIVE_ATTENDANCE_RANGE_DATED_FACTS` (`approvedLeaveDates`, `holidayDatesByEmployment`)
     in the same transaction; a caller can also pass its own `facts` to `readBeforePayrollBundle`.
   - *Loop cards*: the owner's gate and card rules on the gate rows, pauses, open cases of every loop (the projection
     keeps the live loops' cases, the owner's own predicate) and Watch levels; a gate read elsewhere or two cards of one
     kind whose order the owner leaves to the plan read the owner.
   - *Readiness gaps* send the correction source's statutory flag in the text its owner's one-table select renders
     (`s.person_id="person_id"`, which binds to the statutory row itself, so the owner's flag is whether any statutory
     row the caller can read exists; for an HR caller that differs from the employee's own row). The section keeps the
     owner's answer; correcting the owner is a separate decision because it changes which gaps an HR caller is offered.
   - *TP1* (the month collapse), *TP3* (records and drafts), the *previous-employer answer*, the
     *Family register* and *onboarding acknowledgements* (the owner's filter as its exact SQL twin: jsonb equality with a
     JSON string is JavaScript's strict equality with that string) are the owners' own rows and projections.
   - Where the checklist reads only some fields, the section carries those fields of the same rows (decision 8's rule):
     the pending corrections and OT plans without their attachment and workflow reads, own leave requests without their
     give-back working dates, open claims with an attachment count, Leave Credit requests with their worked dates, the
     profile's declared child count only, reviews without ratings, letters' first page. No amount, limit, balance,
     rating or bank fact is read. The OT plans' page is read one row past its end: a tie on its two order keys at the
     boundary leaves the page to the owner.
   Module gates stay the owners': a section is built only where the owner's own gate (`assertModuleGate`, and the AI
   Centre check for Performance) would admit it. A projection that refuses its rows, a failed owner check, or a failed
   statement leaves that owner, or every owner, to read exactly as before in the same snapshot;
   `withOwnerBeforePayrollReads` keeps the old path for equivalence. Error paths of the reads the narrowed sections leave
   out (an attachment, workflow, working-date or autonomy-card read that would fail) no longer mark their group "could not
   check"; their values never reached the checklist. Equivalence: the hosted diagnostic compares the checklist both ways
   and every section with its owner for each fixture subject (`beforePayroll:*`), with fixture rows for every owner
   added after the traces; test/before-payroll-checklist.test.ts does the same per login.

## Not done here

- **Before payroll's remaining reads** (decision 11). The own-subject proof and company date proof
  (`requireOwnHomeSubject`) and the approvals preview (decision 7) read as before. Leave Credit (Time Off In Lieu on),
  letters, notices and onboarding are compared with real rows only for the fixture subjects that hold them (the employee,
  the manager and an onboarding joiner); the other tenant has Time Off In Lieu off.
- **Deferred task owners.** Decision 10 brought them into the account task statement. Still reading on their own: Profile
  candidates' locked decision transaction, Rewards while an access observation is due, and decision 10's exact-or-owner
  cases (disagreeing `limit 1` rows, an alternate id spelled other than plain UUID text, the owners' own non-refusal errors, parse refusals). The
  full lists (`listPendingTasks`) still read the owners; the assigned work index below would answer them too.
- **The entitlement explanation in Time Off.** The resolver now reads from the bundle (decision 9), but an employee whom
  no rule, sole table or default reaches still gets the "no eligibility match" explanation from
  `explainEntitlementEligibility` live: every table version and rule of that type, the membership per rule and the first
  failing axis per rule. It could take the same preloaded tables and rules and ask every membership and axis subset in one
  `resolveOrgCriteriaTargetsBatch` statement, plus the person and dated assignment facts it quotes.

## Read models worth maintaining

- **Assigned work index**: one row per open decision and assignee, maintained by each workflow owner's writer and
  rechecked by the owner on open. Home's task count and first page, the shell badge and Needs you would read one
  indexed statement instead of a dozen owner queries, at every queue size. It is the better long-term design: decision 7
  still evaluates authority per candidate on every read (its cost grows with the queue, 20,000 pending Claims in the
  fixture), and its exactness rests on SQL twins of TypeScript guards that must change together. Design:
  - `assigned_work(tenant_id, owner, item_id, assignee_employment_id, subject_employment_id, company_id, created_at,
    due_date, kind, revision)`, primary key `(tenant_id, owner, item_id, assignee_employment_id)`, indexed by
    `(tenant_id, assignee_employment_id, created_at desc)`, RLS to the assignee's own person, no request body or amount.
  - Written only inside each owner's own transaction: the request writer adds or removes the request's rows; the step
    writer replaces them when the current step moves; and every fact authority derives from rewrites the rows it
    touches: reporting lines, delegations and their scopes, role grants, department and business-unit heads, payroll
    partner grants, attendance workflow participants. That last set is what makes it larger than a cache, and each of
    those writers needs a test that the index matches the owner after the write.
  - Readers trust it for counts and the first page; opening an item still runs the owner's decision guard, which stays
    the authority. A nightly owner-against-index comparison per tenant reports drift instead of hiding it.
  - Migrate one owner at a time behind decision 7's section for that owner, starting with Claims and Leave, which hold
    most rows.
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
