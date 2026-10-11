# ADR-0034 — Notification engine (multi-channel, event-derived)

- **Status:** Accepted. The event-derived in-app engine is live. Workflow email and per-employment consent use the managed SMTP service as specified in §7; activation still requires the private-service upgrade, active relay and verified internal authentication. Additional time-based producers, WhatsApp and push remain deferred. The runtime master gate is the tenant's `notifications` module entitlement.
- **Date:** 2026-06-22 (34-2b: 2026-06-24)
- **Builds on:** ADR-0006 (domain-event substrate — the spine notifications derive from), ADR-0033 (TOIL — the first concrete consumer), the existing topbar bell (`core/approvals-inbox.ts` + `components/notification-bell.tsx`)
- **Pull-through from:** ADR-0033 §33-7 ("TOIL → notifications"). Also the broadest of the deferred *platform engines* — it pays off across every module, not just TOIL.

## 1. Original context (2026-06-22)

The only "notification" today is the topbar **bell**: `pendingApprovalsCount()` computes, on demand, how many items await the current user's action (pending leave / corrections / profile-changes / claims) and renders a badge linking to `/approvals`. There is **no persistence** (no "mark read", no history), **no delivery** (nothing leaves the browser), and **no per-user control**.

That's a real gap for the deskless anchor: 4,500 shift workers don't sit at a browser. **In Malaysia the realistic reach order is WhatsApp ≫ email ≫ in-app.** And several things people should be told about aren't approvals at all — "your manager banked a day in lieu" (`toil.accrued`), "your in-lieu day expires in 7 days", "your leave was approved", "your payslip is ready".

Every one of those moments already produces (or could produce) a **`DomainEvent`** — the substrate the whole system is built on. So notifications should be a **projection of the event log**, not a new thing each module has to remember to call.

## 2. Decision

Build an **event-derived, multi-channel notification engine**: a sweep reads new domain events, a single **registry** maps event types → (recipients, rendered message, channels), and notifications are persisted per recipient and delivered through pluggable channel adapters. Gated by `NOTIFICATIONS_ENABLED` — when off, the bell falls back to today's computed count (byte-identical).

### 2.1 Data model
- **`notification`** — one row per (recipient, notification): `recipientEmploymentId`, `kind` (e.g. `toil.accrued`, `leave.approved`, `approval.pending`), `title`, `body`, `linkPath` (deep link into the app), `severity` (`info` | `action` | `warning`), `sourceEventId` (FK `domain_event`, nullable for scheduled scans), `readAt`, `createdAt`. **RLS: recipient-only** (a user sees only their own; admins do not get a god view of others' notifications).
- **`notification_pref`** — per (recipient, category, channel) on/off, with sensible defaults (in-app on; email/WhatsApp opt-in or category-gated). Absent row = default.
- **`notification_delivery`** — per (notification, out-of-app channel): `channel` (`email` | `whatsapp` | `push`), `status` (`pending` | `sent` | `failed` | `skipped`), `attempts`, `lastError`, `sentAt`. In-app needs no row (the `notification` row *is* the in-app delivery).
- **`notification_cursor`** — per tenant, the `(last_event_created_at, last_event_id)` the dispatcher has processed. The event log stays **append-only** (ADR-0006) — no mutable "notified" column on `domain_event`.

### 2.2 The registry (single mapping, decoupled from modules)
`core/notifications/registry.ts`: `eventType → { recipients(event, tx): employmentId[], render(event): {kind,title,body,linkPath,severity}, channels: Channel[] }`. Recipients are resolved from the event's `subjectEmploymentId` + the org graph (manager-of) + the actor. Examples:
- `leave.requested` → the approver(s); `leave.approved`/`leave.rejected` → the requester.
- `toil.accrued` → the subject ("N day(s) banked in lieu"); `toil.converted`/`toil.lapsed` → the subject.
- `approval.*` generic → the decider. (The existing approvals-inbox logic becomes one producer, so the bell keeps showing approvals.)
Unmapped event types produce nothing — most events never notify.

### 2.3 Dispatch — an outbox sweep (no queue infra)
ai-hr is Next + Postgres (no BullMQ/Redis), so dispatch is a **sweep**, like `runToilExpiry` / `openLeaveYear`: `dispatchNotifications(ctx)` reads `domain_event` rows after the cursor (ordered by `created_at,id`), applies the registry, inserts `notification` rows + `notification_delivery` rows per recipient prefs, advances the cursor; then runs **scheduled-scan producers** (time-based, not event-based: TOIL *expiring in N days*, contract/probation/document expiry) idempotently. Triggered by a cron (systemd timer / the scheduled-tasks mechanism) and opportunistically on bell-load for low perceived latency.

> **Why a sweep, not inline fan-out in `appendEvent`:** keeping `appendEvent` pure avoids inverting the layering (the substrate helper would otherwise depend on the org graph + channel config). The registry stays the single place that knows "event → who hears about it". Latency is the sweep interval (seconds–a minute), fine for notifications; the opportunistic bell-load trigger hides it.

> **Substrate note:** a notification is a *derived projection* with its own table acting as its audit — per CLAUDE.md it does **not** itself append a `DomainEvent` (that would be an event storm and a derivation loop). Documented skip.

### 2.4 Channels (pluggable adapters)
`NotificationChannel.send(notification, contact) → DeliveryResult`:
- **in-app** — ships. The `notification` row; the bell reads unread + a dropdown (mark-read, deep links).
- **email** — adapter interface defined; impl behind `NOTIFY_EMAIL_ENABLED` + provider config (Resend or SMTP). Contact = `person.primaryEmail` (present). Deferred until a provider is chosen.
- **whatsapp** — MY deskless priority, but **BLOCKED on client onboarding**: needs the customer's WhatsApp Business account (WABA) + a phone number + **pre-approved message templates** (Meta requires templates for business-initiated messages) + a provider (Meta Cloud API or Twilio). Contact = `person.phone` (nullable → must be captured + E.164-normalised). Adapter interface ships; live impl deferred like the bank files — won't guess credentials/templates.
- **push** — future (needs the mobile app, Phase 6).

### 2.5 Privacy boundary (PDPA — ADR-0030)
Notifications carry PII (names, leave/pay facts). In-app is recipient-RLS-scoped. **Out-of-app channels send PII to external services** (email/WhatsApp providers), so: content **minimisation** (the WhatsApp/email body says "Your leave request was approved — open the app", not the medical/pay detail; the app is the source of truth behind the gate), explicit **consent** via `notification_pref` (opt-in for external channels), and the provider is a data processor (DPA needed before WhatsApp goes live). Crypto-shred (ADR-0030) already covers the `domain_event` source; `notification` rows are redacted/removed when a subject is erased.

## 3. Current gating

The per-tenant `notifications` module entitlement gates projection and the email sweep. Workflow email
additionally requires a group-enabled category, explicit per-employment recipient consent, an exact
verified internal identity and the active managed SMTP relay (§7). The earlier environment flags below
are historical design, not current runtime controls. WhatsApp and push have no live adapter.

## 4. Slice plan
- **34-1** — schema (`notification` + `notification_pref` + `notification_delivery` + `notification_cursor`) + RLS (recipient-only) + migration. Gated, additive.
- **34-2** — registry + `dispatchNotifications` sweep (in-app only) + **bell upgrade** (read `notification`, unread badge, dropdown with mark-read + deep links; falls back to the computed count when off). First producers: TOIL (`toil.accrued`/`converted`/`lapsed`), leave (`leave-request.approved`/`rejected`).
- **34-2b** *(2026-06-24)* — the rest of the "your request was actioned" decisions, each already carrying the requester as `subjectEmploymentId` so they slot straight into the subject-routed dispatch: `resignation.accepted`/`rejected` (ADR-0042), `claim-request.approved`/`rejected`, `profile-change.approved`/`rejected`. Plus the **payslip-ready fan-out**: `payroll-batch.closed` has no single subject, so a registry `recipients(tx, ev)` resolver enumerates the batch's payslips and produces one `payslip.ready` notification per employee (the dispatch loop now supports fan-out specs; recipient defaults to `subjectEmploymentId` when none). Notification titles/bodies stay English strings stored at dispatch time (localized rendering is 34-3 work). Still gated; the per-tenant cursor keeps the fan-out idempotent.
- **34-3** — `/me` notification prefs UI (category × channel) + i18n ×6.
- **34-4** — scheduled-scan producers (TOIL *expiring soon*, contract/probation/document expiry) + the delivery sweep skeleton (statuses, retry) + a cron/admin "run now".
- **34-5** — email adapter (behind `NOTIFY_EMAIL_ENABLED` + chosen provider).
- **34-6** — WhatsApp adapter interface + template scaffolding (behind `NOTIFY_WHATSAPP_ENABLED`; live send **blocked** on client WABA + approved templates + `person.phone` capture).

## 5. Consequences
- **Positive:** one engine serves every module (force-multiplier); decoupled (modules just append events, as they already do); immediate in-app value + a clear path to WhatsApp where the deskless workforce actually is; reuses the event substrate end-to-end.
- **Negative / risks:** the sweep adds a moving part (cron) and an ordering cursor; recipient-resolution must be careful not to leak (RLS recipient-only is the backstop); external channels need a PDPA DPA + content minimisation before going live; WhatsApp is onboarding-blocked (don't let the engine's value hinge on it — in-app + email stand alone).
- **Reversible:** flag-gated; off ⇒ byte-identical; all tables additive.

## 6. Open questions (for when channels go live)
- **Email provider:** Resend (simple API) vs SMTP relay (no vendor) — decide at 34-5.
- **WhatsApp provider:** Meta WhatsApp Cloud API (direct, cheaper) vs Twilio (easier, dearer) — decide when the customer provides the WABA; both need the same template-approval step.
- **Recipient identity with concurrent employment:** notifications target `employmentId`; the bell shows the session person's employments' notifications. Confirm the grouping when a person holds multiple active employments.


## 7. Workflow email through the managed SMTP relay (2026-10-12)

The owner selected a **brief alert with a link to the app**. Workflow email consumes the existing
notification registry and the installation-managed SMTP relay (ADR-0100); it never stores a second
SMTP configuration or copies HR detail into a message. USER, PERSON and EMPLOYMENT remain separate.

### Ownership and authorization

- The event registry owns category, recipient employment, severity and relative deep link. A minute
  sweep and opportunistic rendering share a tenant advisory lock when advancing the projection cursor.
- A group administrator controls email categories for the tenant. Categories are off by default.
  `notification_email_policy` records that decision and its event-sequence watermark. It is distinct
  from the recipient's existing `notification_pref`, which owns explicit consent per employment and
  category. An absent or historical preference without recorded consent is off. Saving an already-on
  switch preserves its watermark; re-enabling starts with future events only.
- The person opts in while signed in through the exact, verified internal identity. The kernel checks
  the identity binding and employment ownership, rather than adopting an account by email. Demo and
  legacy sessions cannot grant consent for external mail. Turning a preference off remains possible.
- Both controls must permit the new event. A pending delivery records the exact app-user target and
  source event, with a uniqueness rule that coalesces the same event/kind for concurrent employments
  belonging to one account. It contains no copied email address, HR body or SMTP credential.
- Before delivery the worker resolves the registry's recipients again. The private service also
  rechecks the current identity binding, employment, policy and consent. It reads the current person's
  primary email and confirms that the exact enabled Keycloak account still has that verified address.
  The atomic start compares the entire verified target snapshot, so an address, identity or link changed
  while the provider is being checked cannot be sent using stale recipient data.
  A changed, missing, disabled or revoked account is skipped, never found or linked by matching email.

### Transport and failure model

The existing root-installed Unix-socket service owns SMTP credentials. The web process submits only a
persisted delivery ID and a short-lived random lease token; it cannot provide an arbitrary recipient,
message, sender, SMTP endpoint or application origin. The service receives EXECUTE on narrow private
SQL functions, without HR table access or USAGE on the shared `app` schema. A root-reviewed upgrade is
required to install the new service bundle. Application deployment alone does not upgrade it.

The service uses the active, tested managed relay with implicit TLS and certificate verification.
Messages contain a category alert, an authenticated application link built from the deployment-owned
HTTPS origin, and no frozen notification title/body, employee name, amount or decision reason.
Translations follow the recipient's saved email language, independently of the event's English text.

A durable lease separates authorization from transport. The service marks the attempt started before
SMTP. Explicit temporary SMTP rejection may retry with bounded backoff (five attempts maximum).
Unknown acknowledgements and abandoned started attempts become **uncertain** and are not automatically
retried: SMTP does not offer exactly-once delivery. A group administrator can explicitly retry after
acknowledging possible duplicate mail; eligibility is checked again. `sent` means accepted by the relay,
not received or read by a human. Pre-send unavailability leaves the pending job for a later sweep.

### Scope and activation

The existing registry covers attendance, claims, delegation, leave, notices, offboarding, payroll,
performance, profile changes, readiness, employment reviews, rewards and TOIL. It is the authority for
which events notify; a category switch does not invent notifications for every operation in a module.
WhatsApp and push remain deferred. The notification module entitlement and tenant standing continue to
apply. A configured category, a user's consent and an active relay are all required; no backlog is
emailed merely because a switch was turned on. The delivery log reports sanitized outcome codes.
Internal-auth cutover, owner MFA, relay activation and a real human receipt remain separate operator
steps; this feature must not claim those were completed by shipping code.
