# Leave Configuration — the order of build, cutover and removal

**Feedback item `a6fe37fc` · Phase 3 design deliverable · written 2026-09-08 against `main@0c01befc`**

Companion to `docs/design/a6fe37fc-leave-config-ia.md` (the proposed structure) and
`docs/audits/a6fe37fc-leave-config-audit.md` (Phase 1).

> **Nothing in this document has been built.** It is the sequence being proposed for approval, together
> with the reconciliation the plan promised and how it will actually be run.

---

## 0. The rule the whole order obeys

**Something works at every point, and nothing is removed before its replacement is proven.**

That is the plan's own sequencing, quoted: *"Build the new screens alongside the old ones, so at every
point you have something that works … Only then remove the old screens, the old routes and the code
behind them."* Rounds 2–4 build; Round 5 removes. **All ten of today's page components are deleted**
(IA §2.0), and Round 5 names them one by one.

Four consequences, and every round below is shaped by them:

1. **The engine is never touched.** `core/leave.ts`, `core/leave-compute.ts`,
   `core/entitlement-template.ts` and `core/leave-approval-policy.ts` are untouched by every round.
   The customer's 297 balance records were produced by them and are reconciled against them.
2. **No table is created, altered or dropped. No migration number is needed or requested.** Every round
   is screens. If a later round finds it needs a column, it stops and asks for a number rather than
   inventing one.
3. **The four employee-facing screens** (`/leave`, `/leave/tracker`, `/leave/employee-balances`,
   `/leave/employee-records`) **must work after every single round**, not only at the end. They read the
   same configuration; none of these rounds changes what that configuration *is*.
4. **No address ever 404s.** Each of the ten routes becomes a redirect stub in the same commit that
   deletes its page, so every bookmark an administrator has still arrives.

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
  re-resolves and diffs; `--coverage` reports which rules ever win.

  **⚠️ IT CONNECTS TO THE PRODUCTION DATABASE ITSELF — NOT A COPY — AND THE CUSTOMER-FACING MOCKUP MUST
  SAY THE SAME THING.** There is no rehearsal copy of this tenant's data, and a replay run against one
  would prove nothing about the rows that route real requests. What makes it safe is not the target but
  the shape: it issues **reads only**, inside **one transaction that always rolls back**, and the
  `--apply` flag `scripts/convert-approval-rules.ts` has **does not exist here**. It enumerates tenants
  through `MIGRATION_DATABASE_URL` exactly as that script does.

  Run it **on the box, by sourcing the env file** — `node --env-file=` exits 9 there (`bad option`), the
  server being node v18.19.1:

  ```
  cd /opt/ai-hr && set -a && . ./.env.production && set +a \
    && node --import tsx scripts/replay-approval-routing.ts --baseline …
  ```
* `test/leave-approval-replay.test.ts` — the same harness against a seeded tenant, on every gate.

**Exit condition:** a baseline committed for the production tenant, and the harness proven able to fail
(§2.4).

**Nothing about any screen changes in this round.**

### Round 2 — the new leave type screen, built **alongside** the old one

**The plan's own sequencing:** *"Build the new screens alongside the old ones, so at every point you have
something that works."* So this round **adds** and removes nothing.

**What is built:** `app/admin/leave-config/types/page.tsx` and the components under it — a **new page
component**, not an edit of `components/leave-type-panel.tsx`. The four steps and six sub-steps become the
five tabs of IA §2, and the 24 sub-forms are rewritten onto them.

**What does not change in this round:** `/admin/leave/entitlements` and its panel are untouched and are
still what the menu links to. The old screen is the working one until Round 5 says otherwise.

**The three rules the rewrite obeys, because a rewritten form is where this goes wrong:**

1. **Every sub-form keeps its tri-state marker and its hidden `name`.** A form that posts
   `updateTypeAction` without its marker does not fail to save — it saves, and **wipes the columns a
   neighbouring form owns**. Nothing type-checks that. The marker list of IA §1.2 is the checklist.
2. **No server action changes signature, and no new action is written.** The new forms post the existing
   actions. If a field needs an action that does not exist, the round stops and says so.
3. **The left rail is re-created, not dropped.** It is the only way to pick a leave type (IA §2.1).

**Two settings arrive from elsewhere,** because they are properties of the leave type:
*Send to payroll module* (`send_to_payroll`, today on Payroll impact) into **Tab 1**, and *Per-date
approval* (`per_date_approval`, today in *General setting*) into **Tab 5**. Neither old screen loses its
copy in this round — Round 5 is where a setting stops being editable in two places, and both are on the
same screen-by-screen cutover list so the window is one round wide and is deliberate rather than
accidental.

**Guards that pin the OLD arrangement.** They read `components/leave-type-panel.tsx`, which this round
does not touch, so **they all stay green through Round 2 and must not be edited here.** They come due in
Round 5, when the file they read is deleted, and each one's *case* is carried onto the new screen rather
than dropped:

| Guard | What it pins today | Where its reasoning goes |
|---|---|---|
| `test/leave-type-general-substeps.test.ts` | The four General sub-steps `details · yearType · earning · carry`, and the `SubStepBar` reuse contract | Earning and carry forward answer *how many days* and join the day tables in Tab 3; Details and Leave Year Type become Tab 1. The reuse contract survives on whatever bar the new page uses. |
| `test/leave-condition-substeps.test.ts` | The two Condition sub-steps `criteria · rules`, and eight of the ten application-rule cards **in source order** | Criteria becomes Tab 2; the cards split — the balance card to Tab 3, the company half-day slot to Company rules, the rest to Tab 4. **The tripwire asserting no Expiry form creeps back must be re-pointed at the new file, not deleted** — `c459bff9` removed that step on purpose. |
| `test/leave-type-config-active-section.test.ts`, `test/leave-type-workspace.test.ts` | The four step keys and the persisted `leaveTypeCards:<id>` shape | Five tab keys on the new page, and a hydration guard that remaps every retired key (`general`, `ess`, `entitlement`, `custom`, `eligibility`, `workflow`) onto its new tab instead of snapping an administrator's browser back to tab 1. |
| `test/leave-type-partial-approval-toggle.test.ts` | Per-date approval inside the General step | Same form, same marker, same column — Tab 5. |

**⚠️ Storage-key rule — and the tripwire it names DOES NOT EXIST, so this round has to write it.**
The new tab keys must not be named `approval`, `display` or `calculation`. Those are the retired accordion
keys from the pre-`c979aa8b` panel, and re-using one would make an administrator's stored
`leaveTypeCards:<id>` payload hydrate onto the wrong tab. **`test/leave-type-config-categories.test.ts`
asserted exactly that (`for (const cardKey of ['approval', 'display', 'calculation'])`) and was DELETED
in `c9e18c7e` (r167, "retired where it did not survive"). No successor carries it: of the 29 test files
that read `components/leave-type-panel.tsx`, none asserts those three strings absent.** So there is no
guard here and nothing will catch a wrong key — `tsc`, the targeted tests and the full gate all pass.
Round 2 must **add** the assertion against its own new file, as a case in the new screen's shape test,
before it names a single tab. Proposed keys: `identity · eligibility · entitlement · application ·
approvers`.

**Render check, not a status check:** a new tab bar is exactly the shape that returns 200 with a
`MISSING_MESSAGE` behind it (`r127` shipped this screen with two label sets that did not exist). Every new
tab label ships in all six locales with real translations, and the round is not done until the page has
been rendered on a dev server and the dev log read.

### Round 3 — the rest of the new module, still alongside the old screens

**What is built,** all under `/admin/leave-config`, all new page components, none of them replacing
anything yet:

* `company-rules` — **the one genuinely new screen.** It gathers the four settings that belong to a
  company or the tenant and are currently on four different surfaces: company half-day full deduction
  (today inside *every* leave type's Condition step), company leave encashment policy (today on Payroll
  impact), per-company replacement-leave policy (today on Replacement leave), tenant shared leave groups
  (today at the foot of the Leave types screen).
* `entitlement-tables` · `generate` · `adjustments` · `import` · `records/entitlement` ·
  `records/balances` — the six screens whose flows are not changing. Each mounts the **same shared
  components** its old page mounted; the page component is what is new. IA §2.0.2 is the one place this
  document says it would rather not rebuild these, and it is a recommendation, not a condition.

**The permission columns are not optional.** Every new guarded `page.tsx` needs a route in
`lib/permissions.ts` or `test/function-access.test.ts`'s reverse-completeness case fails, and the route
and the page land in one commit or neither. This round's seven routes attach to the **existing
`leaveConfig` screen key** — same admin surface, same `requireAdmin` guard, following the
`/admin/leave/generate` precedent. (Round 4's `approval-chains` is the exception: it attaches to
**`leaveApproval`** and keeps `scopedSession`, because a company-scoped admin must keep seeing only their
own companies — IA §6.4.)

**⚠️ THE SCREEN KEYS DO NOT CHANGE, AND THAT IS DELIBERATE.** `lib/permissions.ts:107` records that a
screen key "may key stored role configs". Renaming `leaveConfig` would silently drop every tenant's
existing grant for the area. Only `href` and `routes` move.

**During Rounds 3 and 4 the same setting is editable on two screens** — the new one and the old one it
will replace. That is the price of "something works at every point", it is the window the plan asked for,
and it closes screen by screen in Round 5. Nothing is *stored* twice: both editors write the same column
through the same action.

### Round 4 — Approval: the editor, and the read-only restoration

**What is built:** `app/admin/leave-config/approval-chains/page.tsx` — templates, assignment, escalation,
as today — **plus** a read-only list of the rules that are *not* built from a template, showing their
business unit / department / position scope and their effective chain. Those columns are stored, are read
by `resolveApprovalChain`, decide who approves, **and are shown nowhere** since `706d34e8` removed the
only surface that displayed them. And **Tab 5** on the new leave type screen: which chain reaches this
type, its ordered steps, the escalation — read-only, linking to Approval chains to change anything.

**The guard whose case must be carried over:** `test/leave-approval-page-restructure.test.ts` asserts
`<WorkflowMatrix` is absent from the approval page. It stays absent, and the assertion must be
re-pointed at the new page rather than deleted when the old one goes. The new reasoning: what `706d34e8`
removed was a second **editor** over rows the assignment section already maintains; a read-only read-out
of a column that routes live requests is not that editor, and the case must say so explicitly so the next
reader does not re-delete it as a regression.

**Replay:** run before and after. A read-only view changes no rule, so the expected result is *zero
differences*, and a difference here means something else in the round did more than it said.

### Round 5 — cutover: the menu moves, and the ten old pages are deleted

This is the round the reporter's Phase 2 asks for, and it is one commit per screen, ten times.

**For each of the ten screens, in one commit:** the menu/map entry and every inbound link move to the new
address · the old `page.tsx` is emptied to a **redirect stub** · its route leaves `lib/permissions.ts` ·
its private title key leaves `messages/*.json`. `test/function-access.test.ts` fails **both** ways — a
guarded page absent from the registry, and a registered route whose page no longer calls a guard — so the
two halves land together or neither does.

**Deleted in the same commits, by name:**

| Deleted | Lines |
|---|---|
| `app/admin/leave/entitlements/page.tsx` | 731 |
| `components/leave-type-panel.tsx` — and with it the step bar, its two `SubStepBar` mountings, `STEP_KEYS`, `GENERAL_SUB_STEP_KEYS`, `ESS_SUB_STEP_KEYS` | 3,367 |
| `app/admin/leave/approval/page.tsx` | 397 |
| `app/admin/leave/replacement/page.tsx` | 402 |
| `app/admin/leave/adjustments/page.tsx` | 172 |
| `app/admin/leave/generate/page.tsx` | 162 |
| `app/admin/leave/entitlements/ledger-archive/page.tsx` | 162 |
| `app/admin/leave/entitlements/archive/page.tsx` | 155 |
| `app/admin/leave/payroll/page.tsx` | 125 |
| `app/admin/leave/entitlements/templates/page.tsx` | 88 |
| `app/admin/leave/import/page.tsx` | 33 |
| **total** | **≈5,794** |

`components/leave-sub-step-bar.tsx` is **not** deleted — `components/leave/generate-form.tsx` and
`components/leave/adjustment-form.tsx` still use it.

**The names, in the same round.** Every new screen and every tab renders the string the menu shows for
it, through `leaveConfigScreenTitle()`. Four of today's ten screens honour that; all ten replacements do,
and the four private title keys measured in IA §1.1 — `admin.leave.pageTitle` and the archive, ledger-
archive and approval keys — are deleted with the pages that owned them, so they cannot drift again.
`components/leave-config-map.tsx` is repointed at the ten new hrefs and gains **Company rules**;
`test/leave-config-map.test.ts` already enforces that every map href is a declared route on `leaveConfig`
or `leaveApproval`, so the map and the permission registry are checked against each other automatically.

**Inbound links move with the map, because there is only one list (r259).** Every cross-screen link inside
`/admin/leave-config/` resolves through `leaveConfigScreenHref()` — the map's own href for that screen —
rather than through a literal. Round 3 shipped with the two halves disagreeing (the map linked *out* to the
old addresses while four back-links pointed back *into* the module), and the direction chosen was **out**:
the address that is live today, and the one that survives this round untouched, since each old address
becomes a redirect stub aimed at the new module in the same commit. So repointing `LEAVE_CONFIG_MAP` here
moves the menu **and** every back-link on the seven pages together;
`test/leave-config-round3.test.ts` → *"every cross-screen link in the preview module points where the MAP
points"* fails on any literal reintroduced later.

**Repointing the redirect constants is what turns three dormant banners on Company rules live, and the
`warning=` one is a risk warning (r259).** `app/admin/_redirects.ts`'s `ENTITLEMENTS` / `LEAVE` /
`GENERATE` / `ADJUSTMENTS` / `ENTITLEMENT_TEMPLATES` and `app/admin/actions.ts`'s private
`LEAVE_REPLACEMENT` still name the OLD addresses, so every save made on a new screen in Rounds 2–4 lands
back on the screen it will replace (that is what `LeaveConfigPreviewNote` tells the administrator). Company
rules renders `?error=` / `?saved=` / `?warning=` today as **unreachable markup**: the params exist, the
old Replacement leave screen reads them, and this one cannot be reached with them. It ships that way
deliberately — `warning=` carries the Phase-B #14 premium-equivalent **banking-risk** warning, which was
produced on every qualifying save for months and silently dropped because the screen it landed on did not
read the param, and shipping the screen that ABSORBS Replacement leave without the banner would set that up
to happen a second time at exactly this cutover. `test/leave-config-round3.test.ts` → *"the three save
banners on Company rules are DORMANT until Round 5"* asserts the old constant, so **this commit is expected
to fail that case**: re-point it at the new target, re-read the new screen with each param, and do not
delete it.

**The replay runs before and after every one of these ten commits.** Round 5 is where a live request path
could change addresses without anyone noticing, and it is exactly what §2 exists for.

### Round 6 — the last removals, once nothing points at them

* The `leaveTypeCards:<id>` remapping of the six retired keys, once one full leave year has passed and no
  administrator's browser still holds a stale payload.
* Any i18n key no new screen renders. `i18n-check.mjs` answers "is the key there", never "does anything
  render it", so this is a read of the new pages, not a test result.
* The four existing redirect stubs stay stubs, repointed. **Ten new stubs are created in Round 5 and none
  of them is ever deleted** — the reporter's bookmarks are the reason they exist.

**Never removed:** the engine modules of IA §0, the six history tables, the four configuration tables,
`lib/leave-config-health.ts`, and the per-leave-type server actions in `app/admin/actions.ts` (the new
forms post them; nothing becomes orphaned, and that file is shared with every other admin screen).

### What this order does and does not deliver against Phase 2

**Delivered:** all ten page components deleted, ten routes deregistered, ten new routes and new page
components in their place, the four-step/six-sub-step machinery gone, the private title keys gone,
≈5,794 lines of page and panel code replaced.

**Not delivered, and stated plainly rather than justified:** the services, the engine and the tables
survive. Two of those three are the reporter's own written constraints — the do-not-drop rule for a table
holding both configuration and transactions, and the *"objectively required for compatibility with
existing production data"* carve-out. The third, the per-leave-type server actions, survives for a reason
that is **ours, not the reporter's**: the new forms write the same columns through them, so deleting them
would mean writing replacements that do the same thing, and IA §2.0.1 says so where the reporter can
disagree with it. **IA §2.0.2 additionally recommends not rebuilding six of the ten screens at all, once,
as something the reporter can reject.** None of this may be attributed to the approved plan, which asked
for the opposite.

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

**Across two RUNS, a case is matched by its tuple, not by the employment it is named after.** Within one
transaction the subject list is identical on both sides, so the key above is enough. Between a committed
baseline and a `--verify` weeks later it is not: `listRoutingSubjects` keeps one *arbitrary* representative
per tuple (no `ORDER BY`, and none is needed), and ordinary staff turnover changes which colleague that
is. So the baseline stores each tuple's **attributes** — its identity, never replayed — and a verify
re-keys the baseline onto today's representatives before diffing. A baseline case counts as *not compared*
only when **no active employment is in that tuple at all**. Matched by employment instead, a departed
representative silently removes her still-employed colleagues' whole tuple from the comparison, and the
verify can print *"every baseline routing case still reaches the same approver"* and exit 0 while a live
employee's approver has moved. Baseline files therefore carry `version: 2`; a version-1 file is refused,
not read on a best-effort basis.

**What it costs the database.** The replay's transaction issues a **constant eight statements per tenant**
whatever the grid's size — the two read-only statements, the subject join, the leave types, the day-range
bounds, the two rule-set reads, and (only with `--coverage`) the rule listing. The rules are read once and
the grid is resolved afterwards, in memory, so a tenant with 261 rules and a large day-probe set does not
hold a long transaction open against production or pin its vacuum horizon.

Three places it runs, and all three are required:

| Where | When | What it proves |
|---|---|---|
| `test/leave-approval-replay.test.ts` | Every gate, seeded tenant | The harness works and the code under change did not break routing in the shapes the fixtures cover. |
| `scripts/replay-approval-routing.ts --baseline` | Once, on production, before Round 2 | The committed baseline: the 261 rules' answers as they stand today. |
| `scripts/replay-approval-routing.ts --verify <baseline>` | On production before each deploy from Round 2 onward | The customer's real configuration still routes identically. |

**Against the production database itself, on the box.** The script runs **inside one transaction that
always rolls back**, using `MIGRATION_DATABASE_URL` to enumerate tenants exactly as
`convert-approval-rules.ts` does. It writes nothing, ever — the `--apply` flag that script has does not
exist here. There is no copy of this data to run it against, and saying there were would be the one
claim in this pair of documents that is about touching live data; Round 1's note above and
`docs/mockups/a6fe37fc-cutover-order.html` both say *production, read-only, always rolled back*, in
those words.

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
  no leave — but a *tuple* is only excluded when nobody active is left in it, never merely because the
  employment the baseline named it after has gone.
* **`resolveApprovalChain` is scoped to the requesting employment's own current assignment**
  (ADR-0071 1(f)). The replay inherits that scope exactly, because it calls the same function.

---

## 3. What could go wrong, and what catches it

| Risk | What catches it |
|---|---|
| A sub-form is **rewritten** onto the new page without its tri-state marker, and one save wipes a neighbouring column | The marker is asserted per sub-form in the existing leave-type suites; Round 2 re-points those assertions at the new file rather than deleting them. **Nothing else catches this** — the save succeeds, `tsc` is clean and the column is simply gone |
| A card is left editable on **both** the new screen and the old one after cutover | Deliberate and bounded between Rounds 2–4 (both write the same column through the same action); Round 5's per-screen commit is what closes it, and the ten commits are the checklist |
| A new tab label ships untranslated and renders `MISSING_MESSAGE` behind a 200 | i18n parity is enforced by test; the **values** are not, so each round renders the page on a dev server and reads the dev log (the `r127` lesson) |
| The new Company rules page is guarded but unregistered, or registered with no page | `test/function-access.test.ts` fails both ways |
| A map entry points at a route the guard does not cover | `test/leave-config-map.test.ts` |
| A server translator closure crosses into a client tab component and takes the screen down | `test/server-client-boundary.test.ts` (`r123`/`r124` took production tabs down exactly this way) |
| Approval routing changes | §2, on every deploy from Round 2, and before and after each of Round 5's ten cutover commits |
| A guard is deleted because the file it read was deleted | Rounds 2 and 4 name the five guards; Round 5 deletes the file they read, so each case must be **re-pointed at the new page in the same commit**, never dropped |
| A new tab key re-uses a retired accordion key (`approval` / `display` / `calculation`) and hydrates onto the wrong tab | **Nothing.** `test/leave-type-config-categories.test.ts` asserted this and was deleted in `c9e18c7e`; no successor carries it. Round 2 must write the assertion itself — see the storage-key rule |

---

## 4. Rollback

Every round is a screen change on its own branch with no schema change, so rollback is a revert and a
redeploy. Two specifics:

* **Rounds 2–4 revert to nothing.** They only add pages. Reverting one removes a screen nobody was
  routed to yet.
* **Round 5 is the only irreversible-feeling round, and it is not actually irreversible.** Its ten
  commits delete page components, so a revert restores them from git and re-registers their routes. What
  a revert cannot restore is an administrator's browser state: `leaveTypeCards:<id>` will hold the new
  tab keys, and the restored old panel must stay tolerant of an unrecognised key — it already is (it
  falls back to step 1), and **no round may remove that tolerance.**
* **No round moves data.** Every card writes the same column through the same action on both the old and
  the new screen, so nothing has to be written back.

---

## 5. What this order does not include

* No migration, no new table, no altered column, and **no migration number requested**.
* No change to the calculation engine, the entitlement resolver, or the approval matcher — beyond
  Round 1's split of `resolveApprovalChain` into a decision function plus a one-line wrapper, which
  returns the same levels to every existing caller.
* No change to the four employee-facing leave screens.
* No change to what the Generate, Adjustments or Import **flows do**. Their page components are deleted
  and rebuilt at the new addresses like every other screen; the five-step wizard, the four-step
  adjustment flow and validate-then-commit arrive unchanged. IA §2.0.2 recommends, once and rejectably,
  not rebuilding them at all.
* No deletion of any leave record: balances, applications, history, adjustments, approvals and the audit
  trail are untouched throughout.

---

## 6. The picture of this document

`docs/mockups/a6fe37fc-cutover-order.png` (source `…-cutover-order.html`) draws the six rounds, what
still works during each, how the approval replay is run, and what is kept versus what is removed — the
ten deleted page components by name. It is a sketch and **it makes no promise this document does not**;
in particular it says *production, read-only, always rolled back* about the replay, in the same words as
§1 Round 1 and §2.2, because the two audiences must not be told different things about touching live
data.
