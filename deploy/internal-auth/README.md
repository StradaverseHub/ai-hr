# Embedded HR authentication

The owner cancelled Keycloak activation on 2026-10-15. Use `AUTH_PROVIDER=internal`; no identity-service process, OIDC discovery, `/identity` proxy or cloud identity dependency is required. ADR-0117 owns the design. The old Keycloak activation helper on the current server is disabled. Its installed service and legacy tables are retained for reviewed cleanup rather than destructively removed.

## Installation and owner enrollment

Deploy the tested additive release and migration `0543_embedded_authentication` first, preserving current access. Do not seed or replace HR data. Authentication needs a canonical HTTPS `AUTH_PUBLIC_ORIGIN` and a fresh 32-byte hex `AUTH_SESSION_KEY`; keep the key outside the database and source/build archives. Back up the app environment privately before changing it. Losing that key makes stored credentials, authenticator secrets and SMTP credentials unreadable. Do not rotate it by simply changing the variable; a controlled decrypt/re-encrypt migration and session revocation is required. Restore needs the matching key and database backup together.

Organization codes are operator-owned login namespaces, not grants. A cloud deployment may host many codes; an on-prem installation may configure `AUTH_DEFAULT_ORGANIZATION` for convenience. Every code binds exactly one existing tenant. A code cannot be reassigned to another tenant, and existing namespaces cannot silently change. Phones can scan an operator-issued workplace QR code, open its HTTPS setup link, or import the signed setup file. The app reviews the signed server and organization before saving them; the selected organization then supplies the credential namespace for username/password and MFA. Cancelling the review preserves the employee session, drafts and attachments. The offline setup command and distribution requirements are documented in `mobile/README.md`; generation does not activate authentication or create tenant membership.

Run `sudo bash deploy/internal-auth/bootstrap.sh` as the installation administrator from `/opt/ai-hr`, with a root-owned mode-0600 deployment env file and Node.js 22.13+ or 24 LTS. It prepares missing public origin/key settings, asks privately for the owner username, email, organization and temporary password, and invokes the audited owner CLI using the migration connection. The CLI selects an exact existing active group administrator by internal UUID and preserves all HR IDs/grants. An explicit installation-owner option enrolls installation SMTP authority; ordinary customer administrators must not receive it. For a fresh customer, first run the guarded customer provisioner, then pass its exact returned administrator UUID and private activation file to the enrollment helper. It consumes only that pending first-administrator invitation, creates exactly its intended grant and retains the provisioned user/person IDs. Existing exact enrollment is idempotent and never changes a live password or MFA. The current reviewed owner HR UUID is `22222222-2222-2222-2222-222222222222`; that is specific to this installation, not a customer seed.

Only after verifying TLS and owner enrollment, select `AUTH_PROVIDER=internal`, set `ALLOW_DEMO_SESSION=false`, validate `internalConfig()` and restart the already-built app. Every account's initial login must change its temporary password and prove a newly enrolled authenticator. Owner interaction is required; do not collect their password, OTP, QR or recovery codes in chat or logs. The app refuses every HR session until that completes. Keep an explicit operator rollback to the backed-up demo configuration available; there is no automatic demo fallback.

The installation’s public origin is configured privately. Historical checks found its origin certificate expired on 2026-05-12 and HTTP certificate validation timed out through Cloudflare. Those observations do not establish that TLS is repaired. Replace the origin certificate and verify hostname/trust/expiry, and verify Cloudflare's origin certificate validation before production activation. The direct app upstream remains port 3000; do not route login through the cancelled Keycloak edge. DNS-based issuance is an alternative to HTTP validation when upstream port 80 forwarding is unavailable. The operator-configured `repair-current-origin-tls.sh` helper installs the distribution Cloudflare plugin, captures a zone-restricted DNS token privately, validates the new certificate/key before reload, retains a private rollback copy and rehearses automatic renewal. Its generated renewal hook is root-owned outside application source. It does not activate authentication or alter Nginx routing. The token permission and INI format follow the [Certbot plugin documentation](https://certbot-dns-cloudflare.readthedocs.io/en/stable/); Cloudflare origin validation must then be verified as [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

## SMTP and recovery

After verified owner sign-in, use Admin → System Settings → Email delivery. Internal mode owns an encrypted SMTP draft/active configuration in the HR database and uses the app's Nodemailer transport; it does not read Keycloak's SMTP settings. Draft testing sends only to the enrolled operator's verified address, and activation requires explicit receipt confirmation within 30 minutes. SMTP credentials are never reflected in the UI, logs, audit or mobile app. This implementation supports implicit TLS with certificate/hostname verification; a STARTTLS-only relay requires explicit additional support.

Password recovery uses organization plus username, always returns a generic known/unknown-account response, and commits a delivery request before attempting a 30-minute single-use link. Failed or uncertain requests stay held in the shared account-email ledger. Enabling SMTP never replays them; an installation operator must explicitly select and confirm each retry. The original organization, credential subject and version are bound in authenticated ciphertext, so shared email addresses cannot redirect a retry. Each selected attempt generates a fresh link and invalidates the previous one. The raw token travels in a URL fragment; the web page removes it from history and submits it only in a JSON POST. GETs and link scanners never consume it. Existing MFA or a recovery code remains necessary. Changing the password revokes all sessions/challenges and does not remove MFA. Backup codes are one-time and displayed only at authenticator enrollment; keep them privately. No support impersonation or email-only MFA bypass exists.

There is no automatic authentication-email retry worker. Expired record pruning runs separately as the migration owner using `select app.internal_auth_prune()`; never put owner database credentials into the web service or run application-writable source as root in a scheduled job. The supplied `aihr-auth-prune.service` and timer run only the installed PostgreSQL client and fixed cleanup SQL. An operator must create root-owned mode-0600 `/etc/aihr/auth-maintenance.pg_service.conf` with section `[aihr_auth_maintenance]`, the exact owner connection fields, and verified TLS for a remote database; then install the units root-owned into `/etc/systemd/system/`, daemon-reload, start the service once, inspect its result, and enable the timer. Credentials stay in that private service file, never in the command line or web environment. This scheduler has not been installed merely by deploying the source. Workflow notifications reuse their existing consent, event cutoff, recipient freshness and delivery-lease rules with the HR-owned SMTP transport; their existing dispatcher is separate from account recovery.

Public recovery commits its exact request/context before acknowledging it, then schedules only that new request's single delivery attempt with Next's post-response lifecycle. SMTP latency does not delay the public confirmation; a short minimum response time covers ordinary account-lookup differences. This is not a constant-time guarantee during database outages or overload. If the process stops before the attempt completes, the existing expired-lease rules hold the request for an operator's selected retry. No periodic worker replays it. This follows the response-enumeration guidance in [OWASP's recovery cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Acceptance and limits

Verify actual owner login/MFA/logout, browser and native expiry/revocation, a second organization with the same username, role/company refusals, verified SMTP receipt, password recovery and invitation enrollment. Rehearse database/key restore in an isolated installation. On-prem needs customer DNS/TLS and phone reachability via local network/VPN; signed company setup files do not install a CA or bypass TLS. The standard binary expects a certificate trusted by the phone’s system store. A registered DNS name with a publicly trusted certificate can resolve privately and use DNS-based issuance. A private-CA Android deployment needs a separately reviewed, domain-scoped enterprise app trust configuration; adding a user CA alone is insufficient for modern Android defaults ([Android documentation](https://developer.android.com/privacy-and-security/security-config)). Login/MFA require no external identity provider; mail delivery can use an internal relay. Physical device, blocked-egress, restored-state and production owner acceptance must each be recorded separately from local tests. Enterprise federation/passkeys and legacy-service removal are separate work.

## Request abuse protection

Apply migration `0613_request_abuse_budgets` before the server version using it. Mobile API budgets
are shared PostgreSQL token buckets, scoped by authenticated tenant/user and read/write class.
Reads allow a burst of 180 with a three-per-second refill; writes allow 30 with a half-per-second
refill. Device-registration requests additionally allow five with a five-per-hour refill. Local
admission caps outstanding mobile requests at 24 (12 per actor, 16 per trusted source)
and auth requests at eight (four per trusted source) per process. These are
resource limits, not authorization or an attestation verdict. A failed shared budget store returns
503; exhausted capacity returns 429 and Retry-After. Existing v1 error codes remain compatible.

Source fairness requires a reviewed ingress. Include `abuse-http.conf` once under nginx `http {}`,
and the matching `abuse-auth-location.conf` / `abuse-mobile-location.conf` inside the installation's
existing proxy locations. Preserve existing canonical host/protocol, TLS and proxy settings. Set a
10-second `client_header_timeout` and a bounded `keepalive_timeout` at the server level. Start with
the supplied bounded defaults and measure legitimate shared-office/mobile-carrier NAT bursts before
widening rollout. These snippets are installation inputs, not evidence that a live proxy uses them.

Only after verifying that the public ingress OVERWRITES `X-Aihr-Request-Source`, strips a forged
client value and has no reachable bypass to the application listener, set
`AIHR_TRUST_REQUEST_SOURCE=1` in private server configuration and restart the accepted server build.
Never infer this setting from an incoming header. For a tunnel/proxy, configure real client-IP
restoration only for its verified source networks; `$remote_addr` otherwise remains the immediate
peer and may group all users together. Do not trust arbitrary X-Forwarded-For or enable trust merely
to avoid that grouping. Keep the application listener private/loopback.
With trust enabled, a missing, malformed or multi-address source header refuses admission with 503;
it cannot silently disable the source budget.

With verified source admission, shared budgets allow 60 session operations per source/minute and
12 invitation/recovery starts per source/minute; mobile ingress allows 180 per source/minute.
Password/MFA/target-account limits remain independent and shared across distributed sources.
Installation-global login/recovery/invitation ceilings remain the compatibility fallback while
source trust is disabled. They are skipped only by the server route after source admission succeeds,
so public input cannot choose to bypass them. Their availability limitations therefore remain until
actual ingress verification and activation. No active endpoint can assume source trust from docs.

Acceptance: `nginx -t`, local/private/public path comparison, forged forwarding/source headers,
slow/oversized bodies, parallel users behind a shared NAT, noisy and quiet tenants, correct 429 retry
behavior, and database-store outage. Use synthetic users and a bounded staging load budget. Retain
before/after configuration and results privately. Do not stress employee accounts or production.
