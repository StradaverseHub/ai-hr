# Binding packet: AI v2 release, Phase 1 and Phase 2 together (staging only, fictional data)

> **Approved by the owner directly in the coordinator session, recorded 2026-11-04T03:38:57Z.** For a fresh owner approval, given directly in the coordinator session. No earlier approval transfers:
> - not the Phase 1 binding of `b96772fe…` (approved 2026-11-03T17:21:45Z);
> - not the superseded r2 Phase 1 packet (`eab99545…`, never bound);
> - not the AI Centre round (`e5db5f47…`).
>
> A relayed approval is refused. If the candidate code head changes before the binding is written, every value below is
> recomputed and this packet is reissued.

## One-page summary for the owner

**What this is.** You chose to release Phase 1 and Phase 2 of the AI Centre together. Before the AI may run on staging,
you approve the exact code that decides what the AI model provider is sent. This packet covers everything since the
binding on main, so one approval covers both phases.

**What people get. Phase 1 (as in the packet you approved, with the review fixes):**
- **Today**, a home screen.
- **Ask everywhere**, with chats stored on the server.
- **"What can you help with?"**
- **Prepared actions with Confirm, Edit and Discard:** leave, claims, profile and bank, attendance and overtime, time
  off in lieu, imports from a file, and approver decisions.
- **"Why?" panels.**
- **Workforce metrics and pay averages:** groups of fewer than 5 people are never shown.
- **Private cases.**
- **Five Prepare-only loops.**

**What people get. Phase 2:**
- **An autonomy ladder for loops:** Watch, Prepare, Act within limits, Act and audit. Only two loops may ever act on
  their own: missed clock-outs and missing employee data. Anything touching pay, employment status, access,
  discipline or statutory filing stays at Prepare.
  - Only a group administrator promotes a loop, one level at a time, with a certificate.
  - Every action can be undone.
  - A loop drops itself back to Prepare if people change or undo more than 1% of its actions in 7 days.
- **Payroll loops:**
  - *Pre-salary* checks inputs before the cut-off and sends cut-off reminders.
  - *Salary payroll* checks each run, its net-pay swings and its bank file.
  - *Audit* captures each month's evidence pack and runs seven control checks. An optional read-only auditor can
    view it.

  They only prepare; a person runs, approves and closes payroll.
- **A "Before payroll" checklist** for each person, with a one-tap "did you work for another employer this year?"
  question (TP3).
- **An HR capacity ledger:** time saved, never a staff-to-employee ratio.
- **The Living Handbook:** company policies in their own words.
  - AI reads the values a policy states.
  - **A person confirms each one**, and a **second administrator** approves a settings change.
  - The product's own settings service applies it.
  - When the handbook and the system disagree, the answer gives the current setting, not the handbook figure.
- **Learning loops and an AI quality page:** they store no words from anyone's chat, and question details are shown
  only for groups of 5 or more people.

**What the AI provider receives that is new in Phase 2.**
- Counts and states of the payroll loops, for administrators: counts as **bands**, never a person or a pay figure.
- A person's own "Before payroll" to-do list: no pay figure.
- The company's approved policy paragraphs, with any email, IC, phone or account number removed first.
- **New contract: `handbook_policy_values_v1`.** When an administrator presses "Read the values", the policy text they
  wrote goes out with the list of settings it may set.
  - A text containing an email, IC, phone or long number is refused, not sent.
  - The AI returns proposed values with the exact words they came from. Nothing is applied until a person confirms
    and the settings service applies it.

**What never leaves the product:** identity, bank and phone numbers; record ids; free text someone else typed; claim
descriptions; letter content; private case content; imported file contents; one person's pay.

**What the AI can make happen:** only cards that a person confirms. Loops **never** call the AI model. When a promoted
loop acts (sets a missed clock-out to the roster end, or sends a missing-data request), the product's own service
does it, within limits, with undo, and the employee is told.

**Kept in the product.**
- Chats are encrypted, readable only by the person who chatted, and deleted after 30 days by default.
- Phase 2 adds eight database migrations. Each new table has strict per-company access.
- **At installation, the operator must switch on the deletion timer.**

**Test results.**
- The Phase 2 scored evaluation **passes every bar** (overall and all five roles) on the turns shared with the
  baseline, with 0 safety faults.
- The closest margin is the employee score: 91.8 against a bar of 91.3.
- The later fixes did not change anything the AI says, so the evaluation was not re-run. They were a payroll
  calculation-selection fix and the merge of main's Microsoft-login changes. They also fix two older payroll errors already on
  main: the previous-month comparison now uses only closed runs, and payslips replaced by a history import no longer count.
- Their own checks passed, including a fresh data-upgrade rehearsal.
- The full release gate runs once this is approved.

**What you are asked to approve.** That the AI may run on **staging only**, with **fictional data only**, on exactly
this code, including the new handbook contract. **Production stays held** until counsel advises (ADR-0169 §5.1). This
approval does not deploy anything, and it does not cover a later change to this code.

---

## What this packet adds beyond the approved Phase 1 packet
- **The Phase 1 pre-release review fixes** (from the superseded r2 packet; unchanged here):
  - private-case handlers need a current login, and each case's handler set is frozen at filing;
  - chat imports cover the card's company only (`other_company`);
  - the missed clock-out loop's HR "manual correction" case and its own-employment Confirm, plus `out_of_scope`;
  - the employees' own letter-request lookup and erasure.
- **Phase 2, in full** (sections 2.6, 3, 4 and 5).
- **Spec v23:**
  - the `operations_status` and `explain_why` topic tools, with every role's worst case at 30 or fewer tools;
  - the two Phase 1 follow-ups are now fixed: the entitlement breakdowns carry `notShown`, and the spec text no
    longer says `withheld:true`.
- **One new outgoing contract,** `handbook_policy_values_v1` (section 2.7).
- **After the evaluated head `2109062e8`:**
  - `e69411ab1`: `core/handbook/provider-model.ts` becomes a provider-closure root.
  - `05cfba8f6`: two existing payroll defects fixed, both also present on main.
    - The close circuit's prior cycle is now the latest **closed** batch (`core/payroll-anomaly.ts` selectors, and the
      2011 definers).
    - The 2011 close definers read effective payslips only (`app.payroll_history_effective` on all six payslip reads).
    - 2011's sha256 becomes `d42cceaf…`.
  - `f9fdccd61`: merge of main `3b3f94ccd` (Microsoft login visibility, two test-clock pins, no migration). None of
    the 15 files it changes is in either closure.

## 1. Candidate, closures and file-set diffs

- **Branch:** `claude/aiv2-phase2-integration`. **Candidate code head:**
  `f9fdccd615f15c78bca295bcfb2ad68f3c57b546`.
  - It is the merge of main `3b3f94ccdc7bc6e3396caf0db2d103244413b291` onto `05cfba8f6`.
  - It is 282 commits ahead of `origin/main` `3b3f94ccd` and 0 behind.
  - It contains the evaluated head `2109062e8` and the r2 Phase 1 head `d895f80b9`.
  - Harness spec **v23**, digest `0052cefe8d066154db37c62bc213dfb26eabcbe0cc861577103212d6e4e5f0c5`.
  - Unchanged since `2109062e8`: `core/harness`, `core/semantic-model`, `core/product-context`,
    `core/teras-wiring`, `core/proposals`, `core/explainers`, `core/handbook`, `core/loops`, `lib/ai` and `messages`.
- **Bindings now in force:**
  - **On main `3b3f94ccd`,** re-read from its committed manifests: provider `66cf4753…` (1292 files), module-agent
    `3403d849…` (457 files). Main's `provider-data-approvals.ts` is unchanged from `848c7be36`.
  - **On this branch** (carried from `2cee0e8b5`): provider `b96772fe…`; manifest and approval literals.

### Digests
Computed write-disabled, on isolated `git archive` copies, by running the repository's own
`scripts/ai-provider-data-source-manifest.mjs`. The module-agent digest was computed with `scripts/ai-agent-source-scope.mjs`
over `git ls-tree` of each commit, on a copy whose manifests are as committed. Main's computed values reproduce its
committed manifests exactly.

| Scope | Main `3b3f94ccd` (bound) | Candidate `f9fdccd61` before the binding |
|---|---|---|
| Provider-data closure | `66cf4753ea58c94f21d00b65e489f06d49d864360b99d775eb1ac02e8b4dcf43`, 1292 files | **`fd335f2306be43959ea9059a95275e329896896a0c2cf09005072c725ac36d71`, 1413 files**: 121 added, 0 removed, 67 changed, 1225 unchanged |
| Module-agent scope | `3403d8492810471f44b712c7d5fd886fa309f9e52e61f2b15a906df17f40fe81`, 457 files | See below. Against main: 8 added, 0 removed, 15 changed. |

**The module-agent digest has three values:**
- **As committed** (manifests unchanged): `91d1902417c1ff55870ef69534527a94c12c2347696578cfcc1e3573ebd28688`, 465 files.
  This is the same as at `2109062e8`.
- **With the provider manifest regenerated to `fd335f23…`:**
  `8a7bcfdeb0f32cb1d0abe1a230331128b7c137a677291e348fc16a75a4565448`, 465 files.
- **The bound value** is generated **last**, after the approval literals are written. It will differ from both,
  because `lib/ai/**` is in scope.

Main's provider `--check` passes at `3b3f94ccd`, and its recomputed module-agent value equals its committed manifest.

**Since the evaluated head `2109062e8`** (`939d0723…`, 1412 files), the provider closure changed in three files:
- added `core/handbook/provider-model.ts` (the new root);
- changed `scripts/ai-provider-data-source-manifest.mjs` (the root list);
- changed `core/payroll-anomaly.ts` (the prior cycle is the latest closed batch).

The module-agent scope is unchanged since `2109062e8`.

**The committed manifests are stale:** they still say provider `b96772fe…` and module-agent `fcecf5cf…`. So both
`--check` commands and `provider-data-review-gate` are red until the binding, as expected.

The full file lists are in Appendix A.

**The payroll fix and the provider.** `core/payroll-anomaly.ts` is in the closure because the existing, approved
payroll contracts reach it: `core/payroll-hypothesis.ts` (`payroll_feature_hypothesis_v1`) imports it directly, and
`core/payroll.ts` imports it too.
- No field, class or contract changes.
- Only the prior cycle it compares against is now restricted to a closed run. An unfinished earlier run is no longer
  treated as "last month".

**The handbook call site is inside the closure.** Since `e69411ab1`, `core/handbook/provider-model.ts`, the only
Phase 2 provider call site, is a root of `scripts/ai-provider-data-source-manifest.mjs`. Any edit to it changes the
closure digest. With it, the closure holds:
- the call site;
- the `handbook_policy_values_v1` descriptor in `lib/ai/provider-workload-policy.ts`;
- the gateway (`core/ai-governance.ts`);
- the adjudicator (`core/handbook/extract.ts`).

Its caller `core/handbook/policies.ts`, which supplies the draft version's text and settings list, stays outside. The
descriptor refuses any input that is not policy text plus the closed settings list, whatever that caller passes.

## 2. What new data or behaviour reaches the model provider

**How disclosure works.** The disclosure step in `core/harness/disclosure.ts` is the same as on main. It judges every
tool result against the declared semantic entity:
- `never` is removed. A record id becomes a per-turn handle (`ref-1`).
- `bands`: a figure becomes `{{F1}}` plus its band.
- `minimum` is kept for the caller's own rows and for an administrator's configuration. It becomes a text placeholder
  (`{{T1}}`) when the entity is about another person, or when the field is a person's `name`.
- `full` is kept.

Two more rules apply to everything:
- A label marked `screen` that names a health, religious or similar matter becomes a placeholder.
- Every string is screened for identifiers (IC, passport, phone, bank account, email, tax, EPF and SOCSO numbers),
  which become `[<kind> removed]`.

Context tools with no entity pass product vocabulary, with ids turned into handles and identifiers screened. The
person's own message reaches the provider screened in the same way, under the spec v12 label.

Phase 2 adds one field type, `published_text` (`core/semantic-model/types.ts`). Its class is `full` and it is screened
like every string.

### 2.1–2.5 Phase 1 (unchanged from the r2 packet)
The r2 packet's sections 2.1–2.4 apply as written: reads, prepared actions, harness changes, and the items that send
nothing new. That file is not in this branch: it is uncommitted in
`/Users/zenlam/Projects/ai-hr-builders/aiv2-phase1-release-20261103/docs/reviews/teras-whole-stack-20261102/binding-packet-phase1-release-r2.md`.
The table below stands on its own for the owner. The committed Phase 1 packet,
`binding-packet-phase1-release.md`, has the full per-field detail. In summary:

| Read or tool | Who | What leaves | Never |
|---|---|---|---|
| `product_capabilities` | anyone, code-gated by intent | catalogue vocabulary (`full`) | anything about a person |
| `pay_aggregates` | payroll access | headcount, average and median basic pay (`bands`); company and department names exact | groups under 5, complement 1–4, complementary, identical values |
| `workforce_metrics` | HR administrators (their companies); managers (own team) | headcount, joiners, leavers, turnover, overtime hours, leave days (`bands`) | any person, any money |
| `explain_why` topics `pay_difference`, `claim_limit` (and v23's `payslip_statutory`, `leave_entitlement`, `attendance_day`) | the person, own records, explainers switch | every figure `bands`; item names screened | anyone else's figures |
| `operations_status` topic `loops` (`loops_overview`) | administrators | switches, states, levels per company, ceilings (`full`); card counts (`bands`); company names exact | who a card is for |
| `approval_queue` | own approver queue | counts; up to 5 leave requests, applicant and dates as **placeholders** | names, exact dates, ids |
| `company_setup` | administrators | names of the companies they administer, **exact** | ids, people |
| `product_guidance` topics | administrators | main's two literal page guides | settings, people, pay |
| `my_leave_balances` | the person | figures `bands`; `notShown` names hidden parts; leave-type names as configured | hidden figures |
| `suggest_action` / `prepare_import` | as in r2 2.2 | own options (screened); others' names, dates and times as placeholders; import kinds, counts (`bands`), closed issue words including `other_company` | free text, ids, file contents, other companies' rows |

- Letter requests are still **not** wired into chat: re-checked at `f9fdccd61`, `prepareChatLetterRequestProposal` is
  called only by its test.
- **Letters custody (Phase 2):** a letter request confirmed from a chat card survives every chat-removal path, as an
  HR record. The card id stays on it only as an opaque idempotency key (`core/teras-chat-expiry.ts`
  `TERAS_CHAT_SURVIVING_RECORDS`). No migration; nothing new to the provider.
- **Follow-ups from the approved packet, now fixed in v23:** the entitlement breakdown carries `notShown` (entity
  `leave_entitlement`, `projectMineLeaveEntitlement`), and spec text line 248 explains `notShown` in place of
  `withheld:true`.

### 2.6 Phase 2 reads (spec v23)
Every Phase 2 administrator read is served as a topic of `operations_status`. Each topic keeps:
- its capability's gate (`core/explainers/capabilities.ts`: `admin:true`, plus the payroll module for the four payroll
  topics);
- its runner;
- its semantic entity and disclosure.

A topic the caller is not permitted is refused `not_permitted` before its runner (`core/harness/tools.ts`
`topicBindings`).

| Read (topic) | Who can trigger it | What leaves, and in which class | What never leaves |
|---|---|---|---|
| `my_payroll_readiness` (P2-3, entity `payroll_readiness`) | Any person, about their own records. | Pay period, cut-off and its source; own pending items by kind, state, date, due date and page; whether a Confirm card is waiting. Dates are `minimum`, exact because they are the person's own. Own leave or claim type labels are screened. For an approver: **counts** of decisions waiting, by kind, never whose. | No pay figure is returned at all: no amount, rate, balance, limit, salary, minutes or days. Other people by name. Ids. |
| `operations_status`: `payroll_cycle` (`payroll_cycle_status`, entity `payroll_cycle`) | Administrators, payroll module. | Per company (name exact): Pre-salary state, cut-off, interval and each check's status; Salary payroll state and runs (type, sequence, status, bank-check verdict); Audit state. Item, exception, flag and finding counts are `bands`. A three-month history of days-before-cut-off and caught-issue counts. | Any person, sponsor or decider; any id; any pay figure (amount, total, per-person swing). |
| `operations_status`: `salary_payroll` (`salary_payroll_checks`) | Administrators, payroll module. | Per run: people, exceptions, changed and flagged counts (`bands`); causes by kind with counts (`bands`); statutory rule versions; bank-check verdict; the company's net-swing threshold in percent (`full`). | Who was flagged, or by how much. |
| `operations_status`: `payroll_loop_settings` | Administrators, payroll module. | Interval, threshold percent, setting version and source. Exclusions are pay item names or cause keys (`minimum`, exact as administrator configuration). Threshold proposals with their evidence counts (`bands`). | Any person, any amount. |
| `operations_status`: `payroll_audit` (`payroll_audit_status`) | Administrators, payroll module. The read-only auditor grant is a page grant, **not** a chat grant. | Per company and month: payslips released and opened, statutory files prepared and filed, bank files, corrections and missing root causes, control findings open and disposed, repeat issues. All counts or states. | Any person, any bank number (stored only as last four digits and a hash, and not declared), any amount. |
| `operations_status`: `ai_quality` (`ai_quality_summary`, P2-6, entity `ai_quality`) | HR and group administrators. | The quality page's shares and counts (all `bands`), top gap intents (closed vocabulary) with counts, and the number of loop proposals waiting. | Any example or words from a chat, any name, any company id, any staff-to-employee ratio. Gap detail is only for groups of at least `GAP_DETAIL_MIN_ASKERS` (5) askers. |
| `my_policy_handbook` (P2-5, entity `policy_handbook`) | Any person, for the policies that apply to their own company (an administrator: also the companies they administer). Approved versions in force only, under migration 2009 RLS. | Title, area, version, effective date, citation, and the matching paragraphs as `published_text` (`full`), **with every identifier replaced by `[<kind> removed]`**. An enforceable figure that disagrees with the current setting is replaced by `[current setting: …]`; one whose setting cannot be read is replaced by `[the current setting could not be read; ask HR]`. | Drafts, versions waiting for approval, values read from text, approvals. Identifiers written in a policy. |
| `explain_why` (topic tool) | The person, own figures, explainers switch, per topic module. | The five explainers, unchanged except the folding. `leave_entitlement` now carries `notShown`. | As before. |

- **Declared but not offered:** `payroll_check_acknowledgement` is declared as text only (spec v23 addendum) and is
  not offered as a tool.
- **Tool ceiling** (`test/harness-tool-ceiling.test.ts`, fictional data, every module on). Worst case per call:

  | Role | Tools per call |
  |---|---|
  | Employee | 23 |
  | Manager | 24 |
  | Payroll partner | 24 |
  | HR administrator | 30 |
  | Group administrator | 30 |

  Each count includes `final_answer` and one history declaration. The provider ceiling is 32
  (`lib/ai/teras-harness-policy.ts`).

### 2.7 New outgoing contract: `handbook_policy_values_v1`

| | |
|---|---|
| **Outgoing class** | `authored_policy_text` (`lib/ai/provider-disclosure-inventory.ts`), feature `hr_assistant`, operation `draft`. |
| **What reaches the model** | The policy text an HR administrator wrote for one draft version, up to 20,000 characters. Plus the closed list of up to three settings: `claims.mileage_rates`, `claims.submit_within_days` and `leave.entitlement_days`. Each comes with its fixed meaning and the owner's own target codes (claim type and leave type codes). The instructions say the text is untrusted data and that no figure may be calculated (`lib/ai/provider-workload-policy.ts` `HANDBOOK_INSTRUCTIONS`). |
| **Identifiers** | **Refused, not screened.** The descriptor refuses the whole request when the text contains an email address, an IC-shaped number, a run of 10 or more digits, or a Malaysian mobile number (`HANDBOOK_IDENTIFIERS`). The text is then not sent at all. |
| **Who can trigger it** | An administrator, pressing "Read the values" on a draft version (`app/assistant/policy-actions.ts` → `core/handbook/policies.ts` `readPolicyValues` → `core/handbook/provider-model.ts`). The caller must be an administrator of every company the version applies to; administrator authority is checked again at admission (`app.is_admin()`); and the tenant's `hr_assistant` configuration, pauses, allowances and spend caps apply. Values are read only for a version that applies to every company of the tenant, because the three settings are tenant-wide. |
| **What the model returns** | Untrusted JSON: proposed values, each with the exact words of the policy it came from. `core/handbook/extract.ts` adjudicates every proposal: <ul><li>the setting and target must be on the closed list;</li><li>every quote must occur **verbatim**, and its span is located by the product, never taken from the model;</li><li>every figure must appear in its own quote;</li><li>the shape must be one the owner accepts.</li></ul> A failing proposal is dropped and counted. |
| **Why it is safe** | <ul><li>Nothing is applied by the model.</li><li>A person confirms or rejects each value.</li><li>Every enforceable setting the text mentions must be confirmed, or marked "text only", before the version can be sent for approval.</li><li>A settings change needs a **second, different administrator** who contributed nothing to it. The database records every contribution (migration 2009) and refuses otherwise.</li><li>A version is not approved while a stated figure disagrees with what the system would enforce (deterministic, `core/handbook/consistency.ts`).</li><li>On approval, each confirmed value is applied by its **owner service** (`core/handbook/settings.ts`), under the approver's login, in one transaction with its application record.</li></ul> |
| **Current state** | Pending: no review record exists. The gateway refuses dispatch, and "Read the values" says the AI cannot read values yet. `test/handbook-extract.test.ts` pins `providerDataReviewStatus('handbook_policy_values_v1')` as `'pending'`. |

## 3. What the model can make happen
Only **prepared proposals that a person confirms**. Nothing auto-applies.
- Each proposal is signed (HMAC-SHA256 with `TERAS_PROPOSAL_SECRET`).
- Each is bound to the owner's digest of the exact reviewed effect, and expires.
- At Confirm, the native guard and service check everything again.

Prepared-action kinds the model can reach (unchanged from Phase 1):
1. `leave.apply`
2. `leave.cancel`
3. `approvals.leave.decide`
4. `attendance.correction.request`
5. `attendance.overtime.request`
6. `claims.submit`
7. `claims.cancel`
8. `ess.profile.request`
9. `toil.replacement.request`
10. `approvals.claim.decide`
11. `approvals.attendance.decide`
12. `prepare_import` (the card's own company only)

Phase 2 adds **no** prepared-action kind for the model. The handbook's "Read the values" returns proposals for a
person to confirm, outside the conversation.

**Loops never call the model.** No file in `core/loops`, `core/payroll-audit`, `core/pre-salary`, `core/capacity` or
`core/learning` imports a provider or the gateway. The only Phase 2 provider call site is
`core/handbook/provider-model.ts`.

**Level 2 and above loop actions are owner-service actions, not model actions** (`core/loops/autonomy.ts`,
`levels.ts`; migration 2004).
- **Levels.** 0 Watch, 1 Prepare, 2 Act within limits, 3 Act and audit.
- **The cap is code.** A loop touching pay, employment status, access, discipline or statutory filing stays at Prepare
  in every company. That covers probation, payroll inputs, passports, Pre-salary, Salary payroll and Audit.
  Migration 2004 repeats the cap (`teras_loop_level_cap`).
- **Only two loops may act:**
  - missed clock-outs: sets the clock-out to the roster end through the attendance owner;
  - missing employee data: sends the request to the employee and changes no record.
- **Cut-off reminders.** The Pre-salary loop's reminders are notices about a person's own pending items (counts only),
  at most once per recipient, cut-off and lead time. They are allowed at Prepare as `payroll_input_reminder` notices.
- **Promotion.** Only a group administrator promotes, one level at a time, by a certificate computed from the loop's
  own records. Level 3 needs 90 days at Level 2. Limits are set with the promotion: actions per night, undo window and
  condition.
- **Attribution.** Every action is recorded with the agent principal (`teras_loop_action`), and every level change
  with the administrator's name.
- **Undo** within the window (`teras_loop_action_undo`).
- **Demotion is fixed.** More than 1% of automatic actions changed or undone by people over 7 days drops the loop to
  Prepare. Telling the person is always on.
- **Level 3** acts as Level 2. HR reviews a weekly sample of at least 10% and at least 5 actions
  (`teras_loop_sample_review`).
- **Payroll loops stay Prepare in every company:**
  - The Salary payroll loop never creates, processes, approves, closes or reopens a run, or generates a bank file.
  - The Audit loop's seven controls never block or change anything; a person disposes of each finding.
  - **Grouped dispositions and standing "expected" acknowledgements:** a payroll administrator marks a check as
    expected for one person, a group or the company (`payroll_check_acknowledgement`, migration 2011). It is audited
    and revocable. It never suppresses a **block**, and nobody acknowledges a check about themselves. Learned proposals
    of an acknowledgement are evidence only; a group administrator who made none of the dispositions approves them.
- **TP3 question.** "Did you work for another employer this year?" is answered by the joiner only, about themselves.
  It is append-only, holds no amount, and payroll reads none of it (`core/pre-salary/tp3-answer.ts`, migration 2011).

## 4. Storage and retention

**Stored chats (Phase 1, unchanged).** Migration `2000_teras_chats`, sha256
`8cd50320de942af9aa59e515c5e39e78f6027325da86264dd8e772bff1c802b7`.
- AES-256-GCM encrypted.
- Per-user FORCE RLS.
- "Keep chats for" 1, 7, 30, 90, 180 or 365 days, **default 30**.
- Hard deletion by the retention runner.
- Gated turns store no words.

**Phase 1 migrations 2001–2003** are byte-identical to r2 (amended SHAs):

| Migration | sha256 |
|---|---|
| `2001_private_cases` | `bcfb193a…` |
| `2002_teras_loops` | `9614f0d8…` |
| `2003_letter_requests` | `86648ce2…` |

**Phase 2 migrations 2004–2011.** Every new table has row-level security enabled **and forced**, and its own grants.

| Migration | idx | when | sha256 | New tables (FORCE RLS) |
|---|---|---|---|---|
| `2004_teras_loop_autonomy` | 804 | `1793330001404` | `b6bdeac1995dad6df759ce9a537c98e9a3666bf01aef716a7f6cac9a9134b132` | `teras_loop_level`, `teras_loop_level_change`, `teras_loop_action`, `teras_loop_action_undo`, `teras_loop_sample_review` (5/5) |
| `2005_teras_payroll_cycle_loops` | 805 | `1793330001405` | `d211dd97ebdeb673998d29a2a9b3b8d8597c39a5646259ac0c855d46eca49fbc` | `teras_payroll_threshold_decision`, `teras_payroll_loop_setting`, `teras_payroll_swing_disposition` (3/3) |
| `2006_payroll_audit_loop` | 806 | `1793330001406` | `05bc9e35367093ae4c6aec877a7ca7ec171387cb84b28940e0db0e190fcf7723` | `payroll_audit_reader`, `payroll_audit_capture` (append-only, hash-chained), `payroll_audit_finding`, `payroll_audit_disposition`, `payroll_audit_correction_cause`, `payroll_audit_control_setting` (6/6) |
| `2007_teras_capacity_baseline` | 807 | `1793330001407` | `8b2bb6e38d76c7bf6643e45c62c11ed89e71d954615438d527adf1b4593f22ad` | `teras_capacity_baseline`: versioned; minutes and counts only (1/1) |
| `2008_own_payroll_cut_off` | 808 | `1793330001408` | `c068fa72631c648453117fdf73cc81e6ffbbb4cc94d55d82397e40ac4e4291f8` | no table (one grant) |
| `2009_teras_living_handbook` | 809 | `1793330001409` | `2ffa6731bc3e8cfbc0586875ba9c33d0db2c67104376dc99e35ba181214ccae0` | `teras_policy_document`, `_version`, `_scope`, `_value`, `_value_confirmation`, `_approval`, `_application`, `_drift_finding`, `_contribution`, `_text_only` (10/10). Nothing is deleted. |
| `2010_teras_learning_loops` | 810 | `1793330001410` | `2cabdaa5975db8ef1d91f6027bb38b4b7ca1f7ce3c17561b9961926f2e02c201` | `teras_learning_signal`, `teras_learning_signal_review`, `teras_gap_turn`, `teras_gap_occurrence`, `teras_gap_status`, `teras_eval_candidate` (6/6). **No words from any chat.** Signals and gaps are refused from a routed or refused turn. The only words are an administrator's own redacted eval candidate. |
| `2011_payroll_loops_hardening` | 811 | `1793330001411` | `d42cceaf96f728c8682b73c40c33b5d3066de40f1d5484100dff3686c811d909` (amended in place in `05cfba8f6`, never applied; was `71c1b7ee…`) | `payroll_check_acknowledgement`, `payroll_check_rule_decision`, `teras_cut_off_reminder`, `payroll_tp3_previous_employer_answer` (4/4). The close definers now take the latest **closed** prior batch and read effective payslips only. |

- **Allocation:** in the AI Centre block 2000–2019 (`docs/MIGRATION-ALLOCATION.md`). Re-check the live ledger and
  watermark (main's applied 0953 at `1793330000353`) before admission. Main `3b3f94ccd` adds no migration.
- **`docs/MIGRATION-ALLOCATION.md`** records `d42cceaf…` for 2011. Migrations 2000–2010 are byte-identical to
  `2109062e8`.
- **Letters custody:** no migration (the 0973 draft was dropped). Letter requests survive chat removal as HR records.

**Operator steps at install:**
- **Enable the AI retention timer** (`deploy/systemd/aihr-ai-retention.timer`, `deploy/systemd/AI-RETENTION.md`).
- `TERAS_PROPOSAL_SECRET` and `AI_CONFIG_SECRET` must both be present.
- Loops stay off, and every loop starts at Prepare. Only a group administrator switches loops on and promotes them, on
  a fictional staging tenant.

## 5. Evidence

| Evidence | Run | Head | Status |
|---|---|---|---|
| Phase 2 scored evaluation | `41740712701` (ci87) | `2109062e8` | success. Figures below. |
| Timing | `41740721786` (ci88) | `2109062e8` | success. 67 turns, 0 errors. Sequential p50 7.6 s, p90 19.8 s; concurrent ×4 p50 7.1 s, p90 14.0 s. |
| Populated upgrade (Phase 2) | `41740353018` (ci53) | `2109062e8` | success. 35 test files, including `test/board-nine-populated-upgrade.test.ts`. Its logged `[populated-upgrade-ledger]` line shows rows 649–656 as staging's eight migrations, 657–660 as 2000–2003 and 661–668 as 2004–2011, each hash equal to that migration's sha256. **Predates the 2011 edit.** |
| Populated upgrade (final) | `41766084935` (ci112) | `f9fdccd61` | success. 20 upgrade test files, `board-nine` included, all passed. Re-traced from its logged ledger: the same 20 rows 649–668, with row 668 now `d42cceaf…` (the amended 2011). |
| Focused union runs | ci47–ci86 | `2109062e8` | 40 runs. The coordinator checked every run with `gh run list`: all 40 succeeded at `2109062e8…`. |
| Fix runs | `41763969639` (ci100, typecheck and selected tests), `41763973392` (ci101), `41763976865` (ci102) | `05cfba8f6` | all success |
| Merge runs | `41766077994` (ci110, typecheck, linux-build, selected tests), `41766081547` (ci111), `41766084935` (ci112) | `f9fdccd61` | all success |
| **Full release gate** | after the binding | the binding commit | **Not yet run.** The gate refuses unbound code. |

**Why no new evaluation.** Everything after `2109062e8` leaves the AI's inputs and instructions as evaluated:
- the closure-root script entry;
- a closed-status filter and effective-copy filters in payroll SQL and TypeScript;
- the Microsoft-login merge.

None of them touches the harness, spec, semantic model, product-context tools, wiring, proposals, explainers or
`messages`, so no AI reply text changes. The one closure file that changed in behaviour, `core/payroll-anomaly.ts`,
only narrows which earlier run counts as the prior cycle.

**Scored evaluation, spec v23** (`0052cefe…`), `openai/gpt-6-luna`. Figures are given two ways:
- **44 shared turns:** the release comparison basis, recomputed by the coordinator from the run's artefact.
- **All 67 turns:** the run log's own `AIHR_ASSISTANT_SMART_EVAL` line (set digest `84104d2c…`, 134 answers).

| Run | Basis | Overall | HR admin | Group admin | Employee | Manager | Payroll | Safety faults |
|---|---|---|---|---|---|---|---|---|
| `41740712701` | **44 shared turns** | 86.4 | 87.5 | 83.8 | 91.8 | 91.4 | 72.5 | 0 |
| `41740712701` | all 67 turns (log) | 86.2 | 86.3 | 83.6 | 87.5 | 94.0 | 74.4 | 0 |

**Bars and results.** Measured on the 44 turns shared with baseline run `41534700953`, as the mean over both passes.
The coordinator recomputed these from the run's `assistant-smart-eval.json` artefact.

| Role | Bar | Score (`41740712701`) | Margin | Result |
|---|---|---|---|---|
| Overall | 82.2 | 86.4 | +4.2 | **PASS** |
| HR admin | 82.3 | 87.5 | +5.2 | **PASS** |
| Group admin | 74.4 | 83.8 | +9.4 | **PASS** |
| Employee | 91.3 | 91.8 | **+0.5** | **PASS** |
| Manager | 86.2 | 91.4 | +5.2 | **PASS** |
| Payroll | 70.2 | 72.5 | +2.3 | **PASS** |

- All six pass. The thinnest margin is the employee score (+0.5).
- Payroll (72.5) is lower than the Phase 1 candidate's 75.1 but above its bar.
- The all-turns line uses a different turn set (67 turns, against the baseline's shared 44), so it is not compared
  with the bars.
- Phase 1's evidence (`41707089294`, `41693210410` and others) is in the r2 packet. It applies only to code unchanged
  since.

## 6. What the owner is asked to approve
**In plain language.** That the AI Centre may send the provider exactly what section 2 describes, including the new
`handbook_policy_values_v1` contract, and make happen exactly what section 3 describes, on the code with fingerprint
`fd335f2306be43959ea9059a95275e329896896a0c2cf09005072c725ac36d71` (1413 files). This replaces the bindings at `66cf4753…` (main) and `b96772fe…` (the Phase 1 branch).

**What stays out:**
- **Production stays held** until counsel advises (ADR-0169 §5.1). No real tenant data may reach a provider.
- **Staging only.** This approval is not a deployment authorisation, not staging acceptance and not a runtime PASS.
  The full gate runs after the binding; the release goes through the shared queue and lease.
- **Fictional data only** on staging.
- It covers **this closure only**. Any later change to a closure file needs a fresh approval. That includes wiring
  letter requests into chat.

### Known limits and follow-ups
- **Letters in chat:** letter requests are not wired into chat.
- **Payroll partner (`pay-net-1`):** a payroll partner has no page that shows an individual's pay. A question about one
  person's pay is answered without a page link, and is never sent to HR or the payroll team.
- **Payment method:** it is read as of today, not as of the run date (`localization/my/ocbc-payment.ts`).
- **Translations:** native review is still outstanding (Tamil and Thai gate patterns, and the Phase 1 and 2 strings).
- **Employee eval margin:** thin, at 0.5 over the bar.

## 7. Exact binding (written only after a fresh owner approval)
In this order, on `f9fdccd615f15c78bca295bcfb2ad68f3c57b546`:
1. **`lib/ai/provider-data-source-manifest.ts`**, generated: `b96772fe…` →
   `fd335f2306be43959ea9059a95275e329896896a0c2cf09005072c725ac36d71`.
2. **`lib/ai/provider-data-approvals.ts`:**
   - all **26** occurrences of `b96772fe…` become `fd335f23…`: 25 historical approved records, one written
     compactly (`authored_pay_formula_v1`), and `teras_harness_turn_v1`;
   - the 25 historical records keep status, reviewer, evidence and `reviewedAt` byte-for-byte;
   - both pending records stay byte-identical;
   - `teras_harness_turn_v1` changes as below;
   - **one new approved record** for `handbook_policy_values_v1` is added as the last row.

   The merge of main left this file unchanged; it is byte-identical to `2cee0e8b5`'s.
3. **`test/handbook-extract.test.ts` line 112:** it pins the contract as `'pending'`, so it must become `'approved'`
   in the same commit, or that test turns red.
4. **`docs/reviews/ai-provider-owner-approval-2026-10.md`**: append `## AI v2 release binding` (anchor
   `#ai-v2-release-binding`), stating:
   - the closure move (`b96772fe…` on the branch, `66cf4753…` on main → `fd335f23…`, 1413 files);
   - the Phase 1 review fixes and Phase 2 scope;
   - the new `handbook_policy_values_v1` contract and its outgoing class;
   - that no earlier approval transfers;
   - the route and actual time of the fresh approval;
   - that it covers this closure only;
   - that counsel's advice is still required before any real data.
5. **`lib/ai/module-agent-source-manifest.ts`**, generated **last**. Its value will differ from both `91d19024…` and
   `8a7bcfde…`.
6. Both `--check` commands. Then focused CI including `provider-data-review-gate` and `test/handbook-extract.test.ts`.
   Then the full release gate.

**The `teras_harness_turn_v1` record change:**

```diff
 {
   "contractId": "teras_harness_turn_v1",
   "status": "approved",
-  "sourceDigest": "b96772fea09e857c01e8de90fdc39e6bbe7ad2b03eebc7c530a57bc12f357a32",
+  "sourceDigest": "fd335f2306be43959ea9059a95275e329896896a0c2cf09005072c725ac36d71",
   "reviewer": "human:zenlam repository-owner provisional",
-  "evidence": "docs/reviews/ai-provider-owner-approval-2026-10.md#phase-1-release-binding",
-  "reviewedAt": "2026-11-03T17:21:45Z"
+  "evidence": "docs/reviews/ai-provider-owner-approval-2026-10.md#ai-v2-release-binding",
+  "reviewedAt": "<AT APPROVAL>"
-}
+},
+{
+  "contractId": "handbook_policy_values_v1",
+  "status": "approved",
+  "sourceDigest": "fd335f2306be43959ea9059a95275e329896896a0c2cf09005072c725ac36d71",
+  "reviewer": "human:zenlam repository-owner provisional",
+  "evidence": "docs/reviews/ai-provider-owner-approval-2026-10.md#ai-v2-release-binding",
+  "reviewedAt": "<AT APPROVAL>"
+}
 ].map(row=>Object.freeze(row as ProviderDataReviewRecord)));
```

`<AT APPROVAL>` is the actual UTC time of the fresh approval, written as `YYYY-MM-DDTHH:MM:SSZ`. Each of the other 25
approved records changes only its `sourceDigest` (`b96772fe…` → `fd335f23…`).

**How the pending list changes.**
- The records with `status: "pending"` stay exactly `['structured_canonical_records_v1','attendance_trend_analysis_v1']`,
  which is what `test/provider-data-review-gate.test.ts` asserts.
- `handbook_policy_values_v1` is pending today by **absence**: `providerDataReviewStatus` answers `'pending'` for a
  contract with no record.
- After the binding it is one of **27** approved records. The gate test then requires its reviewer, evidence anchor,
  past `reviewedAt` and current digest, like every other approved record.

```diff
 // test/handbook-extract.test.ts
-  expect(providerDataReviewStatus('handbook_policy_values_v1')).toBe('pending');
+  expect(providerDataReviewStatus('handbook_policy_values_v1')).toBe('approved');
```

## Release notes for the installation
- Migrations 2000–2011 as in section 4.
- Enable the AI retention timer.
- `TERAS_PROPOSAL_SECRET` and `AI_CONFIG_SECRET` must be present.
- Loops off and at Prepare until a group administrator acts, on a fictional staging tenant.
- The handbook contract makes provider calls only when an administrator presses "Read the values".

---

## Appendix A: closure file-set diffs (`f9fdccd61` against main `3b3f94ccd`)

### Provider-data closure against main `3b3f94ccd` (`66cf4753…`): 121 added, 0 removed, 67 changed

**Added (121):**
- `core/assistant-actions/own-leave-apply-form.ts`
- `core/assistant-actions/own-toil-worked-day.ts`
- `core/capacity/baseline-rules.ts`
- `core/capacity/baseline.ts`
- `core/capacity/ledger-math.ts`
- `core/capacity/types.ts`
- `core/chat-import/kinds.ts`
- `core/chat-import/previews.ts`
- `core/chat-import/tool.ts`
- `core/claim-limit-explain.ts`
- `core/cost-allocation-import.ts`
- `core/employee-home.ts`
- `core/employee-import-history.ts`
- `core/explainers/claim-limit.ts`
- `core/explainers/pay-difference.ts`
- `core/explainers/payroll-loops.ts`
- `core/handbook/ask.ts`
- `core/handbook/consistency.ts`
- `core/handbook/extract.ts`
- `core/handbook/provider-model.ts`
- `core/handbook/settings.ts`
- `core/handbook/types.ts`
- `core/import.ts`
- `core/learning/access.ts`
- `core/learning/ask.ts`
- `core/learning/proposals.ts`
- `core/learning/quality-math.ts`
- `core/learning/quality.ts`
- `core/learning/types.ts`
- `core/letter-requests.ts`
- `core/loops/acknowledgements.ts`
- `core/loops/autonomy-cards.ts`
- `core/loops/autonomy-types.ts`
- `core/loops/autonomy-views.ts`
- `core/loops/autonomy.ts`
- `core/loops/cards.ts`
- `core/loops/cut-off-reminders.ts`
- `core/loops/definitions.ts`
- `core/loops/detect.ts`
- `core/loops/document-expiry.ts`
- `core/loops/levels.ts`
- `core/loops/missed-clock-outs.ts`
- `core/loops/missing-employee-data.ts`
- `core/loops/net-swing.ts`
- `core/loops/pay-relevant.ts`
- `core/loops/payroll-cycle-views.ts`
- `core/loops/payroll-freshness.ts`
- `core/loops/payroll-inputs.ts`
- `core/loops/payroll-loop-settings.ts`
- `core/loops/period.ts`
- `core/loops/pre-salary-checks.ts`
- `core/loops/probation-ending.ts`
- `core/loops/salary-payroll.ts`
- `core/loops/samples.ts`
- `core/loops/swing-proposals.ts`
- `core/loops/types.ts`
- `core/loops/views.ts`
- `core/pay-difference.ts`
- `core/payroll-audit/append.ts`
- `core/payroll-audit/controls.ts`
- `core/payroll-audit/corrections.ts`
- `core/payroll-audit/inputs.ts`
- `core/payroll-audit/reader-grant.ts`
- `core/payroll-audit/settings.ts`
- `core/payroll-audit/status.ts`
- `core/payroll-audit/types.ts`
- `core/payslip-absence-lines.ts`
- `core/payslip-zakat-line.ts`
- `core/personnel-register-import.ts`
- `core/pre-salary/ask.ts`
- `core/pre-salary/person-items.ts`
- `core/pre-salary/tp3-answer.ts`
- `core/private-case-route.ts`
- `core/process-assessment.ts`
- `core/product-context/capability-catalogue.ts`
- `core/proposals/assigned-decide.ts`
- `core/proposals/attendance-request.ts`
- `core/proposals/chat-import.ts`
- `core/proposals/claim-cancel.ts`
- `core/proposals/claim-submit.ts`
- `core/proposals/leave-apply.ts`
- `core/proposals/leave-type-match.ts`
- `core/proposals/own-words.ts`
- `core/proposals/profile-change.ts`
- `core/proposals/toil-request.ts`
- `core/semantic-model/entities-catalogue.ts`
- `core/semantic-model/entities-decisions.ts`
- `core/semantic-model/entities-handbook.ts`
- `core/semantic-model/entities-imports.ts`
- `core/semantic-model/entities-loops.ts`
- `core/semantic-model/entities-metrics.ts`
- `core/semantic-model/entities-own-changes.ts`
- `core/semantic-model/entities-payroll-loops.ts`
- `core/semantic-model/entities-payroll-readiness.ts`
- `core/semantic-model/entities-quality.ts`
- `core/semantic-model/entities-toil.ts`
- `core/semantic-model/entities-why.ts`
- `core/semantic-model/topic-tools.ts`
- `core/workforce-metrics.ts`
- `db/payroll-audit-schema.ts`
- `db/teras-autonomy-schema.ts`
- `db/teras-capacity-schema.ts`
- `db/teras-learning-schema.ts`
- `db/teras-payroll-cycle-schema.ts`
- `lib/ai-centre/loop-attribution.ts`
- `lib/chat-import.ts`
- `lib/cost-allocation-workbook.ts`
- `lib/dashboard-cards.ts`
- `lib/employee-home-read-model.ts`
- `lib/import-sections.ts`
- `lib/personnel-bank-import.ts`
- `lib/personnel-family-import.ts`
- `lib/personnel-import-catalog.ts`
- `lib/personnel-import-labels.runtime.ts`
- `lib/personnel-import-labels.server.ts`
- `lib/personnel-import-lookup.ts`
- `lib/pre-salary/items.ts`
- `lib/product-context/capability-intent.ts`
- `lib/today/audience.ts`
- `packs/attendance/exceptions.ts`
- `packs/payroll/pay-averages.ts`

**Removed (0):**
- none

**Changed (67):**
- `core/agent-registry/controls.ts`
- `core/agent-registry/workers.ts`
- `core/assistant-actions/own-toil-replacement-source.ts`
- `core/assistant-leave-projection.ts`
- `core/assistant-read-session.ts`
- `core/attendance-clock-data.ts`
- `core/attendance-clocking-import.ts`
- `core/claims.ts`
- `core/company-refs.ts`
- `core/employment-review.ts`
- `core/entitlement-template.ts`
- `core/explainers/capabilities.ts`
- `core/explainers/entitlement.ts`
- `core/harness/memory.ts`
- `core/harness/reply-checks.ts`
- `core/harness/runner.ts`
- `core/harness/spec.ts`
- `core/harness/tools.ts`
- `core/leave-credit-request.ts`
- `core/leave-import.ts`
- `core/letters.ts`
- `core/notifications.ts`
- `core/payroll-anomaly-detectors.ts`
- `core/payroll-anomaly.ts`
- `core/payroll-history-revisions.ts`
- `core/payroll.ts`
- `core/product-context/actions.ts`
- `core/product-context/approval-queue.ts`
- `core/product-context/company-setup.ts`
- `core/product-context/tools.ts`
- `core/proposals/proposal.ts`
- `core/proposals/suggested.ts`
- `core/read.ts`
- `core/record-readiness.ts`
- `core/replacement-request.ts`
- `core/semantic-model/entities-recommend.ts`
- `core/semantic-model/entities.ts`
- `core/semantic-model/generate.ts`
- `core/semantic-model/types.ts`
- `core/teras-wiring/turn.ts`
- `db/schema.ts`
- `db/teras-schema.ts`
- `lib/ai/agent-capability-inventory.ts`
- `lib/ai/grounded-tool-presentation.ts`
- `lib/ai/leave-answer-evidence.ts`
- `lib/ai/module-job-presentation.ts`
- `lib/ai/module-specialist-followup.ts`
- `lib/ai/module-specialists.ts`
- `lib/ai/provider-workload-policy.ts`
- `lib/approval-history.ts`
- `lib/assistant-actions/own-toil-replacement-contract.ts`
- `lib/authz.ts`
- `lib/leave-import-schema.ts`
- `lib/permissions.ts`
- `lib/product-context/destinations.ts`
- `lib/product-context/request-gate.ts`
- `localization/country-pack.ts`
- `localization/my/ocbc-payment.ts`
- `messages/en.json`
- `messages/ms.json`
- `messages/ta.json`
- `messages/th.json`
- `messages/vi.json`
- `messages/zh.json`
- `packs/attendance/service.ts`
- `packs/payroll/service.ts`
- `scripts/ai-provider-data-source-manifest.mjs`

### Module-agent scope against main `3b3f94ccd` (as committed): 8 added, 0 removed, 15 changed

**Added (8):**
- `core/assistant-actions/assigned-decision-proposal-confirm.ts`
- `core/assistant-actions/attendance-request-proposal-confirm.ts`
- `core/assistant-actions/leave-apply-proposal-confirm.ts`
- `core/assistant-actions/letter-request-proposal-confirm.ts`
- `core/assistant-actions/own-change-proposal-confirm.ts`
- `core/assistant-actions/own-leave-apply-form.ts`
- `core/assistant-actions/own-toil-worked-day.ts`
- `core/assistant-actions/toil-request-proposal-confirm.ts`

**Removed (0):**
- none

**Changed (15):**
- `core/assistant-actions/own-toil-replacement-source.ts`
- `core/assistant-leave-projection.ts`
- `core/assistant-read-session.ts`
- `lib/ai/agent-capability-inventory.ts`
- `lib/ai/ai-inventory.ts`
- `lib/ai/grounded-tool-presentation.ts`
- `lib/ai/leave-answer-evidence.ts`
- `lib/ai/module-job-presentation.ts`
- `lib/ai/module-specialist-followup.ts`
- `lib/ai/module-specialists.ts`
- `lib/ai/provider-data-approvals.ts`
- `lib/ai/provider-data-source-manifest.ts`
- `lib/ai/provider-disclosure-inventory.ts`
- `lib/ai/provider-workload-policy.ts`
- `lib/assistant-actions/own-toil-replacement-contract.ts`

### Provider-data closure since the evaluated head `2109062e8` (`939d0723…`): 1 added, 0 removed, 2 changed

**Added (1):**
- `core/handbook/provider-model.ts`

**Removed (0):**
- none

**Changed (2):**
- `core/payroll-anomaly.ts`
- `scripts/ai-provider-data-source-manifest.mjs`
