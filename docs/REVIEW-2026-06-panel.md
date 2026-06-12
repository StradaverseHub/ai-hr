# Six-persona product review — June 2026

Independent panel (HR consultant, HRIS power-user, HR newbie, security, SME veteran, MNC
veteran). Personas 1–4 were source-grounded (sandbox blocked live UI/DB); security + newbie were
run live by the maintainer. This is the consolidated verdict + the action order being executed.

## Consensus

A **world-class Malaysian payroll engine wearing a thin HRMS.** Foundation ~8/10 (statutory math,
RLS+ABAC+audit substrate, multi-entity org model); product surface ~2/10. The calculator is years
ahead of the product; the backlog is closing that gap.

## High-confidence findings (≥2 personas, independent)

| Finding | Flagged by | Sev | Effort |
|---|---|---|---|
| No bank/giro payment file + no bulk payslip distribution | Consultant, Power-user, SME | P0 | M |
| Auth (WorkOS) not built | SME, MNC | P0 gate | M (seam exists) |
| Audit trail: write substrate complete, no read surface | Power-user, MNC | P0 (best ROI) | S |
| No CSV/bulk employee import | SME, MNC | P1 | M |
| EA/Form E cash-only (no BIK/VOLA/ESOS/CP38) | Consultant, SME | P1 | M |
| Unpaginated lists, no search/filter | Power-user, MNC | P1 | M |
| Pay structure = basic + 1 untyped allowance | Consultant | P1 | M–L |
| Foreign-worker / age-60 EPF rates; per-person (cross-employer) PCB | Consultant, MNC | P1 | M / L |
| Hardcoded effective dates in forms | Power-user, SME | P2 | S |
| Stale README | Consultant, SME, MNC | P2 | S |

## Security (live-probed)

- **S1 / Medium** — cleartext bank name+account written into the append-only `domain_event`
  payload on a profile-change request (`core/profile.ts`). Append-only + PDPA erasure conflict.
- **S2 / Low** — CP39 route echoes the raw driver error (SQL+params) in the 500 body.
- **S3 / Low** — malformed-but-format-passing ids 500 instead of 4xx (`/me/payslip/notauuid`,
  `periodKey=2026-13`).
- **S4 / Low (compliance)** — sensitive-data *reads* are not audited (`core/read.ts`).
- Done right: prod-guarded dev shim, no env secrets, full RLS coverage, no SQL injection,
  immutability triggers, append-only audit, routes RLS-scoped/admin-gated.

## Newbie onboarding

No first-run wizard / setup checklist / glossary; statutory acronyms (PCB category, TP3, ORP,
E-number) shown with little inline help; hire dead-ends when no company/department exists.

## Strategic fork (owner decision — NOT auto-decided)

SME-of-one wants the group tree / cost centers / concurrent employment / approval chains
**hidden**; MNC wants those + multi-country packs, SSO/SCIM, a workflow/SoD engine, an
integration API, residency, analytics. Panel's implicit strategy: **win SME first**; let the
enterprise-shaped architecture accrue toward MNC without rework. North star (MNC reviewer): "the
multi-entity, multi-country payroll/compliance system of record with a bulletproof audit trail
and clean integrations — not a worse Workday."

## Execution order (autonomous; forks + WorkOS excluded)

1. ✅ Trust-debt slice — security S1–S3, default form dates, README. *(#105)*
2. ✅ Audit-trail view — `/admin/audit` + per-record History. *(#106)*
3. ✅ CSV employee importer. *(#107)*
4. ✅ Payment summary export (honest neutral CSV; byte-exact bank file stays #73). *(#108)*
5. ✅ List pagination + search — People (and the shared pattern for other lists). *(#109)*

Deferred to owner: SME/MNC fork, WorkOS auth, typed pay components, multi-country packs.
Still open (P1, not forks): EA BIK/CP38; foreign-worker EPF + cross-employer PCB (both
sourcing-dependent).
