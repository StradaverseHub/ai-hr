# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

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
