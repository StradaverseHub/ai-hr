# AI HR

A modern, AI-assisted Human Resource Management System (HRMS).

> **Status:** Pre-implementation. We are at the *data modeling + architecture* stage.
> No application code has been written yet beyond a disposable UI spike. The
> documents under [`docs/`](docs/) are the current deliverable and are open for review.

---

## What this is (and is not, yet)

`ai-hr` is being built as a **commercial, multi-tenant SaaS HRMS**, by a **solo founder**.
Those two facts are in tension, and the architecture is shaped by resolving it honestly:

- **Single-tenant in operation, multi-tenant in the schema.** Every table carries a
  `tenant_id` and is protected by Postgres Row-Level Security from the first migration,
  so the SaaS path stays open — but we do **not** build tenant provisioning, billing,
  signup, or region routing for customers who don't exist yet.
- **Go deep on one country, not wide on twenty.** The initial wedge is
  **Malaysian / ASEAN SME HR + statutory compliance** (EPF / SOCSO / EIS / PCB).
  The platform is *multi-country ready*; it is not *multi-country built*.
- **Buy the undifferentiated heavy lifting.** Auth, directory sync, email, and payments
  are managed services, not solo-maintained code.

See [`docs/architecture/slice-0-spec.md`](docs/architecture/slice-0-spec.md) for the v1 definition.

## v1 scope — "Slice 0: the spine"

A walking skeleton that proves the bets that **cannot be retrofitted**, with everything
else deliberately deferred.

**In scope**

- Tenant isolation (`tenant_id` + RLS), one tenant operationally
- Multi-**company** within a tenant (legal entity as a first-class citizen)
- **Bitemporal effective dating** on the organizational core
- Identity model: `Person → Employment → Assignment → Position`
- **Matrix reporting** as a typed, effective-dated, cycle-guarded graph
- Employee lifecycle as events: hire / transfer / terminate
- Leave (Annual only): accrual ledger + request → approve workflow
- AuthZ: RBAC + ABAC enforced in the database via RLS
- Immutable domain-event log + audit trail

**Explicitly deferred** (recorded, never silently dropped): payroll & the calc kernel,
attendance, biometrics, the AI feature suite, multi-country, data-residency / region
routing, billing, SSO/SCIM wiring, additional leave types, performance & succession.

## Architecture at a glance

| Concern | Choice | Rationale (ADR) |
|---|---|---|
| Database | PostgreSQL | RLS + bitemporal SQL ([0005](docs/adr/0005-tech-stack.md)) |
| Data access | Drizzle ORM | SQL-close, RLS- and temporal-friendly ([0005](docs/adr/0005-tech-stack.md)) |
| App | Next.js (App Router) modular monolith | Solo velocity, extractable later ([0005](docs/adr/0005-tech-stack.md)) |
| Auth & tenancy | WorkOS (AuthKit + Organizations) | Enterprise SSO/SCIM-ready ([0005](docs/adr/0005-tech-stack.md)) |
| Time model | Bitemporal (valid-time now, full system-versioning when payroll lands) | [0001](docs/adr/0001-bitemporal-effective-dating.md) |
| Isolation | `tenant_id` + Row-Level Security | [0002](docs/adr/0002-multitenancy-rls.md) |
| Org/identity | Person / Employment / Assignment / Position + typed reporting graph | [0003](docs/adr/0003-organizational-model.md) |
| Authorization | RBAC + ABAC in the DB | [0004](docs/adr/0004-authorization.md) |
| Audit | Append-only domain-event substrate | [0006](docs/adr/0006-event-and-audit-substrate.md) |

## Documentation

- [**North Star**](docs/architecture/north-star.md) — the AI-native, self-improving end goal and how the foundation serves it
- [Architecture Decision Records](docs/adr/) — the load-bearing decisions
- [Domain model & ERD](docs/architecture/domain-model.md)
- [Slice 0 specification](docs/architecture/slice-0-spec.md) — personas, use cases, acceptance criteria, test strategy
- [Threat model](docs/architecture/threat-model.md) — STRIDE-lite for the v1 surface
- [Malaysia localization](docs/architecture/my-localization.md) — country-pack spec mapping
- [UI/UX enhancement plan](docs/architecture/ui-ux-plan.md) — UX audit + roadmap

## Methodology

We apply the full discovery → threat-modeling → data-modeling → API → test → implementation
→ review cycle **per vertical slice**, not once for the whole platform. Big-design-up-front
across all modules is itself a risk; each slice earns its own rigor.

## Getting started

Local dev runs against a dedicated **PostgreSQL 14** cluster on port **5433** (data dir
`/opt/homebrew/var/aihr-pg14`). The app connects as the non-privileged `ai_hr_app` role so
RLS is enforced; migrations run as the `postgres` owner. Databases: `ai_hr_dev`, `ai_hr_test`.

```bash
pnpm install
cp .env.example .env.local   # local URLs (no secrets — localhost trust auth)
pnpm db:start                # start the Postgres cluster (pg_ctl)
pnpm db:migrate              # apply migrations to ai_hr_dev
pnpm test                    # migrates ai_hr_test, runs the Slice 0 acceptance suite
pnpm db:stop                 # stop the cluster
```

**Schema changes:** edit `db/schema.ts` → `pnpm db:generate` (table DDL) → hand-write any
RLS / grant / constraint changes as a `drizzle-kit generate --custom` migration → `pnpm db:migrate`.

> `db:start` / `db:stop` hardcode this machine's brew paths. Elsewhere, point them at your
> PostgreSQL `pg_ctl` + a data dir (`initdb -U postgres`), or just set `DATABASE_URL` to any
> Postgres (e.g. Neon). The app needs a non-superuser role; see `db/migrations/0001_*`.

### Layout

```
db/        schema.ts (Drizzle), client.ts (RLS session wrapper), events.ts, migrations/
core/      org.ts (hire/transfer/terminate/reporting), leave.ts (request/approve)
test/      harness.ts + slice0.test.ts (UC2/4/6/8/9 acceptance tests)
docs/      ADRs, domain model, Slice 0 spec, threat model, North Star
```
