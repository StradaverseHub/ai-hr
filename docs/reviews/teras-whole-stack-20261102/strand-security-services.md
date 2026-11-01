# Security and access review: Teras services and database layer

Reviewer strand: security and access (blocker class). Checkout `/Users/zenlam/Projects/ai-hr/.claude/guarded-worktrees/compassionate-goldwasser-551770`, branch `claude/teras-review`, HEAD `7d57fc6a4`, diff base `7fe8f8627`. I only read the code. I ran no tests, type checks, builds or databases. The draft tests are in `tests/security-services/` next to this file.

## Summary by severity

| Sev | # | Title | Where |
|---|---|---|---|
| blocker | 0 | None found. On every path I traced, a tenant, company, person or role boundary was enforced in code, by RLS, or by both. | |
| high | 0 | | |
| medium | M1 | The explainers worker switch is never enforced. Explainer tools are offered while the switch is off (the default). | core/explainers/capabilities.ts:32-33, core/harness/tools.ts:58 |
| medium | M2 | The approvals chooser lists pending requests the caller can see but cannot decide, and numbers its choices over those requests. | core/proposals/suggested.ts:63-71 |
| medium | M3 | Recommendation agreement follow-ups are not bound to the decider or to an actual decision. A group admin, or repeat calls, can rewrite agreement metrics. | core/recommenders/leave-decision.ts:191-202, db/migrations/0890:309-313, core/agent-registry/views.ts:58-66 |
| low | L1 | The outcome record's `trace` field is unvalidated (`z.record(z.string(), z.unknown())`). Free text can be stored in it, which contradicts the module's invariant. | core/outcome-record/record.ts:53, 0890:151 |
| low | L2 | `app.teras_is_grantor_manager` differs from the My Team definition of "current manager": `terminated_on IS NULL` versus `> today`, and `current_date` versus the HR date. | 0895:66-77 vs core/my-team-scope.ts:37-43 |
| low | L3 | Task memory is erased only when `assistant_exchange` rows retire. It has no retention limit of its own and stores whole signed proposals. | 0890:212-234, core/harness/memory.ts:20-30 |
| low | L4 | The read policies on mandates and outcome records accept `app.is_group_admin()` without `principal_snapshot_current()`, unlike the write policies. | 0890:275-277, 304-307 |
| info | I1-I5 | See the end of this report. | |

---

## Findings

### M1 (medium): the explainers worker switch is displayed but never enforced

**Evidence (verified by reading)**
- Registry: `core/agent-registry/workers.ts:128-135` declares `explainers` with `switch:{kind:'worker_control',workerId:'explainers'}`. The switch is off by default (0895:13-21). `setWorkerSwitch` lets a group admin change it (`controls.ts:78-103`), and `listWorkers` shows its state (`views.ts:91`).
- The tool offer ignores it: `core/explainers/capabilities.ts:32-33`
  ```ts
  export const terasCapabilitiesFor=(ctx)=>TERAS_CAPABILITIES.filter(row=>(!row.admin||isAdmin(ctx))&&(row.module===null||isModuleEnabled(ctx,row.module)));
  ```
  `core/harness/tools.ts:58` binds every capability that filter returns. `grep workerRunGate` across core/lib/app/components finds only the recommender (`leave-decision.ts:110,152`). Nothing gates the explainers.
- The registry admits that the stop switch is not honoured (`stop.honoured:false`, workers.ts:133). It does not admit that the on/off switch is not honoured either.

**Reproduction:** in a fresh tenant the switch is off, and `workerRunGate(groupAdmin,'explainers')` returns `{run:false,reasons:['switched_off']}`. Yet `nativeToolProvider(employee,{companyId},false)` still returns bindings for `explain_payslip_statutory`, `explain_leave_entitlement` and `explain_attendance_day`. The first two bind whenever their module is enabled for the tenant. Observed: offered. Expected: not offered, because the administrator turned the worker off (or never turned it on).

**Impact:** this is a control-integrity problem, not a data leak. Each explainer reads only the caller's own records, under the caller's own RLS. The problem is that an administrator who keeps the worker off still has the AI explaining payslip and statutory figures to staff, and the Workers page says it is off. The harness is not wired to production yet (header comments), so exposure is latent today. **Confidence: High.**

**Fix:** in `nativeToolProvider`, or in an async `terasCapabilitiesFor`, read `workerRunGateTx(tx,ctx,'explainers')` and offer no explainer when `run` is false. Keep `setup_copilot` outside this gate if that is intended. Add the check to each explainer's `run()` as well, so a stale offer still refuses.

**Test:** `findings.test.ts` › `REVIEW medium: with the explainers worker switched off …` fails today.

---

### M2 (medium): the approvals chooser includes requests the caller cannot decide

**Evidence:** `core/proposals/suggested.ts:63-71`
```ts
const all=(await listLeaveRequests(ctx,undefined,50,{status:'pending'})).filter(row=>row.personId!==ctx.personId).sort(...);
const assigned=request!==null?(request>=1&&request<=all.length?[all[request-1]]:[]):all.filter(row=>date===null||String(row.startDate)===date);
if(assigned.length>1){ return {kind:'choose', pending: assigned.slice(0,10).map(row=>({request:all.indexOf(row)+1, applicant:String(row.employee), leaveType, days, starts, startDate, endDate}))} }
```
`listLeaveRequests` (core/read.ts:1550-1576) returns every pending request that RLS shows the caller. That includes a manager's reports at any step, all company requests for an HR admin, and so on. It is not the native assignment. The repository already has the right owner, `pendingLeaveDecisionChoiceMetadataTx` (core/leave.ts:12249-12271). Its contract says "No unassigned candidate count or existence escapes the owner", and the inbox's `pendingLeaveTaskMetadata` (core/leave.ts:12273) follows the same rule. suggested.ts bypasses both. The variable is named `assigned`, but it holds visible requests, not assigned ones.

**Reproduction:** a manager has two reports with pending leave. The colleague's current step is assigned to `hr_admin`, so the manager can see the request but not decide it. The manager says "Please approve the leave", and `prepareSuggestedProposal(manager,'approvals.leave.decide',{}, …)` returns `{kind:'choose', pending:[…'Fictional Matrix Colleague'…]}`. Expected: no choice list. Exactly one request is assigned, so the code should go straight to the decide preparer. In general the list should hold assigned requests only. Picking the colleague's number later yields nothing, because `prepareLeaveDecideProposal` refuses through the native gate. No decision can be forged.

**Impact:**
- Applicant names and dates go to the model, which receives them as placeholders, and are restored to the caller as "waiting for your decision". The caller can already read these requests, so no data crosses an access boundary.
- This minimisation breach contradicts both the native chooser's contract and the CHOOSE_NOTE ("waiting for this person's decision").
- The page limits to 50 rows ordered by `createdAt desc`, so a request that really is assigned can drop off the list. The request is then not listed at all.
- `more` counts unassigned requests.

**Confidence: High** that this happens. Medium on severity.

**Fix:** build `all` from `pendingLeaveDecisionChoiceMetadataTx` (it carries `currentStepId` and `applicantLabel`), then join `listLeaveRequests` only for the display fields of those ids. Use the native step id rather than the ad hoc `select … leave_approval_step … limit 1` at suggested.ts:74.

**Test:** `findings.test.ts` › `REVIEW medium: the "choose" list names only requests the caller is assigned …` fails today.

---

### M3 (medium): agreement follow-ups are forgeable and repeatable

**Evidence**
- `core/recommenders/leave-decision.ts:191-202`: `recordRecommendationDecision(ctx,{recordId,decision})` takes `decision` from the caller. It never checks that the caller decided the request, that a decision exists, or that no follow-up was already recorded. It reads the record under RLS, then calls `recordOutcomeFollowup`.
- `core/outcome-record/record.ts:89-102`: `recordOutcomeFollowup` accepts `decision` and `undo` follow-ups on any record the caller can read.
- 0890:309-313: the insert policy admits `r.asked_by_user_id=current_user OR r.grantor_user_id=current_user OR app.is_group_admin()`.
- `core/agent-registry/views.ts:58-66` and `export.ts:55-68` count every follow-up row, not the latest per record.

**Reproduction:**
1. A group admin calls `recordRecommendationDecision(groupAdmin,{recordId:<manager's recommendation>,decision:'rejected'})`. A `rejected` follow-up is written with `by_user_id=groupAdmin` against the manager's record. A group admin can also append `undo` to any record through `recordOutcomeFollowup`.
2. The manager calls the function three times with `approved`. Three `accepted` rows are written, and `metrics.decided` becomes 3 for one recommendation.

Expected: only the person who decided the request writes the follow-up, once, and only after a real decision tied to it (for example the decision event or approval step id). Observed: anyone who can read the record can append, as often as they like.

**Impact:** the outcome record is an audit trail. Acceptance and reversal rates are shown to customers (§11.3 change 5) and feed the decision to trust a worker. They can be skewed by repetition, or by an administrator attributing decisions to records they did not decide. Nobody can read or decide anything they should not, but the audit trail can be falsified. **Confidence: High.**

**Fix:**
- Restrict the `decision` and `undo` follow-up insert policy to `r.asked_by_user_id=current_user` (or the grantor for mandate records). Drop the `is_group_admin()` branch for those kinds.
- Add a partial unique index on `(tenant_id,record_id) WHERE kind='decision'`.
- Bind `recordRecommendationDecision` to the native decision. Derive `decision` from the leave approval step or event the caller wrote, instead of accepting it as input.

**Tests:** `findings.test.ts` › `REVIEW medium: a group administrator cannot append…` and `REVIEW low: one recommendation carries at most one agreement decision…` both fail today.

---

### L1 (low): the `trace` field accepts arbitrary content

**Evidence:**
- `record.ts:10-11` states the invariant: "every string is short and every object is flat, so a caller cannot smuggle a record's contents, a question or a reply into the record."
- `record.ts:53` validates `trace` only as `z.record(z.string(),z.unknown()).nullable().optional()`.
- The database checks only `jsonb_typeof(trace)='object'` (0890:151). The RLS insert policy lets any login write a person-authority record for itself.
- Group admins can read every record (0890:304-307).

Today's only writer, `storedTrace` (trace-persistence.ts:26-41), stores only kinds and counts, so this is a schema gap rather than a live leak.

**Reproduction:** `writeOutcomeRecord(employee,{…,trace:{question:'<free text about a colleague>'}})` succeeds. **Confidence: High.**

**Fix:** validate `trace` against a strict zod schema mirroring `storedTrace`'s output (bounded strings, enums, counts). Optionally add a size CHECK in SQL.

**Test:** `findings.test.ts` › `REVIEW low: the outcome record refuses free text in trace` fails today.

### L2 (low): the "current manager" rule differs between the definer function and My Team

**Evidence:**
- 0895:73-75 uses `rl.valid_from<=current_date … AND sub.terminated_on IS NULL AND mgr.terminated_on IS NULL`.
- core/my-team-scope.ts:37-43 uses the HR date (`todayInKualaLumpur()`) and `m.terminated_on IS NULL OR m.terminated_on>today`.

As a result:
- A manager serving notice, with a future `terminated_on`, cannot revoke a report's mandate or see it, while still being that report's manager everywhere else.
- A report with a future termination date also falls out of the set.
- Around midnight, `current_date` (server timezone) and the HR date (UTC+8) can disagree on line validity.

This fails closed (it refuses more, never less), so it is low. **Confidence: High** (verified by reading).

**Fix:** use the same predicate as `direct` in my-team-scope, with the HR date passed in or derived the same way.

**Test:** `findings.test.ts` › `REVIEW low: a manager whose employment ends in the future …` fails today.

### L3 (low): task memory has no retention of its own

**Evidence:**
- 0890:212-234: rows are deleted only by a trigger on `assistant_exchange` retire or delete.
- The Teras harness does not write `assistant_exchange` (`grep assistant_exchange core/harness` finds nothing).
- `TaskMemory` holds `goal`, `selections` and `openProposals` (memory.ts:20-30). A decide proposal carries `facts` with the applicant's balance, dates and others away.

Once the runner is wired, a login that never produces `assistant_exchange` rows keeps its task memory indefinitely. Archiving the user or a PDPA erasure does not obviously reach it. RLS correctly confines it to the owning login (0890:319-321), and the store re-checks the owner (task-memory-store.ts:25). **Confidence: Medium.** It depends on how the runner is wired.

**Fix:**
- Add an `updated_at` time-to-live sweep, or drop `openProposals` older than their `expiresAt` on save.
- Hook person erasure.
- Make the erasure trigger fire on the harness's own transcript once one exists.

### L4 (low): read policies skip the principal snapshot check

0890:275-277 (`teras_mandate_read`), 304-307 (`teras_outcome_record_read`) and 0895:28-29 admit `app.is_group_admin()` from the session's claimed grants without `app.principal_snapshot_current()`, which the write policies on the same tables require. A group admin whose grant was removed keeps read access for the life of that session. This follows the existing session model, so it is low. **Confidence: Medium.** I did not compare it with the policy convention on older tables.

**Fix:** add `AND app.principal_snapshot_current() IS TRUE` to the group-admin branch of the read policies.

---

## Role matrix: what I checked and how each service behaves

The eight actors are built in `tests/security-services/_actors.ts`:

- **employee:** the applicant.
- **manager:** the applicant's direct manager.
- **covering delegate:** modelled as a `reporting_line` with `line_type='delegate'`, subordinate = delegator, manager = stand-in (db/schema.ts:111-114, `core/org.ts setReportingLine`).
- **company HR admin:** `hr_admin` with `companyId` set.
- **group admin:** `isGroupAdmin` = `super_admin` (any scope) or `hr_admin` with null `companyId` (lib/authz-model.ts:17-19, mirrored by `app.is_group_admin()` in 0016:38-44).
- **payroll partner:** `payroll_partner`.
- **other company's admin:** an HR admin of another company in the same tenant.
- **other tenant:** a user from another tenant.

`role-matrix.test.ts` asserts each row below. Those tests are expected to pass.

| Service | Allowed | Refused (code / RLS) | Evidence |
|---|---|---|---|
| setWorkerSwitch | group admin of own tenant | everyone else: `not_administrator` in code, and the insert/update policy requires `is_group_admin()` and a current snapshot | controls.ts:80; 0895:31-37 |
| setJobTypeEnablement, setMandateStopSwitch, setManagerRevocationPolicy | group admin | others in code; RLS 0890:254-271 | mandates.ts:26,39,55,70 |
| grantMandate (team summary) | manager. HR admins also pass `hasTeamAccess` (see I2) | employee, delegate, payroll: `no_authority`; other tenant: key 1 closed; DB grant policy needs both keys, grantor = caller, current snapshot | mandates.ts:107-125; 0890:279-286 |
| grantMandate (daily digest) | any current login, for self only (`scope.team='self'`) | agent contexts; a login without a person | job-types.ts:45-46; mandates.ts:29-34 |
| listMandates | grantor, group admin, and the grantor's manager only when the tenant policy allows | all others: RLS | 0890:275-277; 0895:129-131 |
| revokeMandate | grantor; group admin; the grantor's manager only when the policy is on | all others: not found by RLS. A manager with the policy off: not found (RLS hides the row) and `manager_revocation_not_allowed` in code. The guard trigger refuses mislabelled `revoked_by`, renewal by non-grantors, field edits and deletes | mandates.ts:168-188; 0895:93-136 |
| runMandate | agent principal only | re-checks the stop switch, key 1, delegability, validity, run limit and the grantor's current authority each run (`app.principal`, `app.login_blocked`, which covers archived users and ended employments). The job runs as the grantor's session, so a changed reporting line or ended manager employment narrows the team at run time. Writes the record only against the same mandate version | run.ts:48-54,76-116; my-team-scope.ts:37-43; 0579:246-265 |
| listOutcomeRecords / latestDailyDigest | asker, grantor, group admin | all others: RLS | 0890:304-307; daily-digest.ts:101-106 |
| outcomeSummary, exportAgentRegistry, listWorkers, workerDetail | group admin, own tenant (tenant filter plus RLS) | others: `not_administrator` | export.ts:48; views.ts:22 |
| recommendLeaveDecision | a caller the inbox owner considers assigned (`pendingLeaveTaskMetadata` → `assertCanDecideLeaveStep`, which admits delegations) | the applicant (self-exclusion), unassigned callers, other tenants: `not_assigned`; switched off or stopped: unavailable; gate re-checked before writing the record | leave-decision.ts:107-117,151-153; core/leave.ts:12273-12300 |
| prepareLeaveDecideProposal | the native decision review admits the caller | everyone else: unavailable | leave-decide.ts:30-63 |
| setupCopilot / setupReadiness / coverageReadiness / companySetup | `isAdmin`. Owners run under the caller's RLS, so a company admin naming another company's id gets that company's rows filtered by RLS. Logins pending: group admin only | employee, manager, delegate, payroll | copilot.ts:109-110; setup-readiness.ts:26-27 |
| digestPreview / daily digest job | any login; setup and deadlines only for `isAdmin`, across `app.is_admin_for` companies | counts only from the caller's own inbox | daily-digest.ts:54-80 |
| PostgresTaskMemoryStore | the owning login | other logins: `TaskMemoryRefused` and RLS; agents: RLS (`agent_principal IS NULL`) | task-memory-store.ts:21-26; 0890:319-321 |

### The specific attacks from the brief

- **Cross-tenant and cross-person reads.**
  - All six new 0890 tables and the 0895 table have RLS enabled, with a tenant predicate in every policy.
  - Explicit grants: privileges are revoked first, then only the needed ones granted. The outcome tables cannot be updated or deleted, and triggers refuse UPDATE and DELETE for every role (0890:189-199, 323-331).
  - No service in scope uses the owner connection. Every query goes through `withTenant(ctx)`.
  - SECURITY DEFINER functions:
    - `app.teras_task_memory_erased_with_transcript` deletes only rows matching the triggering exchange's tenant and user.
    - `app.teras_is_grantor_manager` returns a boolean about the caller, scoped to `app.current_tenant_id()` and `app.is_self_person`.
    - `app.teras_manager_may_revoke` is invoker-rights.
  - None of them leaks across tenants.
- **Forged, tampered, replayed and expired proposals** (proposal.ts):
  - The signature is HMAC-SHA256 over a domain-separated canonical JSON of the whole body. The secret is 32 bytes or more, and the code fails closed without it.
  - Comparison uses `timingSafeEqual` after a length check.
  - Expiry and not-before (with 5 s skew) are enforced.
  - The `strict` schema refuses extra keys.
  - The authority is bound to tenant, user and person. Mandate authority is refused.
  - `refine` ties the authority tenant to the subject tenant.
  - Single use relies on the review custody row, which the review route consumes (outside my scope). The approved-cancel variant has no custody row, but its packet only pre-fills the `/leave` form, which re-runs every gate, so a replay grants nothing.
- **Confirming another person's proposal:** verify, card and packets all refuse an authority mismatch (proposal.ts:127-128).
- **Mandates outliving the grantor's role:** re-checked at every run (see runMandate above). Revocation stays possible after the grantor loses authority, which is correct.
- **A manager revoking outside tenant policy:** refused in code and in SQL (0895:111-113, 129-136). The guard refuses `revoked_by` relabelling, and the permissive-policy OR cannot be exploited because the trigger re-checks every field.
- **Leaks through task memory, traces and outcome records:** RLS is sound. Gaps are noted in L1, L3 and M3. The outcome `reads.refs` hold employment and request ids, readable only by the grantor or asker and group admins.
- **Small-group totals:** there is no minimum group size anywhere:
  - the team absence summary gives the manager names anyway;
  - `othersAway` and `team_coverage` use `plannedAbsences` under the caller's own read access;
  - the digest counts only the caller's own inbox and administered companies;
  - the outcome summary is group-admin only.

  No total I found aggregates across a boundary the caller could not already read row by row, so there is no inference beyond existing access. If a future surface shows these counts to someone without row access, it needs a k-minimum.
- **The worker switch called by a non-group-admin:** refused (see the matrix).
- **The digest showing more than the inbox allows:** it shows counts only, from `listPendingTasks`, with no names (daily-digest.ts:56-59).
- **A recommendation for a request the caller cannot decide:** refused (`not_assigned`). The M2 chooser is the one place where unassigned requests surface.
- **Connect tool specs** (generate.ts:83-102):
  - Reads with an identifier input are excluded.
  - Output schemas drop every `never` field. Every `id`-typed field in entities*.ts is `never`.
  - Actions are limited to `leave.apply`, prepare-only.
  - Annotations are read-only for reads and non-destructive for prepare.
  - No internal identifiers are exposed (see I4 for names).

## Informational

- **I1.** `isGroupAdmin` treats a company-scoped `super_admin` as a group admin, in TS (authz-model.ts:18) and SQL (0016:42). This predates this change, but every Teras group-admin gate inherits it, so the owner should confirm it is intended.
- **I2.** `hasTeamAccess` (authz-model.ts:12-14) admits `hr_admin` and `super_admin`. A company HR admin with no reports can therefore grant the team summary. The run narrows the team to direct reports (team-absence-summary.ts:26-29), so nothing leaks, but the grant succeeds where §3.10 rule 3 implies team-manager authority.
- **I3.** There is one proposal secret for all tenants, with no key id or rotation support (proposal.ts:88-92). Tenant binding is inside the signed body, so this is acceptable. Rotation would invalidate cards in flight.
- **I4.** Connect output schemas include person names at `minimum` disclosure (entities.ts:130 `name`, 138 `reports.name`). These are not internal identifiers, but they are personal data, and the §3.9 legal review should see them.
- **I5.** `verifyProposal` throws `ProposalUnavailable` instead of returning a refusal when the secret is missing (proposal.ts:89-92). This fails closed. Callers must not catch it into a valid-looking response.

## Draft tests

Everything is under `tests/security-services/`, written as if it lived at `test/review/`.

- **`_actors.ts`:** builds the eight actors on fictional fixtures: names "Fictional …", emails `<uuid>@fixture.test`, two tenants, two companies, and the delegate reporting line.
- **`role-matrix.test.ts`:** `REVIEW pass` coverage for every service in the matrix above. Expected to pass.
- **`findings.test.ts`:** expected to fail on the current code:
  - `REVIEW medium:` explainers offered while switched off (M1);
  - `REVIEW medium:` the chooser lists an unassigned request (M2);
  - `REVIEW medium:` a group admin appends an agreement decision (M3);
  - `REVIEW low:` repeated agreement follow-ups (M3);
  - `REVIEW low:` free text in `trace` (L1);
  - `REVIEW low:` manager serving notice (L2).
- **`proposal-integrity.test.ts`:** `REVIEW pass` for forged, tampered, other-caller, expired, not-yet-valid, mandate-authority, cross-tenant and missing-secret proposals. Pure, no database.

Caveat: these are static drafts. Fixture details, such as whether the harness tenant has the payroll and attendance modules enabled or whether a whole-scope delegate is admitted by `assertCanDecideLeaveStep` today, may need adjusting on the first CI run. The role-matrix recommender test asserts consistency with `pendingLeaveTaskMetadata`, not a hard-coded allow for the delegate, for that reason.
