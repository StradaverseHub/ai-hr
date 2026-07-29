# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

## CURRENT STATE — read this first (2026-07-29)

Written 2026-07-29 at the end of a long session, for whoever picks this up next. Everything below the
`---` after this section is the per-round history; this part is the standing contract and the live
state. Update it when the state changes, not just when a round ships.

## How this project is actually run

**Deploy is automatic after a green gate.** The repo documents a human release gate (ADR-0045); the
owner has overridden it. Once tsc + the full suite + next build + the upgrade rehearsal are green, merge
to main, rsync, run deploy.sh, verify, mark the items deployed. Do not stop to ask.

**A round is not finished until HANDOFF.md records it.** Standing instruction from the owner.

**The gate, in full.** `pnpm exec tsc --noEmit` · `pnpm vitest run` (the WHOLE suite, not a subset) ·
`pnpm exec next build` · `./scripts/upgrade-rehearsal.sh main <scratch-db>` whenever a migration is
involved. The rehearsal is the one that catches "this applies to an empty database but not a populated
one".

**Deploy mechanics.** SSH is on **port 8288**, not 22 — `IMPROVE_SSH_HOST=203.142.6.241`, user `ubuntu`,
app at `/opt/ai-hr`. Deploy is rsync (excluding node_modules/.next/.git/.env*/.turbo/coverage/.claude)
then `./deploy/deploy.sh` on the box, which migrates, seeds catalogs, runs backfills and restarts. The
server has NO git checkout — rsync only, so `git log` there tells you nothing.

**Health check.** `GET /` returning **401** is CORRECT — it is the password gate, not a failure. Check
`systemctl is-active aihr` and curl `http://127.0.0.1:3000/` from the box.

## The feedback board — how the loop works

**Commands** (all from the repo root, `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:<cmd>`):
`pull` (open + contested) · `pull-approved` · `pull-blocked` · `push-plan` · `block` / `unblock` ·
`build-start` / `build-complete` · `release` · `mark-deployed` · `raise`.

Parsing tip: `pnpm` prints a banner before the JSON. Split on the first `\n[\n`, not the first `[`.

**Plans are PLAIN TEXT.** The board renders them RAW — no Markdown. Asterisks, hashes, backticks and
pipe tables all show as literal clutter to a non-technical reader. There is a skill for this:
`.claude/skills/feedback-plan`. Read it before writing any plan. Business language above the dashed
line, all technical detail in the BUILD NOTES trailer below it.

**Approve carries NO payload.** `approveFeedbackPlan` sends only the item id, so a plan that asks the
reporter to choose between options can never be answered — one item sat unbuilt three rounds that way.
State ONE course of action, recommend it, and tell them to reject with a reason if they want otherwise.

**Statuses:** open → planned → approved → building → done → deployed. Plus `contested` (reporter pushed
back, will be re-planned) and `blocked` (approved but waiting on an answer — added this session, 0317).
`startFeedbackBuild` accepts ONLY `approved`, which is what makes `blocked` a real guard.

**Plan history exists now (0318).** Every plan version and every push-back is kept in
`feedback_plan_revision`, append-and-close-once. Do not try to "tidy" it; a closed revision is immutable
by policy and by trigger.

## Running builds with subagents

Established pattern, used for r73/r74/r75. It works, with rules learned the hard way:

- **Group by FILE OVERLAP, never by theme.** r74 lost a round because a four-part delivery
  (650b6eb8 + its three siblings) was split across two agents; the agent correctly refused to build a
  navigation whose other tabs would 404. If two items touch the same screen, they go to one agent.
- **Anything cross-cutting runs SOLO and LAST**, against the settled tree. Pagination touched ~30 list
  pages; run alone it produced no collisions.
- **Every agent needs its own `TEST_DB_NAMESPACE`.** Without it they drop each other's template
  mid-run and both sets of results become noise that looks like real failures.
- **Tell each agent the traps its items will hit** — the guards it must not weaken, the writers that
  recently broke, the contracts it may not change. The best results this session came from briefs that
  named the specific hazard.
- **Agents must REPRODUCE before fixing.** Four reported faults this session did not reproduce; the
  code was correct and the real cause was adjacent. A held-back item with findings is a good result.
- **The integration gate catches what no agent can see.** Every agent's own tests passed in r74 and
  r75; the full suite still found a permission-matrix omission and a nested-form bug. Per-agent runs
  are necessary and never sufficient.

## Traps that cost real time this session

**THIS DOCUMENT'S SHIPPED LISTS ARE NOT EVIDENCE.** r76 found an item recorded here as shipped in r74
that had never merged — and the same file listed it as still planned twenty lines earlier. The reporter
was shown, and refuted, a feature that did not exist. Before trusting any "shipped" claim, run
`git log -S <a symbol the work introduced> main`. An empty result means it never landed, whatever this
file says. The abandoned branch also carried a migration number `main` had already used, which merges as
a **silent skip**, not a conflict.

**TEST DATABASES LEAK.** `TEST_DB_NAMESPACE` has no teardown — each parallel round permanently adds a
template plus ten workers. It reached **366 test databases**, at which point DROP/CREATE DATABASE hangs
and a normally 1-7s template build took **1308s**. It looked exactly like a catastrophically slow
migration and nearly got reported as a 22-minute production deploy window. It is not: production has a
handful of databases. Cleanup restored a 7-second rehearsal. **106 databases and 138 git worktrees are
still lying around — both want a sweep.** The harness should drop a namespace's databases when its run
ends.

**Local Postgres after a reboot.** Data dir `/opt/homebrew/var/aihr-pg14`, but its config defaults to
port **5432** while the project uses **5433** — it must be started with `-o "-p 5433"`. After an unclean
stop it needs several minutes of crash recovery (397s this time). A launchd unit would end this.

**tsc CANNOT see a missing translation key.** `t('historyRevision')` type-checks and fails at runtime.
Six locales, no guard for it. A source-static test comparing `t('…')` calls against `messages/en.json`
would be cheap and is not written yet.

**`rejects.toThrow()` passes on the WRONG throw.** Two tests this session passed for the wrong reason —
one because a fixture used a non-existent field so the insert failed on NOT NULL before ever reaching
the constraint under test. Assert the constraint NAME or match the real Postgres error via the `.cause`
chain; Drizzle wraps errors as "Failed query: …".

**Fetching page HTML to check the UI gives false positives.** Next.js embeds the whole i18n catalog in
the payload, so grepping rendered HTML for a label finds it whether or not the component rendered.
Check the component source.

## Live state

**Deployed:** `main@35cde09`, service active, migrations through **0322**.

Shipped this session and live: r73 (3 items + `blocked` status + a silent data-loss fix), plan history
(0318), r74 (10 items), r75 (10 items), slice 4 (nav + page gating), feedback attachments on push-back
(0321), r76 (4 items + the 9816a5ad investigation, 0322). **37+ feedback items closed, 6 migrations.**

**Board right now: 0 approved. 13 open or contested awaiting plans, plus the planned queue.**

**THE ANSWER TO 9816a5ad IS LOAD-BEARING FOR SEVERAL QUEUED ITEMS — read r76 Decision 2 before touching
entitlements.** Short form: both entitlement configurations are live (Annual Leave 6 employees on Benefit
Scheme, 16 on `leave_policy`), and `leave_policy` is the ONLY home for earning method, carry-forward and
expiry, rounding, and `maxBalanceDays` — for scheme-driven employees too. Deleting it zeroes 16
employees' leave and stops accrual for all 22.

**The reporter has since contested that plan and asked for a RESET instead** — delete the existing
entitlement values outright and reconfigure from scratch on Benefit Schemes, explicitly declining the
migration path. That is a knowing acceptance of the disruption, and it interacts with `fa3f4ccb`
(same reporter, "remove the entire section and delete any entitlement logic, data, dependencies or
calculations", no backward compatibility) — the two want the same demolition and should be planned
together, not separately.

PLANNED, awaiting approval — the notable ones:
- `fc776376` pagination, revision 2. **The reporter is right that it is not there.** The feedback board
  (517 rows, their largest list) was deliberately excluded because it sorts in the browser, and
  everywhere else `showPager()` hides the controls below 25 rows while their lists hold 23-47. The
  re-plan builds a client-side pager and makes the size control always visible.
- `9cbf5e0d` — now a LARGE item: the reporter supplied the full Employee Status state machine, six
  statuses, three retired, no manual editing. Supersedes what r75 shipped.
- `241817ef` — the third attempt at removing the Approval Workflow subsections. Two settings live ONLY
  there (the multi-step OFF switch, the escalation config). This revision RECOMMENDS putting both on
  the Assignment Template, so approving it now carries a real instruction.
- `deec1691` — reporter overruled the operator-only placement; explorer moves under Admin as a sellable
  module defaulting OFF, using the slice-4 gating shipped this session.
- `89ea527b`, `1ef1cf95`, `8ebabbf2`. (`48224d12`, `22de47c4` and `23ad620e` shipped in r76;
  `fa3f4ccb`, `1f6fd6d8`, `241817ef` and `9816a5ad` are now **contested** and need re-plans.)

**CONTESTED, needing re-plans (as of r76):** `9816a5ad` (reset instead of migrate — see Live state above) ·
`fa3f4ccb` (delete the Company Entitlements service-length bands outright, no backward compatibility) ·
`1f6fd6d8` (reporter supplied the exact Leave Balance Summary field list and formula) · `241817ef` (third
attempt; reporter argues the company multi-step toggle is redundant because the template decides it).

**OPEN, unplanned (9):** `63393e52` + `d8471481` (both employee import — CSV upload vs an .xlsx redesign;
**plan them together or they will contradict each other**) · `a324a4b3` (Admin > Attendance expandable
menu — overlaps what r74 already split three ways, check before planning) · `941c9dac` (movement
effective date vs entry date) · `4d391ab7` (one movement event writes TWO employment history rows) ·
`ae9350f2` (Termination movement type — interacts with `4d391ab7`, same writer) · `61bf109d` (pay item
input types + formula setting) · `956cec85` (Malaysia statutory forms submenu) · `d6429eb4` (wording only:
"Decide Each Date").

## Carried debt — none of it blocking, all of it real

1. **NOTHING HAS BEEN BROWSER-VERIFIED since r70.** r71 through r75 plus slice 4 moved Payroll's whole
   navigation to a fly-out, split Attendance three ways, renamed leave labels across screens, added
   four inquiry surfaces, added pagination to ~17 screens and now hide menu rows by entitlement. All of
   it verified by tests and `next build` only, which prove wiring and not layout. This is the single
   largest gap and it is why the pagination refute was a surprise rather than something we caught.
2. **Pagination pages in memory on ten tables** — `paginateRows()` fetches everything then slices. The
   reader-visible contract holds, but the plan promised faster loads and for those ten that is not yet
   true. Pushing limit/offset into ~10 read functions is the follow-up.
3. **ADR-0077 slices 5-10 are unbuilt.** Slice 4 shipped this session. The plan lives at
   `~/.claude/plans/resilient-greeting-ripple.md`. Note slice 4 had to be re-aimed at r74's `navNodes`
   contract because the plan predates it — expect the same for later slices.
4. **Test-DB and worktree cleanup**, per the traps above.
5. **No i18n key guard**, per the traps above.


---

# Round history

## r76 — 2026-07-29 — 4 approved items, and an investigation that stopped a deletion

**Shipped:** `main@35cde09` (branch `build/r76`). Migration `0322`.
**Gate:** `tsc` clean · **470 files / 5258 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, service active, 273 migrations applied, `person_emergency_contact` present
with both carried-over rows, and all five retired `person.emergency_contact_*` columns gone.

**Shipped:** 082fa566 (leave apply popup shows Pending approval + Available only) · 23ad620e (emergency
contact becomes a register; `0322` retires the single field) · 22de47c4 (Assign Template picker shows the
scheme name only) · 48224d12 (scheme names read once, deterministic order — **one bullet deliberately not
built**).
**Investigated, not built:** 9816a5ad — the answer went to the board as plan revision 3.

**Zero integration defects.** Three branches merged with no textual conflict AND no semantic one — the
first round since r69 where that held. Contrast r74 and r75, which each shipped a defect that only the
full suite caught. Not a new rule: it is a property of this item mix (one popup, one profile tab, two
config screens), and r68's counter-example still stands.

### Decisions

**1. AN ITEM CAME BACK REFUTED FOR BEING "BUILT IN THE WRONG PLACE" WHEN IT HAD NEVER BEEN BUILT AT ALL —
and this document is what said otherwise.** Line 335 of this file records `23ad620e (multiple emergency
contacts)` among r74's shipped items. It was not shipped. `git log -S person_emergency_contact main`
returns nothing; the work sat on an abandoned branch (`b1a4951`, worktree `wf_4aeeefdd-b40-4`) that never
merged. Line 136 of this same file simultaneously listed the item as still *planned* — the document
contradicted itself and nobody read both lines together. So the reporter was shown, and refuted, a
feature that did not exist. **A shipped-record that is never checked against the tree is worse than no
record**, because it is trusted. The correction is applied at line 335; the general fix is that a round's
shipped list should be generated from the merge, not typed.

The stranded branch also carried `db/migrations/0319_person_emergency_contact.sql` — and `main` had
already shipped `0319_attendance_rule_tenant_wide.sql`. Two different migrations, one number. Merged
naively that is not a conflict but a **silent skip**: drizzle-kit reads the last applied `when` once and
ignores anything below the watermark, so the table would simply never have been created in production and
the failure would have surfaced later as a missing relation. Renumbered to `0322` / `when
1781862422000`, and journal ordering was re-checked at integration (one pre-existing violation at idx
230→240, unchanged).

**2. THE INVESTIGATION'S ANSWER WAS "REMOVE NEITHER", AND IT PREVENTED ZEROING 16 EMPLOYEES' LEAVE.**
9816a5ad asked which of two entitlement configurations drives the balance an employee sees, and which is
safe to delete. Traced through code and then checked against production: **both are live.** For Annual
Leave, 6 of 22 active employees take their days from a Benefit Scheme and **16 fall through to the older
`leave_policy` timeline** (Medical: 5 / 17). Precedence is one shared composition,
`entitledDays = max(floorDays, schemeDays ?? policyDays)` (`core/leave-compute.ts:502`), with
`schemeBandDays` returning `null` — not zero — as the fallback trigger.

The sharper finding is the one the reporter could not have seen: **`scheme_leave_entitlement` stores days
and nothing else.** Earning method, carry-forward and its expiry, rounding, and `maxBalanceDays` live
ONLY on `leave_policy`, and are read for every employee including scheme-driven ones —
`accrueEarnedLeave` even asserts `pol!.days` non-null, so an earned-method type cannot accrue at all
without a policy row. Deleting the "redundant" configuration would not have tidied anything; it would
have zeroed 16 employees' Annual Leave and switched off monthly earning and carry-forward for all 22.
Confirmed against two real ledger entries where the two configurations disagree and the winner is
therefore provable (2.79 days = scheme's 12 prorated; 0.05 = policy's 10 prorated where the scheme had no
row). Also cleared up the premise: the two tables the reporter was comparing are **the same records
rendered twice**, not two configurations.

**3. THE FIFTH NON-REPRODUCING REPORT IN TWO SESSIONS.** 48224d12 asked to remove a second scheme picker
from Service Based Entitlements. That screen has exactly one `<select>` — Company — and picking a company
already lists every scheme. The picker described is on the adjacent *Benefit Schemes* sub-step. The agent
built nothing for that bullet and said so, which is the correct outcome; the item shipped its other three
bullets and the `build_ref` carries a plain-English note telling the reporter exactly which control we
did not touch and why. The recurring shape is now unmistakable: **a report names a screen, and the fault
is on the one beside it.**

**4. A DISPLAY STRING HAD A SECOND CONSUMER, AND CHANGING IT IN PLACE WOULD HAVE ALTERED A SURFACE THE
PLAN PROMISED WAS UNTOUCHED.** The composed scheme label at `app/admin/leave/approval/page.tsx:290` also
feeds `schemeText()`, the badge on the *saved assignments* table. The build added `name` alongside
`label` rather than editing `label`, so "only the picker changes" is literally true. Neither the file-map
scout nor I caught this; the build agent did, by reading every consumer before editing. The naming rule
itself now lives in `lib/benefit-scheme-label.ts`, deliberately **import-free** so it can never become an
ADR-0080 drift entry.

**5. THE REMOVED WARNING WAS THE ONLY PLACE THE PRODUCT ADMITTED THE TWO CONFIGURATIONS DISAGREE.**
48224d12 asked to delete the amber `serviceGradeDisagreement` note; 9816a5ad, running the same round,
proved the disagreement it reports is real and affects most of the workforce. Built as approved — the
reporter asked plainly and it is display-only and reversible — but **partially on purpose**: the surface
is withdrawn while `gradeLevelServiceDays` / `sampleYearsForColumn` and their prop wiring are kept and
still unit-tested, so restoring the note is a ten-line edit rather than an archaeology exercise. A test
pins the shape of that compromise so neither half drifts. The reporter was told plainly, in the plan
pushed to the board, that the note is gone and can be put back on request.

**6. Two judgment calls recorded because both went against the obvious reading.** The warning badge on the
Assign Template picker was KEPT despite "remove the supporting detail lines" — it is the stated cause of
the Assign button's `disabled` state, so removing it yields a dead button with no explanation. And the
shared `SchemeEntitlementMatrixRow` was changed for BOTH surfaces though only one was reported, because
that file already carries an explicit invariant that the two surfaces must name a scheme identically;
fixing one would have created exactly the drift the invariant exists to prevent.

**Carried:** every UI change in r71–r76 plus slice 4 remains **browser-unverified**. This round moved a
leave popup, rebuilt the personnel Profile tab's emergency-contact section, and changed two config
screens. The 082fa566 build also notes its two surviving columns are `text-right` in a `w-full` table and
will now spread across the dialog rather than sitting compactly — plausible, unseen.

---

## Feedback attachments on push-back — 2026-07-29 — a screenshot when asking for changes (0321)

**Shipped:** `main@1fce3cf`. Migration `0321`.
**Gate:** `tsc` clean · **468 files / 5215 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, both columns present, 105 existing attachments defaulted to `submitted`.

Reported directly, not via the board: the feedback form lets you attach an image when you first raise an
item, but there is no attachment option when you ask for changes. Confirmed — the raise form carried a
file input, the contest and refute forms only a textarea.

### Decisions

**1. The stage column is why this was not a one-line fix.** feedback_attachment had no notion of WHEN an
image arrived, so an untagged upload on a contest would sit indistinguishably beside the original bug
screenshot. On an item that has been round three times that is a pile of pictures with no story — the
exact failure 0318 fixed for the plan TEXT, about to be reintroduced for the images. So an attachment now
records the plan revision it answers plus what the reporter was doing (submitted / contested / refuted),
with a CHECK pairing them: a contested row cannot exist without naming a revision and silently fall out
of the timeline. `stage` is deliberately NOT derivable from the revision — a contest and a post-deploy
refute can both answer revision 2 and are different complaints.

**2. The revision is read at attach time, never taken from the form.** A stale page would otherwise file
an image against the wrong round. Pinned by a test that re-plans afterwards and asserts the earlier image
still answers v1.

**3. A failed upload does not roll back the push-back.** Losing a recorded objection because a file was
too large is the worse outcome, so failures surface on the toast and the words survive.

**Two of my own mistakes, recorded because both are recurring shapes:**
- The constraint test PASSED FOR THE WRONG REASON — it used a Base field that does not exist, so
  employment_id was null and both inserts failed on NOT NULL; the CHECK under test was never reached. It
  now asserts the constraint BY NAME. A test that only checks "it threw" passes on the wrong throw.
- tsc CANNOT SEE A MISSING TRANSLATION KEY. t('historyRevision') does not exist; the real key is
  historyPlanV. Found by checking every key in the file against messages/en.json. With six locales and no
  guard for this, it will happen again.

**Environment note.** The Mac rebooted at 08:16 and the local Postgres did not come back — its data dir
defaults to port 5432 while the project uses 5433, so it needs `-o "-p 5433"` at start, and it took 397s
of crash recovery after the unclean stop. Worth a launchd unit rather than a manual start.

---

## Slice 4 — 2026-07-29 — nav + page gating from entitlements (ADR-0077)

**Shipped:** `main@14cbdcf`. No migration.
**Gate:** `tsc` clean · **467 files / 5209 tests** · `next build` clean. Verified live: `GET /` 401.

The rail stops advertising modules the customer has not bought, and a module entry page redirects with
an explanation instead of an error screen.

### Decisions

**1. BOTH LAYERS FAIL OPEN — the opposite of every service gate, and the decision worth reviewing.**
getSession degrades to a session with NO snapshot on a migration-lag deploy, a revoked grant or a
connection blip. Services must refuse in that state: a service that guesses moves money. If nav did the
same, that same blip would empty the sidebar for every user of a paying tenant WHILE THEIR PAGES STILL
WORKED, and the product would look uninstalled. So `visibleModuleCodes` returns `null` ("no opinion,
show everything") as a value genuinely distinct from `[]` ("hide everything"), and a test pins that the
two differ. Showing a link to something you cannot use is a worse menu; hiding everything is a worse
outage — and the service layer is the control either way.

**2. Hiding is NOT the control, and that is asserted rather than assumed.** A hidden module's service
call still throws `ModuleNotEnabledError` (D3). If that test ever stops throwing, slice 4 has quietly
become enforcement and an unpurchased module is reachable by typing its address. A deep link skips the
redirect entirely and meets the service refusal — correct, and precisely why this layer is allowed to
be incomplete. Completeness here would imply the redirect is what protects the module.

**3. Core modules are never hidden**, even when a snapshot explicitly disables them. A rail without My
Absence is a broken product, not a downgraded one. `leave` contributes nav and is core; the four
sellable ones (attendance, claims, payroll, performance) are the only hiding candidates.

**4. The plan was written against a contract that no longer exists.** It assumed `nav?:
NavNodeDescriptor` — one untagged node per pack. r74 replaced that with `navNodes`, an array of
group-tagged nodes, and split Attendance three ways. Slice 4 gates against the new shape. The
row-to-module map is derived from the pack descriptors the sidebar already resolves rather than a
hand-written list, so it cannot drift the next time a pack adds a row.

**Process note.** The first test fixture invented a per-module status map where `EntitlementSnapshot`
actually carries `enabledModules: string[]`. The fail-open catch turned that malformed context into
"show everything" — correct in production, and indistinguishable from a passing design in a test. Every
case now asserts a NON-null result first, so a fixture that stops matching the real shape fails loudly
instead of quietly exercising the degraded path.

**Carried:** slice 4 hides menu rows and has never been browser-verified, along with r71-r75.

---

## r75 — 2026-07-29 — 10 approved items (approval config, leave surfaces, HRDF, movement, pagination)

**Shipped:** `main@778821c` (branch `build/r75`). Migration `0320`.
**Gate:** `tsc` clean · **466 files / 5202 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, both `app.approval_history` and the new `app.approval_history_count`
present on production.

**Shipped:** 9816a5ad + 22de47c4 (Job Grade gives way to Benefit Scheme, entitlements and approval
assignment) · 082fa566 (Available nets off committed leave) · 29710798 (one success message) ·
1f6fd6d8 (leave view config matches the revised summary) · efece4ce (say "not registered for HRDF"
instead of showing nothing) · e3c733df (Criteria column restored on Job Grade) · 66a63bd6 (Employment
History Edit + Delete as visible reversals) · deec1691 (record relationship explorer, operator plane) ·
fc776376 (one pagination framework).
**Held, returned to the reporter as re-plans:** 4b90e548 · c4339f4c.

### Decisions

**1. An agent refused a removal and corrected my brief while doing it.** `4b90e548` asked to delete the
Approval Workflows and Company Defaults subsections. Three things live only there: the ONLY switch that
turns multi-step approval OFF (the Assign Template button posts a hardcoded `value="1"` — it can only
turn it on), the ONLY editor for the escalation settings the overnight sweep reads live, and the
wildcard any-type approval rules, which render read-only elsewhere. Removing the section would not stop
escalation — it would FREEZE it, permanently and unchangeably.

I had told the agent that removing the company-default fallback would leave requests unroutable. That
was wrong, and it checked: resolution falls through to a built-in `['direct_manager','hr_admin']` chain.
The real failure mode is SILENT RE-ROUTING — employees covered by a company default would quietly change
approver with nothing surfacing it. Worse than unroutable, because unroutable fails loudly. The item now
asks the reporter one question: where do those two settings live once their section is gone.

**2. The fourth non-reproducing report, and the first with a mechanism found.** `c4339f4c` claimed Leave
History shows only Annual Leave. There is no leave-type predicate anywhere in that path, proven with a
test seeding six types that all return. But the agent then found the likely real cause: EMERGENCY LEAVE
NEVER APPEARS UNDER ITS OWN NAME — `requestEmergencyLeave` decomposes an EL request into ANNUAL + UNPAID
child rows when EL has no configured balance source. The reporter is probably looking for an EL
application that genuinely is not there as "Emergency Leave". Asked for one specific example rather than
guessing; the six-type test is kept as a regression guard.

**3. HRDF was never a calculation fault.** The levy computes correctly (2026-08 Chin Hin Construction
Engineering = RM56). SIX of eight companies have no HRDF registration at all, including ISEDECOR BINA —
the largest active payroll. And the real bug: an employee there has "Subject to HRDF" ticked while the
company is unregistered, so the tick is SILENTLY DISCARDED (`hrdfSubject` returns the explicit flag,
then the levy yields 0 for `not_registered` — the function's own header says so). Someone set something
and nothing happened, with no message anywhere. Fixed by saying so on screen, not by changing the levy.

**4. Pagination held back TEN surfaces and named every one.** The dangerous class: six client-side
sortable grids sort and filter IN THE BROWSER over the full fetched set, so server-paging their rows
would silently demote column sorting to sorting-within-the-current-page — a behaviour regression
disguised as a display change. Three more were excluded for the reason import previews are: `/approvals`
(paging a bulk-decision surface makes "approve all" mean "approve all on this page"),
`/admin/claims/reimbursements` (a footer total covering rows you cannot see), `/leave/employee-balances`
(a single-record breakdown). And it caught a same-round conflict: the `/leave` Employee Details listing
pages at exactly TEN because 650b6eb8 asked for ten — the shared default of 25 would have reverted an
approved item.

**5. Two promises to the reporter that the build did not fully keep, recorded rather than buried.** The
pagination plan said three releases; it shipped as one commit (nothing staged back — the phrasing was
about risk containment). And it promised every list screen would load faster "because the page fetches
25 rows instead of all of them" — true for the seven screens that page in SQL, NOT yet true for the ten
that use `paginateRows()` and still fetch everything before slicing. The reader-visible contract is
identical and the 2,000-row ceiling still protects the browser; the SQL push-down is the follow-up.

**Carried, still not done:** r71–r75 UI changes have never been browser-verified. This round alone added
pagination to ~17 screens, moved Job Grade to Benefit Scheme on two config screens, and added Edit and
Delete to Employment History.

**Operational finding, not a product one.** The r75 gate showed the test template taking 1308s to
migrate, against 1-7s in every prior round, which looked like migration 0320 being catastrophically
slow. It was not. DROP DATABASE and CREATE DATABASE were hanging: the local cluster had accumulated
379 databases, 366 of them test databases, because TEST_DB_NAMESPACE has no teardown and every
parallel agent round permanently adds a template plus ten workers. 280 leaked workers and 27 leaked
templates across r73-r75. After dropping them the same rehearsal ran in SEVEN SECONDS.

Worth recording for two reasons. Production was never at risk - it holds a handful of databases and
0320 is a CREATE OR REPLACE FUNCTION - so reporting a 22-minute production migration window would
have been wrong. And the isolation strategy that made six concurrent agents possible leaks: without a
teardown it gets slower every round until someone meets it during an incident. The harness should drop
a namespace's databases when its run ends.

---

## r74 — 2026-07-29 — 10 approved items (payroll nav, attendance rules, leave inquiry, entitlements)

**Shipped:** `main@0230bbf` (branch `build/r74`). Migration `0319`.
**Gate:** `tsc` clean · **459 files / 5115 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, all 9 attendance rules converted tenant-wide on production.

**Shipped:** 1459e116 (Payroll tabs → sidebar fly-out) · 6da67ab7 (attendance rules tenant-wide) ·
8ec63139 · 20c699f8 · 953be4b0 · 650b6eb8 (the four-part HR-admin leave inquiry surface) · 37a1141e
(Carried Forward → Brought Forward) · ~~23ad620e (multiple emergency contacts)~~ **— WRONG, see r76
Decision 1: this never merged and was built for real in r76** · 9cbf5e0d (employee
status follows the derived default) · a03eff24 (entitlement setup as a grade-group matrix). Plus
0bb0e303 and the 895c80f9 nav contract, built ahead of the round.

### Decisions

**1. A third nav node exists to stop a silent access regression.** 0bb0e303 splits Attendance by
audience. The obvious two-way split — staff rows and admin rows — puts Roster and Import under Admin,
but both are `managerUp` and the Administration sidebar group is gated `adminOnly` AS A WHOLE, so every
manager who reaches them today would have lost them with no error and no ticket. They get a third node
in the per-row-gated Manage group. Pinned as its own named test, because it is the one way that change
could quietly take access away.

**2. `0319` drops the company axis, and that — not a new shift link — is what the item actually needed.**
The reporter asked to "bind attendance policy directly to shift setting". A shift ALREADY picks its rule
via `shift.rule_id`; the blocker was that a shift is tenant-wide while the rule library was per-company,
so one shared shift could only ever point at one company's rules while employees of every other company
were rostered onto it. Conversion is non-destructive: the Standard of the company with the most
employments wins tenant-wide, every other company's Standard survives renamed `Standard — <Company>`,
and name collisions are suffixed rather than merged. `attendance_policy` was deliberately NOT touched —
it is the fallback for days with no assigned shift, the branch b7b886e2 left on legacy duration math.

**3. Three defects reached integration that no agent's own tests could have caught.** Each is an argument
for the full-suite gate over per-agent targeted runs:
- Two `scopedAdmin` screens shipped with **no permission-matrix column**, so Security & Permissions could
  neither grant nor revoke them. Caught by the reverse-completeness guard in `function-access.test.ts`.
- `FilterPanel` was mounted INSIDE another `<form>` on both new inquiry pages. Nested forms are invalid
  HTML that browsers do not report — the parser discards the inner tags, the panel's fields are absorbed
  into the outer form, and its Apply button submits that one. It worked only because both targeted the
  same action, and wave 2 then added a `hidden` prop for the two-listing page, which is exactly the case
  where merged forms submit the wrong field set. Guarded by `filter-panel-not-nested.test.ts`.
- Two defects in my own 0bb0e303 work, both from verifying with a hand-picked file list: a tsc error from
  an edit I re-ran vitest but not tsc after, and a source-static guard that could not even COLLECT because
  it read a const the split renamed — a file I never ran.

**4. An item was held back for being part of a set, and the refusal was right.** 650b6eb8's plan says it
is part 2 of 4 and must ship with its three siblings; the grouping split them across two agents. Building
the shell alone meant a three-tab navigation with two tabs 404ing, or that agent silently building its
siblings and colliding with the other. It wrote nothing and said why. Its siblings shipped in wave 1, so
it built cleanly in wave 2 — the sequencing, not the item, was the problem.

**5. OPEN, for the reporter not us:** `/leave` now opens on Employee Details but KEEPS the org-wide
leave-request table below it. The item reads as though the landing page becomes the inquiry surface, but
removing that table would undo 8ec63139 from this same round — same reporter, who asked for multi-select
filters on every one of its columns — and orphan `/leave/export`. Reversible if they disagree.

**Carried, still not done:** r71–r74 UI changes have never been browser-verified. This round moved
Payroll's entire navigation to a fly-out, split the Attendance menu three ways, renamed leave labels
across screens and added four inquiry surfaces. Tests and `next build` prove wiring, not layout.

---

## Plan history — 2026-07-28 — the request→plan→push-back→re-plan trail is kept (0318)

**Shipped:** `main@e3ef2bf`. Migration `0318`, new table `feedback_plan_revision`, backfill wired into
`deploy.sh` permanently.
**Gate:** `tsc` clean · **453 files / 5008 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, **478 plan versions recorded**, 40 reported unrecoverable.

Not a feedback item — asked for directly. The board could show the CURRENT plan and nothing else.

### Decisions

**1. The history was being destroyed as it happened, not merely unshown.** `feedback_request` holds ONE
`plan` and ONE `contest_reason`; every re-plan overwrote the plan and cleared the push-back that caused
it, and the events carried `{revision, model}` / `{revision, decidedBy}` — never the text. Measured before
building: 29 items had gone more than one round, **~40 plan versions already gone**, one item six rounds
deep. Those are NOT reconstructed. The page compares history rows against `plan_revision` and states how
many are missing; a placeholder row would turn a known unknown into a plausible lie.

**2. SELECT-only was incoherent, and the correction is the real design.** The first cut granted the app
read-only "because the services write as owner" — they do not: in-app approve/contest run as `ai_hr_app`
through `withTenant`, so a read-only grant would have recorded nothing the reporter did. The guarantee is
**append-and-close-once**: INSERT a live revision, UPDATE it once to close it, never DELETE. `USING
(outcome IS NULL)` makes closure one-way — a recorded objection matches no UPDATE policy again — and a
BEFORE UPDATE trigger freezes the plan text, because RLS is row-level and cannot stop a rewrite riding
along with the close. Caught by a test, not by review.

**3. Approval is a STAMP, not an ending.** Closing the revision on approval left a shipped-then-refuted
plan with nowhere to record the refutation — the version was already spent, so the reporter's post-deploy
words vanished. That is the exact class of loss this table exists to prevent, reintroduced one layer down.
`approved_at` and `outcome` are now separate facts on one row: they approved it, we shipped it, they sent
it back.

**4. "0 refute reasons recovered" was checked, not accepted.** The deploy printed 0 where 27 was expected.
26 genuinely cannot be recovered — a refute triggers a re-plan that increments `plan_revision`, so the
version each refute answered no longer exists as a row (confirmed against the event payloads: every refute
revision sits below its item's current one). The 27th WAS recoverable and had been mislabelled
`contested`, because `refuteDeployment` parks its text in `contest_reason`. Keeping "you built the wrong
thing" apart from "you shipped it and it missed" is why the table has separate outcomes, so the backfill
now relabels it. Production reads `refuted|1`.

**5. The first upgrade rehearsal FAIL was real and nearly dismissed.** Every data check printed `ok`, so it
read as noise — but step 4 (apply the new migrations) had failed on a missing `drizzle-kit` in the fresh
worktree, meaning those checks validated the BASELINE alone and `0318` had never been rehearsed. Deps
installed; the re-run is a genuine PASS over populated data. A rehearsal whose failure mode looks like
success is worth remembering.

**Also corrected mid-build:** two tamper assertions had been loosened to `/append-only|Failed query/` to
reach green — which would pass on any query failure at all, i.e. a permissions test that does not test
permissions. Replaced with a helper that walks Drizzle's `.cause` chain for the real Postgres error.

---

## r73 — 2026-07-28 — 3 approved items + the `blocked` status + a silent data-loss fix

**Shipped:** `main@d13b226` (branch `build/r73`). Migration `0317`.
**Gate:** `tsc` clean · **452 files / 4995 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, `feedback_status` carries `blocked`, both columns present on production.

**Shipped:** 622e12eb (Payroll Register report) · b7b886e2 (attendance derived against the shift's
time-in/out window) · 08913328 (Movement Current/After comparison, delta-only writes).
**Closed without code, per approved decisions:** 4c6f69bd · 7a348d34 · 3282eccc · d7455ed2.

### Decisions

**1. `blocked` exists because the board could not tell parked work from queued work.** `approved` means
"the reporter agreed to the plan", which the loop reads as "ready to build" — but an item is sometimes
approved and then found to depend on a question only the reporter can settle. Five sat in `approved`
looking identical to work merely waiting its turn, and each round re-derived the difference from memory.
The guard is `startFeedbackBuild`, which accepts only `approved`: parking an item removes it from every
build round, so a block cannot be worked around by an agent that never saw the question. Labelled
**"Waiting on an answer"**, not "Blocked" — the consultant is not an engineer, and naming the question
tells them there is something to do.

**2. All three DECISION items came back approved, and two of them closed items rather than building
anything.** `3282eccc` → keep first-year leave granted up front; 4c6f69bd closed, Mei Ling's 19.73 is the
agreed model. `d7455ed2` → SKBBK does follow the employee profile; 7a348d34 closed, only the stale May run
carries the old figure. `895c80f9` → build the two-node nav rule. Each closure carries a plain-English ref
saying no code changed and why, so "Deployed" does not send the reporter hunting for a fix that was never
needed.

**3. `transferEmployee` silently wiped every employee's Business Unit — pre-existing, still live.** The
CLOSE+INSERT carried department, position, cost centre, location, employment type and status forward but
not `business_unit_id`, so each new assignment version was written NULL. No error, no event, no changed
label. The writer predates the column (migration `0219`). Both live callers are on the Employment tab and
neither has any business touching a business unit: `setLocationAction` names only a location,
`transferAction` only a department — so an admin changing where someone sits silently unassigned them from
their business unit. This is why 08913328 moved Movement off the writer, but the writer stayed live on the
location flow, which is the part that kept costing data. The build agent filed it rather than fixing it;
overruled, because the loss is silent and the screen is in daily use. Proven red before green.

**4. A build agent's side effect was reverted.** The register build registered its dataset first, silently
changing which dataset the Payroll "New report" button seeds. The item asked for a register to EXIST, not
for an existing button to start doing something else.

**5. Held back for the reporter to decide, not guessed:** Edit/Delete of Employment History events (it is a
projection over the append-only event ledger — "delete" means a compensating event or tampering with the
audit trail); a "Pay Group" field that exists nowhere in the schema (nearest neighbour is Payroll Policy,
and mapping one onto the other would quietly redefine an admin's mental model); and Hire as a creatable
Movement type (it would create a second way to originate an employment).

---

## r72 — 2026-07-28 — 13 approved items (leave config, approvals, org labels, HRDF)

**Shipped:** `main@d345d68` (branch `build/r72`). 61 files, +4401/−1094, migration `0316`.
**Gate:** `tsc` clean · **448 files / 4961 tests** · `next build` clean · **upgrade rehearsal PASS**.

**Shipped:** cdf9ca48 + a7fab30b (Balance Deduction Source + Allow Unpaid Leave) · bc9be1e8 + 0d9cf710
(retire the Company Entitlements tab) · c9986927 (organisation lists → Organization Labels) · 1e4eb8af
(Leave Year Configuration into Leave Type > Custom Settings) · 726ac8c2 (Manager Leave Summary) ·
165baee5 + f6d3be0b (Condition · Criteria editable in place) · bb3938b9 (Assign Template criteria panels) ·
3d2bc793 (shortcuts row) · d4735493 (single-vs-multi-step an explicit choice) · efece4ce (HRDF levy in
Transaction View History).

### Decisions

**1. Parallel agents produced three collisions none of them could see.** Every agent's own tests passed;
the combined tree failed. (a) `cdf9ca48` changed the apply-popup to resolve the SOURCE balance type while
two tests pinned the old argument list — the INVARIANT (popup Pending == submit-guard reserve) was verified
to still hold before rewriting them against shared helpers, rather than editing them until they passed.
(b) `165baee5`/`f6d3be0b` changed the rule-card idiom while `cdf9ca48`/`a7fab30b` added cards using the old
one; only the two new cards moved. The lesson carried into r73: group agents by file overlap, and treat any
cross-cutting item as solo work.

**2. The HRDF fault did not reproduce as reported.** It is computed and stored correctly; it reads 0.00
because only one company has a rate configured. Surfacing it in Transaction View History is what shipped.

---

## r71 — 2026-07-28 — 12 approved items (leave entitlements, counts, labels)

**Shipped:** `main@5c1d6bf` (branch `build/r71-clean@fe2bb0c`). 28 files, +565 lines, migration `0315`.
**Gate:** `tsc` clean · **443 files / 4869 tests** · `next build` clean · **upgrade rehearsal PASS** —
the first release gated against a POPULATED database rather than an empty one. Deployed and verified
live: `GET /` 401, `job_grade.description` present on production, no errors since restart.

**Shipped:** 783bf55a · baea8e5b · c2a48426 · 77a4049f · 45c781e2 · 7f9fbf50 · 082fa566 · ab77dc1f ·
9b25b094 · a46fe0c0 · 567333b7 · e3c733df.

### Decisions

**1. Two reported bugs were one, and the allowlist was asking the wrong question.** `openLeaveYear`
selected what to grant with `code IN STANDING_LEAVE_CODES` — ANNUAL, SICK, HOSPITALIZATION and nothing
else — so a Service-Based Entitlement on Caregiver or Study Leave saved successfully and never reached
an employee (783bf55a), and leave taken against the resulting non-existent grant drove the ledger below
zero (baea8e5b). The allowlist itself was correct: ADR-0066 keeps FESTIVE types out of the accrual and
forfeit engines deliberately. What was wrong was the discriminator. It now asks **"did an administrator
configure entitlement days for this type"** rather than "is this code one of three strings". Festive
types have neither a policy nor a scheme entitlement, so they are still excluded.

**2. Three items were HELD because the report did not survive contact with the data.** Each would have
changed money or reversed a decision on a reading that turned out to be wrong:
- `4c6f69bd` → raised **3282eccc**. Wants 11.34 days where the system deliberately grants 19.73 up
  front (decision `adcdf215`). A different MODEL, not a rounding bug.
- `7a348d34` → raised **d7455ed2**. The reported SKBBK fault **does not reproduce** — T100009's July and
  June payslips are both 0.00; only the stale May run carries 44.65. The real gap found instead: an
  employee with NO statutory record is treated as covered while one with an all-unticked record is
  exempt, so saving an empty form differs from never opening it. Affects 5 of 20 active employees.
- `1459e116`. The Payroll nav row is contributed by the payroll PACK, not the sidebar, so a fly-out
  changes the pack's nav contract — and the component renders one child level where the request draws
  three.

**3. Two items needed a reading of the request other than the literal one, both recorded on the board so
the reporter can overrule.** `e3c733df` asked to rename Grade Name → Description and add a new Label;
done literally, every existing grade name moves under "Description" and Label — the field people read —
is blank on every row. The item's stated GOAL was to match the other System Label categories, whose
pattern is `label` = name shown, `description` = optional detail. Also declined the Criteria column:
`job_grade` is tenant-global, and the existing code records that hosting it in the company-scoped grid
"still rendered a meaningless Criteria column". `082fa566` got a NEW `available` key rather than
redefining `balance`, so anything that genuinely means a balance keeps its word.

**4. `useSearchParams` is gated by `next build`, not `tsc`.** It typechecks fine and fails at BUILD time
outside a Suspense boundary. Both new client components using it (`submit-toast`, the dialog's
open-on-arrival) were verified with a real build rather than assumed safe.

### Outstanding

- 22 approved items remain, including the pairs that must ship as single changes
  (`cdf9ca48`+`a7fab30b` touches pay; `bc9be1e8`+`0d9cf710` both remove the same tab).
- The r71 UI changes have NOT been browser-verified.

---

## Slice 3 — 2026-07-28 — deployment env gates become per-tenant entitlements

**Shipped:** `main@a664e5e` (merge `499e79e`, branch `build/slice3@8d1f18d`). 101 files, +6305 lines.
**Gate:** `tsc` clean · **442 files / 4865 tests** · `next build` clean. Deployed via the documented
two-phase sequence (`--migrate-only`, reconciliation checked, then finish); verified live — `GET /`
returns the 401 password gate and all three `toil_accrual` policies are present on production.

**Built:** eight `process.env.*_ENABLED` flags moved onto `isModuleEnabled` / `settingEnabled`;
migration `0314`; `scripts/reconcile-entitlement-parity.ts`; `scripts/check-audit-chain-gate.ts`;
`deploy.sh --migrate-only`; ~58 test files converted from env writes to entitlement rows.

### Decisions

**1. The cash-XOR-TOIL invariant was still switchable — by WHO RUNS PAYROLL — and that is the whole
reason this slice needed three review rounds.** Making the exclusion unconditional was not enough.
`EXCLUDE_TOIL_BANKED_DAYS` is a correlated subquery, so it runs under the CALLER's RLS. `0099` widened
attendance / payslip / compensation to the payroll capability but never `toil_accrual`, because nothing
in the payroll path read it then — this slice is what made that gap live. For a `payroll_partner` the
attendance row was visible and the accrual was not, so `not exists` read trivially TRUE and every banked
rest day would have been prefilled as overtime CASH while the leave credit stayed on the ledger: the
employee paid twice for one day. `0314` widens the read. **A guarantee that holds for one role and not
another is not a guarantee**, and no amount of unconditional application code fixes a visibility gap
underneath it.

**2. Widening a `FOR ALL` policy's `USING` clause cannot express "read only".** `0314`'s first attempt
did exactly that and asserted in its own header that it was safe "because WITH CHECK is unchanged".
That is false: **PostgreSQL authorises DELETE from `USING` alone** — a DELETE produces no new row, so
WITH CHECK is never consulted. Since `0076` grants `ai_hr_app` full DML, the USING clause was the only
thing standing between a payroll session and destroying an employee's banked-leave ledger. The shipped
form is a separate `FOR SELECT` policy (permissive policies are OR'd per command) plus a RESTRICTIVE
DELETE policy that also closes a pre-existing hole where an employee could delete their own accrual.

**3. The entitlement-parity reconciliation was removed from `deploy.sh` as an automated gate, on
purpose.** It could never reach a clean state: `provision.ts` deliberately writes ZERO `tenant_setting`
rows for a new tenant, while `enable-demo-flags.sh` sets three switches true on the box — so the
preflight counted every post-`0313` tenant as three rows short, permanently and by design. The first
customer provisioned after this deploy would have blocked every deploy after it, and both escapes were
worse than the check (`--apply` writes platform-scoped rows `ai_hr_app` cannot close again;
`ENTITLEMENT_PARITY_ACKNOWLEDGED` disables it forever). **A check whose only correct resolution is human
sign-off cannot be an automated `set -e` gate.** It is a one-shot for the maintenance window, and
`--migrate-only` exists to give it the stop point DEPLOY.md always described. This deploy verified it
was unnecessary rather than skipping it: the only tenants are the demo group (pre-`0313`, backfilled,
7 module rows) and the reserved system tenant.

**4. Eight separate guards in this slice could not see what they claimed to check.** The pattern, not
any single instance, is the finding: `adminCtx` exempting itself from the entitlements it was meant to
prove; the drift ratchet counting docblock prose as code; a test asserting a row count where only a
settled AMOUNT distinguishes converted from lapsed; and — the subtlest — the ratchet missing
`defaultProvisionModuleCodesIn(process.env)` because it matches literal gate NAMES in the scanned file
and the lookup happened one call away against a parameter. **A guard that checks a proxy for the
property is not checking the property.**

**5. Ruled PASS by hand, and the reason is recorded rather than hidden.** Round 1 passed, round 2
FAILED, and round 3's judge died on a network error without ruling. Rather than treat an unruled round
as a pass, the verdict was made explicitly: the gate above, `0314` **mutation-proven** load-bearing
(stubbed to `USING (false)` the payroll-partner tests redden; restored they pass), correct journaling,
and three of round 2's open findings confirmed fixed in code. Two LOW findings were not individually
re-verified — stated so the next reader knows the edge of what was checked.

### Outstanding

- `scripts/upgrade-rehearsal.sh` is committed on `build/r71` but **has never completed a run**. Every
  gate here tests the INSTALL (schema-only template, clean-room migrates an EMPTY database); nothing
  tests the UPGRADE against populated data. This deploy was exactly its use case.
- `build/r71` carries a DUPLICATE test-DB namespacing implementation; `main`'s (`a664e5e`) wins, since
  it also fixes `cleanroom-verify.sh`, which runs its own vitest and clobbered the shared template.
- Test isolation: `resetDb()` truncates ~90 tables **per test** at ~175ms — measured at ≈22% of total
  suite compute, and the source of the TRUNCATE deadlocks that produce phantom failures.

---

## Slice 1 — 2026-07-26 — entitlement + settings substrate (no behaviour change)

**Shipped:** `build/slice1@1be70fa`. 26 files, +1528 lines. Nothing READS these tables yet — slice 2
adds the resolver, slice 3 flips the env gates onto it. **Gate:** clean-room PASS ·
**441 files / 4785 tests** · `tsc` clean · `next build` clean · 3 adversarial rounds (13 agents,
1054 tool uses), all passed.

**Built:** migration `0313` (module + setting_definition catalogs, tenant_module, tenant_setting,
subscription, subscription_line, usage_snapshot, platform_user, tenant_provision_request_module,
tenant extended); `packs/catalog.ts` (14 modules — 6 core, 8 billable; 5 settings, 4 platform-scoped);
`scripts/seed-catalogs.ts` wired into all four bootstraps; `packs/register-all.ts`; harness defaults +
`setModule`/`setSetting`; provisioning and operator intake carrying country + modules end to end.

### Decisions

**1. The catalog is NOT the pack registry, and conflating them was the plan's original error.** A
`ModulePack` is a CODE identity; a catalog row is a COMMERCIAL one. They diverge both ways: `toil`,
`multi_cycle_payroll` and `typed_pay_components` are billable with **no pack** (they are behaviours
inside a parent pack's service), while `leave` **has** a pack but is core and must never be sellable.
So the catalog is its own table with `parentModule` + `packBacked`, seeded from a code manifest, and
`test/module-catalog-drift.test.ts` pins the correspondence in BOTH directions — a new pack without a
catalog row can never be sold; a row pointing at a non-existent pack fails the suite.

**2. The privilege matrix is the slice's real deliverable, and the gate structurally cannot check it.**
`bootstrap-db.sql:50-54` auto-grants full CRUD on every new table to `ai_hr_app`, and
`cleanroom-verify.sh:47-52` **reproduces that grant** — so the clean-room masks a missing GRANT and can
never catch a missing REVOKE. Delete a REVOKE from 0313 and every other test still passes while any
hr_admin can grant themselves Payroll. `test/module-entitlement-rls.test.ts` reads `information_schema`
directly. The round-3 judge **mutation-tested** this: deleted a REVOKE, exactly one test went red, and
nothing else in 4785 did.

**3. `tenant_setting`'s scope join is what makes "every flag in the database" safe.** Writes require own
tenant AND `app.is_admin()` AND an EXISTS proving `setting_definition.scope = 'tenant'` — in BOTH the
USING and WITH CHECK arms, closing INSERT, UPDATE (walking a row onto another key), DELETE and
ON CONFLICT. So a customer can SEE that their audit chain is on and cannot switch it off. Enforced in
Postgres, not in a server action, so it binds any path that reaches the table.

**4. Core modules are code, not rows — enforced by a TRIGGER, not a policy.** Policies do not bind the
owner and are bypassed entirely by a `BYPASSRLS` role, so the slice-7 platform plane would sail through
one. A tenant with zero entitlement rows still has Leave and ESS by construction.

**5. Local and production run different Postgres majors** — 14.17 vs 16.14. `UNIQUE NULLS NOT DISTINCT`
is PG15+, so the nullable `company_id` grain uses a COALESCE expression index. Anything written for 16
would pass on the server and fail the gate.

**6. Corrections made during the build, recorded so they are not repeated:**
- The plan's "GRANT SELECT on customer-visible columns only" conflates a ROW property with a COLUMN
  grant. `customer_visible` drives rendering; the resolver needs `default_value` for hidden rows too.
- I invented `CountryPack.currency`, which does not exist. Currency-from-pack is slice 6's job;
  provisioning keeps `'MYR'` with the reasoning recorded rather than shipping untested slice-6 work.
- `packs/*/index.ts` inside a block comment contains `*/` and **closes the comment early**. Rewrote as
  `packs/<name>/index.ts`.
- My divergence inventory was wrong by ~9x: **46** test files mutate a tracked gate, not 4. It is no
  longer prose — `SLICE3_ENV_GATE_WORKLIST` recomputes the file→gates map from the tree and compares
  both ways.
- Two tests were green only because this box leaves `INDIVIDUAL_TXN_PAY_ENABLED` unset. Fixed, and
  re-verified under the **live deployment's full flag set**.

### Outstanding

- **Slice 3 must inspect all 46 files individually.** The worklist detects THAT a file mutates a gate,
  not WHETHER the mutation lands before or after `seedBase` — hook-registration order is not
  statically decidable.
- **The 0313 setting backfill is one-shot and env-blind.** Parity-correct for the documented
  `cp .env.example .env.local` flow and for the one live deployment; on any OTHER populated database
  whose env lacks those flags it GRANTS payroll reset/unlock rather than preserving them. Remediation
  DELETE is inline at `0313:463` but must be run by hand, and nothing detects the divergence.
- The "admin can READ their own entitlements" test remains formula-equivalent to `seedBase`'s own
  computation; its independence rests on the two drift ratchets. Stated honestly in the test.

---

## Slice 0 — 2026-07-26 — SECURITY: invitation privilege-escalation closed

First slice of the ADR-0077 platform program (plan: `~/.claude/plans/resilient-greeting-ripple.md`).
Not a feedback round — no board items. **Shipped:** `build/slice0@02511f7` → `main` as `26eebbe`.
Deployed 05:54:58 +08 (`✓ Ready in 128ms`, `GET /` 401). Verified live on the server: the CHECK
constraint applied and BOTH guard triggers (`app_user_subject_guard`, `app_invitation_lifecycle_guard`)
are present.

**Gate:** clean-room **PASS** — **4722/4722 tests, 437 files** · `tsc` clean · `next build` clean ·
3 mandated adversarial rounds (13 agents, 768 tool uses), all passed · plus an independent operator-
takeover probe run by hand against a real DB.

### The vulnerability was real and was reproduced before any fix

Exploits were written FIRST and run against unpatched `main`: **5 succeeded.** A customer's group
admin — and even a single-company `hr_admin` — could mint themselves the installation-tier `operator`
role through the invitation seam and consume it into a real grant.

Two facts combined: `app_invitation_rls`'s WITH CHECK (0151:51-53) had **no role conjunct**, and
`app.consume_invitation` is SECURITY DEFINER (0281) inserting `v_inv.role` into `role_assignment`
uncritically — and `role_assignment` is not FORCE-RLS, so 0295's matrix **never evaluated**. The
invitation seam was a way to write a grant the grant table itself would have refused.

### Decisions

**1. The initial fix was correct but badly incomplete — three further paths were found under review.**
- **`person_id` is also a payload, and it is the sharper hole.** Consume does
  `UPDATE app_user SET workos_user_id = <accepter>` on the target person's existing login. An
  invitation with a *legitimate* role (hr_admin, own company) pointing at the group super_admin's
  **person** hands the accepter that identity and every grant it carries, and locks the victim out.
  **It needs no forbidden role at all**, so a role-only fix sails straight past it.
- **Invitation rows were mutable after issue.** `ai_hr_app` held UPDATE on every column with a
  scope-only USING, so a `revoked` invitation could be flipped back to `pending`, `accepted_at`
  blanked, `expires_at` extended and `token_hash` replaced — defeating single-use, expiry and
  `revokeInvitation` in one statement. A WITH CHECK **cannot** fix this: it sees only the new row,
  never the transition. Required a trigger.
- **The seam was not even the shortest path.** `app_user`'s policy (0016:191-193) lets any GROUP
  admin run `UPDATE app_user SET workos_user_id = '<my account>'` on ANY login in the tenant —
  including the `operator` login, which `app_user.tenant_id NOT NULL` guarantees lives in one
  (db/seed.ts:181-193). No invitation involved. Closing the seam alone left this wide open.

**2. `SECURITY DEFINER` helpers were `pg_temp`-shadowable.** Postgres searches the session's TEMP
schema first when `pg_temp` is not named, so the house-standard `SET search_path = public` does not
protect a definer: any `ai_hr_app` session may `CREATE TEMP TABLE employment(...)` and choose the
answer a helper returns — defeating the new person-scope conjunct. Every function this migration
creates uses `SET search_path = pg_catalog, public, pg_temp` **and** schema-qualifies its relations
(both, so neither is solely load-bearing), and the two pre-existing helpers in the chain
(`is_company_descendant`, `has_role_for`) are re-issued for the same reason.

**3. Two of the first-round tests passed for the WRONG reason.** `consume_invitation` opens with
`UPDATE app_invitation SET status='accepted'`, and a CHECK constraint is re-evaluated on the updated
row — so with the constraint restored right after a forged insert, the *constraint* was refusing the
row and the RAISE guard was never exercised. Green while asserting a different mechanism than
claimed. Fixed by holding the constraint off across the whole legacy window and asserting the RAISE
text specifically. **This is the failure mode to watch for in every later slice.**

**4. Deliberate deviation from the slice plan.** The plan called for consume to refuse "company-scoped
rows unless hr_admin". Rejected as wrong: 0295's group branch permits a group admin to grant any
customer role at any scope (a company-scoped `manager` is legitimate), and at consume time the session
is the INVITEE's, so inviter-context conjuncts are not re-evaluable. Consume checks only static row
facts. Also corrected: the plan's headline `super_admin` example was already closed — 0020's
`role_assignment_super_admin_group_wide` blocks it at the grant table. **`operator` was the open path.**

### Outstanding

- **Kept false positive (ops debt):** a person with an ACTIVATED login who must move to a new WorkOS
  subject (email change, re-hire, lost account) can no longer be re-bound by invitation — the invitee
  gets a raw 500 and recovery is owner-side only. The rejection reasoning holds (the DB cannot
  distinguish an innocent re-bind from a takeover) but it is reachable from the shipped person
  dropdown in `app/admin/users/page.tsx`, which does not filter people who already hold a login.
- **Next slice candidate:** the remaining 0015/0016 definer helpers (`can_see_person`,
  `can_admin_employment`, `can_see_employment`, `company_subtree`) still carry
  `SET search_path = public` and read relations unqualified — same `pg_temp` defect, live elsewhere in
  the RLS surface. Nothing 0312 guarantees routes through them.
- **Accepted residual:** a company-scoped hr_admin may still activate an un-activated, grant-less login
  of a person in its own subtree. Bounded by the person conjunct; closing it would break
  `db/provision.ts` and `bootstrap-invite.ts`.
- **Recurring flake class, spun off separately:** `test/cp38.test.ts` (and previously
  `test/zakat-history.test.ts`) assert a secret's absence by substring-matching `JSON.stringify` of a
  payload containing a random UUID — ~1% failure per run. Same defect class twice now; should assert
  on parsed fields.

---

## r70 — 2026-07-25 — 2 approved items (1 a re-fix of a contested r69 item)

**Shipped:** `build/r70@c130ff7` → merged to `main` as `8ce75a3`. Both `deployed`. `deploy.sh` migrated +
restarted, 14:17:10 +08 (`✓ Ready in 136ms`, `GET /` 401 = password gate).

**Gate:** clean-room **PASS** — **4678/4678 tests, 436 files** · `tsc` clean · `next build` clean. Plus a
manual browser measurement of `7fe7e1ae` (below) — the step the automated gate structurally cannot do.

| id | Item |
|---|---|
| `7fe7e1ae` | Action search bar — focus-ring overlap (RE-FIX; r69's attempt was a verified no-op) |
| `2bba9e35` | Service-Based Entitlements is now the full policy editor (unblocks `bc9be1e8`) |

### Decisions

**1. r69's `7fe7e1ae` fix was a provable no-op, and the loop's gate could not have caught it.** The
reporter contested it: *"It still looks the same."* Correct. r69 swapped the modal input's `w-full` for
`min-w-0 flex-1` on a horizontal-overflow theory; measured in the running app at 1280×720 and 375×812, the
before/after geometry is **byte-identical** (input 285px, 17px right-slack, `scrollWidth−clientWidth=0`).
There was never any horizontal overflow. The **real** defect is vertical: the input carries
`outline:2px, offset:2px` (a 4px-outset ring), sits flush at the modal's zero-padding top edge, and is
`autoFocus` — so its ring paints ~3px **above** the modal, across the 24px rounded corners, every time it
opens. r69 shipped anyway because its test was a **source-string** assertion (`min-w-0` present) that
cannot see pixels; the build agent flagged this as a KNOWN GAP and it shipped regardless. **This is the
loop's structural blind spot: the build phase forbids starting a dev server (hang-guard), so it literally
cannot verify a visual fix.** The operator must do the browser measurement for any UI-geometry item.

**2. The re-fix was verified by measurement, not assertion, and the panel found a bug the operator's own
diagnosis missed.** Fix: add the house `py-3` to the search row + `p-3` to the results wrapper (this row
was the ONLY `border-b border-border px-4` in the repo with no vertical padding — an oversight vs 35 other
CardHeader sites), and `outline:none` on `Dialog.Content`. That last one is the missed bug: Radix renders
`Dialog.Content` with `tabindex=-1`, so on Enter the **dialog itself** caught a focus ring across all four
corners — a worse version of the same defect. Browser-measured after the fix (ring inset vs the modal clip
box, positive = inside): search input **+8px** top (was −3px, outside); result row **+8px** all sides;
dialog container ring suppressed (`outline:none`); wide delegation state (max-w-4xl) no h-overflow, +29px
inside. The `inset-ring` alternative was rejected in planning: `app/globals.css` defines the focus rule
**unlayered**, so it beats every Tailwind utility — `outline-none`/`ring-inset` on the input are inert, and
routing around it would fork the app-wide focus ring for one field.

**3. `2bba9e35` was built to UNBLOCK `bc9be1e8`, and `bc9be1e8` was deliberately held out of this round.**
`bc9be1e8` (remove the Company Entitlements tab) must build off a `main` that already contains the full
editor, or its agent reads a tree where Service-Based Entitlements still can't add/delete and either
no-ops or deletes the only policy-management UI. Building both in one parallel batch off the *current*
`main` would have defeated exactly that ordering. So `2bba9e35` shipped alone this round; `bc9be1e8` is now
unblocked for r71. Browser-confirmed the new capability renders: the Service Based Entitlements sub-step
now shows "+ Add entitlement", "Remove", and the Earning Method control, not just day figures.

### Integration

Trivial — the two patches share no files (command-bar vs leave-type-panel), applied clean, no locale
overlap. The real work this round was verification, not merging.

### Outstanding

- **`bc9be1e8` is now BUILDABLE** — its blocker (`2bba9e35`) shipped to `main` this round. It is the only
  approved item on the board. r71: build it off `main` (which now contains the full editor), and confirm
  by hand that add/edit/**delete** of a per-company policy all work inside Service-Based Entitlements
  before removing the old tab — that hand-check is the item's own precondition, see r68 Decision 1.
- **Local dev DB drifts behind `main` between rounds.** It was a migration behind this round (`0311` from
  r68 never applied), so the app 500'd on load — which is *why* r69's visual bug was never seen before
  shipping. Run `npx drizzle-kit migrate` against `ai_hr_dev` (port 5433) before any browser check. An
  `r70-integration` entry was added to this worktree's `.claude/launch.json` (port 3011) to run built code.
- **The loop cannot self-verify UI geometry.** The build phase's hang-guard forbids a dev server, so every
  visual/layout item needs an operator browser measurement before release. r69→r70 is the cautionary tale.
- The hourly watcher still polls the stale `IMPROVE_SSH_HOST` default (`10.20.30.20`) and reports
  `approved=0`. Fix the plist before it hides a real backlog again.

---

## r69 — 2026-07-25 — 8 approved feedback items

**Shipped:** `build/r69@f56ccb7` → merged to `main` as `93d9d18`. All 8 `deployed`. `deploy.sh` migrated
and restarted the service, 00:04:23 +08 (`✓ Ready in 125ms`, journal clean, `GET /` 401 = password gate).

**Gate:** clean-room **PASS** — empty DB migrated `0000` → latest, then **4672/4672 tests, 436 files** as
`ai_hr_app` under RLS · `tsc --noEmit` clean · `next build` clean. **Zero integration failures** — the
first multi-item round in a while where nothing collided (contrast r68, which had two).

| id | Kind | Item |
|---|---|---|
| `57840a6e` | issue | HRDF contribution not calculated after payroll processing |
| `0315dac7` | issue | Incorrect leave balance |
| `f71dcafd` | issue | Notification icon UI — colliding count bubbles |
| `7fe7e1ae` | issue | Action search bar input spilling past the popup edge |
| `421d7551` | enhancement | "My Absence" renamed to "My Leave" |
| `9e64ac20` | enhancement | Leave request popup — deduction box replaced with a compact summary |
| `836118c4` | enhancement | "Approval" → "Approval Items" with a combined pending count |
| `95aafb3c` | enhancement | Multi-company switcher — bulk select/deselect |

### Decisions

**1. `57840a6e`'s ticket diagnosed the wrong layer — the payroll engine was never broken.** The report
was "HRDF not generated after payroll processing"; the engine computes HRDF end to end and always did.
The real defect was one control upstream: Subject-to-HRDF was a **checkbox**, which structurally cannot
carry the tri-state the data model uses (`null` = follow the company's registration default, `true`/
`false` = explicit override). An untouched card rendered unchecked while the company was
`not_registered`, so saving that card for *any* unrelated reason silently wrote an explicit **No** —
permanently excluding that employee from the levy even after the company later set a 0.5%/1.0% rate. Now
a three-option select. The corrective for already-damaged rows uses the **DomainEvent log as the
discriminator**: a No written while the company was `not_registered` is provably accidental and resets to
null; a No written while registered is HR's real decision and is left alone; anything untraceable is
**reported for HR rather than auto-changed**. That last branch is the important one — it declines to
guess on exactly the rows where guessing would silently overwrite a human decision.

**2. `0315dac7` was rebuilt as a raw ledger partition, because the old arithmetic was algebraically
false.** The Leave Breakdown derived its carry figures rather than partitioning the ledger, which does
not close after a year-open cap forfeit, a `maxBalanceDays` clamp, or an overdrawn carry-in.
`leaveEntitlementBreakdown` now sorts every ledger row ≤ asOf into **six disjoint buckets**, so
`Σ buckets = balance` and `balance − pending = available` hold *by construction* rather than by
agreement. The old single "Adjustment" line is split into config adjustments (which tie line-by-line to
Leave Config → Entitlement → Adjustment) and a separately labelled **"System corrections"** row for the
automatic `sys:policy_recalc` / `sys:profile_recalc` entries the commingled figure used to hide.

> **⚠ Not confirmed against live data.** The reported symptom — an employee showing 13 days of adjustment
> with nothing on the Adjustment screen — was **never reproduced**. The local dev DB has no adjustment
> rows for her (ANNUAL accrual 6.00 only), and the read against the live server was blocked by the
> permission classifier. Both faults are proven from code and pinned by tests, and the symptom *matches*
> fault 1 (an unlabelled system correction surfacing inside the commingled Adjustment line) — but that is
> inference, not verification. **Worth confirming on the deployed data before telling the reporter it is
> fixed.**

**3. `836118c4` deviated from its approved plan, correctly.** The plan directed editing
`messages/i18n.csv` and running `pnpm i18n:import`. But `messages/*.csv` is **gitignored** (line 52) and
untracked — it is a regenerable working file, absent from a fresh worktree entirely. A CSV edit could not
have shipped in the patch, and the plan's CSV round-trip assertions would fail on any clean clone. Built
against the six tracked JSON catalogs instead (the precedent every other i18n test follows) and replaced
the CSV assertions with hard-coded expected strings per locale, which still catches a stale-CSV import
reverting the rename. **Future plans touching i18n should stop specifying the CSV round-trip.**

**4. `95aafb3c`'s "Deselect all" deliberately does not submit.** `getScopeIds` (`lib/scope.ts`) coerces an
empty `company_scope` cookie back to *all* allowed ids, so submitting an empty selection would silently
re-tick every box. Deselect is therefore a client-side clear only; Select all commits with `flushSync`
before `requestSubmit()` so the bulk change posts the full id set.

### Integration

Much cleaner than r68: **no source file was touched by more than one patch.** The only shared surface was
the six locale files, which merged without conflict because each patch appends its own keys (6488 → 6501,
parity ✓ across all six). All 8 applied with `git apply --3way` and zero conflicts, and the full suite
found nothing — so this round's clean textual merge *was* a clean semantic merge. That is a property of
this particular item mix, not a general rule; r68's counter-example still stands.

`421d7551`'s build flagged a coordination risk for the integrator — that `9e64ac20` might also edit the
renamed keys or add a second sidebar row. Checked: `9e64ac20` touches neither key, `packs/leave/index.ts`
still declares exactly one `labelKey: 'myAbsence'` row, and all six locales carry the in-language term.

### Outstanding

- `bc9be1e8` remains `approved` and unbuildable — see r68 Decision 1. It was deliberately excluded from
  this round's build rather than left to triage, because its precondition is now *half* met (`0b7eeb4b`
  shipped in r68) and an agent reading only the plan could wrongly conclude it is buildable.
- **The blocker behind it is now on the board as `2bba9e35`** (status `open`, raised 2026-07-25):
  "Make Service-Based Entitlements the single place to manage company entitlement policies" — add,
  delete, carry-forward / earning method / effective dates, and the covered-employee count, all against
  the same policy records the old tab writes (no copy, so the two cannot disagree while both exist).
  Framed as one concrete change so it respects the approve-carries-no-payload rule. **Build order is
  forced: `2bba9e35` must ship before `bc9be1e8` can be built at all.**
- Confirm `0315dac7` against live data (see the warning above) before reporting it fixed.
- ~~Leftover `ahr_build_*` databases~~ — **cleared 2026-07-25**: 170 dropped, 3.2 GB reclaimed,
  `ahr_build_golden` deliberately kept (verified still migrated, 130 tables) because the build workflow
  clones it as its fast-path template. Note the cleanup pattern is `ahr_build_*` only; the older
  `ahr_r66_integration` / `ahr_r67_integration` / `ahr_preview_*` databases were left alone.
- The hourly watcher still polls the stale `IMPROVE_SSH_HOST` default and reports `approved=0` — it
  reported nothing while 8 items queued up. Fix the plist before it hides a real backlog again.

---

## r68 — 2026-07-24 — 8 approved feedback items (a 9th deliberately not built)

`build/r68@d8f9869` → `main` as `c008ac3`. All 8 `deployed`. Gate: clean-room PASS, 4609/4609 tests, 432
files. Shipped: anniversary→up-front grant (`adcdf215`, closing r66 Decision 1), service-based entitlements
by company×grade (`0b7eeb4b`), Grade→Job Grade (`02594a47`), medical/hosp balance fix (`6574c6b4`),
rounding reaches the balance (`5c928c07`), leave-criteria org fields (`7648a6c7`), company-change before
payroll (`9464bd56`), auto payroll-cycle catalog on company create + migration `0311` (`361e3b15`). Two
integration defects the full suite caught in patches that merged with ZERO textual conflict — the round's
lesson: **a clean three-way merge is not a clean semantic merge.** (1) `361e3b15` imported `core/payroll-
cycle` straight into `core/admin.ts`, breaking the ADR-0080 shrink-only pack ratchet; fixed by routing
through the `packs/payroll/service` facade, not by widening the allowlist. (2) `adcdf215` changed the a2c
first-year figure (10.90→19.73) that `5c928c07`'s test had hard-coded, so a green-looking assertion was
stale; repointed 11→20, kept it biting on the rounding. `bc9be1e8` was approved by the reporter but held
back: its plan forbids removing the Company Entitlements tab until add/edit/delete work inside Service-Based
Entitlements — verified against the merged `0b7eeb4b` that they do not yet. That gap became board item
`2bba9e35`, shipped in r70.
## r67 — 2026-07-24 — 3 approved feedback items

`build/r67@038d2db` → `main` as `76f3195`. All 3 `deployed`. Gate: 4515/4515 tests, 427 files. Search
popup cut-off (`1c541ceb`), Grade config moved to System Labels (`b1b81a08`), leave request popup with
localised type sort + Pending/Taken/Balance summary and a day-by-day panel (`643d38e7`). Two calls worth
keeping: `643d38e7` fixed an unnamed defect — `previewLeaveDeductionAction` returned null whenever
`employmentId` was empty, which is always true for a self-service employee, so the "this will deduct N
day(s)" line had been **silently dead for regular employees**, rendering only for an HR/manager applying
on someone's behalf. And off-day vs rest-day was deliberately NOT split, because the leave engine treats
every non-working weekday identically when deciding deductions; faking the split would make the day-by-day
panel disagree with the deducted-days total directly above it. Its three popup figures are structurally
incapable of disagreeing — all reuse the same `leaveBalance()` / `previewLeaveDeduction` source behind an
`includeDayRows` flag. First round to build off a `main` that already contained the prior round, which is
why its 6-locale merge needed no hand-editing unlike r66.

## r66 — 2026-07-24 — 12 approved feedback items

`build/r66@e76d082` → `main` as `7666b2e`. All 12 `deployed`. Gate: 4463/4463 tests, 425 files. The round
that established the one-branch rule: 9 of the 12 touched the same leave-config screens and
`components/leave-type-panel.tsx` alone was edited by 7, so releasing them one at a time would have had
each deploy overwrite the last. Two anniversary tickets (`18e15fc1`, `f3a64d90`) turned out to
*contradict* each other — same migration SQL, different first-year entitlement — and shipping
`f3a64d90`'s accrue-to-date semantics left the question open; **r68's `adcdf215` closed it** by switching
to the up-front grant with the reporter's approval. Two further merge repairs: `b81d3c52` referenced an
i18n key `eee43966` had renamed, and `eee43966`'s panel tests targeted a card `b8fcae73` deletes (both
repointed, assertions verified to still bite). Its live operational notes are carried in r68's Outstanding.
