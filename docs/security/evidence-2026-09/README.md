# Evidence notes — Security Assessment 2026-09

Raw working notes from the three-pass red-team assessment (see
[`../SECURITY-ASSESSMENT-2026-09.md`](../SECURITY-ASSESSMENT-2026-09.md) for the report). Each file is
the condensed output of one audit/verification agent, with file:line, reproduction steps, observed HTTP
headers and SQL. Tags: FACT / VERIFIED / HYPOTHESIS.

## Pass 1 — dimension audits
- `pass1-auth.md` — authentication & session
- `pass1-authz.md` — authorization, RLS, IDOR
- `pass1-injection.md` — SQL/CSV injection, input handling
- `pass1-secrets.md` — secrets, crypto, config
- `pass1-fileupload.md` — file upload/download, PII exposure
- `pass1-infra.md` — infrastructure, deploy, DoS
- `independent-evidence-pass1.md` — lead's own dynamic probes (headers, forged-cookie identity)

## Pass 2 — independent verification (refute-first) + gap hunts
- `pass2-crypto.md` — audit chain + PII-at-rest (both confirmed)
- `pass2-xss.md` — stored-XSS chains (live header repro)
- `pass2-payslip.md` — manager → subordinate payslip/PII (confirmed, broadened)
- `pass2-rls.md` — exhaustive per-table RLS completeness (isolation intact)
- `pass2-authconfig.md` — auth/config cluster (several downgraded)
- `pass2-rsc-pii.md` — client-side RSC over-fetch (clean) + column authz (2 findings)

## Pass 3 — third sweep
- `pass3-bizlogic.md` — business-logic / workflow / race
- `pass3-deps.md` — dependency audit summary
- `pass3-nextcve.md` — Next.js CVE reachability
- `pass3-critic.md` — completeness critic / false-positive audit
