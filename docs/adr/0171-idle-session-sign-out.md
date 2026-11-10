# ADR-0171: Configurable idle sign-out for the web app

Status: proposed on branch `claude/idle-session-timeout`; owner decisions recorded 2 November 2026; no
deployment authorized.

## Context

Embedded sign-in (ADR-0117) issues a web session with a fixed 8-hour lifetime and no idle limit, so an
unattended browser stays signed in to HR data for hours. When a session did end, the next client navigation
followed the server's redirect to `/login` inside the still-mounted shell: the login form appeared within the
old sidebar and top bar, which kept showing the signed-out person's name, notification count and menu.

Separate `(auth)`/`(app)` root layouts were built and measured as the structural fix for the second problem.
The release bundle grew from 272 MB to 313 MB against the 285 MB capacity profile, and moving every route
invalidated source-path-pinned evidence (provider-data approvals, System Testing guides, System Labels
provenance, release phase reuse). That branch (`claude/auto-logout-behavior-d9837f`) is retained, not adopted.

## Decision

Each organization's idle limit is a business fact with one owner: `session_policy`, one row per tenant,
written only by that organization's group administrator under the same authority, revision and audit pattern
as the login presentation (`core/session-policy.ts`). No row means 15 minutes. The limit is a whole number of
minutes from 5 to 480 (the absolute session lifetime); there is no "off". The database enforces the bounds.

The embedded sign-in service is authoritative. A web session records its last reported activity. Reading the
session refuses, revokes and audits (`app-user.session-idle-expired`, actor `system`) a session idle past its
organization's limit. Only `POST /login/api/activity`, sent by the shell for real input, moves the clock;
ordinary requests, polling and prefetching never do. Writes are throttled to one per 30 seconds per session,
and the activity operation has its own admission and per-source budget so it cannot crowd sign-in out.
Sessions created before this change start their idle clock on first read instead of ending at deployment.
The limit is read through `app.session_idle_timeout_minutes`, which exposes nothing but the number; an
unreadable policy enforces the default rather than no limit. Changes reach other server processes within one
minute.

`components/session-lifecycle.tsx` is the shell's one owner of how a session ends. It treats keyboard, pointer,
touch, wheel and scroll input in any tab as activity (shared through local storage), reports it at most once a
minute plus once when input stops, shows a one-minute countdown with "Stay signed in", and at the limit revokes
the session and sends every tab to `/login?reason=idle`, which explains the sign-out. It uses the earlier of the
browser's and the server's deadline. It also reloads the document whenever a client navigation lands on a
login-flow route, so no expiry path renders the login form inside the shell.

## Provider contract

`lib/session-activity.ts` defines what one activity report means for any web session, independent of which
provider issued it: `active` (an enforcing provider recorded it and returns the remaining allowance),
`not-enforced` (a live web session exists but no enforcing provider owns it — the shell hides the countdown and
never signs that person out) or `expired` (no live web session, or an enforcing provider just ended it). The
activity route consults enforcing recorders in order, then the live identity across every provider.

A provider with its own web session store (the Entra connector, PR194, which owns that store) adopts the limit by:
recording `lastActivity` on its web sessions; refusing, revoking and auditing its own idle sessions on read with
`idleTimeoutMinutesFor(tenant)`; and adding its recorder to the route's list (returning `null` for tokens it does
not own). Until it does, its users are `not-enforced`, never `expired`. The combined regression that must pass
before both land: a valid federated web session reporting activity is never answered `expired`; once the
provider records activity, the same session ends after the organization's limit and the shell's countdown
appears for it.

## Scope and consequences

- Web sessions on the embedded sign-in only. Native app sessions keep their 15-minute access tokens and
  refresh rotation; mobile idle sign-out is a separate decision. Legacy WorkOS/Keycloak adapters show the
  setting with a note that it is not applied.
- A tab with JavaScript disabled or a failed activity report is signed out at the server limit even while the
  person is working; the failure direction is the secure one.
- The setting appears under System Configuration → Login. Translations other than English need native review.

## Amendment, 2026-11-10: the editor moves to Security Center → Password Policy

Board item f3edc521 (approved plan, revision 1). Decision. The Automatic sign-out editor is shown on
**Security Center → Password Policy** (`/admin/security-center/password-policy`), as the third section after
the password rules and the authenticator code frequency, with its own Save button. It is removed from
**System Configuration → Login & browser appearance** (`/admin/settings/login`), which keeps only the sign-in
page look. This supersedes "The setting appears under System Configuration → Login" above.

Unchanged: the owner (`core/session-policy`), the `session_policy` row and its revision, the 5–480 minute
bounds and 15-minute default, the `session-policy.updated` audit event with the previous value, RLS
(`app.is_group_admin()` and tenant), and the editor set: super administrators and organization-wide HR
administrators. A company-scoped HR administrator is refused by the page guard, the service and RLS on both
the old and the new page. No data moves; the saved value appears in the new place as it is. The form and its
save action keep their files under `app/admin/settings/login/` (the same placement precedent as the
authenticator code frequency), so the agent capability inventory is unchanged; the action now refreshes the
Password Policy page.

Consequence for compatibility providers: Password Policy is offered only with the embedded sign-in, so under a
WorkOS/Keycloak adapter the setting is no longer shown at all (previously it was shown with a note that it is
not applied). This supersedes "Legacy WorkOS/Keycloak adapters show the setting with a note that it is not
applied" above. The limit was never enforced there; the stored value is kept and takes effect when the
installation moves to the embedded sign-in (ADR-0117). The `sessionTimeout.notEnforced` message is no longer
rendered; it is left in the dictionaries because they are part of the owner-approved provider-data source
closure and retiring an unused string does not justify a re-binding.
