# Proposal: Entra sign-in and HR-driven directory provisioning

Status: Owner-authorized implementation candidate. Source and focused verification exist; installation and real Microsoft/AD acceptance remain pending.
Date: 2026-11-02.
Owner requirement: Employee creation should provision a corporate identity and support Microsoft sign-in. Cloud-managed Entra and on-premises Active Directory are both required at launch.

## Context and verified baseline

Enterprise IT should not have to re-enter employees after HR creates them. Employees should use their corporate Microsoft account to enter HR, with the company's identity policies applied.

Source inspected at `e1585acbaa440ff084f64d03d9dc8f83c201df7b`, the fetched common `origin/main` and `origin/alpha` on this date. This is source evidence only; no installation was queried. `lib/identity/config.ts` accepts internal, Keycloak and WorkOS providers, not Entra. `lib/identity/oidc.ts` validates Keycloak-specific endpoints and token claims. It cannot be repointed to Microsoft by changing an issuer. `lib/session.ts` resolves identities through `app.principal_by_identity`; `db/schema.ts` defines `app_external_identity` with issuer/subject bindings. `core/auth.ts` owns invitations and account archive; `core/org.ts` owns personnel operations. These seams need explicit integration, rather than a second employee or permissions store.

This proposal extends [ADR-0117](0117-embedded-hr-authentication.md) with optional enterprise federation. HR continues to own its users, permissions and sessions. Existing internal login remains available according to an explicit organization policy; Entra-only enforcement must be a deliberate, tested cutover with recovery access.

## Proposed architecture

Use two separately configured capabilities: Entra OIDC sign-in and Microsoft API-driven inbound provisioning. An organization can use sign-in with existing directory accounts without enabling account creation. Directory write consent is never a prerequisite for sign-in.

For lifecycle provisioning, prefer Microsoft's inbound service for both targets over separate Graph user creation and a custom privileged AD agent. IT owns mappings, scoping and matching rules in Entra. HR owns the authoritative workforce records and delivers committed changes through a durable outbox.

| Organization mode | Provisioning path | Sign-in path |
| --- | --- | --- |
| Cloud managed | HR → inbound provisioning → Entra account | Microsoft Entra OIDC → existing HR user |
| Hybrid AD | HR → inbound provisioning → customer provisioning agent → AD → configured AD-to-Entra sync | Microsoft Entra OIDC → existing HR user |

Hybrid launch support means AD with Entra connectivity and an installed Microsoft provisioning agent. A disconnected AD-only installation requires a different authentication and provisioning design and is not represented as Entra support. An HR application installed on-premises can use this integration if it can reach the approved Microsoft endpoints; that does not make it an offline feature.

The customer must configure and license the inbound provisioning application, consented service principal, target domains/OUs, matching rules and, for hybrid, provisioning agent and AD-to-Entra sync. Verify the currently supported API version, cloud endpoints, licensing and operation-specific least-privilege permissions during implementation. Microsoft documents upload and provisioning-log permissions; do not request broad directory write access by default. Sign-in and synchronization credentials must be separate, encrypted, rotated and restricted to authorized installation administrators.

## Actors, scope and identity ownership

- Installation identity operator: registers trusted Microsoft endpoints and credentials; cannot gain HR personnel access through that role alone.
- Explicitly authorized tenant integration administrator: selects a provisioner approved for that tenant, tests the connection, configures company scope, managed fields and activation policy. Neither a posted tenant ID nor a company email domain grants authority.
- Authorized HR creator: creates employees in their existing company scope. A published, administrator-approved policy may automatically queue eligible employees; HR creation permission alone cannot alter connector configuration or directory privileges.
- Provisioning worker: processes only committed, authorized, tenant-bound intents under a configured service principal. It cannot assign HR administrative grants.
- Employee: signs in as an exact bound identity and receives only existing effective HR permissions.

Person, employment, HR login and directory account stay distinct. One person with multiple employments must not produce duplicate accounts. Define eligibility across all active employments in the connector's scope; leaving one company cannot disable an identity still required by another. Use a stable, tenant-namespaced source key independent of mutable employee number, email and UPN.

Bind verified Microsoft tenant/object identifiers (`tid`, `oid`) to the exact existing HR user, with trusted issuer and client context. Record protocol `sub` where required; do not assume different clients have identical `sub` values. Never adopt an account by email or create HR grants from Microsoft groups. Existing accounts require authorized explicit linking or an approved migration using immutable identifiers. Customer provisioning matching rules must follow the same rule; email/UPN-only automatic matching is not acceptable.

## Required behavior and acceptance criteria

1. **Connect and test.** A scoped administrator selects cloud or hybrid mode and sees readiness for sign-in, upload, status reconciliation and hybrid sync separately. Wrong tenant, missing consent, unsupported endpoint or unavailable agent blocks activation with an actionable message. A successful upload alone is insufficient readiness evidence.
2. **Create employee.** A committed employee creation queues one provisioning intent when enabled by policy. A saved draft sends nothing. Creating HR records succeeds independently of Microsoft availability; the employee page displays Pending, Processing, Awaiting directory sync, Ready, Needs attention or Disabled. The default is pre-provisioned/disabled until the configured effective activation time. Corporate credential enrollment is IT-managed; HR never emails or logs a reusable directory password.
3. **Confirm completion.** An HTTP 202 means Submitted, not Ready. Reconcile per-record provisioning results, persist the returned target identifiers and, for hybrid, independently confirm the Entra object and exact HR binding before declaring Microsoft sign-in ready. Retry transient throttling/outages using bounded backoff and Retry-After. Handle uncertain submissions by reconciliation before resending; no assumption of exactly-once delivery. Stale worker leases and late responses cannot overwrite newer intent revisions.
4. **Sign in on web and mobile.** Use a maintained OIDC library with authorization code, PKCE, state and nonce; mobile uses the system browser and a one-use app-bound completion exchange. Validate configured issuer, signature, audience, time and Microsoft tenant. Resolve the exact identity binding before issuing an HR session. Graph access tokens and ID tokens are not HR API bearer credentials. Microsoft handles its configured MFA/Conditional Access; a policy failure cannot fall back to internal login. Test deployment/organization switching and callback replay.
5. **Update and leave.** Synchronize only allowlisted HR-owned fields, using effective workforce changes and complete mapped records. A termination queues disablement only when eligibility across employments ends. Revoke HR access at the authoritative effective time even if directory sync is down. Report directory disablement separately; HR logout does not imply Microsoft-wide logout. Rehire requires a reviewed restore/link path; no silent account recreation or hard deletion.
6. **Observe and repair.** The employee account panel shows last attempt, confirmed outcome, sanitized error and scoped retry. Integration administrators see an authorized queue, failed mappings, credential expiry and agent/sync readiness. Audit actor, policy revision, source revision, target and outcome without tokens, credentials or unnecessary HR payloads. Revoking a connector stops unsubmitted work; already submitted work remains visible for reconciliation.

Persist connector configuration/version, source-to-target bindings, outbox intents/leases, per-attempt status and audit references. Tenant-bearing foreign keys, uniqueness rules, RLS and grants apply to every new table. Keep credentials in the private encrypted settings boundary. Allocate migrations through [migration policy](../MIGRATION-ALLOCATION.md); no migration number is reserved by this proposal.

## Scope and trade-offs

Launch includes cloud and hybrid provisioning, existing-account linking, web/mobile sign-in, managed profile updates, effective activation/disablement, reconciliation and administrator recovery. Microsoft 365 licenses/mailboxes, device enrollment, arbitrary security-group management, guest invitations and full directory import are separate capabilities. Creating an Entra account does not promise a licensed mailbox.

The shared inbound service delegates naming, mappings and AD writes to enterprise IT and avoids operating a custom domain-privileged agent. Its costs are Microsoft licensing, asynchronous completion and customer configuration. Direct Graph `/users` creation is a possible later cloud-only adapter, not the default workforce lifecycle route. A custom AD agent would add deployment, credential and patching responsibility and is deferred. Keycloak federation would reintroduce the separate identity server previously cancelled by the owner and is not selected.

## Delivery and verification

Deliver in dependency order: identity/permission contracts and coordinated schema; trusted connector setup and exact account linking; durable cloud/hybrid provisioning and reconciliation; web/mobile federation and session enforcement; effective lifecycle updates and operator recovery. Both directory modes must pass before claiming launch support.

Run focused development checks on standard GitHub-hosted runners under repository policy. Required behavior proof includes two tenants with colliding emails/employee numbers, unauthorized configuration/link/retry, duplicate/concurrent creation, lost upload responses, delayed/out-of-order results, Microsoft throttling/outage, AD agent outage, AD-to-Entra sync delay, existing-account conflicts, future hires, import/revert, multi-employment termination, rehire, credential rotation, forged/wrong-tenant tokens, callback replay and retained-session offboarding. Verify real web/mobile journeys and populated migration rehearsals; apply the release impact classifier before staging. No deployment or production authority is implied.

Launch acceptance: every submitted fixture has a traceable terminal result or explicit actionable failure; repeated employee events create no duplicate directory accounts; no unbound/foreign identity receives HR access; effective HR revocation succeeds during directory outage. Record provisioning latency by mode and sign-in completion rates in the pilot, then set operational latency targets from measured results rather than promise instant hybrid sync.

Customer setup questions: target domains/OUs, naming and immutable matching rules, managed fields, account activation timing, Microsoft cloud and licenses, available AD agent/sync, and authorized IT contacts. These are configuration dependencies; no customer tenant or runtime access was supplied in this request.

## Microsoft references checked 2026-11-02

- [Inbound provisioning concepts](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/inbound-provisioning-api-concepts): HR sources, cloud/hybrid targets, asynchronous reconciliation, complete-record uploads, permissions and licensing.
- [Inbound provisioning FAQ](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/inbound-provisioning-api-faqs): AD target support and distinction from direct Graph user creation and a standard SCIM endpoint.
- [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow): web/mobile code flow with PKCE and OIDC.
- [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference): stable tenant/object identity and mutable email claims.
- [Create user](https://learn.microsoft.com/en-us/graph/api/user-post-users?view=graph-rest-1.0): alternative cloud user-creation operation; not selected as the unified lifecycle route.

## Implementation candidate — 2026-11-02

The owner requested implementation of both directory modes and web/mobile sign-in. Candidate source
lives in `lib/entra`, `app/login/entra`, `app/admin/settings/entra`, `mobile/lib/entra-auth.ts` and the
uninstalled `0899_entra_workforce` migration. See [IT setup and acceptance](../../deploy/entra/README.md).
The first implementation uses a stable generated account name and only displayName/userName/active
plus the immutable source marker. The directory route and source-marker mapping freeze after setup;
changing them needs reviewed migration. The optional federation leaves embedded login available.

The administrator-enabled connector policy authorizes baseline employee HR-user creation only for a
person without any HR user, after its exact newly provisioned directory object is independently
confirmed. Existing HR accounts keep their identities/grants and require explicit linking. Linking
cannot adopt installation operator accounts or another nonemployee account. Uncertain uploads require
an explicit IT-reviewed recovery selection, followed by independent object verification without
resubmission. Rejected upstream operations and transport/consent failures retain distinct retry paths.
Technical connector setup is explicitly English pending customer-language review; employee sign-in
controls/errors use the six existing locales. No source or hosted result establishes installed agent,
real tenant consent/mapping, mobile device or production acceptance. IT will configure test directories
after source verification, as confirmed by the owner.
