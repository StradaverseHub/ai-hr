# ADR-0005: Tech stack — Postgres, Drizzle, Next.js monolith, WorkOS

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

A solo founder must move fast without painting the enterprise SaaS path into a corner.
The constraints that drive the stack: bitemporal SQL ([ADR-0001](0001-bitemporal-effective-dating.md)),
Row-Level Security ([ADR-0002](0002-multitenancy-rls.md)), and enterprise-grade auth
(SSO/SCIM) for selling upmarket.

## Decision

- **PostgreSQL** — non-negotiable. RLS and rich SQL (recursive CTEs, range types,
  exclusion constraints, future system-versioning) are foundational here. Local via Docker;
  managed (e.g. Neon) later.
- **Drizzle ORM** for data access. Chosen over Prisma because the heart of this system is
  RLS + hand-rolled bitemporal tables, where Prisma fights us (no native RLS, no temporal
  tables, raw SQL for every as-of query). Drizzle stays close to SQL, keeps strong TS
  types, and lets us express policies, ranges, and as-of reads without an impedance
  mismatch.
- **Next.js (App Router) as a modular monolith.** Route handlers + server actions, with a
  clean internal `domain` / `application` / `infrastructure` layering so a service can be
  extracted later. **No microservices** — wrong overhead for solo.
- **WorkOS** for authentication and tenancy. AuthKit for the hosted login surface;
  Organizations map to tenants; SAML SSO and SCIM directory sync are first-class for the
  eventual enterprise sale (we wire SSO/SCIM in a later slice but model users to anticipate
  directory-sourced identities now).
- **Zod** for boundary validation; **Vitest** (unit/integration) + **Playwright** (E2E)
  for the test pyramid mandated by the engineering principles.

## WorkOS scope & cost — what to enable, and when

WorkOS is à la carte and priced so cost tracks revenue. We enable **AuthKit only** to start
(free up to 1M monthly active users) and switch on paid products **only when a concrete need
appears — never speculatively.**

| Stage | Enable | ~Cost | Notes |
|---|---|---|---|
| Slice 0 / dev | AuthKit (email+password, social) | **Free** | Free to 1M MAU, then $2,500/mo per extra 1M |
| Pre-launch / first customer | + Custom Domain | ~$99/mo | Branded login + email deliverability; enterprise trust |
| First enterprise deal | + Enterprise SSO | $125/connection/mo (volume-discounted to ~$50) | One connection = one customer's IdP |
| Enterprise wants auto-provisioning | + Directory Sync (SCIM) | $125/connection/mo | Lower priority for us — see nuance |
| Large / compliance customers | *maybe* Audit Log streaming | $125/mo per SIEM stream | Often unnecessary — see below |
| Public self-serve signup abused | *maybe* Radar | usage-based | B2B onboarding ⇒ likely never |

**SSO vs. SCIM for an HRMS.** SSO (staff log in with corporate credentials) is high-value when
we go enterprise. SCIM auto-provisioning is **lower priority for us specifically**: an HRMS is
often the *source of truth* for employees — we create them, rather than syncing a list in from
the customer's directory. Treat SSO and SCIM as independent decisions, not a matched pair.

**Do not buy WorkOS Audit Logs to duplicate [ADR-0006](0006-event-and-audit-substrate.md).** Our
domain-event substrate *is* our audit trail. WorkOS Audit Logs only earns its cost if a customer
demands their events streamed into *their* SIEM (Splunk/Datadog) and we'd rather not build that
export ourselves. We still capture WorkOS auth events (logins, SSO changes) — via webhooks into
our own log, not by paying for the product.

**Radar (bot/fraud) is not needed** for B2B onboarding — accounts are invited, not publicly
self-served. Revisit only if a public signup flow is ever opened and abused.

## Consequences

- (+) The whole stack is TypeScript end-to-end — one language for a solo dev.
- (+) RLS-in-Postgres + Drizzle gives database-enforced isolation with ergonomic queries.
- (+) WorkOS removes auth, SSO, and directory-sync from the solo maintenance burden.
- (−) Drizzle is less familiar than Prisma (used elsewhere by the founder); short ramp on
  the migration/query patterns. Judged worthwhile because the core is temporal + RLS.
- (−) A modular monolith requires discipline to keep boundaries clean so the future
  extraction is real, not aspirational.

## Alternatives considered

- **Prisma + raw SQL.** Faster ramp (familiarity), but fights RLS and temporal on exactly
  the parts that matter most. Rejected.
- **Separate NestJS API + SPA.** Cleaner service boundary, but more moving parts and infra
  for solo; the monolith can be split when there's a second engineer or a scaling reason.
- **Clerk for auth.** Strong DX and familiar, but WorkOS leads on SAML SSO + SCIM, which
  the enterprise GTM needs sooner than later.
- **Self-hosted auth (Auth.js + RLS).** Lowest cost, highest risk on a security-critical
  surface; rejected for v1.
