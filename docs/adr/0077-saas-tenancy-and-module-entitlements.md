# ADR-0077 — SaaS tenancy, module entitlements, and the Stradaverse control plane

- **Status:** Proposed (architecture + build plan — no code written yet)
- **Date:** 2026-07-20
- **Relates to:** ADR-0072 (WorkOS auth / `app.principal`), the RLS substrate (migration 0002 onward),
  ADR-0020 (statutory pack distribution), ADR-0075 (verification gates — see §8 risk)

## 1. The ask

Sell and operate the HR system the way Odoo sells apps: a customer takes the modules they need, modules are
activated per customer rather than per deployment, and Stradaverse can see across customers to run the
business — who is subscribed, how many users, what is active.

Three distinct questions sit inside that, and they have different answers:

| Question | Answer |
| --- | --- |
| Is the **isolation** model ready for multi-tenant SaaS? | **Yes** — genuinely, and it is the expensive part |
| Is the **commercial** model ready? | **No** — it does not exist at all |
| Is there a Stradaverse control plane? | **No**, and RLS currently makes one impossible by design |

## 2. Current state — audited, not assumed

### What is already right

- **Every business table carries `tenant_id`,** and RLS policies key off `app.tenant_id`.
- **`withTenant()` sets the tenant per transaction** via `set_config('app.tenant_id', …, true)` — i.e.
  `SET LOCAL`, cleared at COMMIT, so a leaked connection cannot carry tenant state to the next request
  (`db/client.ts:52-56`).
- **The application role cannot escape RLS:** `ai_hr_app` has `rolbypassrls = false`. Isolation is enforced
  by Postgres, not by developer discipline.
- **Tenant already resolves from identity:** WorkOS subject → `app.principal_by_subject()` → `tenant_id`
  (`lib/session.ts`). A second tenant needs no auth work.
- **`tenant.workos_org_id`** already maps a customer to a WorkOS organization.

This is a real multi-tenant foundation. Nothing below requires reworking it.

### What is missing

1. **Feature gates are deployment-wide, not per-tenant.** All nine are environment variables:
   `TOIL_ENABLED`, `MULTI_CYCLE_PAYROLL_ENABLED`, `TYPED_PAY_COMPONENTS_ENABLED`, `PAYROLL_RESET_ENABLED`,
   `PAYROLL_UNLOCK_ENABLED`, `INDIVIDUAL_TXN_PAY_ENABLED`, `NOTIFICATIONS_ENABLED`,
   `AUDIT_HASH_CHAIN_ENABLED`, `FEEDBACK_AI_PLANNING_ENABLED`.
   **This is the single blocking fact.** Two customers on one deployment necessarily get identical modules,
   so "sell Leave to one, Leave + Payroll to another" is impossible today.
2. **`tenant` is four columns** — `id, workos_org_id, name, created_at`. No plan, status, seat count, trial
   expiry, or entitlements.
3. **No provisioning path.** Tenants exist because `db/seed.ts` created them. There is no "onboard a
   customer" operation.
4. **No control plane — and RLS correctly prevents one.** `ai_hr_app` cannot read across tenants, so a
   Stradaverse admin page cannot simply be another page in the app.
5. **No metering.** No seat counts, no usage records, no subscription entity.
6. **Navigation is hardcoded** in `components/sidebar.tsx`, filtered only by role booleans passed from
   `app/layout.tsx`.

## 3. Decisions

### D1 — Stay on one shared database with RLS; sell dedicated instances as a tier

Shared-schema-with-RLS is the right default: one migration run, one deploy, cheap per tenant. The
counter-argument is blast radius, and it is real — one RLS defect exposes every customer.

The mitigation already exists (RLS tests, `ai_hr_app` without BYPASSRLS) and must be treated as
non-negotiable going forward.

**A dedicated instance is already possible today at zero architectural cost** — it is this same application
pointed at its own database, which is exactly what the demo server is. So "dedicated deployment" becomes a
*pricing tier* for a client who demands data separation, not a rewrite. That option should be sold, not
engineered.

### D2 — Module entitlements in the database, replacing the environment gates

A `module` registry plus a `tenant_module` join, read through one function:

```ts
isModuleEnabled(ctx: SessionContext, code: ModuleCode): Promise<boolean>
```

The nine environment flags migrate to rows. Environment variables remain **only** for kill-switches that
must work without a database (e.g. disabling a broken subsystem platform-wide).

### D3 — Enforcement is server-side, at the service boundary

Hiding a nav item is UX, not a control. A customer without the Payroll module must be refused at the
**service entry point**, not merely unable to find the link. Three layers, and only the third is the actual
gate:

1. nav — hide (cosmetic)
2. page — redirect with an explanation (cosmetic)
3. **service / server action — throw `ModuleNotEnabledError`** (enforcement)

Modelled on the existing `TOIL_ENABLED` discipline, where `core/toil.ts` refuses at every entry point rather
than trusting callers.

### D4 — Deactivation is never destructive

Odoo's uninstall drops the module's data. **We must not copy that.** Malaysian payroll records carry
statutory retention obligations, and a customer who downgrades, lapses, or is suspended for non-payment must
not lose payslips.

Deactivation therefore means: module hidden, writes refused, **data retained and readable by the
platform**. Reactivation restores the module with history intact. Deletion, if ever offered, is a separate,
explicit, dual-controlled operation with its own retention check — never a side effect of a billing state.

### D5 — Control plane: separate database role, deny-by-default routes

`ai_hr_app` must never gain cross-tenant read. So the platform view needs its own privilege:

- a new role **`ai_hr_platform`** with `BYPASSRLS`, used by a **separate connection pool**;
- a `/platform` route group that is deny-by-default and constructible only from platform server code;
- platform identity kept **outside** `app_user` (Stradaverse staff are not employees of any tenant);
- every platform action appended to `DomainEvent` under a `platform` module — Stradaverse looking at a
  customer's data is itself an audit event.

Considered and rejected for now: a **separate application**. It is the stronger isolation story and worth
revisiting if an enterprise client audits us, but it doubles deployment for a handful of tenants. The
privilege boundary here is a distinct database role, so a routing bug alone cannot leak cross-tenant data —
it would also have to use the platform pool.

### D6 — Provisioning is one transactional operation

```ts
provisionTenant({ name, plan, modules[], adminEmail, country }): Promise<TenantId>
```

Creates the tenant, the WorkOS organization, the module entitlements, the first admin invitation, and the
**reference data** — statutory packs, MY leave types, holiday calendar, default pay components, dashboard
cards. Idempotent, and emits `tenant.provisioned`.

The reference-data seeding is the substantive work: `statutory_ruleset` is tenant-scoped, so each tenant
needs its own copy. Open question §7.2 covers whether that should stay per-tenant.

### D7 — Metering by daily snapshot

`usage_snapshot` written by a daily cron per tenant: active employments, active users, payslips generated,
modules active, storage. Point-in-time rows rather than derived-on-read, so a billing figure can be
reproduced months later and disputed against evidence.

## 4. Data model

```
module                      -- the catalog (seeded from code, not customer-editable)
  code PK, name, category, description, depends_on jsonb, billable, sort_order

tenant_module               -- the entitlement
  tenant_id, module_code, status(active|trial|suspended|disabled),
  activated_at, expires_at, activated_by_platform_user_id
  PK (tenant_id, module_code)

tenant  (extended)
  + status(active|trial|suspended|closed), plan, country,
    trial_ends_at, seats_purchased, primary_contact_email, notes

subscription
  tenant_id, plan, seats_purchased, period_start, period_end,
  status(active|past_due|cancelled), amount, currency

usage_snapshot
  tenant_id, captured_on, active_employments, active_users,
  payslips_generated, modules_active jsonb
  UNIQUE (tenant_id, captured_on)

platform_user               -- Stradaverse staff; deliberately NOT app_user
  id, email, name, role(owner|support|readonly), disabled_at
```

RLS: `tenant_module`, `subscription`, `usage_snapshot` are readable by the owning tenant (a customer may see
their own modules and usage) and writable **only** by `ai_hr_platform`. `platform_user` is invisible to
`ai_hr_app` entirely.

## 5. Module catalog (first cut)

Core (always on, not billable): Employees, Org, Leave, ESS, Approvals, Knowledge Base.

Billable: Payroll (+ MY statutory), Attendance, Claims, Performance, Analytics, Recruitment (future),
Documents, TOIL, Multi-cycle payroll, Typed pay components, System Analysis & Dependency Explorer.

The last one is the first entry added for a reason other than "a customer wants to buy it" (r79,
deec1691). It is an Admin reference screen describing how the PRODUCT is built — record types and the
relationships between them — which is Stradaverse's intellectual property rather than any customer's
data. During single-tenant setup it is wanted under Admin; once a second customer exists it should not
be. Modelling it as a module that defaults OFF is what makes that a provisioning choice instead of a
code change under pressure, and it is the pattern to reuse for any future internals-facing surface.

`depends_on` matters: TOIL requires Attendance and Leave; Multi-cycle requires Payroll. Activation must
refuse an entitlement whose dependency is not active, or the customer buys something that cannot function.

## 6. Build sequence

| # | Slice | Notes |
| --- | --- | --- |
| 1 | `module` + `tenant_module` schema, registry seed, RLS | No behaviour change yet |
| 2 | `isModuleEnabled()` + `ModuleNotEnabledError` + per-request cache | The enforcement primitive |
| 3 | Migrate the 9 env gates to entitlements | Default every existing tenant to *all on* — zero behaviour change on the demo |
| 4 | Nav + page gating from entitlements | `app/layout.tsx` passes the entitlement set |
| 5 | `ai_hr_platform` role + `/platform` route group, deny-by-default | Privilege boundary before any UI |
| 6 | Platform: tenant list, detail, module toggles | The Odoo-Apps-equivalent screen, Stradaverse-side |
| 7 | `provisionTenant()` + reference-data seeding | Onboarding becomes an operation, not a script |
| 8 | `usage_snapshot` cron + platform dashboard | Seats, active users, subscribed modules |
| 9 | Customer-facing "Apps" page (optional) | Request/trial a module; activation stays Stradaverse-gated |

Slices 1–4 are the sellable unit: after them, two customers on one deployment can have different modules.
Slice 3 is the risky one and is explicitly designed to be a no-op for existing tenants.

## 7. Open decisions

1. **Pricing unit** — per active employee, per user, per module, or a base + module combination? This
   determines what `usage_snapshot` must capture and cannot be retrofitted cleanly. **Needed before slice 8.**
2. **Statutory packs: per-tenant or global?** Currently tenant-scoped, so every tenant carries a copy of
   identical Malaysian law. Per-tenant permits client-specific overrides; global removes duplication and
   makes a statutory update one write instead of N. Recommendation: keep per-tenant rows, seed from a
   canonical global pack, so an update is a fan-out but overrides stay possible.
3. **Who may activate a module?** Stradaverse only (safe, sales-gated) or customer self-serve with billing
   consequences? Recommendation: Stradaverse-gated first; self-serve trials later.
4. **Trial semantics** — time-boxed full access, or capped by employee count?
5. **Suspension behaviour on non-payment** — read-only, or blocked with an export path? Recommendation:
   read-only plus export, never a hard lock-out on a payroll system.

## 8. Consequences and risks

**Positive.** Modules become a commercial lever without a code fork per customer. Onboarding becomes one
operation. Stradaverse gains a real view of the book of business. The isolation model, which is the
expensive part, is already built and does not change.

**Risks.**
- **Shared-database blast radius.** One bad migration now hits every customer at once. ADR-0075's
  shadow-migration gate stops being a nicety and becomes a release requirement.
- **The platform role is a loaded gun.** `BYPASSRLS` exists precisely to defeat the protection everything
  else depends on. It must live behind its own pool, its own route group, its own identity table, and log
  every access as a domain event.
- **Gate-migration regression.** Slice 3 rewires nine live feature flags. Defaulting existing tenants to
  all-on makes it a no-op by construction; the RLS and payroll golden tests are the safety net.
- **Entitlement checks in hot paths** must not add a query per call — resolve once per request and cache.

**Non-goals.** Billing/payment integration (manual invoicing initially), customer self-serve signup,
per-tenant custom code, and any destructive uninstall.
