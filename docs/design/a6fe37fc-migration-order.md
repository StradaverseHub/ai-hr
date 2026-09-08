# Leave Configuration — the order of build, cutover and removal

**Feedback item `a6fe37fc` · Phase 3 design deliverable · written 2026-09-08 against `main@0c01befc`**

Companion to `docs/design/a6fe37fc-leave-config-ia.md` (the proposed structure) and
`docs/audits/a6fe37fc-leave-config-audit.md` (Phase 1).

> **Nothing in this document has been built.** It is the sequence being proposed for approval, together
> with the reconciliation the plan promised and how it will actually be run.

---

## 0. The rule the whole order obeys

**Something works at every point, and nothing is removed before its replacement is proven.**

Three consequences, and every round below is shaped by them:

1. **The engine is never touched.** `core/leave.ts`, `core/leave-compute.ts`,
   `core/entitlement-template.ts` and `core/leave-approval-policy.ts` are untouched by every round.
   The customer's 297 balance records were produced by them and are reconciled against them.
2. **No table is created, altered or dropped. No migration number is needed or requested.** Every round
   is screens and arrangement. If a later round finds it needs a column, it stops and asks for a number
   rather than inventing one.
3. **The four employee-facing screens** (`/leave`, `/leave/tracker`, `/leave/employee-balances`,
   `/leave/employee-records`) **must work after every single round**, not only at the end. They read the
   same configuration; none of these rounds changes what that configuration *is*.

---

## 1. The order

Each round is its own branch, its own gate, its own HANDOFF entry, and each is independently
deployable and independently revertable.

### Round 1 — the approval replay harness. **Built first, before anything moves.**

The acceptance test is built before the thing it tests. Nothing else in this plan is safe without it,
and building it last would mean discovering a routing change after it had shipped.

**What is built**

* `resolveApprovalDecision(tx, companyId, leaveTypeId, attrs)` in `core/leave-approval-policy.ts` —
  returns `{ levels, ruleId, source }` where `source` is `'rule' | 'tenant-default' | 'fallback'`.
  `resolveApprovalChain` becomes a one-line wrapper returning `levels`. **One matcher, two callers** —
  a second ranking of the same rules is the defect this whole item exists to remove.
* `approvalRoutingSnapshot(tx)` and `diffApprovalRouting(before, after, subjects)` — the two private
  functions `core/leave-approval-consolidation.ts` already has (`snapshotApprovalRouting`,
  `diffSnapshots`), promoted to exports. **No new logic is written.**
* `scripts/replay-approval-routing.ts` — `--baseline <file>` writes a snapshot; `--verify <file>`
  re-resolves and diffs; `--coverage` reports which rules ever win. Read-only, inside a transaction that
  always rolls back, run against production the same way `scripts/convert-approval-rules.ts` is:
  `node --env-file=.env.production --import tsx scripts/replay-approval-routing.ts --baseline …`
* `test/leave-approval-replay.test.ts` — the same harness against a seeded tenant, on every gate.

**Exit condition:** a baseline committed for the production tenant, and the harness proven able to fail
(§2.4).

**Nothing about any screen changes in this round.**

### Round 2 — the leave type's five tabs, behind the existing route

**What changes:** `components/leave-type-panel.tsx` only. The four steps and six sub-steps become the
five tabs of the IA §2. Every sub-form moves **with its tri-state marker and its hidden `name` intact** —
that is what makes the move safe, and it is the precedent `9d8cf621` set when the payroll-impact form
moved screens.

**What does not change:** the route (`/admin/leave/entitlements`), the left rail (the leave type list —
the only way to pick a type, and it must not be replaced by a map or a tab bar), every server action,
every service, every read, every column.

**Two functions arrive from elsewhere in this round**, because they are properties of the leave type:

* *Send to payroll module* (`send_to_payroll`) moves from the Payroll impact screen into **Tab 1**. The
  Payroll impact screen keeps the **company** encashment policy until Round 3 moves it, so it is never
  an empty screen.
* *Per-date approval* (`per_date_approval`) moves from *General setting* into **Tab 5**.

**Guards that pin the arrangement being reversed, and must have their case UPDATED rather than deleted:**

| Guard | What it pins today | The new reasoning it must carry |
|---|---|---|
| `test/leave-type-general-substeps.test.ts` | The four General sub-steps `details · yearType · earning · carry` | Earning and carry forward answer *how many days* and join the day tables in Tab 3; Details and Leave Year Type become Tab 1. The reuse contract (one shared `SubStepBar`, never a reinvented nested bar) survives unchanged. |
| `test/leave-condition-substeps.test.ts` | The two Condition sub-steps `criteria · rules`, and eight of the twelve application-rule cards **in source order** (a card that moves fails the walk) | Criteria becomes Tab 2; the rule cards split — the three balance cards to Tab 3, the company-wide half-day card to Company rules, the rest to Tab 4. The tripwire asserting no Expiry form creeps back **stays exactly as it is**. |
| `test/leave-type-config-active-section.test.ts`, `test/leave-type-workspace.test.ts` | The four step keys and the persisted `leaveTypeCards:<id>` shape | Five tab keys, and the hydration guard must remap every retired key (`general`, `ess`, `entitlement`, `custom`, `eligibility`, `workflow`) onto its new tab instead of snapping the browser back to tab 1. |
| `test/leave-type-partial-approval-toggle.test.ts` | Per-date approval inside the General step | Same form, same marker, same column — Tab 5. |

**Storage-key rule:** the new tab keys must **not** be named `approval`, `display` or `calculation`.
Those are the retired accordion keys `test/leave-type-config-categories.test.ts`'s successors assert
must never reappear in this file, and a tab called "Who approves it" whose storage key is `approval`
would trip it. Propose `identity · eligibility · entitlement · application · approvers`.

**Render check, not a status check:** a re-tabbed panel is exactly the shape that returns 200 with a
`MISSING_MESSAGE` behind it (`r127` shipped this screen with two label sets that did not exist). Every
new tab label ships in all six locales with real translations, and the round is not done until the page
has been rendered on a dev server and the dev log read.

### Round 3 — Company rules

**What is built:** one new screen gathering the four settings that belong to a company or the tenant and
are currently on four different surfaces — company half-day full deduction (today: inside *every* leave
type's Condition step), company leave encashment policy (today: Payroll impact), per-company
replacement-leave policy (today: Replacement leave), tenant shared leave groups (today: the foot of the
Leave types screen).

**Each card moves once and lands once.** The old location loses the card in the *same* change that the
new one gains it — never two editors over one column.

**The permission column is not optional.** A new guarded `page.tsx` needs a column in
`lib/permissions.ts` or `test/function-access.test.ts`'s reverse-completeness case fails. It attaches as
a **route on the existing `leaveConfig` screen key** — same admin surface, same `requireAdmin` guard —
following the `/admin/leave/generate` precedent, not as a new screen key. The route and the page land in
one commit or neither; that test fails **both** ways.

**Two screens shrink but do not disappear:** *Payroll impact* keeps the per-type payroll settings until
Round 2 has taken them (it has, by now) — after Round 3 it has no content left, and it is retired to a
**redirect stub** in Round 6, not deleted here.

**What must not move:** `runToilExpiry` and `closeReplacementLeaveYear` stay on `/admin/toil`. They are
deliberately **not** gated by the `toil` entitlement, because a lapsed add-on does not cancel days
employees have already banked, and for a First-Schedule-eligible employee that debt is statutory.
Absorbing them behind a configuration screen would silently re-gate a statutory obligation.

### Round 4 — Approval: the read-only restoration

**What is built:** on **Approval chains**, a read-only list of the rules that are not built from a
template — their business unit / department / position scope and their effective chain. Today those
columns are stored, are read by `resolveApprovalChain`, decide who approves, **and are shown nowhere**
(`706d34e8` removed the only surface that displayed them). And **Tab 5** on the leave type: which chain
reaches this type, its ordered steps, and the escalation — read-only, linking to Approval chains to
change anything.

**The guard whose case must be updated:** `test/leave-approval-page-restructure.test.ts` asserts
`<WorkflowMatrix` is absent from the page. It stays absent. The new reasoning: what `706d34e8` removed
was a second **editor** over rows the assignment section already maintains; a read-only read-out of a
column that routes live requests is not that editor, and the case must say so explicitly so the next
reader does not re-delete it as a regression.

**Replay:** run before and after. A read-only view changes no rule, so the expected result is *zero
differences*, and a difference here means something else in the round did more than it said.

### Round 5 — cutover: the names

Every screen and every tab renders the string the menu shows for it, through `leaveConfigScreenTitle()`.
Four of ten screens honour that today; this makes it ten of ten and fixes the four drifts measured in
IA §1.1 — including the generic **“Leave configuration”** heading still sitting on the busiest screen.

`components/leave-config-map.tsx` gains **Company rules**; `test/leave-config-map.test.ts` already
enforces that every map href is a declared route on `leaveConfig` or `leaveApproval`, so the map entry
and the permission route are checked against each other automatically.

### Round 6 — removal, and only of what has a proven home

Removed: the step bar and the two sub-step bars, the retired storage keys and their remapping code once
a full leave-year has passed, and the *Payroll impact* screen's page component — which becomes a
**redirect stub** to Leave types, exactly as `/admin/leave` and `/admin/leave/application-rules` did.
Its route leaves `lib/permissions.ts` in the same commit that empties the page (a stub has nothing to
guard; `test/function-access.test.ts` fails on a registered route whose page no longer calls a guard).

**Never removed:** the four redirect stubs, the engine modules of IA §0, the six history tables, the
four configuration tables, and `lib/leave-config-health.ts`.

**The reporter's Phase 2 asked for the old implementation to be "completely removed".** What this order
actually deletes is the *arrangement* — the step/sub-step machinery and one emptied page. The services
behind the screens are the carve-out the reporter's own request allows ("objectively required for
compatibility with existing production data"), and the tables are protected by the reporter's own
do-not-drop rule. That difference is deliberate, is stated in the approved plan, and should not be
quietly re-litigated by a later round.

---

## 2. The reconciliation — how the promise is actually discharged

> **The promise:** *every one of the 261 approval rules must still reach the same approver for the same
> real employee, before and after.*

### 2.1 What is compared

Not the rules. **The answers.** A rule is only correct through the chain it produces for a real person,
and comparing rows would pass a migration that rewrote two rules into one with the same routing — or,
worse, fail one that was identical in effect. So the comparison is over resolved chains.

**Subjects.** `listRoutingSubjects(tx)` reads every employment with `terminated_on IS NULL`, joined to
its **current open assignment** (`valid_to IS NULL AND superseded_at IS NULL`), that assignment's
department's business unit, and its grade's group via `grade_group_member` — the *same* joins
`resolveRequestApprovalChain` (core/leave.ts) makes for a real request. It then collapses them to one
representative per **distinct** tuple of

```
(companyId, businessUnitId, departmentId, positionId, gradeId, gradeGroupId, employmentType)
```

`resolveApprovalChain` reads **nothing else** about the requester, so it is a pure function of that tuple
plus the leave type and the day count. **One representative therefore stands for every employment that
shares its tuple** — which is what makes "prove it for every active employee" affordable: hundreds of
employments, dozens of tuples. The report states `employmentsCovered` (the real headcount), not the
tuple count, because the promise is about employees.

**Leave types.** Every row of `leave_type`, archived included. A rule scoped to an archived type still
matches if the type is ever used, and excluding it would leave a blind spot exactly where a migration is
most likely to have been careless.

**Day counts.** `approvalDayProbes(tx)`: `0`, `1`, every configured `min_days`/`max_days` bound and the
value either side of it, and one value above the largest bound. A day range only changes the answer *at*
its bounds, so this covers every interval the matrix can express — and it is both faster and more
complete than probing 1, 2, 3, …

**The check count is therefore `subjects × leaveTypes × dayProbes`**, which is a **superset** of the 261
rules: every rule that can win for anybody wins somewhere in that grid.

### 2.2 How the comparison is run

```
snapshot := for each subject s, leave type t, day probe d:
              key   = `${s.employmentId}|${t}|${d}`
              value = resolveApprovalChain(tx, s.companyId, t, { ...s.attrs, days: d }).join(' → ')
```

`before` is taken, the change is applied, `after` is taken, and the two maps are compared key by key.
Any key whose value differs is a failure, reported as **company · employment · leave type · days ·
before-chain · after-chain** — named, never counted, so the operator can look the employee up.

Three places it runs, and all three are required:

| Where | When | What it proves |
|---|---|---|
| `test/leave-approval-replay.test.ts` | Every gate, seeded tenant | The harness works and the code under change did not break routing in the shapes the fixtures cover. |
| `scripts/replay-approval-routing.ts --baseline` | Once, on production, before Round 2 | The committed baseline: the 261 rules' answers as they stand today. |
| `scripts/replay-approval-routing.ts --verify <baseline>` | On production before each deploy from Round 2 onward | The customer's real configuration still routes identically. |

The script runs **inside one transaction that always rolls back**, using
`MIGRATION_DATABASE_URL` to enumerate tenants exactly as `convert-approval-rules.ts` does. It writes
nothing, ever — the `--apply` flag that script has does not exist here.

### 2.3 The coverage report — the part the plan did not ask for and should have

`resolveApprovalDecision` returns the winning rule id, so the replay can also report **which of the 261
rules ever won**. Rules that never win are already unreachable *today* — a rule scoped to a grade nobody
holds, or shadowed by a more specific rule — and the customer should be told which ones they are. That
is honest about the limit of the promise: the replay proves nothing changed for any real employee, and a
rule reaching no real employee is proven unchanged only in the sense that it reached nobody before and
reaches nobody after.

### 2.4 Proving the harness can fail

A reconciliation that cannot fail proves nothing. Before the baseline is trusted, the harness is run
against a deliberately broken state **inside a transaction that rolls back**: set one targeted rule's
`leave_type_id` to `NULL` and re-resolve.

That is not an arbitrary corruption. `core/leave-approval-policy.ts` reads a `NULL leave_type_id` as the
**company default chain — a wildcard, not a non-match** — so blanking that column silently converts one
targeted rule into a rule matching *everyone*. It is precisely the failure the audit's §5 identifies as
the near-miss of release three (`6e9a126e`), where grade groups' `SET NULL` foreign key would have
re-routed 205 live rules without erroring. **The harness must report a non-empty difference list for
that injection, or it is not yet the acceptance test.**

### 2.5 What the replay does not cover, stated rather than assumed

* **A chain is resolved from today's org data.** An employee who changes department tomorrow gets a
  different chain tomorrow — correctly. The replay proves the *rules* unchanged, not the org.
* **Pending requests keep their snapshotted steps** (ADR-0071 §g), so a mid-flight approval is unaffected
  by any of this by design.
* **Terminated employments are excluded**, matching `listRoutingSubjects`. A terminated employee submits
  no leave.
* **`resolveApprovalChain` is scoped to the requesting employment's own current assignment**
  (ADR-0071 1(f)). The replay inherits that scope exactly, because it calls the same function.

---

## 3. What could go wrong, and what catches it

| Risk | What catches it |
|---|---|
| A sub-form loses its tri-state marker while moving tabs, and one save wipes a neighbouring column | The marker is asserted per sub-form in the existing leave-type suites; the move must keep those assertions and re-point them at the new tab, not delete them |
| A relocated card is left rendering in **both** places, so two editors write one column | Each round's diff must show the card removed from its old home in the same commit; the sub-step guards read the panel source |
| A new tab label ships untranslated and renders `MISSING_MESSAGE` behind a 200 | i18n parity is enforced by test; the **values** are not, so each round renders the page on a dev server and reads the dev log (the `r127` lesson) |
| The new Company rules page is guarded but unregistered, or registered with no page | `test/function-access.test.ts` fails both ways |
| A map entry points at a route the guard does not cover | `test/leave-config-map.test.ts` |
| A server translator closure crosses into a client tab component and takes the screen down | `test/server-client-boundary.test.ts` (`r123`/`r124` took production tabs down exactly this way) |
| Approval routing changes | §2, on every deploy from Round 2 |
| A guard is deleted because it pins a decision being reversed | Round 2 and Round 4 name the four guards and require their **case** to be updated in place |

---

## 4. Rollback

Every round is a screen change on its own branch with no schema change, so rollback is a revert and a
redeploy. Two specifics:

* **Round 2's browser state.** `leaveTypeCards:<id>` in each administrator's browser will hold new tab
  keys after the round. A revert must leave the old panel's hydration guard tolerant of an unrecognised
  key — it already is (it falls back to step 1) — so a reverted screen opens on Details rather than
  throwing. Round 2 must not remove that tolerance.
* **Round 3's relocations.** Reverting Round 3 restores each card to its original screen; no column was
  written differently, so no data has to move back.

---

## 5. What this order does not include

* No migration, no new table, no altered column, and **no migration number requested**.
* No change to the calculation engine, the entitlement resolver, or the approval matcher — beyond
  Round 1's split of `resolveApprovalChain` into a decision function plus a one-line wrapper, which
  returns the same levels to every existing caller.
* No change to the four employee-facing leave screens.
* No rebuild of the Generate, Adjustments or Import flows.
* No deletion of any leave record: balances, applications, history, adjustments, approvals and the audit
  trail are untouched throughout.

---

## 6. The picture of this document

`docs/mockups/a6fe37fc-cutover-order.png` (source `…-cutover-order.html`) draws the six rounds, what
still works during each, how the approval replay is run, and what is kept versus what is actually
removed. It is a sketch and it makes no promise this document does not.
