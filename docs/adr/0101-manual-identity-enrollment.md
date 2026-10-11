# ADR-0101: Administrator-created usernames and temporary passwords

Status: Accepted, 2026-10-11. The owner explicitly requested an Admin → Users option for manually assigning a username and initial password. This extends ADR-0072's invitation-only enrollment without enabling self-registration, and consumes ADR-0098's deployment-owned identity.

## Ownership and authorization

Keycloak owns usernames, password hashing, password policy, first-login password changes and authentication. The HR application owns people, internal user IDs, grants and company scope. A manually created account must target an existing person with an active employment. It is never linked by matching an email claim. The exact issuer and returned provider subject are bound explicitly to the chosen internal user.

Only a verified Keycloak session that resolves to the current internal user, with a live group-administrator grant, may operate this workflow. Company-scoped administrators, employees, demo sessions and WorkOS sessions cannot use it. Database helpers recheck live grants, tenant ownership and the actor's enrolled issuer; the private enrollment table is inaccessible to the web database role. The existing realm-scoped invitation service credential performs provider user operations; it receives no master-realm or HR permissions. Web-process compromise remains inside the trusted identity-administration boundary, as with the existing invitation client.

Existing provider usernames or emails are never adopted, reset or deleted on the strength of a search result. Existing real HR logins, archived accounts, any previously enrolled identity (including revoked mappings), ambiguous person logins and placeholders carrying grants beyond the requested role/scope are refused. A legitimate unactivated placeholder can retain its internal ID and eligible grants. The existing invitation-confers rule remains authoritative. Both invitation consumers and manual enrollment take the same person row lock to serialize binding; applied migrations are not edited.

## Manual ownership verification

SMTP is not a prerequisite. The administrator must explicitly attest that they have verified the person's identity and ownership of the specified email address, and will deliver the temporary password privately. Keycloak's verified-email flag records this administrator attestation, not a claim that an email challenge occurred. The attestation is audited. Ordinary emailed invitations retain their existing recipient-verification requirement. No automatic email/domain-based linking or public registration is introduced.

## State and failure handling

The private enrollment intent stores only the requested person, username, email, role/scope, actor, issuer, exact returned subject and progress. It is workflow history, not the authoritative login directory. It contains no password, mail token, invitation token or provider access token.

1. Reserve the immutable request and commit its ownership attestation before provider mutation. A request-ID advisory lock and enrollment row locks serialize repeated/concurrent submissions. Other administrators in the same group can resume an unfinished request.
2. Create a disabled provider identity **without credentials**, refusing any existing username/email. Persist the exact ID from the successful creation response before a password mutation. A lost creation response or database commit can leave an unlinked, disabled provider account. The application deliberately refuses to adopt it by username; an installation administrator must inspect and reconcile that exceptional case.
3. Read back the exact disabled, local, non-service account. Set the submitted password as temporary, verify `UPDATE_PASSWORD`, then commit the internal user, exact identity binding, authorized grant and linked status atomically. The password exists only in the submitted request and provider request; it is never stored in HR data, URLs, audit payloads or returned UI state. Blank/short credentials cannot silently become permanent passwords.
4. After the binding transaction commits, enable the identity and read back the result. Record successful completion only after confirmation. A failed or lost activation response leaves a resumable linked intent. A retry of a linked or completed request never resets the password; an already enabled account is only reconciled.
5. Cancellation is offered only before linking. It deletes only an exact recorded, still-disabled account and verifies deletion before committing cancellation. Unknown creations are never deleted by search; cancelling their local intent does not claim provider cleanup. Linked accounts use the existing HR archive lifecycle rather than this cancellation path.

The user must change the password at first sign-in. Password validation follows the installation's Keycloak policy, with a 14-character minimum at the form/service boundary. MFA and subsequent email changes remain governed by identity policy. Existing account password-reset and username-edit administration are separate future workflows; manual creation is not a backdoor to either.

## Delivery limits

The option can be shown with an explanatory unavailable state in the current demo. Mutations become available only after secure internal-authentication cutover; this release must not bypass the outstanding origin TLS and human owner password/MFA steps. Local/disposable provider acceptance is not evidence of production owner enrollment, public cutover, real employee account creation or private-network/device acceptance.

Provider behavior checked against the pinned [Keycloak 26.8 Admin REST API](https://www.keycloak.org/docs-api/26.8.0/rest-api/index.html) and actual disposable service. No custom password hashing or direct password-grant login is implemented in HR or the native app.
