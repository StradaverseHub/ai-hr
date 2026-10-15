# ADR-0116: Central AI inventory and allowances

Status: proposed; requires execution and experience verification before release.

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
No database transaction spans the new governance layer's provider call.

Reservations are estimates, not exact provider billing guarantees. A finishing call can exceed a
monthly allowance; subsequent admissions stop when recorded and held capacity exhaust it. This
limitation must be visible. Do not label estimated tokens as recorded usage or silently expire held
reservations. Periods use Malaysia midnight/month boundaries and calls belong to their start period.

A shared call counts against every company in the calling principal's authorized scope. A group
administrator or tenant-wide scheduled agent therefore charges every company. This is deliberately
conservative until callers can reliably supply narrower, authorized source attribution. The screen
must explain this; it must not imply precise single-company source attribution. User and company
caps apply cumulatively. Changing policies preserves counters and run history. No default caps are
invented for existing customers. Existing Assistant and Performance business quotas still apply.

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
