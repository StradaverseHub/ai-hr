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

6. **Home's account tasks are one statement** (`core/account-task-bundle.ts`, branch
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

7. **Before payroll's payroll reads need no history barrier, and its claim rules no balances.** TP1 and the two TP3 reads
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

## Not done here

- **Time Off and Today** bundles (another branch).
- **Before payroll as one read.** Its remaining owners still read separately: the attendance day chain
  (`attendanceForEmploymentRange`, shared with Today), own corrections, overtime plans and cap, loop cards, own leave
  requests and eligible types, open claims, Leave Credit requests, readiness gaps, profile and dependants, letters,
  notices, reviews and onboarding acknowledgements. Each needs the treatment Tasks received: a section beside its owner
  that shares the owner's SQL, a TypeScript projection fed from the preloaded rows, and an owner-against-section
  equivalence comparison. The attendance chain follows the Today bundle.
- **Deferred task owners.** Leave cancellations, resignations and employment reviews (behind their shared candidate
  probe), Attendance, Profile, Rewards, assessment and calibration work, OneHR feedback and onboarding still read on
  their own whenever they have a candidate. Cancellations can reuse `leaveApproverDecisionSql` with its own task type;
  the others need their decision proofs as SQL beside their owners, or the assigned work index below.

## Read models worth maintaining

- **Assigned work index**: one row per open decision and assignee, maintained by each workflow owner's writer and
  rechecked by the owner on open. Home's task count and first page, the shell badge and Needs you would read one
  indexed statement instead of a dozen owner queries, at every queue size. It is the better long-term design: decision 6
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
  - Migrate one owner at a time behind decision 6's section for that owner, starting with Claims and Leave, which hold
    most rows.
- **Own leave balance snapshot**: per employment and leave type, the current cycle's balance, pending and Apply figures,
  rewritten by the ledger and request writers. Time Off and At a glance would read one row set; the calculators stay
  the writer-side owner.
- **Holiday calendar by company and calendar period**: resolved original holidays per (company, calendar, year),
  refreshed by holiday and assignment writers, replacing the per-year resolution chain on every view.
