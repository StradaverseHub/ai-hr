# ADR-0089 — Employer and period scoped PCB incentive declarations

- **Date:** 2026-10-02
- **Status:** Implemented in r380; execution and release verification pending.
- **Raised by:** feedback `2b9235f6-d0d1-4530-9118-ceea1cbf601a`.
- **Related:** ADR-0009 (multiple employments), ADR-0006 (audit), ADR-0020 (statutory packs), ADR-0085 (saved statutory working).

The old person-level REP and Knowledge Worker flags collapsed both methods into 15% of monthly
remuneration. They also had no employer, effective period or approval provenance. A C-suite flag on
that same row would apply to every employer and survive transfers without proving eligibility.

## Decision

`employment_tax_scheme_my` owns HR declarations of an existing REP, Knowledge Worker or C-suite
approval. Each immutable declaration identifies the tenant, employment, employer, scheme, inclusive
start/end payroll months, approval reference, declaring user and server timestamp. The application
records HR's attestation; it does not issue or independently verify an authority's approval. AI never
infers eligibility from a title, salary, citizenship or an old person-level flag.

Only an administrator for the current owning employer can record or revoke a declaration. The save
locks and derives the employment's current company. An expected-company precondition binds the
confirmation to the employer HR reviewed, while the submitted identifier never grants ownership.
The country must be MY, the recorded tax status must be resident, and C-suite also requires recorded
non-citizen or PR status. HR confirms the scheme's approval and eligibility explicitly. Approval
references are kept in the authorized declaration record, not copied into audit-event payloads.

Active declarations cannot overlap for the same tenant, employment and employer, regardless of
scheme. Both the service and a database exclusion constraint enforce this. Facts cannot be edited or
deleted by the app role: correction means revoke and append a replacement. Archival is the only
column the app role can update; RLS also protects tenant, employer, actor and timestamp boundaries.

Payroll resolves the employer-period declaration through the country-pack contract before producing
money. It acquires declaration locks in stable employment order and holds them through commit; save
and revoke use the same lock. No active declaration plus a legacy incentive flag refuses processing
instead of guessing eligibility or silently choosing another tax method. Ordinary resident and
non-resident paths remain available. There is no automatic approval backfill or person-wide C-suite
selector.

The MY calculator owns the deterministic annual chargeable-income method. The new working stamps
its scheme, scheme version and declaration ID alongside the actual P, relief, EPF, accumulated
payments, rebate and zakat legs. Verified constants and the documented C-suite/table and additional
remuneration interpretations live in [Statutory Sources](../architecture/STATUTORY-SOURCES.md).

## Historical reads

Saved payroll is never rewritten by a declaration edit, expiry, revocation, profile change or page
view. The shared explanation reader consumes the saved scheme and declaration ID without querying
current approval state. Unsupported, incomplete or contradictory provenance is unavailable, rather
than converted into a different formula. Legacy flat-rate working remains labelled as its original
method. Comparative replay uses compatible saved scheme provenance for every run and flags mixed or
legacy incentive working instead of consulting today's approval to reconstruct it.

## Verification requirements

The release must cover deterministic monetary cases, employer/tenant/employee refusal with permitted
controls, inclusive period boundaries, overlap and append-only database grants, stale employer
confirmation, actor provenance, revocation versus historical reads, action submission contracts,
six-locale actual screens and PDFs, a payable additional-remuneration fixture, reversal evidence,
the full gate, build and migration shadow. No production approvals or historical money are inserted
as part of deployment.
