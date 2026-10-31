# ADR-0116: Central AI inventory and allowances

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Status: accepted. Local acceptance and experience verified on 2026-10-15; release checks remain separately required.

## Request and graph

Administrators need one place to find, monitor and control every AI capability and agent, and set
user and company limits. The owner selected daily requests and monthly tokens. The existing HR
engine remains authoritative for permissions, modules, data, approval and consequential decisions.

Nodes: tenant, login, company, capability, provider configuration, policy and model call. A call
belongs to one tenant, its calling login when present, one capability and its authorized companies.
A company/user policy adds an allowance; it never grants access. Existing feature switches retain
one owner in tenant settings. Platform improvement planning is visible but platform managed.

## Decisions

Use the existing `/control-tower/agents` route for the full inventory, effective readiness, current
month usage, company/user controls, recent call history and the existing orchestration queue.
Provider credentials remain in their existing settings page, linked from the inventory. The gateway
attaches an opaque server-only authorization capability to resolved configurations. All production
model callers name their inventory feature. No prompt, response, image, tool payload or credential
is persisted in the usage ledger.

A short tenant advisory lock serializes admission and settlement. Admission commits a pending
reservation before transport starts. Daily requests count model calls, including failures that
reached the gateway; blocked requests do not consume capacity. Each assistant exchange counts
separately. Monthly usage includes input, cached input and output. Provider-reported usage replaces
the reservation; absent usage, failed settlement or process interruption retains the reservation.
No database transaction spans the new governance layer's provider call. Governed calls disable
hidden SDK retries: a retry must pass a new admission and consume another request.

Reservations are estimates, not exact provider billing guarantees. A finishing call can exceed a
monthly allowance; subsequent admissions stop when recorded and held capacity exhaust it. This
limitation must be visible. Do not label estimated tokens as recorded usage or silently expire held
reservations. Periods use Malaysia midnight/month boundaries and calls belong to their start period.

A shared call counts against every company in the calling principal's authorized scope. A group
administrator or tenant-wide scheduled agent therefore charges every company. This is deliberately
conservative until callers can reliably supply narrower, authorized source attribution. The screen
must explain this; it must not imply precise single-company source attribution. User and company
caps apply cumulatively. Changing policies preserves counters and run history. No default caps are
invented for existing customers. Existing Assistant and Performance business quotas still apply. The older Assistant question/month
budget retains its existing UTC schedule (08:00 Malaysia time), explicitly labelled beside its
allowance; this increment does not rebucket that historical ledger. Operational credential/model
checks remain outside workload quotas; these counters are not a provider invoice reconciliation.

Group administrators manage shared features, user allowances and the existing per-user Assistant
grant from this screen. Grant/revoke reuses the canonical grant service and its history; an allowance
never grants feature access. Assistant control refusals have a distinct translated message rather than
being described as provider failure. Company administrators can edit
only their own company allowances. Database RLS enforces scope and rejects out-of-tenant targets.
Company monitors expose scoped aggregates without other companies, identities or detailed call
rows. Detailed tenant run history is group-admin-only. Existing approvals and manual workflows
remain available; pausing an AI model cannot approve, reject or change an HR fact.

The deterministic central orchestrator reuses its existing evidence, refresh control and approvals
queue. It does not spend model tokens. Unattended agents retain canonical feature switches, including
the template fallback for readiness reminders. Current switches are rechecked on admission.

## Acceptance and evidence required

| Outcome | Scope / role | Verification |
|---|---|---|
| Complete discoverable inventory | All existing model call sites, three agents, central orchestrator, platform tooling | Closed catalogue/caller drift guard and rendered inventory |
| Effective status and canonical switches | Group admin; company read only for shared features | Save/reopen, missing provider/module, paused admission, existing controls regression |
| Daily and monthly limits | Company and login, both cumulative | Database integration: concurrent admission, boundary periods, zero/blank, updates preserve usage |
| Canonical Assistant access | Group admin; ordinary user | Grant/revoke/save/reopen, retained history, typed allowance refusal before transport |
| Durable accounting | Draft, conversation, image, success/failure/interruption | Gateway transport refusal, actual usage settlement, retained reservations, metadata-only history |
| Scoped controls/monitoring | Group admin, company admin, employee, other tenant | Non-vacuous service and app-role RLS tests; scoped aggregates; forbidden writes and history |
| Usable single page | Six locales, desktop/mobile, empty/populated/error | Actual app journey including save, reload, search, pause and logs; visual review |
| Existing behaviour preserved | Assistant, Performance, agent/proposal consumers | Focused consumer checks, required impact gate, production build and migration rehearsal |

Verification is incomplete until each row has direct evidence. The release gate remains separate
from acceptance. Historical model usage is not reconstructed. Exact provider invoices, retrospective
attribution, a new model scheduler and new autonomous HR decision powers are outside this increment.

## Acceptance observation, 2026-10-15

The local app journey demonstrated the inventory, canonical Assistant grant, company/user allowance
persistence, pre-transport quota and pause refusals, scoped company edits, forged-target refusal,
employee access refusal, orchestrator refresh, search, and populated/empty/error/provider-missing
states. All six locales rendered at 1440, 1024, 768 and 390 pixels without document overflow or
application runtime errors. Desktop and mobile screens were visually reviewed, including Tamil
allowance labels and the section navigation. Fixtures ran twice and exited cleanly.

Focused checks cover the AI management service and database policies, all three provider adapters,
the gateway, existing configuration, Assistant access, Performance and downstream agent/proposal
consumers. The expanded run had one incorrectly licensed readiness fixture; correcting that fixture
produced a passing 16-case management run, with the other fourteen consumer files already passing.
Actual external provider connectivity was intentionally untested: the local journey used fictional
data and denied model network calls, proving control refusals before transport. These observations
do not substitute for the final candidate's gate, production build or live-schema migration rehearsal.

## Amendment, 2026-10-19: default user allowance, usage against limits, attention

Decision. A tenant may hold one DEFAULT per-user allowance (`ai_control_policy` kind `user_default`,
scope key `user_default`, no subject; migration 0568): daily requests, monthly tokens and allowed/paused.
It governs every login that has no individual user policy. An individual user policy REPLACES the default
for that login; the two never stack, so an individual allowance may be looser or stricter than the default.
Calls without a login (scheduled agents, `uid` NULL) are never governed by it. Company caps still apply
cumulatively beside whichever user rule applies. Only group administrators may write the default; the 0541
write policy already admits non-company rows only for `app.is_group_admin()`. Every login may read the
default, as it may read its own individual policy. No default value is shipped: a tenant without the row
has no user cap, exactly as before.

`app.ai_admit` keeps its signature, result columns and refusal reasons; only its policy selection changed
(the default joins the policy loop when the caller has a login and no individual policy, counting that
login's own runs). Callers, including future orchestration agents, need no change.

"Use default" removes a login's individual policy row. The application role gains DELETE on
`ai_control_policy`; a BEFORE DELETE guard takes the admission lock and refuses to remove anything but an
individual user row, so feature, company and default rows still change only by update. The removed values
are kept in the `ai-control.allowance-cleared` event; run history is untouched. A login that follows the
default is shown with the default's values prefilled, so saving its row creates an individual copy rather
than an accidental "no cap" exemption.

Monitoring. Every company and user row shows usage against its effective limit: requests today and tokens
this month, where tokens are recorded plus held reservations, i.e. exactly what admission counts. "Near
limit" starts at 80% and "At limit" at 100% (a zero cap is at its limit). A "Needs attention" section lists
companies and logins near or at a cap with usage, companies and logins paused by a configured zero request,
token or concurrency cap (listed even before any attempt; amended 28 October 2026, previously excluded),
and logins with calls blocked today (Malaysia day).
Company administrators see only their own companies there and no login identities. The user list is ordered
by this month's counted tokens, highest first, computed over every matching login, so heavy users are not
hidden behind an alphabetical first page. Group administrators can filter recent runs to blocked or failed
calls and by capability. The unused per-agent switch action was removed; feature switches remain the single
writer for the agents' canonical settings.

## October 2026 review amendment — Assistant question quota (WP5)

The prepared WP5 change replaces the additional Assistant budget's UTC rollover with Malaysia
business days and question-start months. The HR date owner verifies the period returned by the
database's clock; a caller-supplied deadline cannot move the quota day. Historical usage totals keep
their original period because an aggregate has no evidence for rebucketing individual questions.
The earlier UTC description above records the previous behavior, rather than the new rule.

A question intent reserves its daily place before provider work. The tenant's existing AI-control
transaction lock serializes quota checks with the actual model-run admission. Existing model-run
actual tokens, or reserved estimates where usage is unknown, remain the provider exposure owner.
Question metadata links final exchange accounting to those runs; it stores no question, record,
prompt or model answer, grants no HR authority and cannot be reset by clearing chat content.
The exchange and usage increment reconcile that metadata in the same transaction, including the
born-retired fallback after erasure. Unknown provider usage remains held rather than becoming zero.

These are prepared source requirements, not a claim of migration or staging acceptance. See the
[WP5 verification record](../reviews/ai-architecture-wp5-verification-2026-10.md) for exact checks and
remaining evidence. The coordinated SQL and populated-upgrade rehearsal remain prerequisites.

## October 2026 review amendment — one switch owner per AI feature (WP6)

Every AI feature has exactly one switch. A feature with a catalogued setting (`lib/ai/features.ts`
`setting`) is switched by that setting alone; a settingless feature by its `feature:` policy row.
Migration 0692 moves the setting-to-feature map that SQL admission reads into the read-only reference
table `app.ai_feature_setting`, seeded from `AI_FEATURES` (now including `feedback_planning`, which the
earlier SQL copy omitted); a parity test keeps the two in step. The policy guard refuses a `feature:`
row for a setting-backed feature by name. A row stored before that guard existed is ignored by the
pause check and by admission, and the management page marks it as an ignored stale override rather
than letting it act as a hidden off-switch. The setting read in SQL applies the same provenance rule
as the application's entitlement snapshot.

Owner decision 3 (29 October 2026): the six Performance AI switches default OFF, at install too. There
is no backfill. A tenant with a stored value keeps it; one without now resolves OFF after deploy.

The OneHR per-field limit (five successful drafts per person, field and Malaysia day) stays a
Performance business quota beside the central allowances; both apply. It is not an `ai_admit`
allowance because it counts different things: only adjudicated, saved drafts (failed, refused or
superseded calls are not charged), keyed by a field that can span two Performance features, and
idempotent by request. `ai_admit` counts every admitted provider call per feature, login, company or
group. Folding it in would charge people for provider failures and needs a field dimension the
central ledger does not have; that is a separate owner decision.

These are prepared source requirements, not a claim of migration or staging acceptance. A
populated-baseline migration rehearsal of 0692 remains a prerequisite.

## Provider and model change gate — WP14, 29 Oct 2026

Review recommendation R19 treats a provider or model change as a release (migration 0694).

- **Pending, then baseline, then activate.** Saving a direct provider (Anthropic, OpenAI, Google, AI gateway)
  stores a pending change; the gateway never reads it and the active configuration keeps serving. The OpenRouter
  candidate was already pending. A current group administrator runs the fixed baseline holdout suites against
  the pending configuration from AI management › Provider: the read-plan holdouts and the human-question
  holdouts with the checked-in baseline prompt, adjudicated deterministically. Activation is refused until a
  run of that exact version (a re-save mints a new version) has passed. OpenRouter promotion also needs its
  existing evaluation receipt. The run state is derived by the database from per-suite counts, never posted.
- **Accept with reason.** A group administrator may accept a failed or unfinished run of the current version
  with a recorded reason (10–1000 characters). The acceptance is kept on the run, audited as
  `ai-control.provider-baseline-accepted`, and admits activation of that version only.
- **Whose spend.** Baseline requests are the administrator's own: feature `provider_evaluation` under that
  administrator's ordinary allowances, with the run row as the spend root. The scheduled agent principal never
  runs them and gets no model spend (owner decision 2, 29 Oct 2026).
- **Existing and platform configurations.** The live row records the run that admitted it; any later in-place
  change clears it. AI management flags an active configuration without such a run (including every
  configuration activated before 0694), and the platform default (environment key and `AI_DRAFT_MODEL`,
  fingerprinted by provider and model) while a tenant uses it, as "baseline not re-evaluated for this model".
  The flag never stops a configuration from serving.
- **Per-feature caps.** A feature row may now hold daily-request, monthly-token and concurrency caps, which
  `ai_admit` already applies to every run of that feature in the tenant, on top of all other allowances. Only
  group administrators set them, and only for features without a module setting. Setting-backed features
  (scheduled agents, Performance AI) cannot carry a cap, because WP6 gives each of them a single switch owner;
  extending caps to them is a follow-up if needed.
- **Not yet covered.** The tool-calling Assistant conversation holdout suite is not part of the baseline gate.
