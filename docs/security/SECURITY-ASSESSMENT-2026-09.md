# AI HR — Security Assessment (September 2026)

**Type:** Authorized internal red-team assessment (defensive).
**Target:** `main@c8a3b77c` (r357), reviewed on an isolated git worktree + a throwaway seeded
scratch database and a local dev server. **Production (203.142.6.241) was never attacked** — it was
consulted read-only only for facts already established elsewhere.
**Date:** 2026-09-29.
**Method:** three full scan passes; every significant finding independently re-checked by a separate
agent instructed to *refute* it. 15 subagents plus lead verification.

Evidence tags used throughout: **FACT** (read in code) · **VERIFIED** (proven by reproduction) ·
**HYPOTHESIS** (plausible, not executed). Per-finding raw notes (file:line, repro commands, observed
HTTP headers, SQL) are in [`evidence-2026-09/`](./evidence-2026-09/).

---

## Verdict

**The foundations are strong; the exposure is at the edges and in configuration.** The hard, expensive
part — database-enforced tenant isolation — is genuinely well built: 178 of 178 tables carry row-level
security, the app database role cannot bypass it and owns nothing, and a request with no tenant context
reads zero rows. SQL-injection defenses, the AI-secret encryption, invitation tokens, self-approval and
delegation controls, and payroll unlock gating all held up under attack.

**What must be fixed before real employee data lands:** an out-of-date framework with an
unauthenticated-RCE / gate-bypass CVE; employee PII (IC, bank, tax) stored in plaintext; a stored-XSS
class across ~7 file-download routes; and an authorization gap that lets a manager read a subordinate's
IC, tax and bank details. None require a rebuild.

**Counts:** 4 high · 7 medium · low/defense-in-depth list · 18 controls verified solid.

---

## How it was tested

- **Scope:** application source, database, auth/session, file handling, deploy config, dependencies —
  the user's own system, tested with authorization. All exploitation ran against an isolated copy.
- **Pass 1** — six specialists, one dimension each: authentication/session, authorization/tenant
  isolation/IDOR, injection/input, secrets/crypto/config, file-upload/PII, infrastructure/DoS.
- **Pass 2** — six independent agents told to *refute* each significant finding with their own
  evidence, plus two fresh hunts: client-side (RSC) data leakage, and exhaustive per-table isolation.
- **Pass 3** — business-logic/workflow/race abuse; dependency-CVE reachability; a completeness critic
  that re-rated the register and hunted false positives and gaps.
- The adversarial re-checking changed the answer: it downgraded two findings that only fire under a
  specific misconfiguration, promoted the plaintext-PII issue, and roughly tripled the count of
  XSS-vulnerable routes the first pass saw.

---

## HIGH — fix before real employee data lands

Ordered by return on effort (attacker-reachability × blast radius × cost to fix).

### H1 — Upgrade Next.js to ≥ 16.3.3
The app pins `next@16.2.7`, which has an **unauthenticated RCE** in image optimization (fixed 16.3.3)
and a **middleware bypass** plus Server-Action SSRF (fixed 16.2.11). The middleware bypass is the one
that matters: the `SHARE_PASSWORD` gate *is* middleware, so on the demo box (where the "act as"
switcher is the only auth layer) a bypass means full access to seeded data. **VERIFIED** the version.
The image-RCE remote vector is closed by the app's default config (no remote images configured), but
the version is still the cheapest, highest-leverage fix — one bump closes RCE, bypass and SSRF.

**Fix:** bump Next to ≥16.3.3; re-resolve the lockfile so the transitive `sharp` picks up patched
libvips/libheif; then run the full gate + a dev-server render check + a Chinese-payslip PDF render
(the `fontkit` runtime resolution can regress on a Next bump) + re-verify middleware 401/503 behaviour.
**Interim, free:** if the consultant demo is finished, unset `ALLOW_DEMO_SESSION` so real WorkOS auth
becomes the backstop.

### H2 — Encrypt employee PII at rest
The PII vault (`sealForSubject`/`unsealForSubject`, `core/pii-vault.ts`) has **zero callers** outside
its own file. **VERIFIED** on the seeded DB: IC numbers, bank accounts and tax numbers are plaintext
`text` columns; `pii_key` is empty; there is no `pgcrypto`. The PDPA "erasure" path (`core/pdpa.ts`) is
column-NULLing, not the crypto-shredding it is labelled as. With no backups yet and RLS the only
control, a single DB dump or stolen backup is a mass statutory-PII disclosure.

**Fix:** wire the existing vault into the write path for IC / bank / passport / tax columns; move the
master key to a KMS/HSM (not the shared env passphrase with its static salt). Prescribed by ADR-0030 §4
and noted in the readiness doc. Until done, do not describe the product as encrypting PII at rest.

### H3 — Fix stored XSS across all file-download routes
File-serving routes echo the uploader's claimed content-type with `Content-Disposition: inline` and no
`X-Content-Type-Options: nosniff`, and there is no Content-Security-Policy anywhere. **VERIFIED** with
live headers: an uploaded `text/html` file is served back as `text/html; inline` and would execute in
the app origin under the viewer's session. An employee uploads a malicious file; a manager, HR approver
or the owner/triager opens it → attacker JS runs as them. The completeness pass found the pattern in
**~7 routes** (leave, feedback, performance, resignation, attendance-requests, KB download,
review-document), not the 2 first seen.

**Fix — once, centrally:** a shared serve helper that forces `attachment` except for an
image/pdf allowlist, and always sets `nosniff`:
```
const INLINE_SAFE = new Set(['application/pdf','image/jpeg','image/png']);
const disposition = wantsInline && INLINE_SAFE.has(mime) ? 'inline' : 'attachment';
headers: { 'Content-Type': mime, 'Content-Disposition': disposition,
           'X-Content-Type-Options': 'nosniff' }
```
Route every attachment endpoint through it, sniff magic bytes on upload instead of trusting
`file.type`, and add a global CSP (`frame-ancestors 'none'; object-src 'none'`) in `next.config.ts`.
Four routes already do this correctly (personnel-document, claims, photo, logo, payslip-PDF) — copy them.

### H4 — Close the manager → subordinate PII authorization gap
A deliberate privacy decision (migration `0060`) tightened *compensation* reads to admin-or-self so
managers cannot see subordinate pay — but it was never applied to `employee_statutory_my`, `payslip`,
or the EA/PCB report reads, which still resolve through the manager down-walk (`can_see_employment` /
`can_see_person`). **VERIFIED empirically:** as a plain-role user who is a line manager,
`GET /payroll/reports/ea/<subordinate>` returned **HTTP 200 with the subordinate's IC and tax number**;
non-managers got 404. The same predicate exposes bank account, EPF/SOCSO and (with real data) net pay.
No misconfiguration required — it is live in the product.

**Fix:** a new (append-only) migration redefining `payslip_rls` and `employee_statutory_my_rls` to
admin-or-self, mirroring 0060; and an explicit self-or-payroll-admin guard on the EA/PCB and payslip
*view* reads so a statutory document is never gated by row-visibility alone. Fix the stale
"own-or-admin" comments on those routes.

---

## MEDIUM — before go-live, after the high items

| ID | Finding | Fix |
|----|---------|-----|
| M1 | Demo "act as" identity is an unsigned, client-set `dev_user` cookie that assumes any user — active only when `ALLOW_DEMO_SESSION=true` or `NODE_ENV≠production`. Compiled out of a correct customer deploy; risk is the wrong env template on a real box. **VERIFIED** the mechanism (forged cookie → `/me` renders the impersonated employee). | Startup refusal if production + demo flag + WorkOS configured; sign the cookie; confirm the customer template omits the flags. |
| M2 | The schema-owner DB URL (`MIGRATION_DATABASE_URL`) is loaded into the web process env (`deploy/aihr.service`), though the app only uses the app-role URL. A second bug (RCE/env-leak) would then grant power to disable RLS and re-grant encrypted columns. | Split the owner URL into a file sourced only by deploy/migrate/seed; keep it out of the long-lived web process. |
| M3 | Leave-approval ledger path has no row/advisory lock (the claims path does). Two concurrent approvals can double-debit or push a balance past its floor. | Port the claims lock pattern: advisory lock on (tenant, employment, balance-type) + `SELECT … FOR UPDATE` before the status check. |
| M4 | Audit hash chain has no external anchor — a privileged DB actor can edit a row and recompute a valid chain (**VERIFIED** by recomputing a real hash from public columns). Off by default today. | Anchor the chain head to an external append-only/WORM store or notary. An HMAC alone won't help (same box holds the key). |
| M5 | No global security headers / CSP (`next.config.ts` has none). Root cause of the XSS class and clickjacking exposure. | Add `headers()`: CSP with frame-ancestors, nosniff, X-Frame-Options, HSTS. (Folds into H3.) |
| M6 | CSV formula injection in the leave-generation export — the one export bypassing the shared `csvSafeCell` guard; reachable via an imported employee name. | Route it through the shared `toCsv`/`csvSafeCell` like every other export. |
| M7 | No rate limiting on the `SHARE_PASSWORD` gate (WorkOS throttles its own routes). Unlimited guesses against one shared password. | Per-IP backoff at the tunnel/proxy edge, plus a long random password. |

---

## LOW / defense-in-depth

| Finding | Fix |
|---------|-----|
| DB role passwords passed in `psql` argv at bootstrap (owner/app) — documented, one-time, local-only. | Pipe over stdin (platform role already does). |
| systemd unit lightly hardened (only `NoNewPrivileges` + `PrivateTmp`). | Add `ProtectSystem`/`ProtectHome`/`ProtectKernel*`, `RestrictAddressFamilies`, `SystemCallFilter`. |
| Three identity `SECURITY DEFINER` functions not `search_path`-hardened (pg_temp shadowing) — needs a separate SQL foothold. | Re-issue with `SET search_path = pg_catalog, public, pg_temp` + schema-qualify. |
| Demo `/login` lists all seeded users (demo-only, before the gate); `dev_user` cookie lacks `Secure`; `safeEqual` leaks password length. | Scope `dev_principals`; add `secure:true`; compare fixed-length digests. |
| No test asserts RLS-present on every table — a future table could ship without it unnoticed. | Add a schema-drift guard (every public table RLS-on + policy). |
| `Infinity` passes the `amount > 0` check in individual-txn (DB rejects it as a raw error). | `Number.isFinite(x) && x > 0`. |
| Fetch-then-slice pagination (~24 pages) + attendance N+1 — heavy-tenant self-DoS, not cross-tenant. | Push LIMIT/keyset into the query; batch the holiday lookup. |
| `sharp` transitive libvips/libheif CVEs. | Re-resolve the lockfile after the Next bump; add a `sharp` override if needed. |

---

## Verified SOLID — do not re-litigate

**Isolation & access**
- Tenant isolation: 178/178 tables have RLS; app role is NOBYPASSRLS, owns nothing; deny-by-default
  confirmed live. No cross-tenant path found.
- Sensitive tables are tenant + per-employee scoped, not tenant-wide.
- File-download IDOR blocked by RLS; routes 404 (no existence oracle).
- Module gating enforced service-deep, not just in the nav.
- Client (RSC) payloads carry no salary/IC/bank to unauthorized viewers.

**Crypto, auth & logic**
- AI provider secrets: AES-256-GCM, random IV, tenant-bound AAD, fail-closed.
- Invitation/reset tokens: 256-bit, hashed at rest, single-use, expiring.
- Production WorkOS path never trusts a client-supplied subject.
- SQL injection: raw-SQL sites use schema/literal identifiers; no server-side spreadsheet parsing.
- Self-approval banned; delegation self-grant blocked; payroll unlock/reset admin-gated; TP1 reliefs
  bounded server-side; leave cancellation reverses the actual net ledger.

---

## Suggested remediation sequence

One to two focused rounds, each ending in the full gate + a dev-server render check (a 200 is not a
render check).

| Round | Do | Why together |
|-------|----|--------------|
| A | H1 (Next upgrade) + H3/M5 (shared serve helper + global CSP/headers) | Both framework/config-level; share the post-upgrade gate + render check. |
| B | H4 + M3 + statutory-table RLS (one migration for payslip/statutory/EA), M2 (owner URL out of web env), M6 (CSV export) | All code/RLS; one migration, one gate. |
| C | H2 (PII encryption + KMS) — its own round; touches every write path for sensitive columns and needs a key-management decision. | Largest change; must not ride along with unrelated fixes. |
| — | M1, M4, M7 and the Low list as hardening; wire into the go-live checklist. | Config/ops decisions (KMS provider, WORM anchor, on-call) are the owner's to make. |

**Decisions only the owner can make:** KMS/HSM provider for PII and the audit anchor; whether the demo
box keeps `ALLOW_DEMO_SESSION` on; and a go-live gate that a customer deployment must never carry the
demo env template.

---

*Assessment run on an isolated worktree + seeded scratch DB; production not attacked. Three passes, 15
subagents + lead verification, each significant finding independently re-checked. This document
describes the system for defensive remediation.*
