# ADR-0034 — Notification engine (multi-channel, event-derived)

- **Status:** Proposed (design only — no code; gated `NOTIFICATIONS_ENABLED`, off by default)
- **Date:** 2026-06-22
- **Builds on:** ADR-0006 (domain-event substrate — the spine notifications derive from), ADR-0033 (TOIL — the first concrete consumer), the existing topbar bell (`core/approvals-inbox.ts` + `components/notification-bell.tsx`)
- **Pull-through from:** ADR-0033 §33-7 ("TOIL → notifications"). Also the broadest of the deferred *platform engines* — it pays off across every module, not just TOIL.

## 1. Context

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

## 3. Gating
- `NOTIFICATIONS_ENABLED` (master) — off ⇒ no tables read, bell = today's computed approvals count (byte-identical).
- `NOTIFY_EMAIL_ENABLED`, `NOTIFY_WHATSAPP_ENABLED` (per-channel) — off by default; require provider config/credentials.

## 4. Slice plan
- **34-1** — schema (`notification` + `notification_pref` + `notification_delivery` + `notification_cursor`) + RLS (recipient-only) + migration. Gated, additive.
- **34-2** — registry + `dispatchNotifications` sweep (in-app only) + **bell upgrade** (read `notification`, unread badge, dropdown with mark-read + deep links; falls back to the computed count when off). First producers: TOIL (`toil.accrued`/`converted`/`lapsed`), leave (`leave.approved`/`rejected`/`requested`), approvals.
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
