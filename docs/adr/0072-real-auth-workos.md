# ADR-0072 — Real per-user authentication (WorkOS AuthKit)

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

Until now the app has had **no real login**. In a hosted deployment it was protected only by a
single shared HTTP-Basic password (`SHARE_PASSWORD`, see `middleware.ts` / `HOSTING.md`), and once
past that gate a **developer identity switcher** let anyone *become* any `app_user` by picking them
from a dropdown (`lib/session.ts` → `resolveDevPrincipal`, `app.dev_principals()`). Acceptable for a
demo; unacceptable for a real customer — there is no notion of "you are you".

This was a deliberate design choice from day one (ADR-0004, ADR-0005): the **entire authorization
substrate** — RLS (ADR-0002), grants/ABAC (ADR-0009), the `app.principal()` bootstrap seam
(migrations 0012 → 0016) — was built to be keyed off an internal `app_user.id`, and the *only* step
left unbuilt was the one that answers "who is logging in". This slice fills exactly that step and
touches nothing else.

## Decision

**Option A — WorkOS AuthKit** (the originally-designed target, ADR-0005). WorkOS owns the
security-sensitive primitives (password storage, reset emails, rate-limiting, optional MFA). We
verify its session and map the verified subject to the right `app_user`. This is the smallest amount
of security-critical code we own.

Concretely:

1. **`app.principal()` is retained unchanged.** The 0016 grants-jsonb signature
   `app.principal(uuid) RETURNS (tenant_id, person_id, grants jsonb)` stays the single live
   definition. A new SECURITY DEFINER `app.principal_by_subject(text)` *wraps* it, resolving a WorkOS
   subject → `app_user` and returning the extra `app_user_id` (because `app.principal` takes the id
   as input and `getSession()` no longer has a cookie id to supply). Grants are preserved verbatim, so
   RLS scope is byte-identical whether the session came from the dev switcher or from WorkOS.

2. **`workos_user_id` keeps its name** (no `auth_subject` rename — speculative provider-neutrality the
   feedback did not ask for, and it would force an additive column + backfill + lockstep updates to
   `seed.ts` and `app.dev_principals()`). A **global** unique index enforces one WorkOS identity = one
   `app_user` (ADR-0002: one person is in exactly one tenant, so a subject maps to exactly one user).

3. **`SessionContext.userId` remains the internal `app_user.id` uuid**, never the WorkOS subject
   string. `db/client.ts` sets `app.user_id` from `ctx.userId`; `app.current_user_id()` casts it to
   uuid; a subject string there would throw on every self-scoped RLS predicate. `getSession()` puts
   the resolved `app_user.id` into `userId`.

4. **`ALLOW_DEMO_SESSION` is retired as a real-tenant bypass.** After this slice, no production code
   path lets the dev shim be the auth: in production `getSession()` verifies WorkOS or throws
   `AuthRequiredError` → redirect to `/login`. The dev switcher stays, gated to
   `NODE_ENV !== 'production'` (the predicate `lib/session.ts` already used).

5. **`SHARE_PASSWORD` Basic gate is left as-is**, except that `middleware.ts` gains matcher carve-outs
   for the auth routes (`/login`, `/callback`, `/invite`, `/reset-password`) so the real login flow is
   reachable even when a hosted demo sets `SHARE_PASSWORD`. The gate's `NODE_ENV === 'development'`
   predicate is untouched.

6. **Invitation-only account creation.** There is deliberately no open self-sign-up (this is how HR
   systems work). An admin invites by email; the invitee gets a one-time WorkOS link, sets a password,
   and the account goes live. A new `app_invitation` table (token *hash* only, single-use + expiring)
   plus a SECURITY DEFINER `app.consume_invitation(raw_token, subject)` runs the un-authenticated
   consume outside tenant RLS (the invitee has no session yet), mirroring the `app.onboarding_*` seam.

7. **Auth-audit substrate.** Pre-auth and cross-context auth events (a failed login by an un-invited
   email; a reset request for an unknown email) have **no** tenant and cannot pass `domain_event`
   RLS (which is `WITH CHECK (tenant_id = app.current_tenant_id())` and `tenant_id NOT NULL`, and
   `ai_hr_app` is non-BYPASSRLS). So a SECURITY DEFINER `app.append_auth_event(...)` writer appends
   these events outside the tenant RLS path — the same pattern as `app.onboarding_*` / `app.principal`.
   Events: `app-user.invited`, `app-user.invitation.accepted`, `app-user.logged-in`,
   `app-user.login-failed`, `app-user.logged-out`, `app-user.password-reset-requested`,
   `app-user.password-reset`. Actor is lowercase (`db/events.ts`: `'user' | 'system' | 'agent' |
   'external'`) — `{ type: 'external' }` for pre-auth events with no resolvable user.

## Consequences

- **Auth events (`app-user` / `app-invitation`) are admin-only to read.** `domain_event` non-admin
  reads are subject-scoped by `subjectEmploymentId` (ADR-0015); these events have no single employment
  subject, so they fail closed (admin-only). A user will **not** see their own login events in a
  per-record History view. Acceptable; a user-visible login trail, if ever required, is a separate
  surface.

- **The authorization suite is unaffected and we prove it.** The RLS/access tests never call
  `getSession()` — they build `SessionContext` by hand and call `withTenant()` directly. As long as
  the `SessionContext` shape and the `app.principal` contract are unchanged (they are), those tests
  are structurally unaffected. The gate for this slice is: the full existing suite stays green with
  **zero edits** to access/RLS tests.

- **We do NOT buy WorkOS Audit Logs (ADR-0006).** Our append-only `domain_event` substrate is the
  audit trail; the auth-audit writer feeds it.

- **`/select-tenant` is not built (ADR-0002).** One person is in exactly one tenant; multi-*company*
  is within one tenant and already handled by the company switcher. A subject resolves to exactly one
  `app_user` (global unique index); zero resolutions → `AuthRequiredError` → `/login`, never a picker.

## Deferred (named so nothing is forgotten)

- WorkOS SSO (SAML) + SCIM directory sync → Phase 2, enterprise-triggered (ADR-0005).
- Passkeys / social login → optional later.
- A post-login "which organisation" chooser → not built (ADR-0002); would need its own ADR + a
  data-model change.
- `auth_subject` rename of `workos_user_id` → not done.
- A standalone `verifyEmail` service → not built under Option A (WorkOS verifies email before issuing
  the session; `getSession()` trusts WorkOS's verified flag).
- Seeding real WorkOS logins for the consultant demo → follow-up, not this slice.
- Any change to roles / grants / RLS predicates / ABAC / `lib/authz.ts` → out of scope; the zero-edit
  green-suite gate enforces it.

## Option B fallback (only if WorkOS is rejected)

Re-plan the login-provider portion on a vetted self-hosted library (better-auth / Lucia / Auth.js
credentials), which would then own `local_credential` (argon2/bcrypt), a single-use expiring
`password_reset_token`, a `login_attempt` table for rate-limiting (written **and** read pre-auth, so
it needs a SECURITY DEFINER counter, same as the auth-audit writer), a first-class `verifyEmail` flow,
and SMTP creds. Every other step (getSession seam, `principal_by_subject`, invitation consume, the
auth-audit writer, i18n, middleware carve-outs, tests) is identical to Option A.
