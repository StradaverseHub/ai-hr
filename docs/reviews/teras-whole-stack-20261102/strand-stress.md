# Stress and concurrency review — teras / Noveri (claude/teras-review, diff since 7fe8f8627)

Reviewer strand: duplicate effects, races, lock waits, unbounded queries, timeouts, memory growth.
Method: static reading only (no tests, type checks or databases run, per brief). Every line reference is to the checkout at
`/Users/zenlam/Projects/ai-hr/.claude/guarded-worktrees/compassionate-goldwasser-551770`.
Draft tests: `/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr--claude-guarded-worktrees-compassionate-goldwasser-551770/bb7d5878-da87-4535-85c9-df8d49c85b44/scratchpad/review/tests/stress/` (written as if at `test/review/<name>.test.ts`; imports use `../../`).

## Summary

No blocker. The central safety question — can a leave proposal be applied twice, or race the Approvals page into two
decisions — holds: single use is enforced by the pre-existing review custody and native row locks, not by an
app-level check (see Coverage C1–C3). The defects are in the new mandate runner's daily limit, in how the new
recommender and digest scale, and in harness bounds.

| # | Severity | Title | Location | Test |
|---|---|---|---|---|
| M1 | medium | `maxRunsPerDay` is not enforced under overlapping runs | core/mandates/run.ts:63-71, 94-99 | mandate-run-concurrency.test.ts |
| M2 | medium | A stopped run consumes the day's run allowance | core/mandates/run.ts:63-65 | mandate-run-concurrency.test.ts |
| M3 | medium | Recommender never says "recommend approve" once the approver can see 200 approved (or pending) requests; coverage check scans the whole visible tenant | core/recommenders/leave-decision.ts:104, 122-125, 130-131 | recommender-digest-scale.test.ts |
| M4 | medium | One model step can dispatch unlimited tool calls; trace then exceeds the outcome record ceiling and the turn cannot be recorded | core/harness/runner.ts:177-205; core/outcome-record/record.ts:46 | harness-stress.test.ts |
| M5 | medium | Registry page loads every outcome record of the tenant on each render | core/agent-registry/export.ts:47-55; app/control-tower/agents/features/page.tsx:16 | none (described) |
| M6 | medium | Harness proposals read the 50 most recent visible requests tenant-wide; own requests / assigned requests beyond them are unreachable | core/proposals/suggested.ts:54, 63 | none (described) |
| M7 | medium | AI-centre inbox recomputes the full digest (up to 20 companies × copilot + compliance) and the approvals list twice on every render | app/assistant/centre/inbox.tsx:42-52; core/digest/daily-digest.ts:54-77 | recommender-digest-scale.test.ts (time bound) |
| L1 | low | No per-person uniqueness for daily-digest mandates: N mandates give N digests a day | core/mandates/mandates.ts:107-125; 0890:60-81 | mandate-run-concurrency.test.ts |
| L2 | low | Opening `?recommend=` writes a new outcome record on every GET render | app/assistant/centre/inbox.tsx:59-60; app/assistant/centre/recommendation.ts:18-22 | none (described) |
| L3 | low | Concurrent first-time worker-switch changes write false "off→on" audit events | core/agent-registry/controls.ts:88-96 | worker-switch-race.test.ts |
| L4 | low | Overlapping turns in one conversation lose a task-memory update (last write wins) | core/harness/runner.ts:119, 221-223; core/harness/task-memory-store.ts:36-41 | harness-stress.test.ts |
| L5 | low | No cap on conversation history sent per model call | core/harness/runner.ts:112, 130; core/harness/spec.ts:90-96 | harness-stress.test.ts |
| L6 | low | No index for outcome-record lookups by grantor or agent identity used on every inbox/registry render | db/migrations/0890:161-163; core/digest/daily-digest.ts:103-106; core/agent-registry/views.ts:35-36 | recommender-digest-scale.test.ts (EXPLAIN) |
| L7 | low | Team summary with >200 distinct request ids throws before recording; the run leaves no record and does not count | core/mandates/team-absence-summary.ts:47; core/outcome-record/record.ts:32; run.ts:101 | none (described) |
| L8 | low | Decision follow-ups have no uniqueness; repeated "accepted" rows inflate agreement rates | 0890:167-187; core/recommenders/leave-decision.ts:191-202; core/agent-registry/views.ts:58-64 | none (no caller today) |
| L9 | info | Each harness-prepared decide proposal takes the tenant-wide exclusive access-configuration advisory lock | core/leave.ts:6116; core/access-configuration-lock.ts:5-7 | none |

---

## Findings

### M1 (medium) — `maxRunsPerDay` is not enforced when runs of one mandate overlap
Evidence (verified by reading):
- core/mandates/run.ts:63-65 counts today's records in the first transaction:
  `const [runs]=await tx.select({n:count()}).from(terasOutcomeRecord).where(... eq(terasOutcomeRecord.mandateId,mandateId),gte(terasOutcomeRecord.startedAt,dayStart)));`
- The job then runs outside any transaction (run.ts:89-92), and the record is written in a second transaction.
- The second transaction's re-check explicitly ignores the limit (run.ts:97):
  `const changed=again.mandate.version!==first.mandate.version||again.checks.some(item=>item.check!=='run_limit'&&item.result!=='pass');`
- No lock (advisory or row) and no unique slot constraint serialises runs of the same mandate (0890 has none; the agent
  principal cannot `FOR UPDATE` the mandate row because `teras_mandate_change` requires `current_agent_principal() IS NULL`, 0890:288-291).
Reproduction: administrator enables `daily_digest` with `maxRunsPerDay:1`; a person grants with `maxRunsPerDay:1`;
the scheduler (or a retry, or two scheduler instances) starts 8 runs of that mandate together. Observed (by reading): every
run's first transaction sees n=0, all 8 prepare and write `prepared` records. Expected: exactly one prepared run; the rest stopped with `run_limit`.
The window is the whole job duration (digest: listPendingTasks plus, for administrators, up to 40 owner reads).
Impact: the administrator's ceiling (key 1, ADR §3.10) is not a ceiling under concurrency; extra job reads under the grantor's authority and extra records.
Confidence: High (logic); Medium that 8-way Promise.all reproduces every time (pool max 10, db/client.ts:175; first transactions queue ahead of job reads).
Fix: in the record transaction take `pg_advisory_xact_lock(hashtextextended('teras-mandate-run:'||mandate_id,0))`, recount, and include `run_limit` in the re-check (count excluding nothing, since the current run is not yet written); or reserve a slot first with a unique `(tenant_id, mandate_id, hr_day, slot)` row inserted before the job runs.
Test: `REVIEW medium: maxRunsPerDay=1 holds when 8 runs of the same mandate overlap`.

### M2 (medium) — A stopped run uses up the day's run allowance
Evidence: run.ts:63-64 counts every `teras_outcome_record` for the mandate since the HR day start, whatever its `outcome_kind`; run.ts:94-112 writes a record for every run including stopped ones (`outcomeKind:stopped?'stopped':'prepared'`).
Reproduction: administrator presses the tenant stop switch; the daily scheduler runs the digest mandate (stopped, record written);
administrator resumes; the next run the same HR day is stopped again with `run_limit` failing, and every further retry appends another stopped record.
Expected: only prepared runs count toward `maxRunsPerDay`. The existing test test/mandate-work-jobs.test.ts:72-76 masks this with `arrayContaining(['job_type_enabled'])`.
Confidence: High.
Fix: count `outcome_kind='prepared'` only (the index teras_outcome_record_mandate_idx still serves it).
Test: `REVIEW medium: a run stopped by the stop switch does not use up the day's run allowance`.

### M3 (medium) — Recommender degrades to "needs review" for any approver with broad visibility
Evidence (verified by reading):
- core/recommenders/leave-decision.ts:104 `const READ_CAP=200;` and :122-125:
  `listLeaveRequests(ctx,undefined,READ_CAP,{status:'approved'}),listLeaveRequests(ctx,undefined,READ_CAP,{status:'pending'})` … `complete:approved.length<READ_CAP&&pending.length<READ_CAP`.
  These read everything the approver can see (core/read.ts:1550-1577, "admins everything, managers their reports"), not the applicant's employment, and then filter in memory.
- `complete:false` → `own_overlap` = `missing` (leave-decision.ts:83) → verdict `needs_review` (:56).
- :130-131 `plannedAbsences(ctx,undefined,{from,to})` without `personIds` loads every active employment the caller can see (core/read.ts:2051-2090); for an HR approver anyone away tenant-wide makes `team_coverage` "unusual".
- Every recommendation also re-runs `pendingLeaveTaskMetadata(ctx)` (:114) and three `listLeaveRequests` with the per-row `LATERAL app.delegated_approval_subject` (core/read.ts:1559); `prepareLeaveDecideProposal` repeats listLeaveRequests and plannedAbsences again (core/proposals/leave-decide.ts:43-47).
Reproduction: a manager whose direct reports have 200 approved requests in total (any history, any dates) opens a clean request; observed verdict `needs_review` with own_overlap `missing`. Expected: own_overlap computed from the applicant's own requests only → `recommend_approve`.
Impact: the worker's signal is meaningless on real tenants (safe direction: it never wrongly approves), agreement metrics are skewed, and each call costs several tenant-wide reads.
Confidence: High for the cap logic; Medium for the HR-approver coverage effect (depends on which approver kinds are assigned in practice).
Fix: query the applicant's own overlapping approved/pending requests by `employment_id` and date range (no cap needed); pass `personIds` (the caller's visible team, or the applicant's team) to plannedAbsences, or a dedicated count query.
Tests: `REVIEW pass: baseline …` and `REVIEW medium: 200 visible approved requests of OTHER people do not make the applicant's own-overlap check "missing"`.

### M4 (medium) — Unbounded tool calls per model step; trace becomes unrecordable
Evidence: core/harness/runner.ts:177 `for(const call of response.toolCalls){` runs every call in the response; only identical calls are deduplicated (:186-188) and `maxSteps:7` bounds steps, not calls. core/outcome-record/record.ts:46 `reads:z.array(OutcomeReadSchema).max(64)`; trace-persistence.ts:47 maps every trace call to a read, so `persistTurnTrace` (:74-77) throws `OutcomeRecordRefused('invalid')` for >64 calls.
Reproduction (scripted model): one step returning 100 `product_guidance` calls with distinct queries. Observed: 100 executions in one step; `OutcomeRecordInput.safeParse(outcomeRecordFromTrace(trace)).success === false`. Expected: a per-step and per-turn call cap from HARNESS_SPEC (e.g. ≤ the record ceiling), excess recorded as refused, and the turn still recordable.
Impact once wired: a prompt-injected or misbehaving model multiplies DB reads per turn; the audit record for exactly those turns is lost. Runner is test-only today (runner.ts:44-46, 104).
Confidence: High.
Fix: `budgets.maxCallsPerStep` / `maxCallsPerTurn` in HARNESS_SPEC; record surplus calls as `not_offered` without running them, and collapse trace reads beyond 64 into a counted tail.
Test: `REVIEW medium: one model step cannot dispatch an unbounded number of tool calls; the turn stays recordable`.

### M5 (medium) — Registry page loads the tenant's entire outcome history each render
Evidence: core/agent-registry/export.ts:47-55 selects every `teras_outcome_record` row (with `reads` jsonb) for the tenant when `since` is undefined, plus a grouped follow-up scan; app/control-tower/agents/features/page.tsx:16 calls `outcomeSummary(session)` with no `since`. Records are append-only and are written per turn, per recommendation (including per GET, L2) and per mandate run (including stopped retries, M2).
Impact: memory and latency grow linearly with history on the Control Tower page; no upper bound.
Confidence: High (reading); timing not measured.
Fix: aggregate in SQL (`count(*) group by agent_identity, outcome_kind, …`) and default `since` to a window (e.g. 90 days) for the page.

### M6 (medium) — Harness proposals only see the 50 newest visible requests
Evidence: core/proposals/suggested.ts:54 `listLeaveRequests(ctx,undefined,50)` then `.filter(row=>row.personId===ctx.personId…)`; :63 `listLeaveRequests(ctx,undefined,50,{status:'pending'})` (visible, not assigned) for the numbered choice list.
Reproduction: an HR administrator (sees all requests) asks to cancel their own pending leave in a tenant with >50 newer requests: their request is not in the 50 → no card. A manager with >50 visible pending requests cannot reach older assigned ones by number.
Confidence: High. Functional at scale rather than a race; included because it is a large-tenant behaviour.
Fix: filter by `person_id = ctx.personId` (own) and by the assigned-task owner (`pendingLeaveTaskMetadata`) in SQL before the cap.

### M7 (medium) — Inbox render cost on large tenants
Evidence: app/assistant/centre/inbox.tsx:42-49 calls `listPendingTasks`; :52 then calls `digestPreview(session)`, which calls `listPendingTasks` again (core/digest/daily-digest.ts:56) and, for administrators, loops sequentially over up to 20 companies running `setupCopilot` and `complianceWorklist` each in its own transaction (:62-72). With `?recommend=` the recommender adds M3's reads (inbox.tsx:59-60).
Impact: every inbox view by an administrator performs up to ~40 owner computations plus two full approval-inbox builds. Not a correctness issue; a latency and DB-load risk at thousands of employments.
Confidence: Medium (cost of setupCopilot/complianceWorklist on 2000 employments not measured; the draft test's 10 s bound is a guess to be calibrated on the CI runner).
Fix: show `latestDailyDigest` (already prepared by the mandate run) instead of recomputing on render, or compute the preview lazily (explicit "refresh"), and reuse the inbox's `listPendingTasks` result.
Test: `REVIEW medium: the inbox digest for an administrator stays within a bounded time on 2000 employments`.

### L1 (low) — Several daily-digest mandates per person
Evidence: grantMandate (core/mandates/mandates.ts:107-125) inserts without checking for an active mandate of the same job type; 0890:60-81 has no partial unique index. Each mandate has its own `maxRunsPerDay`.
Reproduction: a person grants `daily_digest` twice; both run the same day → two prepared digests. Expected (ADR "a daily 'what needs you'"): one per person per HR day.
Confidence: High (reading); severity low because it is the person's own counts.
Fix: partial unique index `(tenant_id, grantor_user_id, job_type) WHERE revoked_at IS NULL` (plus expiry handling in code), or refuse in grantMandate under an advisory lock.
Test: `REVIEW low: one person gets at most one prepared daily digest per HR day …`.

### L2 (low) — `?recommend=` writes an outcome record on each GET render
Evidence: inbox.tsx:59-60 calls `readLeaveRecommendation` during server render; recommendation.ts:22 → `recommendLeaveDecision`, which always writes an outcome record (leave-decision.ts:151-162). The inbox file header says "Nothing is written, prepared or decided here" (inbox.tsx:34). `prefetch={false}` on the link (components/ai-centre/leave-recommendation.tsx:13) limits prefetch writes, but every reload/back-navigation/RSC refetch appends another record.
Impact: duplicate records, unbounded growth feeding M5, run counts per worker inflated. Confidence: High.
Fix: reuse the latest record for (asker, leaveRequestId, request xmin) within a short window, or compute without recording on render and record only on the approver's explicit action.

### L3 (low) — Worker-switch audit trail wrong under concurrent first changes
Evidence: controls.ts:88-90 `select … for('update')` locks nothing when no row exists; all concurrent first-time callers read `from=false`; the upsert (:92-93) serialises them; each appends an event and an outcome record claiming `from:false` (:95-100). Same-value writes do not bump `version` (0890:15-19 ignores `changed_at`/`changed_by_user_id`).
Reproduction: 8 concurrent `setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true})` on a fresh tenant → 8 events "off→on", version 1. Expected: one transition, seven no-ops (`from=true`).
Fix: `insert … on conflict do nothing` a default row first (or `pg_advisory_xact_lock` on tenant+worker), then `select … for update`.
Test: `REVIEW low: 8 concurrent first-time switch-ons …`.

### L4 (low) — Task memory: overlapping turns lose an update
Evidence: runner.ts:119 loads memory, :221-223 saves `advanceMemory(...)`; PostgresTaskMemoryStore.save (task-memory-store.ts:36-41) is an unconditional upsert. Two turns in one conversation (double submit) both start from `turns:0` and the later save overwrites the earlier one, dropping its `openProposals` and `completedReads`.
Impact: advisory memory only (re-authorised every turn), so low; a dropped open proposal still exists as its custody row. Confidence: High.
Fix: compare-and-set on `turns` (`update … where memory->>'turns' = $prev`) and retry/merge, or serialise turns per conversation.
Test: `REVIEW low: two overlapping turns in one conversation both count in task memory`.

### L5 (low) — No history cap
Evidence: runner.ts:112-113 accepts any `history` length; :130 sends all of it on every call; HARNESS_SPEC.history (spec.ts:90-96) defines markers only. `maxTotalTokens` (spec.ts:36) is checked only after the provider reports usage (runner.ts:157), so the first call of a long conversation is sent in full, and once the history alone exceeds the budget every later turn ends with the budget reply.
Fix: `history.maxMessages` / `maxChars` in the spec, keeping the most recent turns; memory carries the goal.
Test: `REVIEW low: a single model call is never sent more history than the turn's own token budget`.

### L6 (low) — Missing indexes for per-render outcome-record lookups
Evidence: 0890:161-163 creates only `(tenant_id,mandate_id,started_at) WHERE mandate_id IS NOT NULL` and `(tenant_id,asked_by_user_id,started_at)`. `latestDailyDigest` filters `grantor_user_id` + `outcome_kind` and orders by `started_at` (daily-digest.ts:103-106), run on every inbox render; `lastRunTx` filters `agent_identity` (+ `reads @>` jsonb) (views.ts:34-36), run per worker on the registry page. Both scan the tenant's records.
Fix: indexes `(tenant_id, grantor_user_id, started_at DESC)` and `(tenant_id, agent_identity, started_at DESC)`.
Test: `REVIEW low: teras_outcome_record has an index …` (EXPLAIN with `enable_seqscan=off`).

### L7 (low) — Team summary can exceed the record's ref ceiling and leave no record
Evidence: team-absence-summary.ts:47 `refs:[...new Set(requestIds)]`; record.ts:32 `refs:z.array(ref).max(200)`; members are capped at 200 (:29) but one member may have several requests in a week (half days, hourly). writeOutcomeRecordTx throws (record.ts:65) inside run.ts:101, which is not caught: runMandate rejects, no record is written, and (because of M2's counting) the run does not count, so a scheduler retry repeats the full job.
Confidence: Medium (needs >200 distinct requests in a week for one manager's team). Fix: truncate refs to 200 and record `truncated` in outcome.

### L8 (low) — Duplicate decision follow-ups
Evidence: 0890:167-187 has no uniqueness on `(tenant_id, record_id, kind)` for `decision`; recordRecommendationDecision (leave-decision.ts:191-202) appends unconditionally; agreement rates count rows (views.ts:58-64). No caller exists today (grep), so this is latent.
Fix: partial unique index on `(tenant_id, record_id) WHERE kind='decision'` with `on conflict do nothing`.

### L9 (info) — Tenant-wide exclusive lock on each decide-proposal preparation
Evidence: prepareLeaveDecideProposal → prepareLeaveDecisionReview → lockReviewedLeaveDecisionSourceTx, whose first statement is `pg_advisory_xact_lock(hashtextextended('access-configuration:'+tenantId,0))` (core/leave.ts:6116; core/access-configuration-lock.ts:5-7), an exclusive, waiting lock. Pre-existing for Assistant decision reviews; new is that a harness turn can trigger it whenever a person's words ask to approve (suggested.ts:60-77). Concurrent approve-turns in one tenant serialise for the length of the prepare transaction. Not measured; flagged so the wiring step load-tests it.

---

## Coverage: checked and found sound

- C1 Proposal single use (leave decide). The proposal applies nothing (core/proposals/leave-decide.ts:1-14, 69-77); confirm goes to the review custody (core/assistant-actions/generic-review-custody.ts confirm → `settleReviewCustodyTx`, `completeRow` with expected digest), whose native source takes `FOR UPDATE NOWAIT` on the request and its steps and re-nominates under the lock (core/leave.ts:6131-6136), and whose reviewed digest includes request/type/step `xmin` (core/leave.ts:6149-6159). A second confirm replays the completed receipt (test/proposal-leave-decide-roundtrip.test.ts:89-90 shows sequential replay). Pass tests: `8 concurrent confirms … exactly one decision`.
- C2 Proposal vs Approvals page. `decideLeave` locks the same row `FOR UPDATE` (core/leave.ts:6038); the reviewed path requires `status='pending'` and the same current step under the lock (core/leave.ts:6120-6124). Two approvers, or one approver on both paths, produce one decision. Pass tests: `a proposal confirm raced against the Approvals page decision applies one decision only` and `… after the Approvals page already decided is refused`. (Variant with an HR administrator as the second approver not exercised: whether HR may decide a manager step depends on assertCanDecideLeaveStep, unverified here.)
- C3 Leave cancel / apply proposals likewise delegate to custody (leave-cancel.ts:57-72; leave-apply.ts:25-43) or to the native /leave form that re-runs every gate (leave-cancel.ts:9-16); nothing in core/proposals writes leave.
- C4 Outcome record idempotency per run: `UNIQUE (tenant_id, run_id)` (0890:152); persistTurnTrace uses the trace's `turnId` as run id (trace-persistence.ts:57), so a double persist is refused by the database.
- C5 Mandate revoke/renew races: version-guarded `UPDATE … WHERE version = old` (mandates.ts:149-151, 181-183) plus the guard trigger refusing any change to a revoked row (0895:96-97); a concurrent second revoke gets no row → `not_found`. Run-time revocation is caught by the record-time version re-check (run.ts:95-98).
- C6 Enablement and stop-switch upserts use `ON CONFLICT` on the primary key (mandates.ts:45-46, 59-60): no duplicate rows under concurrency.
- C7 Bounded reads: listOutcomeRecords clamps limit to 1..500 (record.ts:117); workerDetail uses `RECENT=20` (views.ts:109, 124-139); digest company loop capped at 20 (daily-digest.ts:35, 63) and refs at 200 (:59); team summary members capped by `maxPeople ≤ 200` (job-types.ts:42; team-absence-summary.ts:29); task memory bounded (`maxCompletedReads:20, maxOpenProposals:5, maxGoalChars:300`, spec.ts:153; memory.ts:78-82).
- C8 Turn budgets: steps (7), per-call timeout via `AbortSignal.timeout` bounded by remaining wall time (runner.ts:161-162), wall time 180 s, spend — all checked before each call (runner.ts:156-158).
- C9 Task memory isolation across tenants/logins: store keyed by (tenant, user, conversation) (memory.ts:40; 0890:203-210 PK) with RLS to the own login (0890:319-321). Pass test: `30 concurrent turns across 3 tenants keep each conversation's memory with its own tenant and login`.
- C10 Recommender record gating: the record is written only if the worker gate still passes in the record transaction (leave-decision.ts:151-152) (READ COMMITTED, so a switch-off committing in the same instant can still slip one record; acceptable).

## Facts, assumptions, unknowns
- Facts: all line-referenced code paths above, read in this checkout.
- Assumptions: the scheduler for mandate runs is not yet wired (run.ts:16-17 says so), so M1/M2 bite when it is, or under manual/retry runs; the harness runner is test-only (runner.ts:42-46, 104), so M4/L4/L5 are pre-wiring.
- Unknowns: real timings for M3/M5/M7 on 2000+ employments (time bounds in the drafts are initial guesses to calibrate on the GitHub runner); whether 8-way Promise.all reproduces M1 on every run (expected yes given pool size 10 and the job's multiple round trips).

## Draft tests (all in tests/stress/)
- mandate-run-concurrency.test.ts — M1, M2, L1 (fail on current code).
- recommender-digest-scale.test.ts — pass baseline; M3 (fails); M7 time bound (calibrate); L6 EXPLAIN (fails).
- proposal-decide-concurrency.test.ts — C1/C2 pass tests (expected to pass).
- worker-switch-race.test.ts — L3 (fails).
- harness-stress.test.ts — C9 pass; M4 (fails); L5 (fails); L4 with PostgresTaskMemoryStore (fails).
