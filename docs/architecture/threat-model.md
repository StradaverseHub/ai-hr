# Threat Model — Slice 0 (STRIDE-lite)

Scope: the v1 surface — multi-tenant org/leave data behind WorkOS auth, Next.js handlers,
and Postgres + RLS. AI, payroll, and attendance are out of scope here and get their own
threat models when scheduled (each imports new, serious risks — e.g. PII-to-LLM leakage,
financial tampering, GPS spoofing).

## Assets

- Employee **PII** (identity, contact) and the org graph.
- **Tenant isolation** boundary (the crown jewel — a breach here is existential for a SaaS).
- Leave records and the audit log's integrity.
- Auth sessions / WorkOS tokens.

## Trust boundaries

Browser → Next.js (server actions / route handlers) → Postgres. WorkOS is an external IdP.
The **only** place tenant/user identity is established is the authenticated session on the
server; the client is never trusted for `tenant_id`, `user_id`, or roles.

## STRIDE

| Threat | Vector | Mitigation |
|---|---|---|
| **Spoofing** | Forged session / stolen token | WorkOS AuthKit sessions; short-lived, httpOnly, SameSite cookies; verify on every request server-side |
| **Tampering** | Editing effective-dated history; mutating the audit log | Append-only versions (close+insert); audit log is INSERT-only via grants/RLS; integrity constraints in DB |
| **Repudiation** | "I didn't approve that leave / make that change" | Every state change emits a `domain_event` with a real actor from the session ([ADR-0006](../adr/0006-event-and-audit-substrate.md)) |
| **Information disclosure** | **Cross-tenant read**; IDOR across employees; PII in logs | **RLS default-deny** keyed off session `tenant_id` ([ADR-0002](../adr/0002-multitenancy-rls.md)); ABAC row policies ([ADR-0004](../adr/0004-authorization.md)); PII scrubbed from logs/events |
| **Denial of service** | Expensive recursive org/as-of queries; request floods | Recursion depth guard on graph traversal; pagination; edge rate-limiting (basic in v1, hardened later) |
| **Elevation of privilege** | App bug skips an auth check; SQL injection; RLS bypass | DB is the backstop (app role is **not** `BYPASSRLS`); parameterized queries via Drizzle; Zod validation at boundaries; deny-by-default on new tables |

## Top risks, ranked

1. **Cross-tenant data leakage** — highest impact. Primary control: RLS, *tested* with
   explicit cross-tenant deny cases (AC-UC8.1). Secondary: app-layer tenant scoping for UX.
2. **Broken object-level authorization (IDOR)** between employees in the same tenant.
   Control: ABAC RLS policies + deny-path tests (AC-UC9.1).
3. **Connection-pool session bleed** — `SET LOCAL app.*` leaking across requests if pooling
   isn't transaction-scoped. Control: transaction-scoped sessions; verified in integration.
4. **Audit gaps** — a write path that forgets its event undermines the whole trail. Control:
   review grep of writes vs `events.append`; treat as a release blocker.

## Compliance notes (PDPA / GDPR-aware, not yet certified)

- **Data minimization:** collect only what Slice 0 needs; no biometrics (deliberately
  deferred — special-category data multiplies liability).
- **Right to erasure vs. retention:** noted as a real future tension (payroll/audit records
  have legal retention that conflicts with deletion requests). Resolved later via legal-
  basis + retention policy + crypto-shredding; **out of scope for Slice 0** but recorded so
  it isn't forgotten.
- **Access logging of PII reads** (not just writes) is a future control for the security
  slice; Slice 0 logs state changes only.
