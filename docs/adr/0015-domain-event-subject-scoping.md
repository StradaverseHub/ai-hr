# ADR-0015 — Subject-scoped reads on the domain-event log

Status: **Accepted** · Date: 2026-06-13

## Context

The append-only `domain_event` log (ADR-0006) is the substrate behind audit, the per-record change
history, the dashboard activity feed, and (later) agent context. Its read policy was tenant-wide:

```sql
CREATE POLICY domain_event_read ON domain_event FOR SELECT
  USING (tenant_id = app.current_tenant_id());
```

That means **any authenticated tenant member could read every event payload in the tenant** — salary
on `compensation.set`, net pay on payroll events, leave details, and (until they were stripped)
performance ratings and merit recommendations. The Performance security review proved it: running as
the seeded employee "Aisyah Rahman" under her own RLS context, a `SELECT … FROM domain_event` returned
her manager's overall rating and merit % while the cycle was unreleased and the comp was meant to be
hidden — directly violating the Performance module's own visibility contract.

This was **latent** (no shipped UI calls a generic event read for a non-admin — `/admin/audit` is
`requireAdmin` and the per-record History is admin-gated), but the data-layer contract was broken: any
new read path (an employee timeline, an API, agent synthesis over the log) would leak immediately. And
it was **broader than Performance** — the same shape exposed comp/payroll/leave data generally.

## Decision

### 1. Add `subject_employment_id` and scope non-admin reads to it

`domain_event` gets a nullable `subject_employment_id uuid` (FK → `employment`, `ON DELETE SET NULL` so
audit history survives a hard delete). Every state-changing service sets it when the event concerns a
single employee; tenant/company/batch events leave it null. The read policy becomes:

```sql
CREATE POLICY domain_event_read ON domain_event FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (subject_employment_id IS NOT NULL AND app.can_see_employment(subject_employment_id))
    )
  );
```

- **Admins** read every event in their tenant — the audit ledger is unchanged.
- **Non-admins** read a row only when it has a subject employment they may see. `can_see_employment`
  already encodes self ∪ active-administrative-line manager ∪ company admin.
- **No-subject rows are admin-only** — fail-closed by construction. A forgotten subject, or a new
  aggregate that doesn't set one, leaks to nobody but admins.

The `INSERT` policy and the append-only `REVOKE UPDATE, DELETE, TRUNCATE` are untouched.

### 2. Mirror the base tables, don't out-clever them

The event's visibility deliberately matches the visibility of the record it audits. `compensation`,
`payslip`, and `leave` base tables already use `can_see_employment` (a line manager already sees a
direct report's salary on the detail page). So gating the *events* with `can_see_employment` is exactly
consistent — not stricter (which would be an incoherent "you can see the value but not the audit of the
change"), not looser. An earlier two-tier design (financial events admin-or-self) was **rejected** for
exactly this reason: it would have made the log stricter than the data it records.

### 3. Time-gated secrets stay out of payloads (defense in depth)

Subject-scoping makes an event visible to the subject. So a value the subject must *not* see — a
pre-release rating, a merit recommendation — cannot live in the payload; subject-scoping alone can't
express "after release." The performance events were already reduced to `{ cycleId }` / ids only (no
rating/merit/bonus), which closes the "own pre-release rating" leak that RLS cannot. Values the subject
*may* see about themselves (their own salary on `compensation.set`) stay in the payload — that's their
own data, and peers are blocked by subject-scoping.

### 4. Universal, with a backfill

The change touches every `appendEvent` call site (≈22 employment-scoped events across comp, org,
leave, attendance, profile, statutory, performance — each passing the subject; ≈12 tenant/company
aggregates passing none). A one-time migration backfills `subject_employment_id` for historical rows by
joining each aggregate back to its employment. A shared `subjectEmploymentForPerson` helper resolves the
person-keyed aggregates (statutory profile, person edits) to a deterministic employment.

## Consequences

- The privacy contract now lives **in the database**, not just above it. A future `/me` timeline or
  event API inherits the correct scoping for free, fail-closed.
- The dashboard activity feed becomes correctly personal for non-admins (an employee no longer sees the
  whole org's activity); admins keep the full firehose. The per-record History (admin-gated) and
  `/admin/audit` are unaffected.
- New event types must set `subjectEmploymentId` to be visible to the subject/their manager; forgetting
  it is safe (admin-only), so the failure mode is "too private," never "leaked."
- Verified by GUC simulation as `ai_hr_app`: a peer sees 0 of another's events; the subject sees their
  own (with no rating/merit scalar in any payload); a manager sees a report's; an admin sees all;
  cross-tenant sees none.

## Alternatives rejected

- **Strip every sensitive scalar from all payloads** (option 3 alone): loses audit fidelity (the admin
  trail could no longer show "salary → X") and is whack-a-mole / fail-open (forget to strip → leak).
  Used only for the time-gated performance secrets, where RLS genuinely cannot help.
- **Two-tier policy (financial events admin-or-self)**: would make the event log stricter than the
  base tables it audits, an inconsistency, since comp/payslip are already manager-visible.
- **Leave it tenant-wide and rely on read-layer gating**: the proven leak shows the read layer is not
  the only door; the contract must hold at the row level.
