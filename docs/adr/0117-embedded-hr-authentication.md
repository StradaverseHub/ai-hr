# ADR-0117: First-party authentication inside the HR application

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Status: Owner-directed replacement, 2026-10-15. Supersedes ADR-0098's Keycloak implementation direction. The owner explicitly requires username/password, MFA and password recovery inside the HR app for cloud and on-prem, and cancelled Keycloak activation. No claim of completed activation or device acceptance is made by this decision.

## Ownership and graph

The HR server owns the login experience, credentials, challenges, sessions and password recovery. PostgreSQL is its durable state; no separate identity server or cloud directory is required. Cryptographic primitives come from Node crypto and authenticator calculations from maintained otplib; this does not mean inventing cryptographic algorithms or implementing an OAuth/OIDC authorization server.

Organization code → configured tenant → normalized username → exact local credential subject → existing external-identity binding → existing app_user → grants/person/employments. Namespaces are tenant-specific. Email and organization branding never confer HR access. Preserve all existing internal IDs and grants. Employee creation continues to create an activation candidate; an administrator explicitly enrolls credentials or issues an invitation. Installation bootstrap is an audited operator action selecting an exact existing HR user, not email-based adoption or public registration.

Private authentication records are AES-256-GCM encrypted in the application using a deployment key outside PostgreSQL; purpose binds each record to its exact key. Passwords are salted scrypt hashes inside encrypted credential records. Browser and native credentials are random opaque handles stored only as hashes. Database privileges refuse direct application-role access to the private table. Rate limits, MFA challenges, recovery and token rotation are durable and serialized across workers. The same application/database boundary applies on-prem. Compromise of the application process and its key is a trusted-boundary compromise; encryption is not a promise against that attacker.

## User journeys and acceptance

- Web and native: organization, username and password; temporary password change; authenticator enrollment with QR/manual key; actual OTP confirmation; one-time backup codes; subsequent OTP or backup-code login. A partial challenge grants no HR access. Failed, expired and replayed challenges are refused.
- MFA is required for enrolled accounts. TOTP uses 30-second steps and bounded clock tolerance; successful steps cannot be reused. Recovery codes are independently random, hashed and consumed atomically.
- Recovery: generic response whether the account exists, per-account limits, single-use short-lived mail link through the installation's tested SMTP settings. Existing MFA remains required; resetting a password does not disable MFA. Successful reset revokes all prior sessions and challenges. No raw token, password, OTP or recovery link enters logs/audit. The delivery ledger records the destination address within its existing administrator scope; recovery history is restricted to the exact installation operator. SMTP activation never replays held account failures. Explicit retries retain the original organization/account binding and mint a fresh link.
- Administration: existing role/company restrictions govern manual enrollment; local provider creates disabled credentials, commits exact identity/HR binding, then enables. Repeat/resume never resets a live password. Preserve pending employee and invitation workflows without adopting identities by email.
- Deployment isolation: runtime company profiles select only trusted application endpoints. Switching deployment clears session/device/drafts and prevents stale completions. Native tokens are isolated by organization/installation and accepted only by the selected app server.
- Live revocation: archived/offboarded HR accounts, revoked identity bindings and removed grants apply during each session resolution. Authentication failure never falls back to demo access.
- Installation: explicit internal provider configuration, operator bootstrap, key backup/restore and rotation procedure, owner MFA enrollment, tested SMTP, TLS and secure cutover/rollback. Certificate renewal remains infrastructure work, independent of the cancelled Keycloak route.

Verification must include actual browser/native journeys, two organizations with colliding usernames, concurrent OTP/recovery/refresh replay, forged/expired records, anonymous refusals, role escalation and cross-tenant invitations. Focused cryptography/state tests do not establish UI or deployment acceptance. Existing Keycloak/WorkOS adapters remain inactive compatibility code until a separately verified cleanup; never activate or automatically fall back to them in internal mode. Enterprise SSO federation/passkeys are separate capabilities, not silently represented as implemented by local passwords and MFA.

## Signed workplace onboarding — 2026-10-23

The owner requested one mobile app that connects by QR code or setup link to an exact cloud or
on-prem installation and organization. Extend the existing signed company profile with an optional
canonical `organization` code for embedded authentication. The operator signs this alongside the
installation addresses; it does not carry a tenant UUID, identity, password, invitation or grant.
Existing profiles without the field retain their original behavior and credential storage namespace.

Offline operator tooling produces a signed setup file, an HTTPS fragment link and its QR image. The
installation's public `/login/mobile-setup` page hands off through the existing app scheme only after
an explicit tap. This requires no central directory or per-client associated-domain app rebuild. The
app verifies its installed signing anchors and asks the employee to review the workplace, server and
organization before changing anything. A confirmation uses the existing session/file/device cleanup;
review retains the mounted session/draft providers while closing private screens. Cancel, including
Android Back, preserves employee drafts and attachments as well as credentials and saved selection. A new incoming link cannot
automatically select a different tenant. Organization-bound profiles add the organization to the
credential namespace, preventing a shared cloud URL/profile ID from reopening another tenant's stored
credentials. Login uses that signed organization with username/password and the normal MFA process.

Cloud and on-prem share this contract. Reachability, VPN and phone-trusted TLS remain installation
requirements. The setup is public routing information, not proof of membership; the server still
resolves the exact existing HR identity and grants. Production authentication remains dormant until
valid origin TLS, supported operator runtime, private key/database backup, owner setup and reviewed
activation prerequisites pass. This decision does not assert production activation or physical-device
acceptance.

## V9 lifecycle sender bindings — 29 October 2026

The owner-pinned V9 application has three business senders: HR Onboarding, Human Resource Department and Kingdee AI HR. Their production addresses come from confirmed SMTP connections; prototype mailbox addresses are never credentials or sender authority. The existing enrolled installation email operator configures these through the same encrypted settings owner, not through an HR role or posted tenant ID.

A binding stores a confirmed connection-version snapshot under the actual tenant and business profile. It requires the selected current connection version, the same operator's successful test within 30 minutes, explicit receipt and an unchanged sender-binding revision. Editing a saved connection leaves its working confirmed snapshot intact and visibly pending. Another binding change invalidates stale test receipts. Applying a lifecycle binding preserves the installation default used for account recovery and other email. An unbound profile follows that default. Compatibility providers do not advertise or accept this new binding operation.

The private lifecycle sender chooses the frozen message profile in its actual tenant, reads only a confirmed snapshot or applied default, and rechecks its revision before committing SMTP start. The durable private proof records the actual sender address/profile and relay revision without secrets. Neither a template nor the browser posts credentials or an arbitrary From address. This is a candidate implementation amendment; testing, merge, installation and staging acceptance remain separate, and it grants no production deployment authority.


## Optional Entra federation and workforce provisioning — 2 November 2026

The owner requested Microsoft Entra login on web/mobile and HR-driven provisioning to both cloud
Entra and on-premises AD from launch. Implement this as an optional capability alongside embedded
HR authentication. HR still owns users, permissions, session revocation and effective employment
eligibility. Microsoft owns its credentials and configured MFA/Conditional Access. No email-based
adoption, Microsoft-group-to-HR-role inference or activation of the compatibility providers is allowed.

An explicitly administrator-enabled provisioning policy may create baseline employee logins for
newly provisioned people after exact immutable directory verification; it cannot adopt an existing HR
login or grant administrative access. Existing logins require explicit ownership-verified linking.
See the [Entra candidate decision and scope](entra-workforce-integration-proposal.md) and
[IT setup](../../deploy/entra/README.md). Source implementation and hosted checks are separate from
real tenant/AD acceptance and installation. No deployment authority is added by this amendment.

## Configurable password expiry and reuse prevention — 2 November 2026

The owner requested recurring password changes with a configurable number of days or months and
no reuse of previous passwords. Embedded authentication owns this policy per tenant. Organization-wide
HR administrators and super administrators configure it in System Settings → Login; company-scoped
administrators and employees cannot edit it. The service verifies the current database principal and
group grant, derives the tenant from the authenticated session, rejects stale revisions, and commits
an audit event with the policy. Compatibility identity providers continue to own their own policies.

Expiry is initially disabled to avoid an unannounced installation-wide lockout. Administrators may
choose 1–3,650 elapsed days or 1–120 calendar months. Month arithmetic uses the HR calendar in
Asia/Kuala_Lumpur, preserving wall-clock time and clamping the day to the last valid target-month day.
A policy edit applies to existing credentials and sessions immediately, using the last successful
password assignment time. Legacy credentials without a recorded date require a change when expiry
is enabled. Expired credentials cannot resolve browser/native sessions, rotate refresh tokens, or use
other services guarded by the canonical active-credential check. Login verifies existing MFA before
issuing the password-change challenge, then revokes old sessions/challenges when a new password is set.
No recurring scheduler or privileged bypass session is needed.

All subsequent password assignments (required changes, recovery, and disabled-account enrollment)
refuse the current password and every password recorded by this feature. Bootstrap and invitation
credentials record their assignment time; their first replacement retains the original scrypt hash.
A random per-subject history salt is encrypted in the existing private auth record store. History
fingerprints run the same scrypt parameters as login, then SHA-256 for bounded record keys. Markers
are namespaced by subject; each marker persists as its own encrypted,
non-expiring record, permitting constant-cost indexed history lookup without plaintext, growing
credential blobs, or trimming old passwords. The original pre-history password remains covered by
its encrypted salted scrypt hash. History cannot recover passwords used before tracking began.
History creation and markers share the subject-locked password transaction; rejected/replayed changes
cannot consume recovery factors, alter history, or partially replace a credential. Session revocation
and expired-record pruning preserve history. The per-subject history salt stays encrypted across
deployment-key re-encryption. As in the existing boundary, application-process/key compromise can
expose decrypted authentication material; history markers do not claim to protect against that attacker.
Disabling expiry preserves reuse protection. Existing recovery still requires MFA and revokes sessions.

This amendment describes the source candidate; hosted checks, installation and rendered acceptance
remain separate evidence. It grants no production deployment authority.

## Operator sign-in reset after a lost authenticator — 3 November 2026

The owner approved an operator-only reset after a production user lost both their authenticator and
their one-time backup codes. Password recovery deliberately keeps MFA. Before this amendment, no
supported path restored that account: an HR administrator could not do it, and editing the encrypted
records directly would corrupt them.

The installation operator runs `deploy/internal-auth/reset-sign-in.sh` on the server, using the same
migration/schema-owner connection boundary as owner bootstrap. There is no HTTP route, HR role or
mobile operation that performs this reset. The operator enters the organization code and exact username.
The command shows the resolved HR user, email and grants with a confirmation code bound to the
credential's current version. The operator confirms that they verified the person's identity outside
the system. The command then reads a temporary password privately from stdin.

One subject-locked transaction validates the tenant password policy and history. It replaces the password,
requires a change at next sign-in, and removes the authenticator secret, used-step marker and every
backup code. It rotates the credential version, revokes all sessions, refresh families and challenges,
cancels an outstanding recovery link, and clears a login lockout. It appends the
`app-user.operator-sign-in-reset` audit event with no secret. The HR user, person, employments, grants,
identity binding, password history and internal IDs are unchanged. An archived or offboarded login, a
disabled pending enrollment, or a stale confirmation is refused. The next sign-in follows the normal
password-change and new authenticator enrollment, and issues new backup codes.

This is not a support impersonation path or an email-only MFA bypass. The operator never sees an OTP
or session and never receives a link. Hosted checks, staging acceptance and a separately authorized
production release remain required before use.
