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
