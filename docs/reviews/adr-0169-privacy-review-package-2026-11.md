# ADR-0169 §5.1 privacy and legal review package (draft, November 2026)

Status: **Draft for the owner's review.** Prepared by engineering on 2 November 2026. It records facts read from source, and labelled options. It gives no legal advice and draws no legal conclusion. Three items are marked **For counsel**: a qualified Malaysian privacy lawyer or data protection officer should advise on them before the owner approves (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:164-169).

Nothing in this package authorises disclosure, deployment, a pilot or production contact.

**Labels used**

- **Fact**: read from the cited source line. Not run, not tested, unless stated.
- **Option**: a course the owner may choose.
- **Recommendation (engineering default)**: what engineering would do if the owner has no other view. Not legal advice.
- **For counsel**: a question only a legal adviser can answer.
- **Decision point**: a field or behaviour the owner must accept, change or reject.

**Sources and citation format**

- `S5` = branch `origin/claude/teras-step5-recommend-digest-registry` at `1efac1951` (code, migrations, threat model).
- `L` = local checkout branch `claude/assistant-onyx-phase1-20261031` at `7e6d4f421` (ADR-0169 and ADR-0170 text).
- A citation reads `branch:path:line`. Only fictional data is used in this document. Identifier examples are described by format, never by value.

---

## Status before you review (2 November 2026)

This package was drafted by reading the code. The drafting pass found seven disclosure defects. The coordinating session confirmed defects 1 to 3 in code, and all seven are **fixed in draft PR 191** (`claude/teras-privacy-fixes`, head da474340, harness spec v6). Each fix has a test that failed on the unfixed code first (run 41327020490: 19 failed). Then 568 tests and the whole typecheck passed (run 41328190341), and a model run on the same head had zero hard-gate failures (run 41329226626). Approved digests are unchanged.

| # | Defect | Fix in v6 |
| --- | --- | --- |
| 1 | Undeclared fields in module rows (employee codes, managers' names) reached the model | Undeclared fields are removed at any depth; every module field is declared; codes and ids `never`, names placeholders |
| 2 | The approver's pending list (names, dates) had no field contract | Declared entity: the model sees an ordinal, a screened leave type, days and a relative start; names and dates are restored locally |
| 3 | Exact figures re-entered through history | Separate person-side and model-side transcripts; only the model-side one can be sent as history |
| 4 | Identifiers screened only in the reply | Screened in the question, history, memory goal and tool output; patterns widened (passport, IC with spaces, EPF, SOCSO, phone, email) |
| 5 | `minimum` meant the same as `full` | `minimum` is exact only for the person's own records and admin configuration; about other people, and every name, it becomes a placeholder; health- and religion-indicative labels are screened |
| 6 | Medical, harassment, grievance and termination-threat turns reached the model | Routed to HR with no model call; not stored as the memory goal |
| 7 | Outcome-record trace stored reply fragments | Trace limited to kinds and counts |

Known cost: one pay question (`emp-pay-why`) is met 1 of 3 instead of 3 of 3, because the model now answers from its own earlier, banded turn instead of re-reading. Tables in sections 2 to 4 below describe the code **before** these fixes, except where they say otherwise. Read them with the table above. The whole-stack security review re-checks every fix.

## 1. What you are approving

**Fact.** Under option 2 the Teras harness would send three kinds of content to an external model: the person's own question and earlier turns of the conversation, the system instructions, and the output of read tools after the semantic-model disclosure step (S5:core/harness/runner.ts:103-104, :170; S5:core/harness/disclosure.ts:3-13). The path is: harness turn runner, then a model client, then (in production, once built) the governed AI gateway, then a provider (S5:core/harness/model-client.ts:3-7). Users would be employees asking about their own records, managers about direct reports, assigned leave approvers, and administrators about setup, each limited by the read's audience and row-level scope (S5:core/semantic-model/entities.ts:20-118; S5:core/semantic-model/entities-setup.ts:23-25). What stays local: fields classed `never` (removed or replaced by an opaque `ref-N` handle), exact figures classed `bands` (the model sees a placeholder and a range), signed proposals, the outcome record and the turn trace (S5:core/harness/disclosure.ts:3-8; S5:core/harness/tools.ts:34; S5:core/harness/trace-persistence.ts:51-55). The daily digest, the approver recommendation and the weekly team-absence summary call no model (S5:core/digest/daily-digest.ts:10-11; S5:core/recommenders/leave-decision.ts:13-21; S5:core/mandates/team-absence-summary.ts:7).

**Fact.** Approval unlocks the next step in ADR-0169: building the production model adapter and the per-tenant switch, then a pilot with one tenant's consent after legal sign-off (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:177-180). Today the runner refuses to run outside a test process (S5:core/harness/runner.ts:38-42, :87). Approval binds to the exact source; a later change needs fresh approval (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:164).

**Fact.** Approval does **not** authorise a deployment, real HR data before the pilot conditions are met, or Teras Connect. Connect needs its own legal review, separate from §5.1 (L:docs/adr/0170-teras-ai-operating-architecture.md:216). Today's closed-reference Assistant stays in production unchanged; it sends ordinal references only and no question, identity, date or amount (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:152; S5:lib/ai/provider-assistant-policy.ts:1-2).

---

## 2. Per-tool, per-field disclosure contract

### 2.1 How the classes are applied (Fact)

| Class | What the model receives | Source |
| --- | --- | --- |
| `never` | Removed. An `id` field or list of record ids becomes an opaque per-turn handle `ref-N`. | S5:core/harness/disclosure.ts:64-68; S5:core/harness/spec.ts:74 |
| `bands` | Placeholder `{{F#}}` plus the range it falls in, for example "between 1000 and 2000". Exact value kept in the turn ledger and restored for the person. | S5:core/harness/disclosure.ts:70-78; S5:core/harness/spec.ts:72-76; S5:core/harness/restore.ts:14-22 |
| `minimum` | **Exact value.** The code treats `minimum` the same as `full`. Nothing checks that "the question needs it". | S5:core/harness/disclosure.ts:8, :80; compare S5:core/semantic-model/generate.ts:47 |
| `full` | Exact value. | S5:core/harness/disclosure.ts:8, :80 |
| Undeclared key | Removed (fail closed), unless it is an envelope key, a container, or the child of an `open` row, which takes the parent's class. | S5:core/harness/disclosure.ts:9-11, :95-99 |
| Any value | A string that is a UUID becomes a handle wherever it appears. Only UUIDs; no other identifier pattern is swept from tool output. | S5:core/harness/disclosure.ts:18, :56-61 |
| Context tools (no entity) | Everything kept except UUIDs. | S5:core/harness/disclosure.ts:103-106; S5:core/harness/spec.ts:79-80 |

Band edges are 0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1 000, 2 000, 5 000, 10 000, 20 000, 50 000, 100 000 (S5:core/harness/spec.ts:76). **Decision point D-BAND:** a band discloses the order of magnitude of a pay figure (for example, net pay "between 5000 and 10000").

Key for the "Model receives" column: **removed**, **handle**, **band** (placeholder plus range), **exact**. "DP" marks a decision point: a field classed `full` or `minimum` that holds personal data, pay, health-indicative content or an identifier.

### 2.2 Reads (production catalogue names; harness-offered)

**my_leave_balances** (leave_balance; own; S5:core/semantic-model/entities.ts:20-27)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| employmentId | never | handle | |
| company | minimum | exact | DP: employer of the person |
| leaveTypeId | never | handle | |
| leaveType | full | exact | DP: a type name such as medical, hospitalisation or maternity leave is health-indicative |
| accrued, taken, pending, balance, available | bands | band | |
| sharedPoolName | minimum | exact | |
| withheld | full | exact | |

**my_leave_requests** (leave_request; own; S5:core/semantic-model/entities.ts:28-38)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| company | minimum | exact | DP |
| leaveTypeId | never | handle | |
| leaveType | full | exact | DP: health-indicative type names |
| status, durationType | full | exact | |
| startDate, endDate, days, hours, fromTime, toTime, workingDates | minimum | exact | DP: the person's absence dates |
| reason, employeeRemark | never | removed | |
| hasDocument | full | exact | DP: with a medical leave type, implies a medical certificate |
| hasRejectedDates | full | exact | |

**leave_entitlement_explain** (leave_entitlement; own; S5:core/semantic-model/entities.ts:39-60)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| employmentId | never | handle | |
| company | minimum | exact | DP |
| leaveType, entitlementStatus, withheld | full | exact | DP for leaveType (as above) |
| cycleStart, carryForwardExpiryDate | minimum | exact | |
| entitlementTemplateName | minimum | exact | |
| eligibility (object) | minimum | exact | DP: names the eligibility rule that did not match; if rules use gender, marital status or service, this discloses it |
| displayEntitlementDays, broughtForward, adjustments, totalEntitlement, takenThisCycle, pendingApproval, forfeitedThisCycle, totalAvailable, eligibleDays, currentYearEntitlement, currentYearEntitlementRounded, monthlyAccruedToDate, carriedForward, carryForwardRemaining, configAdjustments, systemAdjustments, balance | bands | band | |
| transactions[].effectiveOn | minimum | exact | |
| transactions[].entryType | full | exact | |
| transactions[].days | bands | band | |
| transactions[].sourceRequestId | never | handle | |
| transactions[].reason | never | removed | |

**upcoming_holidays** (public_holiday; own; S5:core/semantic-model/entities.ts:61-64): employmentId never → handle; date full → exact; name full → exact. No DP.

**who_is_away** (absence; other people the caller may see; S5:core/semantic-model/entities.ts:65-71)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| personName | minimum | exact | **DP: other people's names** |
| employeeCode | never | removed | |
| employmentIds | never | handles | |
| personCount, approvedOnFromDate | bands | band | |
| absences[].leaveType | full | exact | **DP: third party's leave type next to their name; health-indicative** |
| absences[].status | full | exact | |
| absences[].startDate, endDate, days, hours | minimum | exact | DP: third party's absence dates |

**team_leave_summary** (team_leave_balance; manager over one direct report; S5:core/semantic-model/entities.ts:72-77)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| employmentId, leaveTypeId | never | handle | |
| leaveType | full | exact | DP: third party, health-indicative |
| balance | bands | band | |
| pendingCount | minimum | exact | DP: third party |
| upcomingFrom, upcomingTo | minimum | exact | DP: third party's planned leave |

**employee_profile** (employment_profile; visible scope; sensitivity `identity`; S5:core/semantic-model/entities.ts:78-83)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| employmentId | never | handle | |
| employeeCode | never | removed | |
| name | minimum | exact | **DP: another person's name** |
| company | minimum | exact | DP |
| gradeName | minimum | exact | DP: job grade correlates with pay |
| holidayGroupName, workState | full | exact | DP (minor): work location at state level |
| hiredOn, joinDate | minimum | exact | DP |
| terminatedOn | minimum | exact | **DP: another person's termination date** |

**my_reporting_line** (reporting_line; own; S5:core/semantic-model/entities.ts:84-89)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| employmentId | never | handle | |
| managers[].name, reports[].name | minimum | exact | DP: other people's names |
| managers[].employeeCode | never | removed | |
| reports[].employmentId | never | handle | |
| lineType | full | exact | |

**my_payslip_summary** (payslip; own; pay; S5:core/semantic-model/entities.ts:90-95): payPeriod full → exact; company minimum → exact (DP); runType full → exact; gross, deductions, net bands → band.

**my_pay_change** (pay_change; own; pay; S5:core/semantic-model/entities.ts:96-102)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| period, previousPeriod | full | exact | |
| gross, deductions, net (objects) | bands | band | |
| lines[].code, lines[].name | minimum | exact | **DP: pay item names can reveal religion (for example a zakat deduction), union membership, a court-ordered deduction or a loan** |
| lines[].current, previous, change | bands | band | |

**my_claim_statuses** (claim_status; own; S5:core/semantic-model/entities.ts:103-108)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| id, employmentId | never | handle | |
| claimType | full | exact | DP: a medical claim type is health-indicative |
| status | full | exact | |
| incurredOn, createdAt, decidedAt, paidAt | minimum | exact | |

**my_module_work** (module_work; own; sensitivity `pay`; S5:core/semantic-model/entities.ts:109-113)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| module | full | exact | |
| data (list, `open`) | minimum | **exact for every undeclared child** | **DP and defect, see §2.6 item 1** |
| data[].gross, deductions, net, amount | bands | band | |
| specialistWork | minimum | exact | |
| humanActions | full | exact | |

### 2.3 Explainers (harness-only reads; S5:core/semantic-model/generate.ts:108-114)

**explain_payslip_statutory** (statutory_explanation; own; pay; S5:core/semantic-model/entities-explain.ts:37-49, :62-74)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| period, availablePeriods | full | exact | |
| payslips[].company | minimum | exact | DP |
| payslips[].payPeriod, runType, ruleVersion, basesNotRecorded, basesCoverWholeMonth | full | exact | |
| items[].key, name, ruleKind, workingNotRecorded | full | exact | |
| items[].setBy | full | exact | DP (minor): shows the person chose a manual EPF amount |
| items[].totalBase, additionalBase, employeeReported, employeeTakeHome, employerBorne, employer, effectiveEmployeeRatePercent, effectiveEmployerRatePercent, systemEmployee, systemEmployer | bands | band | |
| payslips[].totals | bands | band | |
| provenance (owner, ruleVersionSource, page, note) | full | exact | |

**explain_leave_entitlement** (entitlement_explanation; own; S5:core/semantic-model/entities-explain.ts:50-54, :75-83): leaveType, leaveTypes full → exact (DP: health-indicative names); employments[] minimum, carrying every leave_entitlement field above except employmentId, with the same classes; proration.annualEntitlementDays, eligibleCalendarDays, unroundedEntitlementDays, displayEntitlementDays bands → band; proration.prorated, daysInLeaveYear, roundingApplied full → exact; provenance full.

**explain_attendance_day** (attendance_day_explanation; own; S5:core/semantic-model/entities-explain.ts:58-60, :84-99)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| date, company | minimum | exact | |
| status, flag, explained, unavailableReason | full | exact | DP (minor): "late" flag is conduct-relevant |
| recorded.lateMinutes, earlyOutMinutes, workedMinutes, overtimeMinutes | minimum | exact | DP: exact conduct and working-time data |
| schedule.source, dayType, ruleApplied, crossesMidnight | full | exact | |
| schedule.shiftStart, shiftEnd, scheduledMinutes, breakMinutes | minimum | exact | |
| punch.checkIn, checkOut, workedMinutes | minimum | exact | DP: exact clock times |
| lateness/earlyOut/overtime.minutes, .steps | minimum | exact | DP: as above |
| provenance | full | exact | |

### 2.4 Setup co-pilot (administrators; S5:core/semantic-model/entities-setup.ts:23-34)

| Field | Class | Model receives | DP |
| --- | --- | --- | --- |
| payPeriod, complete | full | exact | |
| next.stage, next.status, next.page | full | exact | |
| stages[].stage, status, page | full | exact | |
| stages[].blockers[].check, severity, page | full | exact | |
| stages[].blockers[].subject | minimum | exact | Declared "never a person" (entities-setup.ts:31). Not verified in the owner. |
| stages[].blockers[].count | bands | band | |
| gaps[].area, note | full | exact | |
| provenance | full | exact | |

### 2.5 Recommender, digest and other step-5 entities

**Fact.** These are declared as entities only. No read is added to the Teras tool catalogue, so the harness offers none of them to a model today (S5:core/semantic-model/entities-recommend.ts:7). The classes below apply if a later change offers them.

- **leave_decision_recommendation** (S5:core/semantic-model/entities-recommend.ts:24-36): verdict, failedRules[].check, blocking, checks[].check, result, blocking, recommenderVersion full → exact; ruleVersion, recordId never → removed/handle. DP if offered: the check results (balance, own overlap) are facts about the applicant, a third party.
- **daily_digest** (S5:core/semantic-model/entities-recommend.ts:37-48): counts and pages; overdue and dueSoon bands. **Fact:** the digest wording is a fixed template and calls no model (S5:core/digest/daily-digest.ts:10-11). No egress.
- **agent_worker** (:49-57), **payroll_anomaly** (:59-63; facts bands, employmentId never), **readiness_gap** (:64-67), **pending_approval** (:68-71), **followup_item** (:72-76). DP if offered: followup_item.source `passport_expiry` is full; it implies the person holds a passport under a work pass process.

### 2.6 Content that reaches the model outside the semantic-model contract (Fact)

These paths are not governed by per-field classes. Each is a decision point.

1. **my_module_work rows pass undeclared fields exactly.** The `data` field is `open` at class `minimum`, so any undeclared child keeps `minimum` and passes (S5:core/semantic-model/types.ts:22-24; S5:core/semantic-model/entities.ts:112; S5:core/harness/disclosure.ts:92, :98). The employees module puts `employeeCode` in each row, and the org module puts manager `name` and `employeeCode` in nested rows (S5:core/module-agent-readers.ts:62-65), and the tool returns those rows unchanged (S5:core/assistant-read-session.ts:36; S5:core/assistant-tools.ts:810). `employeeCode` is `never` everywhere else (S5:core/semantic-model/entities.ts:68, :81, :88). Read from code; not run.
2. **suggest_action output.** When several leave requests wait for the approver, the output lists `applicant`, `leaveType`, `startDate`, `endDate`, `days` for up to 10 requests (S5:core/proposals/suggested.ts:28-31, :52-53; S5:core/harness/tools.ts:50, :72). It is disclosed as a context tool: only UUIDs are swept (S5:core/harness/runner.ts:170). Third parties' names with leave types reach the model exactly.
3. **Context tools.** product_guidance returns tenant-authored guide text; approval_queue, setup_readiness and company_setup return counts, statuses and configuration names per their descriptions (S5:core/product-context/tools.ts:30-36, :62-77). Only UUIDs are swept. Field-level content of setup_readiness and approval_queue was not verified.
4. **The question and conversation history, verbatim.** The person's question and every earlier user and assistant turn are sent as written (S5:core/harness/runner.ts:104). On a medical, harassment, grievance or termination-threat turn, the model is still called with the question (only crisis and workplace-harm turns skip the model) (S5:core/harness/runner.ts:89-95; S5:core/harness/spec.ts:103-109).
5. **Restored exact figures re-sent as history.** The runner returns the reply with exact figures restored (S5:core/harness/runner.ts:179, :196). The real-model probe passes that shown reply back as the next turn's assistant history (S5:test/assistant-model-ceiling.eval.test.ts:139), and the runner sends history verbatim (S5:core/harness/runner.ts:104). So a banded pay figure leaves as an exact figure on the next turn. Production wiring does not exist yet; whatever it passes as history decides this.
6. **Task memory note.** The conversation goal is the first question, up to 300 characters, in the person's words, and is sent in the system message each turn (S5:core/harness/memory.ts:72, :81; S5:core/harness/spec.ts:135; S5:core/harness/runner.ts:103).
7. **The model's own tool arguments** (dates, leave type names, a pay period) are echoed back in envelope keys such as `from`, `to`, `asOf` (S5:core/harness/spec.ts:78).

ADR-0170 already says the contract must be rewritten to cover memory and logs, not only egress (L:docs/adr/0170-teras-ai-operating-architecture.md:656).

---

## 3. Identifier denylist

### 3.1 Patterns enforced (Fact; S5:core/harness/reply-checks.ts:32-46)

| Kind | What matches (described, no values) |
| --- | --- |
| record_id | An internal UUID. |
| ic | Malaysian NRIC: six digits forming a valid month and day, two digits, four digits; dashes optional. Not preceded or followed by another digit or a decimal separator. |
| tax_number | An LHDN file prefix (SG, OG, IG, C, D, E, F, J, TP, TA, TC, TN, TR, PT, LE) with an optional space and 8 to 11 digits; or the words tax, TIN or cukai, optionally "no", "number", "ref" or "nombor", then six or more digits. Case-insensitive. |
| passport | One or two **uppercase** letters followed by 7 to 9 digits. |
| bank_account | A run of 10 to 17 digits; or groups of 4, 4 and 4 to 9 digits separated by a dash or space. |

### 3.2 Where it is enforced (Fact)

- Only on the model's **final reply**, before figures are restored (S5:core/harness/reply-checks.ts:1-10, :61-67; S5:core/harness/runner.ts:115-122, :144).
- Order: non_blank, destination_links, overclaim, identifiers (S5:core/harness/spec.ts:83). A failing reply gets one corrective retry, then the fixed fallback reply (S5:core/harness/spec.ts:42-45, :85; S5:core/harness/runner.ts:119-121).
- The finding records the kind only, never the value (S5:core/harness/reply-checks.ts:8-9).
- Unit tests exist in S5:test/teras-harness-units.test.ts (not run for this package).
- The production closed-reference Assistant does not use it; it is harness-only.

### 3.3 Known gaps (Fact unless marked)

1. **It does not stop egress.** It checks what comes back from the model, not what is sent. An identifier the person types, or one inside guide text, a module row or history, has already reached the model. ADR-0169 describes it as "IC, passport, bank and tax numbers never leave" (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:108). In code, "never leave" rests on field classes and the UUID sweep, not on this denylist.
2. No declared entity has an IC, passport, bank or tax field (S5:core/semantic-model/entities.ts:19-119 and the step-4/5 files). That is an absence of fields, not a filter. Open rows and context tools are not covered (§2.6).
3. Passport matching is case-sensitive: a lowercase letter prefix does not match.
4. An IC written with spaces instead of dashes does not match the `ic` pattern, and its 6-2-4 grouping does not match the grouped `bank_account` pattern.
5. Not covered: EPF member number, SOCSO number, employee code, phone number, email, postal address, driving licence, foreign identity formats other than long digit runs, digits written as words, full-width digits.
6. False positives: a 10 or 11 digit phone number matches `bank_account`, so a reply may fall back unnecessarily (availability, not privacy).

**Recommendation (engineering default).** Add the same identifier screen on the way **in**: question, history, memory goal and every tool output, before the model call, with the person told the identifier was not sent. Make passport matching case-insensitive and accept spaced IC. Owner to decide whether to add EPF, SOCSO, phone and email.

---

## 4. What the model never receives (Fact, from code)

1. Fields classed `never` in a declared read: removed, or an opaque handle for ids. This includes leave reasons and remarks typed by the person, the approver's reject reason, employee codes at their declared positions, ledger entry reasons, rule-version labels and outcome record ids (S5:core/harness/disclosure.ts:64-68; S5:core/semantic-model/entities.ts:36, :53, :68, :81, :88, :118; S5:core/semantic-model/entities-recommend.ts:31-36).
2. Raw internal UUIDs anywhere in tool output: replaced by `ref-N` handles, resolved only for the same caller in the same turn (S5:core/harness/disclosure.ts:56-61; S5:core/harness/runner.ts:164-167).
3. Exact values of `bands` fields in tool output: placeholder plus range only. Exceptions: §2.6 item 5 (history).
4. Undeclared keys of a declared entity, outside open rows and envelope keys (S5:core/harness/disclosure.ts:99).
5. Signed proposal objects (S5:core/harness/tools.ts:34).
6. Anything on a crisis or workplace-harm turn: the model is not called (S5:core/harness/runner.ts:91-95, :125-126).
7. Private reads on a gated turn: none are offered (S5:core/harness/runner.ts:69-78).
8. The turn trace, the outcome record and the disclosure ledger: local only (S5:core/harness/disclosure.ts:22; S5:core/harness/trace.ts:3-5).
9. Digest, approver recommendation and team-absence summary content: produced without a model (S5:core/digest/daily-digest.ts:10-11; S5:core/recommenders/leave-decision.ts:157; S5:core/mandates/run.ts:107).

---

## 5. Processor decision

### 5.1 Facts about the current route

**Harness, as tested.**
- The harness speaks to a neutral model-client interface; the production adapter over the governed gateway is not built (S5:core/harness/model-client.ts:3-7).
- The real-model probe posts directly to OpenRouter's chat-completions endpoint with `provider: {data_collection: 'deny', zdr: true}`, plus `only: <list>` and `allow_fallbacks: false` when an allowed-provider list is given (S5:test/assistant-model-ceiling.eval.test.ts:89-94).
- The list comes from the environment variable `AIHR_EVAL_ALLOWED_PROVIDERS` (S5:test/assistant-model-ceiling.eval.test.ts:42), set from a workflow input (S5:.github/workflows/alpha-focused-checks.yml:134). If it is empty, no `only` list is sent and OpenRouter may choose any upstream that meets the flags.
- ADR-0169 records that both real-model runs used `openai/gpt-6-luna` via OpenRouter with an Azure upstream, data collection denied and zero retention (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:39). Code does not fix the Azure upstream; it was a run input.

**Product OpenRouter adapter (used by existing approved features).**
- Every request carries `only` and `order` equal to the tenant's configured allowed providers, `allow_fallbacks` (default false), `require_parameters: true`, `data_collection: 'deny'`, `zdr: true` (S5:lib/ai/providers/openrouter-policy.ts:8-30; S5:lib/ai/providers/openrouter-transport.ts:99).
- Before activation, the adapter checks that the model has a zero-data-retention endpoint for an allowed upstream (S5:lib/ai/providers/openrouter.ts:44-55).
- Source comments say routing flags are not evidence of provider compliance (S5:lib/ai/providers/openrouter-policy.ts:4; S5:lib/ai/provider-protocol.ts:3). The threat model says code cannot prove a provider's contractual handling (S5:docs/architecture/ai-threat-model.md:37).

**Production configuration.**
- A tenant chooses one of five providers: Anthropic, OpenAI, Google, OpenRouter or a general OpenAI-compatible gateway at a tenant-chosen https address (S5:lib/ai/registry.ts:8; S5:lib/ai/providers/gateway-options.ts:1-5).
- The active configuration is resolved per tenant from the database (S5:core/ai-config.ts:154-158), with an environment-key fallback to Anthropic, OpenAI or Google when the tenant has none (S5:lib/ai/registry.ts:46-61).
- No region setting exists in the AI configuration code (search of S5:lib/ai and S5:core/ai-config.ts for "region": no hits).
- **Code cannot tell which provider, upstream or region any installation uses.** That needs a query of the target installation, which this package did not do.

### 5.2 Options

**Option A: direct contract with the upstream model provider** (for example the cloud provider hosting the model, in a fixed region).
- Facts: no adapter named for such a provider exists beyond the five above (S5:lib/ai/registry.ts:8). The general gateway accepts an OpenAI-style https endpoint (S5:lib/ai/providers/gateway-options.ts:1-5); whether a given upstream's endpoint and authentication fit it is not verified. One fewer intermediary in the chain.
- For counsel: whether a direct contract changes the cross-border analysis or the sub-processor chain.

**Option B: keep OpenRouter as intermediary.**
- Facts: zero-retention and data-collection-deny flags and an upstream allowlist are already enforced in the product adapter (§5.1). OpenRouter is an additional party that receives the full request. Its own retention, logging and sub-processor terms are not visible in code.
- For counsel: whether OpenRouter is a processor, a sub-processor or something else; whether its terms bind the upstream; whether the "zdr" routing flag is backed contractually.

**Option C: in-boundary model** (no external disclosure).
- Facts: ADR-0170 funds an in-boundary path with a Malaysia residency plan (L:docs/adr/0170-teras-ai-operating-architecture.md:656). No adapter exists. Understanding is unmeasured (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:144).
- Combination: option 2 may be combined with option 3 for the most sensitive domains such as pay and medical leave (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:146).

**Recommendation (engineering default).** Pin the upstream (no empty allowlist), keep `allow_fallbacks: false`, and do not offer the pay reads (payslip, pay change, statutory explainer, module_work for payroll) or third-party reads (who_is_away, team_leave_summary, employee_profile) in the pilot until counsel answers §6 and §7. The processor choice itself is the owner's, after counsel.

---

## 6. DPA checklist for counsel

A checklist only. Engineering needs each term confirmed in writing, for each party in the chain (intermediary and upstream).

- [ ] Zero retention of prompts and completions, including abuse-monitoring logs, and any exceptions.
- [ ] No training, fine-tuning or evaluation use of customer content.
- [ ] Full sub-processor list, with notice and objection rights on changes.
- [ ] Processing and storage region(s); whether region is contractually fixed.
- [ ] Security measures; whether the provider is bound to them directly.
- [ ] Breach notice: time limit, content, contact.
- [ ] Deletion on termination and on request, with confirmation.
- [ ] Audit or assessment rights, and acceptable third-party reports.
- [ ] Role of each party (processor, sub-processor) and who instructs whom.
- [ ] Onward transfer restrictions.
- [ ] Law enforcement or government access requests: notice and challenge.
- [ ] Liability and indemnity for the above.
- [ ] Whether the intermediary's routing flags (`zdr`, `data_collection: deny`) are contractual commitments.
- [ ] Whether terms can bind to a specific model and upstream, so a silent change is a breach.

---

## 7. PDPA cross-border transfer: facts for counsel

**Categories of personal data that would reach the model (Fact, from §2):**
- Identity and employment: names of the person and of colleagues, company, job grade, work state, hire, join and termination dates.
- Leave and absence: leave type names, dates, durations, balances as bands, colleagues' absences.
- Attendance: exact clock times, lateness, early-out and overtime minutes.
- Pay: banded pay and statutory figures; exact pay item names.
- Health-indicative: medical-type leave and claim type names, attached-document flags.
- Possibly religious or other sensitive content: pay item names such as zakat; anything the person types in a question.
- Employee codes via module_work rows (§2.6 item 1).
- Free text typed by the person, including on sensitive-topic turns.

**Data subjects:** the asking employee; colleagues visible to them; direct reports and managers; leave applicants (for approvers); administrators. Third parties are not told (§8).

**Destination countries:** not determinable from code or configuration in source. The OpenRouter endpoint is `openrouter.ai` (S5:lib/ai/providers/openrouter-transport.ts:15). The upstream is per tenant configuration (§5.1). The test runs used an Azure upstream, region not recorded in code (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:39).

**Safeguards in code (Fact):** field classes and handles; banding with local restoration; UUID sweep; fenced untrusted tool output (S5:core/harness/fence.ts:1-14); pre-read gate and fixed replies for crisis and workplace harm; reply checks; per-turn budgets (S5:core/harness/spec.ts:27-40); runner off outside tests; source-bound approval for existing provider contracts (S5:lib/ai/provider-privacy-request.ts:26-31).

**For counsel:**
1. Which PDPA provision and conditions govern this transfer as the Act now stands, and which condition Teras or the employer relies on.
2. Whether Teras is a data processor for the employer (the data user) for this processing, and what that requires of Teras and of its sub-processors.
3. Whether health-indicative leave and claim type names, or pay item names that indicate religion, are sensitive personal data here, and what consent or other basis that needs.
4. Whether colleagues named in another person's question or tool result need notice, and from whom.
5. Whether the employer's existing employee privacy notice covers disclosure to an AI model provider abroad, or needs changes.
6. Whether a transfer impact assessment is needed per destination, and its content.
7. Obligations under Malaysia's AI governance bill once tabled (L:docs/adr/0169-assistant-context-harness-and-disclosure-repivot.md:169).

No conclusion is drawn here.

---

## 8. Outcome records: notice and retention

### 8.1 What the record stores (Fact)

Table `teras_outcome_record` (S5:db/migrations/0890_teras_outcome_record_mandates.sql:129-159): id, tenant, company, run id, run kind, times, authority (who asked or mandate id, version and grantor), agent identity, `reads` (tool names, status, argument digests, record references), `checks` (check, owner, rule version, result), `replay` (model, provider, instruction set, spec version and digest), outcome kind, `outcome` (a flat object), human involvement, `notice`, and `trace` (JSON). Follow-ups (decision, undo, notice with channel) are in `teras_outcome_followup` (:165-185).

- Writer limits: strings up to 120 characters, flat objects, at most 24 keys (S5:core/outcome-record/record.ts:23-30). The `trace` column has no shape limit (S5:core/outcome-record/record.ts:53).
- The harness stores the whole turn trace there (S5:core/harness/trace-persistence.ts:47). The trace holds tenant, user and person ids and roles (S5:core/harness/trace.ts:19), and reply-check findings. Overclaim and link findings contain the matched phrase from the model's reply (S5:core/harness/reply-checks.ts:64-65). So small fragments of model text are stored, although the header says no reply text is kept (S5:core/outcome-record/record.ts:10-11).
- The approver recommendation stores the leave request id and check results about the applicant (S5:core/recommenders/leave-decision.ts:158-159).
- Readers: the person who asked, the grantor, group administrators, and the agent for mandate runs (S5:db/migrations/0890_teras_outcome_record_mandates.sql:304-307).

### 8.2 The `notice` field today (Fact)

Values: `not_applicable`, `given`, `not_given` (S5:core/outcome-record/types.ts:9-11).

| Writer | Default | Source |
| --- | --- | --- |
| Harness turn | `not_applicable` unless the surface passes another value | S5:core/harness/trace-persistence.ts:46 |
| Approver recommendation (about the applicant) | `not_given` | S5:core/recommenders/leave-decision.ts:160 |
| Weekly team absence summary (about team members) | `not_given` | S5:core/mandates/job-types.ts:35-42 |
| Daily digest (own items) | `not_applicable` | S5:core/mandates/job-types.ts:45-46 |
| Stopped mandate run | `not_applicable` | S5:core/mandates/run.ts:111 |

A later notice follow-up can record `given` with a channel (in-app or email) (S5:core/outcome-record/record.ts:84, :93). No notice wording or delivery exists. ADR-0170 reserves notice wording and retention for the privacy reviewer, default `not_given` and audit retention (L:docs/adr/0170-teras-ai-operating-architecture.md:370).

### 8.3 Retention today (Fact)

- Append-only: no UPDATE, DELETE or TRUNCATE for the app role; a trigger refuses UPDATE and DELETE for every role (S5:db/migrations/0890_teras_outcome_record_mandates.sql:121-128, :189-199, :329).
- Kept with the audit trail; any purge would be an explicit owner migration. No retention period and no purge job exist (same lines).
- Erasure relies on the record holding only ids, so native erasure leaves an opaque reference (same lines; S5:core/outcome-record/record.ts:11-13). The trace's model-text fragments (§8.1) are an exception to "only ids".
- Task memory (the person's first question, up to 300 characters) is erased with the transcript, per login (S5:db/migrations/0890_teras_outcome_record_mandates.sql:201-234).

### 8.4 Options for the owner

**Option N1: keep defaults.** Third parties `not_given`; records kept indefinitely with audit.
- For: no new notice channel; full evidence for audits and the rule-8 acceptance metric (L:docs/adr/0170-teras-ai-operating-architecture.md:276).
- Against: applicants and team members are never told an automated assessment about them was made; indefinite retention of trace content.

**Option N2: in-app notice to the affected person for recommendations and team summaries; fixed retention.** Record `given` with channel `in_app`. Keep the record for a fixed period aligned with the employment-record or audit retention the owner sets; drop or minimise the `trace` column after a shorter period.
- For: transparency to the data subject; bounded storage.
- Against: a notice channel and wording to build and translate; a purge path against an append-only table needs a controlled owner job; a shorter trace window weakens replay.

**Option N3: general notice through the employer's privacy notice; short trace retention, longer record retention.** Record `not_given` per run but document the general notice; keep record columns for audit retention; purge `trace` after a short window.
- For: no per-event notices; keeps acceptance evidence.
- Against: whether a general notice is sufficient is a question **for counsel** (§7 item 4).

**Recommendation (engineering default).** Option N2 for the approver recommendation, N3 for team summaries, and in all cases bound the `trace` column (names, versions, counts and kinds only; no matched phrases). Wording and periods are the owner's decision.

---

## 9. Data register and threat model updates (drafts for the owner)

### 9.1 Data register

**Fact.** No standalone data register exists in `docs/`. The threat model points to a "complete data register" as open item R21/WP12 (S5:docs/architecture/ai-threat-model.md:37). The review defines R21 as a per-feature record of fields that leave the tenant, after which redaction (S5:docs/reviews/ai-architecture-review-2026-10.md:240). WP12 lists "a per-feature data register" (S5:docs/reviews/ai-architecture-handoff-2026-10.md:260-272). A code-level display inventory classifies existing workloads (S5:lib/ai/provider-disclosure-inventory.ts:1-10).

**Proposed entry (draft):**

| Item | Draft content |
| --- | --- |
| Feature | Teras harness conversation (ADR-0169 option 2) |
| Status | Not active. Runner off outside tests. |
| Purpose | Answer the signed-in person's HR questions from their authorised records. |
| Data subjects | Asking employee; colleagues, reports, managers, applicants visible to them; administrators. |
| Data sent | The question and history verbatim; system instructions; task-memory goal; tool output per §2 (exact for `full`/`minimum`, ranges for `bands`, nothing for `never`). |
| Not sent | §4. |
| Recipients | Provider chain per §5 decision (intermediary and/or upstream). |
| Destination | To be fixed by the §5 decision; not determinable from code. |
| Retention at provider | Per DPA (§6); requested zero retention. |
| Retention local | Transcript per existing owner; task memory erased with transcript; outcome record per §8 decision. |
| Safeguards | §7 list. |
| Approval binding | Source digest of the approved closure; change needs fresh approval. |

### 9.2 Threat model changes (drafts)

- **R21 (changed).** From "complete data register remains" to "register entry drafted in this package; open until the owner accepts it and counsel answers §6 and §7".
- **New: disclosure contract bypass through open rows.** module_work `data` passes undeclared fields exactly, including employee codes (§2.6 item 1). Control proposed: make module rows closed per module, or class undeclared children `never`. Test: each module's row keys appear in the declared model.
- **New: third-party data in context-tool output.** suggest_action `pending` sends applicant names and leave types outside the contract (§2.6 item 2). Control proposed: declare it as an entity, or return handles and labels without names.
- **New: banded figures re-egress through history.** Restored exact figures in a prior reply are sent on the next turn (§2.6 item 5). Control proposed: store and send the pre-restoration reply as history, or re-band history.
- **New: inbound identifiers.** The identifier denylist checks output only (§3.3). Control proposed: inbound screen.
- **New: health and belief inference.** Leave, claim and pay item names classed `full`/`minimum` can reveal health or religion, including of colleagues (§2.2).
- **New: sensitive-topic question text.** Medical, harassment, grievance and termination-threat questions reach the model (§2.6 item 4). Control proposed: owner decides whether routed turns skip the model.
- **Changed: retention in chat.** Add outcome-record trace content (§8.1).

---

## 10. Decisions for the owner

1. Processor route: direct upstream, OpenRouter, or in-boundary for some domains. Default: decide after counsel; pin one upstream either way.
2. Region: fix one region in contract and configuration. Default: yes, before any pilot.
3. Fix module_work open rows so undeclared fields are not sent. Default: yes, before approval (defect).
4. Bring suggest_action's pending list under the contract. Default: yes, before approval (defect).
5. Send history without restored figures. Default: yes, before approval (defect).
6. Screen identifiers on the way in, not only in replies. Default: yes.
7. Whether medical, harassment, grievance and termination-threat turns may reach the model at all. Default: no model call; route only.
8. Third-party reads (who_is_away, team_leave_summary, employee_profile, my_reporting_line names) in the pilot. Default: exclude until counsel answers §7.
9. Pay reads in the pilot (payslip, pay change, statutory explainer, payroll module work). Default: exclude until counsel answers §7; if included, accept banding granularity (D-BAND).
10. Health-indicative leave and claim type names, and pay item names: keep `full`/`minimum`, or band to a generic label. Default: generic label for sensitive types.
11. Treat `minimum` as exact (as today), or implement "only when the question needs it". Default: rename to reflect exact disclosure and review each `minimum` field.
12. Notice for the approver recommendation and team summary. Default: in-app notice (N2) for recommendations.
13. Outcome record retention period, and trace minimisation. Default: bounded period; trace holds kinds only, no phrases.
14. Accept the data register entry and the threat model changes in §9. Default: accept after items 3 to 6 are fixed.
15. Engage counsel on §6 and §7 before approval. Default: yes, as ADR-0169 recommends.

---

### Bundled with this review (owner decision, 2 November 2026)

- **Module-agent digest change for worker switches.** The AI centre's Workers page (the step 5 UI follow-up, stacked on PR 191) shows two workers read-only: the approver recommendation and the explainers. To make them switchable from that page, one server action must be added together with its entry in `lib/ai/agent-capability-inventory.ts`, and `MODULE_AGENT_SOURCE_DIGEST` regenerated. Those files are inside the approved module-agent digest. **Decided by the owner, 2 November 2026:** approved ("They should be able to do it from that page"). This covers exactly one action and its inventory entry. The action is limited to the tenant's group administrator, and every change is written to the audit log and an outcome record. Both workers stay off by default. This approval is separate from, and does not imply, the ADR-0169 disclosure approval. **Implementation (2 November):** the inventory file is also inside the provider-data digest, so a new action would have moved that digest too. The switch is instead added as a closed two-worker branch of the existing, already-classified `setAiFeatureAction`. Neither digest moves, so no approval record is rebound; this is verified by both `--check` commands.

## 11. Unverified

- Which AI provider, model, upstream and region any real installation (staging or production) has active. Not queried.
- Whether OpenRouter or the upstream honours `zdr` and `data_collection: deny`; their contracts and sub-processors.
- The region of the Azure upstream used in the probe runs.
- The exact content of setup_readiness, approval_queue and company_setup output, field by field.
- What every module other than employees and org puts in module_work rows; whether a test already catches the employee code case.
- How production wiring will build conversation history (§2.6 item 5 depends on it).
- Whether `blockers[].subject` in the setup co-pilot is ever a person's name.
- The current text of the PDPA and of any Malaysian AI governance bill. Counsel to confirm.
- Whether the employer privacy notices in use mention AI providers.
- No tests, builds or database queries were run for this package; every fact is from reading source at the cited commits.
