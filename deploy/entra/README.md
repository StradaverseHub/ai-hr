# Entra sign-in and workforce provisioning

Candidate source only. No Microsoft tenant, AD domain, agent or installed service was configured by
this implementation. Cloud and hybrid acceptance require the real customer fixtures below.

## Prerequisites

Use the embedded HR provider (`AUTH_PROVIDER=internal`) and its reviewed HTTPS origin, encryption key,
bootstrap and recovery procedure. Back up the database and authentication key together. Apply the
coordinated Entra migration above the installation's actual watermark before running this source.
Internal login remains available; this increment does not enforce Entra-only sign-in.

An HR group administrator configures **Administration → Settings → Microsoft Entra ID**. Company-only
admins cannot configure or link identities. Connect one Microsoft workforce tenant to one HR tenant.
The saved directory tenant, organization code, provisioning job, account domain, source-marker field and cloud/hybrid mode are immutable; changing them
requires a separately reviewed migration. Credentials and revision are stored atomically, encrypted
under the installation key. Blank password fields retain saved credentials. Saving rotates the
connector revision and invalidates all existing Entra HR sessions. Existing internal sessions retain
their ordinary credential/revocation behavior.

### Sign-in registration

Create a confidential web application in the customer's Microsoft tenant. Register exactly
`https://<HR-origin>/login/entra/callback` as a Web redirect. Configure its client ID and secret in HR;
only `openid profile` is requested. Sign-in-only deployments do not need a provisioning registration, Graph write consent, account domain or target source marker. Provisioning can also operate while Microsoft sign-in is disabled; that mode does not create HR logins. The mobile app also uses this server callback and never contains a
Microsoft client secret. Set the installation's comma-separated `ENTRA_NATIVE_REDIRECT_URIS` to its
reviewed native application redirect URIs; the default is `aihr://auth/callback`. Do not add a wildcard.
The signed workplace configuration remains the owner of the selected HR server and organization.

### Provisioning registration

Create a separate API client/service principal and an API-driven inbound provisioning Enterprise App
for the appropriate target: Microsoft Entra ID or on-premises Active Directory. Configure the target
provisioning service principal ID and synchronization job ID in HR. Grant administrator-consented
upload permissions and provisioning-log read permissions according to the current Microsoft API
reference; the worker additionally needs user read permission to verify the resulting Entra object.
Do not grant directory write, password-reset, license or group-management permissions to this client.
The connection test checks discovery and token acquisition only; it does not prove upload consent,
attribute mappings, AD agent health, sync or employee login.

Configure **externalId as the sole matching key**, never email/UPN. The HR source ID is
`aihr:<tenant UUID>:<person UUID>`, independent of employee numbers and contact addresses. Configure
these managed fields only:

| HR source | Directory target |
| --- | --- |
| externalId | Immutable matching key and the source marker below |
| userName | UPN / sign-in account name |
| displayName | Display name |
| active | Account enabled state (or the corresponding AD disable mapping) |

Names are stable `hr-<person UUID without hyphens>@<verified domain>`; this increment does not offer
customer-defined username patterns, manager mapping or email address provisioning. Do not enable null
flow for unmapped attributes. Each upload is the complete record for these managed attributes.

For cloud targets, create a directory extension named `hrSourceId` and map externalId to it; configure
its full Graph name `extension_<extension app ID without hyphens>_hrSourceId` in HR. The worker checks
this marker after provisioning before adopting a new identity. Configure it as an administrator-owned
attribute, not an employee-editable profile field.

For hybrid targets, install Microsoft's provisioning agent with reviewed least-privilege AD
permissions and target OU/scoping. Map externalId into a suitable AD extensionAttribute1–15 and sync
it to Entra. Configure the corresponding `onPremisesExtensionAttributes.extensionAttributeN` in HR.
Ensure the AD schema, agent mappings, verified UPN suffix and Entra Connect/Cloud Sync configuration
support the chosen field. The worker waits until the Entra object exists, has the exact source marker
and reports on-premises sync enabled. A successful AD write alone is not Entra sign-in readiness.
Disconnected AD-only installations and sovereign Microsoft clouds are outside this connector's
current supported endpoint profile. Cloud and on-premises HR installations both require Microsoft
egress for this capability.

## Employee lifecycle

Enabling provisioning and saving the connector queues existing employees. Committed employment
inserts/updates and person name/void changes queue subsequent work in the same HR transaction.
Rolled-back hires produce no account. The worker evaluates effective dates using the HR calendar
and all non-voided employments; ending one of several active employments does not disable the person.
Future hires are provisioned disabled and enabled when eligible. No directory account is hard-deleted.

After a confirmed directory object is verified, a person with no HR user receives one baseline
employee user with company-scoped employee grants. Existing HR users require explicit linking;
existing grants and local credentials are preserved. Use the exact existing person, HR user and
Microsoft object IDs after verifying ownership. A group admin may link their own account or an
employee-only account. Installation operator accounts cannot be linked through this path, and
nonemployee accounts cannot be adopted by another administrator. Missing/bad links grant no access.

HR authorization and effective offboarding are checked on every Entra HR session read, including
mobile access and refresh, independently of Microsoft availability. Disabling the connector or
changing its revision invalidates its sessions. A local credential reset/version change also invalidates Microsoft HR sessions issued while that credential was bound, preserving the existing recovery revocation rule. Microsoft MFA/Conditional Access is handled by the
Microsoft sign-in flow; HR never captures the Microsoft password or claims to revoke Microsoft-wide
sessions at HR logout. Local HR logout revokes the opaque HR session family.

## Worker setup and operation

Install the example oneshot service/timer only through the normal reviewed installation procedure.
Adjust the actual service account, application path and absolute supported Node path. Its private
`/etc/ai-hr/entra-worker.env` must include the application's restricted `DATABASE_URL`,
`AUTH_PROVIDER=internal`, `AUTH_PUBLIC_ORIGIN` and `AUTH_SESSION_KEY`. Protect it as an installation
secret. The worker needs the runtime `tsx` dependency; an installation packaging dependencies without
it must bundle the worker before enabling this service. There is no public worker HTTP endpoint.

The timer runs bounded batches. Rows have exclusive leases and revision checks. HTTP 202 is Submitted,
then per-record provisioning logs establish the directory result. Account readiness separately checks
the exact Entra source marker. Stale receipts cannot confirm a newer HR revision. Throttling observes
bounded Retry-After. Uncertain uploads without a receipt are held for IT reconciliation instead of
blind replay; never clear that hold merely because no user appears immediately. Configure alerts for
Needs attention and Outcome uncertain. A service restart does not imply its timer was installed.

The administration queue currently shows the latest 500 rows. Rejected records can be resubmitted after IT repairs their mappings; other failed rows retry their retained receipt when one exists. For uncertain outcomes, IT first reconciles Microsoft logs, then uses the selected recovery action; the worker verifies the actual source-marked object without resending creation. Do not edit queue rows or
rebind users directly in SQL to bypass that review. Secrets, access/refresh tokens, verifier codes
and raw Graph errors must not enter logs or tickets. Queue/audit history contains identifiers and
sanitized status, not credential payloads.

## Verification before enabling for employees

Run the authored database, transport and sign-in checks and web/mobile compilers on hosted runners.
Then verify actual cloud and hybrid fixtures: create/update/future activation/offboard; two tenants;
multiple employments; existing-user linking; duplicate retries; revoked grants; wrong issuer/tenant
and forged tokens; state/nonce/PKCE and native return replay; secret rotation; agent/sync outage;
Microsoft throttling; upload timeouts; logout; retained mobile sessions and installation switching.
Rehearse populated migration and key/database restore. Complete the required security/data release
gate, staging acceptance and customer IT setup before claiming this integration installed or ready.

The technical connector setup screen currently renders explicitly in English. Microsoft sign-in controls and errors are localized for the six existing employee languages; customer-language review of the connector instructions remains required before a localized rollout.


## Shared idle-session contract (PR #196)

The integrated candidate uses the same organization idle limit as embedded login (default15 minutes,
configured5–480). Microsoft web sessions record user activity in their own encrypted session store;
ordinary page reads/polling do not extend that clock. The existing activity endpoint resolves the actual
provider before refusing a cookie, so a fresh Microsoft session is not cleared by the embedded-credential
lookup. Family locking serializes activity and expiry; expired sessions cannot be revived. Sessions
created before activity tracking start their idle clock once on first read. Native sessions retain the
existing access/refresh and absolute-lifetime contract and do not use the web-only idle timer.

The merged candidate preserves0898 before0899 and requires its own complete gate. Password-policy
PR #193 remains separate: local credential version changes revoke Microsoft HR sessions, while
Microsoft owns its own credential-expiry/MFA policy. Integration against any changed release baseline
must revalidate these auth boundaries and both migration identities.
