# ADR0126 — Personal Home policy, sharing and recorded projections

Status: source implementation; SQL/types/runtime and actual acceptance remain unverified.

Home is the personal landing; the previous administrative dashboard is retained at the explicit
Administrative workspace link. Each card loads independently against fresh actual session, entitlement,
company selection and salary-free live own employment. Multiple employments require selection.
Clock reads, submissions, receipts and removal carry that selection and revalidate it at the owner.
Attendance, Leave, Payroll, Performance, tasks and notices keep their existing calculation/workflow truth.

Only missing Home facts are stored: immutable company-policy versions, own opt-in sharing/calendar-week
preference, version-bound WFH requests/decisions, explicitly sent greetings, and private source-key insight
dismissals. No policy/consent means disabled/private. WFH approval uses the existing canonical eligible
manager identity reader or actual company administration; own approval is refused. A policy change makes
an old pending decision stale. Overlap is serialized per employment, each date requires strict dated
company proof, and effective arrangements cannot be cancelled retrospectively. WFH never alters a clock,
geofence, photo policy, Leave debit or Payroll amount. All mutations append canonical domain events.

The social audience is explicitly same-company, current same-department peers. Minimal dedicated SQL
projections expose only consented work status, upcoming per-date team entries, birthday month/day moments
and work-anniversary moments. They never return full DOB, reasons, contact, bank, pay or Performance.
Team leave uses recorded per-date decisions; unrecoverable legacy availability remains Unknown. An office
claim requires recorded open Attendance plus an enforced assigned-location capture. Absence of a punch
never means office. Current consent does not expose private historical team calendars.

Greeting preview/edit/explicit send is separate from suggestions. The server rechecks the exact recipient,
moment, policy and sharing; person/employment/sharing/policy locks refuse contention without a lock wait.
Only the recipient's Home inbox receives the saved greeting; no automatic mail or social message is sent.
The sender's request ID binds exact content and recipient for retries. Sender-held UI values confer no
recipient authority. Actual Linux/provider/transport acceptance is irrelevant to this in-app greeting.

The existing Notice owner gains optional pinned/category/acknowledgement configuration. Opening remains
a view marker. Explicit acknowledgement keeps immutable actual login/employment/time and exact content
snapshot/digest, under notice/audience locks. Edited content requires a new acknowledgement, while earlier
evidence remains. Canonical erasePersonPii may redact exact-person greeting text and acknowledgement
text once; digest, recipient/sender IDs, actual actor and original time remain immutable. No extra
statutory hold is invented for these free-text copies. A bounded SECURITY DEFINER helper proves actual
live administrator plus exact subject-company authority; runtime app roles have no table UPDATE.
Restricted migration-owner-only RLS policies allow the narrow redaction even under FORCE RLS.
Other metadata mutations, restoration and identity retargeting remain forbidden. Existing repeating-until-acknowledged notices get the missing acknowledgement policy;
no receipt is manufactured. No second notice, mail or acknowledgement-as-contract mechanism is introduced.

Known limits stay visible: no confirmed employee-readable future payday owner or effort-estimate owner
was found; neither is guessed from a batch date, default pay day or number of tasks. Current calendar
records are not fabricated historical configuration snapshots. Missing dated membership is withheld with
an incomplete-data explanation. New Home/WFH/privacy/notice DB and DOM tests are written, not executed.
Parent owns ordered migration0555 journal union, actual provider/role/visual/mobile/physical acceptance,
types, database/security/concurrency checks, impact gate, build and release.

Own company inclusion reuses Profile's canonical verified-login/hired/blacklist/earliest-end-inclusive
predicate. Group-admin and explicit grant branches are unchanged. The company picker remains UX
narrowing, never downstream retrieval authority. An explicit /leave?employmentId entry validates the
live own subject and selected company and binds ordinary requests, summaries, Leave Credit facts,
claim review and submission to that subject. No-query HR inquiry landing remains unchanged.

Prerequisite source union: Profile de47e2a supplies salary-free subject readers and canonical eligibility;
Credit16db5a440 plus orphanfix2c6b35149 supplies actual-login/null-employment Feedback + explicit Tx.
No fake employment or alternate Feedback writer is introduced. Journal entries are parent-owned.
