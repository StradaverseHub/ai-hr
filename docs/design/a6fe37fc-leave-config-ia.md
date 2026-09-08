# Leave Configuration — the proposed structure

**Feedback item `a6fe37fc` · Phase 3 design deliverable · written 2026-09-08 against `main@0c01befc`**

> This is the design the approved plan promised before any building:
> *"We will come back to you with the proposed structure and screens before building. That is your own
> Implementation Rule and it is the right one."*
>
> **No screen was built, no screen was removed and no migration was written to produce it.** The only
> changes in this round are this document, `a6fe37fc-migration-order.md`, and the mockup sources and
> images they refer to.

Read with: `docs/audits/a6fe37fc-leave-config-audit.md` (Phase 1), and
`docs/design/a6fe37fc-migration-order.md` (the order of build, cutover and removal, and the approval
reconciliation).

---

## 0. The one thing that does not change

**The code that turns rules into a number of days stays exactly where it is, and the new structure sits
on top of it.** This is the plan's own commitment and it is the load-bearing sentence of this document:

| Stays | What it does |
|---|---|
| `core/leave.ts` | The engine. Accrual, recalculation, leave years, carry forward, expiry, the balance guards. |
| `core/leave-compute.ts` | Pure calculation: service bands, rounding methods and bands, carry maths. |
| `core/entitlement-template.ts` | The entitlement tables, the eligibility rules, and `buildTemplateEntitlementResolver` — **the ONE matcher**. |
| `core/leave-approval-policy.ts` | `resolveApprovalChain` — who approves a request. |
| `core/leave-approval-template.ts` · `core/leave-approval-consolidation.ts` | Approval templates, assignment, and the routing-proof machinery this design reuses. |
| `core/org-criteria.ts` · `core/leave-org-criteria.ts` | The single vocabulary for "who does this apply to". |
| `lib/leave-config-health.ts` | Why a leave type cannot produce a balance, as a value instead of as a silence. |
| `core/leave-type-refs.ts` | The single declaration of what references a leave type. |

The customer's **297 balance records** were produced by that engine and are reconciled against it.
Nothing in this design replaces it, forks it, or adds a second implementation of anything it already
answers. Every screen below is a **new arrangement of the same reads and the same writes**.

**And the tables stay.** Per the customer's own constraint, no table holding both configuration and
transaction data is dropped. That covers all six history tables (`leave_request`, `leave_ledger`,
`leave_encashment_snapshot`, `leave_entitlement_recalc_audit`, `leave_generation_run_item`,
`replacement_leave_request`) **and** the four configuration tables, because
`leave_approval_policy` holds **261 hand-built rules** and is irreplaceable in practice. This design
introduces **no new table and needs no migration number.**

---

## 1. What is actually wrong, measured today

The plan names two defects. Both were measured again for this document, and one of them has moved.

### 1.1 "Four screens sharing one name" — half fixed, and the surviving half is the busiest screen

The map (`components/leave-config-map.tsx`, shipped for this item) gives every screen a name and says, in
its own header, that **the menu label and the page heading must be the same string**. Four screens now
honour that contract by calling `leaveConfigScreenTitle()`. **Six do not**, and four of those six render a
heading that is not the name the menu gives them:

| Route | Name in the menu | Heading the page actually renders | |
|---|---|---|---|
| `/admin/leave/entitlements` | Leave types | **“Leave configuration”** (`admin.leave.pageTitle`) | ✗ |
| `/admin/leave/entitlements/archive` | Entitlement archive | “Entitlement configuration record” | ✗ |
| `/admin/leave/entitlements/ledger-archive` | Ledger archive | “Medical & Hospitalisation balance record” | ✗ |
| `/admin/leave/approval` | Approval chain | “Leave Approval Chain” | ✗ |
| `/admin/leave/entitlements/templates` | Entitlement tables | “Entitlement tables” | ✓ (own key) |
| `/admin/leave/import` | Import leave data | “Import leave data” | ✓ (own key) |
| `/admin/leave/adjustments` · `/generate` · `/payroll` · `/replacement` | — | `leaveConfigScreenTitle()` | ✓ (the contract) |

So the generic heading **“Leave configuration”** still sits on the screen an administrator opens most —
the canonical `leaveConfig` href, the one carrying every leave type. The name defect was reduced from
four screens to one, and then three more drifted because each of those pages owns its own title key.
Fixing this is five lines, and §5 puts it in the cutover round rather than leaving it to drift again.

### 1.2 "Settings arranged by how the code grew" — this is the real subject

`leave_type` carries **58 stored settings**, written by **24 independent sub-forms** (each with its own
tri-state marker so a save cannot wipe a neighbour's column), arranged across **four steps and six
sub-steps** on one screen — plus one more sub-form on a second screen. The arrangement records the order
things were built, not the order they are decided. Six concrete examples, all verified in the code:

| # | What you find today | Why it reads as arbitrary |
|---|---|---|
| a | **Earning method, rounding and carry forward** are in step 1, *General setting*. The step named **Entitlement** holds the day tables. | These are two halves of one question — *how many days* — two steps apart. |
| b | **Per-date approval** (split a multi-day request so a manager can approve some dates) is in step 1, *General setting*. | It is an approval behaviour, and it is four steps from anything else about approval. |
| c | **“Send to payroll module”** is a per-leave-type setting on a **different screen** (*Payroll impact*). | Every other per-type setting is on the leave type. This one is reachable only through the menu. |
| d | The **company-wide Half-Day Deduction** card renders **inside every leave type's** Condition step. | One company decision, drawn 25 times, once per leave type. |
| e | **“Who qualifies”** is answered in **three** places: the type's own Criteria gate, the entitlement *eligibility rules*, and the approval *assignment* scope. | Three surfaces, one question — the complaint that started this item. |
| f | The Condition step's *Leave application rules* holds **twelve** cards, three of which — negative balance (with its maximum), balance deduction source, allow unpaid leave — are about **balance**, not about applying. | The card grid is a bucket, not a category. |

**That is the part being replaced.** Not the engine, not the tables, not the 63-setting feature surface
the audit found complete.

### 1.3 And the thing that is neither — stated again because it survives any rebuild

45 entitlement table lineages, **all 45 in force** (nothing has ever been superseded), against **4
eligibility rules in the whole tenant**. Annual Leave alone carries **16 tables in force and 2 rules**;
seven leave types carry 2–3 tables and **zero** rules. A table says *how many days*; a rule says *who
gets it*. The new structure will show that on the leave type where the decision is made, in the words of
the question — but it cannot decide it for you, and neither could a rewrite.

---

## 2. The proposed structure

Organised around **what you are configuring**, which the plan states as five questions:

> **the leave type · who is eligible · what they are entitled to · how it is applied for · who approves it**

Those five are properties of **one leave type**, so they become **five tabs on the leave type**, in the
order the decisions are actually made. Everything that is *not* a property of one leave type — a company
policy, a tenant catalogue, a job you run, a record you read — is grouped by what it is instead.

```
LEAVE CONFIGURATION
│
├─ CONFIGURE
│   ├─ Leave types ················· the spine. Pick a type, answer five questions.
│   │    ├─ 1  The leave type ······ what it is called and how it behaves
│   │    ├─ 2  Who is eligible ····· who may take it at all
│   │    ├─ 3  What they are entitled to ··· how many days, and who gets which table
│   │    ├─ 4  How it is applied for ······· the rules an application must satisfy
│   │    └─ 5  Who approves it ············· the chain that reaches this type  (read-only)
│   ├─ Approval chains ············ templates · assignments · escalation   (the editor)
│   ├─ Entitlement tables ········· all 25 leave types side by side        (the wide view)
│   └─ Company rules ·············· what belongs to a company, not to a leave type
│
├─ RUN
│   ├─ Generate entitlement
│   ├─ Adjustments
│   └─ Import leave data
│
└─ RECORDS  (read-only)
    ├─ Entitlement configuration record
    ├─ Medical & Hospitalisation balance record
    └─ Leave audit trail  →  /admin/audit?module=leave   (a link out, not a rebuilt screen)
```

**Ten destinations, exactly as today.** The count is not the deliverable — *where each setting sits* is.
Three of the four Configure entries already exist as screens; **Company rules** is the only new one, and
it is new because four settings that belong to a company are currently scattered across three screens
and one leave-type step.

### 2.1 Why the leave type is the spine

Because it is the only object every one of the five questions is *about*, and because it is what the
customer picks first today. The left rail (the leave type list) does not move, does not change and is
not replaced — it is the only way to choose a leave type, and the first draft of this item's earlier
mockup quietly removed it. It stays.

### 2.2 Why tab 5 is read-only, and why that is deliberate

`e4238594` **removed** a per-leave-type Approval Workflow sub-step from this exact panel, because it was a
second editor over the same `leave_approval_policy` rows the Approval screen creates — the duplication
the reporter named. The reporter also **rejected** replacing it with a link or a placeholder.

So tab 5 is not that sub-step coming back. It answers the question *"which chain reaches this leave type,
and why"* — the assigned template, its ordered steps, the escalation, and the per-date-approval switch
that genuinely is a property of this type — and every control that would **change** a chain lives on
**Approval chains**. One editor, one place; the tab is the answer, not a second way to write it.

### 2.3 Two views of one thing, never two implementations

Two of the five tabs show rows that also have an all-types screen:

* **Tab 3** mounts the *same* Entitlement Tables + Employee Eligibility block that
  `/admin/leave/entitlements/templates` mounts, filtered to one leave type. That is already how it
  works (`ee6b7c69`) — one component, two mount points, one filter. The wide screen survives because it
  is the only place all 25 types can be read side by side.
* **Tab 5** reads the *same* `leave_approval_policy` rows the Approval chains screen maintains, through
  the *same* `resolveApprovalChain`. It computes nothing of its own.

Neither adds a matcher. That rule — *one matcher, mounted twice* — is the design constraint the plan
states and the audit's §5 explains the cost of breaking.

---

## 3. Every function of the current screens, and where it goes

The failure mode for a rebuild is silently dropping a function, so this is the complete list. **46
functions across 10 screens and 4 redirect stubs.** Nothing below is marked "removed".

### 3.1 Leave types — `/admin/leave/entitlements` (heading today: “Leave configuration”)

| # | Function today | Where it lands |
|---|---|---|
| F1 | Leave type list, search, add, archive, delete | **Leave types** — page header + left rail (unchanged) |
| F2 | Configuration health card (traffic light per type: no earning method, no table, no rule, table reaching nobody, rule expiring, grade with no table, zero maximum balance) | **Leave types** header (all types) **and Tab 3** (this type) — one derivation, two places, as today |
| F3 | Shared leave groups (tenant-level combined limits) | **Company rules** |
| F4 | Company-wide half-day full deduction | **Company rules** |
| F5 | Header links: Import · Entitlement tables · Configuration record · Balance record | **Leave types** header (unchanged) |
| F6 | Details: code, name, description, paid/unpaid, leave unit (day/hour) | **Tab 1 · The leave type** |
| F7 | Per-date (partial) approval | **Tab 5 · Who approves it** — moved out of *General setting* |
| F8 | Leave year type override (a2a / c2c / a2c) | **Tab 1 · The leave type** |
| F9 | Earning method, accrual day, rounding method / threshold / bands | **Tab 3 · What they are entitled to** — moved out of *General setting* |
| F10 | Carry forward: on/off, maximum, percentage, expiry mode / months / month / day, include earned | **Tab 3 · What they are entitled to** — moved out of *General setting* |
| F11 | Entitlement tables + Employee eligibility, filtered to this type (create / edit / retire / delete, and the “how many employees does this rule reach” count) | **Tab 3 · What they are entitled to** (unchanged in place) |
| F12 | Run earned accrual | **Tab 3 · What they are entitled to** (unchanged in place) |
| F13 | Eligibility gate: gender · marital status · minimum service · probation status · the eight organisation-assignment axes | **Tab 2 · Who is eligible** |
| F14 | Allowed durations: full day / half day AM / half day PM / hourly | **Tab 4 · How it is applied for** |
| F15 | Supporting document: required, required only after N days, allowed file types, maximum size, employee remark required, HR remark required | **Tab 4 · How it is applied for** |
| F16 | Backdating limit | **Tab 4 · How it is applied for** |
| F17 | Advance notice: days, and whether they are calendar or working days | **Tab 4 · How it is applied for** |
| F18 | Maximum days per leave year, and the period it is counted over | **Tab 4 · How it is applied for** |
| F19 | Maximum consecutive days, and its unit | **Tab 4 · How it is applied for** |
| F20 | Allow negative balance + maximum negative balance | **Tab 3 · What they are entitled to** — these are balance rules, not application rules |
| F21 | Balance deduction source (this type debits another type's balance) | **Tab 3 · What they are entitled to** — same reason |
| F22 | Allow unpaid leave (the uncovered part becomes unpaid rather than refused) | **Tab 3 · What they are entitled to** — same reason |
| F23 | Duplicate application policy (allow / restrict same type / restrict any) | **Tab 4 · How it is applied for** |
| F24 | Day type inclusion: off day · rest day · public holiday · company holiday · shutdown day | **Tab 4 · How it is applied for** |
| F25 | Override rules — the ordered (trigger → action) exceptions, each with its own switch | **Tab 4 · How it is applied for** |
| F26 | The half-day deduction card, rendered inside this type's Condition step | **Company rules** — drawn once instead of 25 times (F4) |
| F27 | Employee visibility: visible on the self-service tab · may apply | **Tab 1 · The leave type** |
| F28 | Self-service placement: primary / secondary / hidden | **Tab 1 · The leave type** |
| F29 | Custom validation messages shown when a rule blocks an application | **Tab 4 · How it is applied for** — beside the rule each message overrides |
| F30 | Employee leave view configuration (which breakdown components the employee sees) | **Tab 1 · The leave type** |
| F31 | Formula explanations | **Tab 3 · What they are entitled to** |
| F32 | Visual: colour token + icon | **Tab 1 · The leave type** |

### 3.2 The other nine screens

| # | Function today | Screen today | Where it lands |
|---|---|---|---|
| F33 | Entitlement tables + eligibility for **all** leave types side by side | Entitlement tables | **Entitlement tables** (unchanged) |
| F34 | Approval template creation: named, ordered chain; activate / duplicate / delete / set org-wide default | Approval chain | **Approval chains** (unchanged) |
| F35 | Template assignment: company × leave type × grade or named population — this is what writes `leave_approval_policy` | Approval chain | **Approval chains** (unchanged) |
| F36 | Per-company escalation policy | Approval chain | **Approval chains** (unchanged) |
| F37 | *(no screen)* A rule's business unit / department / position scope, and a rule's own custom chain | **nowhere since `706d34e8`** | **Approval chains** — restored as a **read-only** list. See §4.1. |
| F38 | Per-company replacement-leave (TOIL) policy: accrual, eligibility, expiry | Replacement leave | **Company rules** |
| F39 | Per-leave-type “Send to payroll module” (+ the derived, read-only “affects payroll deduction”) | Payroll impact | **Tab 1 · The leave type** — it is a property of the type |
| F40 | Per-company leave encashment policy | Payroll impact | **Company rules** |
| F41 | Generate entitlement — the five-step wizard (year · types · employee criteria · preview count · process) | Generate entitlement | **Run › Generate entitlement** (unchanged) |
| F42 | Bulk leave adjustment — the four-step flow (types · employee selection · details · review) | Adjustments | **Run › Adjustments** (unchanged) |
| F43 | Recent adjustment batches, and reversing one | Adjustments | **Run › Adjustments** (unchanged) |
| F44 | Leave ledger import: validate then commit | Import leave data | **Run › Import leave data** (unchanged) |
| F45 | Entitlement configuration record + CSV export | Entitlement archive | **Records › Entitlement configuration record** (unchanged) |
| F46 | Medical & Hospitalisation balance record + CSV export | Ledger archive | **Records › balance record** (unchanged) |

### 3.3 The four redirect stubs

`/admin/leave`, `/admin/leave/application-rules`, `/admin/leave/audit` and `/admin/leave-approval` are
redirect stubs, not screens. **They stay stubs.** Old bookmarks keep working, and a redirect is
deliberately not listed on the menu — *"listing a redirect as a destination is how a menu starts lying
about what exists."*

### 3.4 The four employee-facing screens

`/leave`, `/leave/tracker`, `/leave/employee-balances` and `/leave/employee-records` are **out of scope
and must keep working at every point**. Nothing in this design touches them, and §5's cutover order is
built so they never see a half-migrated configuration.

---

## 4. What has no home — named, not skipped

A rebuild that silently drops a function is the failure mode here, so these are stated rather than
quietly resolved.

### 4.1 A rule's organisation scope, and a rule's own custom chain — *stored, routed on, invisible*

`706d34e8` removed the per-rule Workflow Matrix. It was the **only** surface that could show or set a
rule's business unit / department / position scope, and the only one offering a per-rule custom chain.
`convertLegacyApprovalRules` **preserves** those columns, so converted rows may still carry them:
`resolveApprovalChain` still reads them, they still decide who approves, and **no screen shows them.**

**This design gives them a read-only home on Approval chains** — a "rules not built from a template"
list showing scope and effective chain, with no editor. Making them editable again would re-create the
duplication `706d34e8` was raised to remove; leaving them invisible is what makes the answer to "why did
this go to that approver?" unanswerable. Read-only is the smallest honest option, and it is the one thing
in this document that is a *restoration* rather than a rearrangement.

### 4.2 The replacement-leave settlement sweeps stay outside Leave Configuration

`runToilExpiry` and `closeReplacementLeaveYear` live on `/admin/toil` **on purpose**: they are not gated
by the `toil` entitlement, because a tenant whose add-on lapses still owes employees the days they banked,
and for a First-Schedule-eligible employee that debt is statutory. Configuration is gated; settlement is
not. **Company rules must not absorb them** — moving them behind a configuration screen would silently
re-gate a statutory obligation. The two screens stay cross-linked.

### 4.3 The Leave Config Audit tab is not rebuilt

`/admin/leave/audit` was retired into the one central Audit Trail (`f1b994e3`). Records links out to
`/admin/audit?module=leave`. Rebuilding a leave-only audit screen would re-fork a surface that was
deliberately consolidated.

### 4.4 The statutory role of a leave type has no editor, by design

`leave_type.role` decides whether a type carries a statutory entitlement (`isStatutoryApplyType`), which
is what refuses `employee_can_apply = false` on maternity, sick, hospitalisation and the rest. It is not
editable on any screen today and **must not become editable** — an editable statutory flag is a
configuration that can deny a lawful entitlement. Tab 1 shows it as a read-only fact.

### 4.5 "Has this entitlement table ever granted anybody a day" has no exact answer

`leave_ledger` and `leave_entitlement_recalc_audit` record employment, leave type, entry type, days and
date. **Neither records which entitlement table or which eligibility rule produced the row** — the
resolver's answer is computed and thrown away. So no screen in this design can promise that, and the
delete guard remains the conservative approximation it is today (it refuses more than it must, never
less). Making it exact needs the deciding lineage stamped onto the grant, which is a schema change and a
separate item.

### 4.6 Five eligibility axes cannot be answered as at a past date

`gender`, `nationality`, `religion`, `race` (on `person`) and `job grade` (on `employment`) are not
effective-dated anywhere in this schema. An eligibility rule narrowing by them is resolved against
**today's** value however far back the question reaches. Tab 2 must keep saying so — the code already
surfaces it as `UNDATED_ELIGIBILITY_AXES` — rather than implying a precision the data does not have.

### 4.7 The configuration problem itself has no screen fix

16 Annual Leave tables in force against 2 eligibility rules is a data-entry state, not a code fault. The
health strip in Tab 3 shows it per type and the health card shows it across all 25; the traffic light and
the named findings are already built (`lib/leave-config-health.ts`, `r209`). **No arrangement of screens
decides which table is for whom.** That decision is the customer's, and it is the same size of work
before and after this design.

---

## 5. How the new structure fixes the two named defects, concretely

| The defect | What the new structure does |
|---|---|
| Four screens shared one name (now: one generic heading on the busiest screen, plus three menu/heading mismatches — §1.1) | **Every** screen and **every** tab renders the string the menu shows for it, through `leaveConfigScreenTitle()`. One string, one source. The map's own header already argues for this; four of ten screens honour it, and the cutover round makes it ten of ten. |
| Settings arranged by how the code grew (§1.2) | Each of the six examples lands in the tab named after the question it answers: (a) earning method + rounding + carry forward join the day tables in **Tab 3**; (b) per-date approval joins **Tab 5**; (c) “send to payroll” comes back onto the leave type in **Tab 1**; (d) the company half-day card is drawn **once** on Company rules instead of 25 times; (e) “who qualifies” becomes **one** question with two views of the same rows (Tab 2 for the type's own gate, Tab 3 for the rules that reach it); (f) the three balance cards leave the application-rules bucket for **Tab 3**. |

Two further properties worth stating because they are what makes this a *rearrangement* and not a rewrite:

* **Every sub-form keeps its tri-state marker and its hidden `name`.** That is what makes moving a card
  between tabs safe: saving one sub-form cannot wipe a column another sub-form owns. It is the
  precedent the payroll-impact relocation (`9d8cf621`) already set, and §5 of the migration order treats
  it as a hard rule.
* **No server action changes signature and no service changes at all.** The same 46 functions, the same
  writes, the same reads — moved.

---

## 6. What this design does **not** propose

Stated explicitly so approval is approval of a bounded thing:

1. **No new table, no dropped table, no migration.** No migration number was allocated to this round and
   none is needed.
2. **No change to the engine.** §0.
3. **No new eligibility vocabulary.** Tab 2 and Tab 3 use `core/org-criteria.ts` — the same vocabulary
   the Notice Board and bulk Adjustments already resolve. A third "who does this apply to" engine is the
   defect wearing the fix's clothes.
4. **No merging of screens that are gated differently.** Approval chains stays on `scopedSession` (a
   company-scoped admin keeps seeing only their companies); the rest stay on `requireAdmin`. Folding them
   would misreport one of the two guards.
5. **No removal of the redirect stubs.** Bookmarks keep working.
6. **No redesign of the Generate, Adjustments or Import flows.** They were each rebuilt recently to an
   approved shape and this item is not re-opening them.

---

## 7. The mockups

Sources in `docs/mockups/`, rendered with `pnpm mockup`. Each is a **sketch** — wording, spacing and
colours will differ — and each draws **only controls that exist and already save today**. No day figure,
no employee, no company name and no entitlement-table name is invented: the audit recorded how many of
the customer's records there are, not what they are called, so the mockups show counts and status and
draw a placeholder where a name will go, and say on the image that they are doing so.

| Image | Shows |
|---|---|
| `a6fe37fc-ia-structure.png` | The whole structure. Where every leave-type setting lives today versus proposed, and the six arrangement defects of §1.2 with their destinations. |
| `a6fe37fc-tabs-1-2.png` | **Tab 1 · The leave type** and **Tab 2 · Who is eligible**, with the leave type list and the health traffic light unchanged. |
| `a6fe37fc-tab-3-entitlement.png` | **Tab 3 · What they are entitled to** — earning method and carry forward arriving from *General setting*, the balance controls from *Leave application rules*, and the customer's real shape: 16 Annual Leave tables in force against 2 rules, 14 reaching nobody. |
| `a6fe37fc-tabs-4-5.png` | **Tab 4 · How it is applied for** and **Tab 5 · Who approves it**, including the read-only restoration of §4.1. |
| `a6fe37fc-company-rules.png` | **Company rules** — the one new screen, and the banner that keeps the replacement-leave settlement sweeps where they are (§4.2). |
| `a6fe37fc-cutover-order.png` | The six rounds, the approval replay, and what is kept versus what is actually removed. Belongs with `a6fe37fc-migration-order.md`. |
