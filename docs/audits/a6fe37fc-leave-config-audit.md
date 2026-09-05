# Leave Configuration — Phase 1 Audit

**Feedback item `a6fe37fc` · audited 2026-09-05 against production and `main@398cb088`**

> This is the Phase 1 deliverable the reporter approved: *"Do not start coding immediately. First inspect
> the existing project and database. Produce the audit/dependency report."* **No code was changed and no
> data was touched to produce it.**

---

## For the reporter — the short version

You asked us to rebuild Leave Configuration from scratch because it was designed wrong. We inspected it
before touching anything, and the inspection says something you should weigh before we remove anything.

**Every setting on your Phase 3 wish list already exists.** Not most of it — all of it. A leave type
carries 63 separate settings today, including every one you listed: half-days, hourly leave, how far back
leave may be dated, how much notice is needed, whether a document is required and which file types are
allowed, probation rules, how public holidays and rest days are counted, maximum consecutive days, and
seven separate carry-forward controls.

**Your live records, which a rebuild would have to carry across:**

| What | How many |
|---|---|
| Approval rules, built by hand | **261** |
| Leave balance records | 297 |
| Entitlement set-ups | 45 |
| Leave applications | 42 |
| Recalculation history records | 115 |
| Leave types | 25 |

The 261 approval rules are the real exposure. They decide who approves whose leave, and they fail
*quietly* after a migration rather than visibly — nobody notices until the wrong person is asked to
approve something, or nobody is.

### What we think is actually wrong — and it is not the code

We found something concrete, and it is very likely the reason the module feels broken to you.

**Annual Leave currently has 16 entitlement tables in force at the same time, and 2 rules to choose
between them.** It is not alone:

| Leave type | Tables in force | Rules to choose between them |
|---|---|---|
| Annual Leave | **16** | 2 |
| Sick Leave | 5 | 1 |
| Compassionate, Paternity, Maternity, Marriage, Study, Hospitalisation, Exam | 2–3 each | **0** for seven of them |

An entitlement table says *how many days*. An eligibility rule says *who gets that table*. When several
tables are in force for one leave type and no rule says who each applies to, the system has nothing to
decide with. **That is a configuration problem, not a design problem** — and it is exactly what would make
entitlements feel arbitrary and impossible to reason about.

**A rebuild would not fix this.** These are your records, and any migration carries them across intact.
You would arrive in a new system with the same 16 competing Annual Leave tables and the same missing
rules. Fixing it means deciding who each table is for — work that is the same size whether the code
underneath is old or new, and considerably safer against the system you already have.

**Our recommendation:** do not rebuild from scratch, and let us fix the Annual Leave configuration first.
That is the change most likely to make the module behave predictably, it is far smaller than a rebuild,
and it risks nothing. We would then reorganise the Leave Configuration screens — same engine, clearer
arrangement. If after reading this you still want the rebuild, we now have the map to do it safely, and
this report is that map.

---

## 1. Screens in scope (18 routes)

**Administrator (Leave Config):** `app/admin/leave` · `/adjustments` · `/application-rules` · `/approval` ·
`/audit` · `/entitlements` · `/entitlements/templates` · `/entitlements/archive` ·
`/entitlements/ledger-archive` · `/generate` · `/import` · `/payroll` · `/replacement`, plus
`app/admin/leave-approval`.

**Employee-facing (must keep working):** `app/leave` · `/employee-balances` · `/employee-records` ·
`/tracker`.

The reporter's own list named six child menus. It is accurate but omits **Application Rules**, **Audit**
and **Import** — three screens a removal plan would otherwise miss.

## 2. Services

| Module | Role |
|---|---|
| `core/leave.ts` | The engine. Accrual, recalculation, leave years, carry forward, expiry. A god-node. |
| `core/entitlement-template.ts` | Entitlement tables, eligibility rules, and the ONE matcher. |
| `core/leave-approval-policy.ts` | Approval chains. |
| `core/leave-type-refs.ts` | The single declaration of what references a leave type. |
| `core/leave-compute.ts` | Pure calculation: service bands, rounding, carry maths. |
| `core/benefit-scheme.ts` | Grade groups only. **Filename is a known lie** — see §5. |
| `core/read.ts` | `leaveEntitlementBreakdown` and the balance reads. |

## 3. Data — configuration vs production records

`core/leave-type-refs.ts` already classifies every referrer, and this classification is the most valuable
input to any rebuild. **Measured against production today: 10 direct foreign keys to `leave_type`, plus
one indirect.**

**HISTORY — refuses a delete, must be preserved (6):**
`leave_request` · `leave_ledger` · `leave_encashment_snapshot` · `leave_entitlement_recalc_audit` ·
`leave_generation_run_item` · `replacement_leave_request`

**CONFIG — cascaded with the type (4):**
`entitlement_template` · `leave_approval_policy` · `leave_shared_group_member` ·
`entitlement_eligibility_rule` *(indirect — reaches `leave_type` through the template's lineage, not a
foreign key)*

**SELF:** `leave_type.balance_source_type_id` — nulled on the other type, never cascaded.

> ⚠️ **Correction to our own documentation.** `AGENTS.md` and `HANDOFF.md` both say the database carries
> **twelve** foreign keys to `leave_type`. Measured on production today it is **ten** direct, plus the one
> indirect referrer. `leave_policy` was one of the missing entries and was dropped in release three. The
> declared list is right; the prose about it is stale. `test/leave-type-referrers.test.ts` reads the live
> constraints in both directions, which is why the declaration stayed correct while the prose drifted.

## 4. Permissions

Screen keys in `lib/permissions.ts`: `leaveConfig` · `leaveApproval` · `leaveEmployeeBalances` ·
`leaveEmployeeRecords` · `leaveTracker` · `leave`. Any new guarded page needs its own column in the
function-access matrix or `test/function-access.test.ts` fails — the route would otherwise be one nobody
can grant or revoke.

## 5. The lesson a rebuild must not relearn

**This has already been done once.** Release three (`6e9a126e`) deleted `benefit_scheme`,
`scheme_leave_entitlement`, `leave_policy` and `employment.benefit_scheme_id`, replacing them with
`entitlement_template` + `entitlement_eligibility_rule`. The current design *is* the output of a previous
rebuild, not an accumulation nobody revisited.

**Grade groups survived that deletion, and why is the single most important paragraph in this report.**
205 (now 261) `leave_approval_policy` rows scope by them. The foreign key is `SET NULL`, and
`core/leave-approval-policy.ts` reads a NULL `leave_type_id` as the **company default chain — a wildcard,
not a non-match**. So dropping grade groups would not have errored. It would have silently converted
targeted approval rules into rules matching everyone.

**Any rebuild proposal must answer that question for every referrer**: not "does the foreign key hold?"
but "what does this column's absence *mean* to the code that reads it?" A nullable column whose null is a
wildcard is the shape that makes a migration dangerous rather than merely difficult.

## 6. Verdict

| | |
|---|---|
| **Safe to remove** | Nothing yet — no screen is unreferenced. Removal only becomes safe once its replacement covers the same configuration surface. |
| **Must be preserved** | All 6 history tables. `leave_approval_policy` (261 rows) is nominally "config" and cascadable, but it is hand-built and irreplaceable in practice — treat it as preserve. |
| **Needs migration** | `entitlement_template` (45 lineages, ALL in force) and `entitlement_eligibility_rule` (4 in force) if the entitlement model changes shape at all. |
| **Fix before anything else** | The 16-in-force Annual Leave tables and the seven leave types with multiple tables and zero rules. Configuration, not code — it survives any rewrite. |

**Recommendation: do not rebuild from scratch.** The feature surface is comprehensive, the current design
is itself the product of a deliberate earlier rebuild, and the concrete defect we found — 45 lineages all
in force, 10 of 11 leave types carrying more than one, only 4 eligibility rules in the whole tenant —
lives in CONFIGURATION and would survive any rewrite intact. Fix that first; reorganise the screens second.

**Measured 2026-09-05:** 45 distinct template lineages, all 45 with `valid_to IS NULL`. Nothing has ever
been superseded. That is itself worth investigating — an entitlement table is versioned by lineage, so 45
live lineages means 45 genuinely competing tables rather than a history of edits.

**If the rebuild proceeds anyway,** the order is: replacement screens first, both systems live together,
migrate `entitlement_template`/`entitlement_eligibility_rule`, verify all 261 approval rules still resolve
to the same approvers on real employees, and only then remove anything. Never drop a table holding both
configuration and transactional data.
