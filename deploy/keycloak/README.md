# Deployment-owned Keycloak

This package prepares Keycloak 26.8.0 with Java 25, a dedicated PostgreSQL database and service, a private management interface and a loopback Nginx edge. The release archive is pinned to GitHub's verified SHA-256 asset digest. It does not change the live app's authentication or tunnel during installation. The existing server requires an administrator for package/service/proxy installation; its `ubuntu` account only has password-free permission to restart `aihr`.

The first installation administrator is **yanli.lam@stradaverse.ai**, as instructed by the owner on 2026-10-11. This installation bootstrap policy does not override tenant administrators' invitation addresses. Identity administration and HR authorization are separate: assigning a Keycloak role never creates an HR grant.

## Administrator installation

Review the files, take a database/configuration backup, and run from a tested application release:

```bash
sudo env AUTH_PUBLIC_ORIGIN=https://sfm.stradaprop.com bash /opt/ai-hr/deploy/keycloak/install.sh
sudo env AUTH_PUBLIC_ORIGIN=https://sfm.stradaprop.com /opt/node20/bin/node --import tsx /opt/ai-hr/deploy/keycloak/configure.ts
```

For an installation without reliable GitHub access, supply `KEYCLOAK_ARCHIVE_FILE=/root/keycloak-26.8.0.tar.gz` alongside `AUTH_PUBLIC_ORIGIN`. The archive is still checked against the pinned digest before extraction. Java package discovery consumes the complete listing under pipefail; the built public distribution is made readable to the service before its writable data directory is restricted.

The installer fails rather than overwriting an existing installation. Partial failures need operator inspection before a retry. It does not stop unrelated services. Check `systemctl status aihr-keycloak`, its private journal, and `http://127.0.0.1:9000/identity/health/ready`. The configured Java heap is 640 MiB and service limit is 1 GiB; monitor actual RSS and app build pressure on the current 4 GiB host. This is a single-node deployment, not high availability.

`/etc/aihr-keycloak/app.env` holds generated application/client credentials. `/etc/aihr-keycloak/initial-owner.json` holds the subject and one-time owner password. Both are root-only. Hand the temporary password to the named owner through an approved secure channel; do not paste it in logs or chat. First login requires a password change and authenticator enrollment. The operator-attested owner email is verified during bootstrap; invitations still require recipient email verification. The temporary master administrator is deleted after realm setup. The owner can administer the realm using `ssh -p 8288 -L 8081:127.0.0.1:8080 ubuntu@203.142.6.241` and `http://localhost:8081/identity/admin/ai-hr/console/`; public `/identity/admin/` and the master realm are blocked.

## Account link and cutover

1. Ship the fully tested additive application release with the existing authentication configuration first. Confirm migrations `0523_deployment_identity` and `0525_identity_email_administration` have applied. Do not seed or replace production HR data.
2. Inspect and explicitly choose the existing initial administrator account. On the current demo this is `22222222-2222-2222-2222-222222222222` (`user_dev_admin` / HR Admin); no existing person's email matches the new owner email. The link preserves this internal account, its tenant and its grants, and does not rewrite the person's HR/contact record.
3. Link the root-created identity through the audited owner script, using the production migration connection:

```bash
cd /opt/ai-hr
sudo /opt/node20/bin/node --env-file=/opt/ai-hr/.env.production --import tsx scripts/keycloak-link-owner.ts --app-user-id=22222222-2222-2222-2222-222222222222
```

4. Test private service discovery, the exact public issuer and clients. Back up the existing public Nginx TLS virtual host (`/etc/nginx/conf.d/aihr-sfm.conf` on this installation), then change its app upstream from `127.0.0.1:3000` to the tested loopback edge `127.0.0.1:3001`. Preserve its certificates and all other directives, run `nginx -t`, reload and verify public discovery plus public admin refusals. The separate `cloudflared-aihr.service` quick tunnel is not this site's public ingress; do not restart it or change its URL. Keep the TLS configuration backup for rollback.
5. Install the private email settings service after linking the owner:

```bash
sudo /opt/node20/bin/node --env-file=/opt/ai-hr/.env.production --import tsx deploy/identity-email/install.ts
```

Run from `/opt/ai-hr`. The socket group must be the actual app OS account (currently `ubuntu`). This bundles the tested service and a separate Node runtime copy into a root-owned path, creates its restricted database login, and starts socket activation. The installer refuses writable or non-root runtime directories. Verify that `/run/aihr-identity-email.sock` is not world-accessible, the web user cannot replace the service runtime/bundle, and neither the web user nor an unrelated user can read `/etc/aihr-keycloak/email-agent.env` or vault files. SMTP tests run in the private `ai-hr-email-test` realm, whose public URLs are denied; its service user can use the fixed owner recipient without taking the real owner's unique email in the login realm. Both realm aliases resolve to one versioned vault file. No email is sent by installation. See ADR-0100 for the credential boundary and trusted-root limitations.

6. Verify the owner's initial login, MFA, refresh, logout, account permissions and anonymous refusals before retiring demo access. Owner-only cutover may precede mail activation so the owner can open Admin → Email delivery; invitations and recovery remain unavailable until a tested draft is activated. Securely back up `.env.production`, merge the generated `app.env` values into it once (replace keys; do not append duplicate definitions), set `ALLOW_DEMO_SESSION=false`, remove the old demo password if no longer required, validate `keycloakConfig()`, then restart the already-built `aihr` service. `AUTH_PROVIDER=keycloak` disables both the demo switcher and Basic-auth layer regardless of leftover flags. Never switch it before the owner is linked and able to authenticate.
7. Open Admin → Email delivery as the enrolled owner. Enter the SMTP host, implicit TLS port (usually 465), sender and credentials, save a draft, send a test, verify inbox receipt and activate. STARTTLS-only relays are not supported. Activation enables realm recovery; application invitations additionally require live activation readiness. The generated `KEYCLOAK_EMAIL_ENABLED=true` is only a capability switch and does not bypass readiness. Then verify actual invitation and password recovery with an owner-controlled test account.
8. Verify `/health` is healthy, signed-out pages redirect to the public login endpoint, anonymous mobile APIs return 401/no-store, and the named owner retains the reviewed internal UUID/grants. Delete the one-time password file after handoff and first login. Preserve the issuer/subject mapping audit.

Bootstrap owner login can be tested directly through the identity realm before the application selects Keycloak. Full end-to-end HR callback/login requires the app cutover, with rollback available and the operator present. Never claim a successful switch merely because the identity process is running.

## Runtime and operational boundaries

Web code uses `openid-client` for code/state/nonce/PKCE validation and `jose` for access-token/JWE validation. Secure, HttpOnly, SameSite=Lax, `__Host-` cookies carry opaque random session handles; the database stores only their hashes and encrypted credentials. Refresh rotation is serialized with a database row lock. Sessions have an absolute eight-hour lifetime. Account archive/employment checks remain authoritative on every request. A Keycloak user disable/revocation may take up to the five-minute access-token lifetime to affect a native bearer token; HR archive blocks immediately through the database resolver.

After migration 0523 has applied, install `deploy/keycloak/maintenance.sh` as a root-owned daily maintenance job. It creates private local identity database backups with 14-day retention and runs `scripts/keycloak-session-prune.ts` as the app OS account (`ubuntu`) to prune expired encrypted sessions. Application source and its writable runtime must never run as root from this scheduled job. Monitor identity readiness, login failures, rate limits, disk, heap, signing-certificate expiry and backup freshness. Back up the dedicated identity database plus encrypted off-host copies of configuration/secrets; protect and rotate encryption keys deliberately. A restored app session table requires its matching session key, or sessions must be invalidated. Rehearse restore in an isolated deployment before declaring disaster recovery complete. Future Keycloak updates need a separately tested upgrade, identity DB backup and pinned artifact digest; do not replace the distribution in place while it is running.

Application mail uses a realm-scoped service account with `manage-users`/`query-users`; it holds no master-realm access or HR grants. Protect that credential as an identity-administration secret and rotate it independently of the web client. Existing tenant invitations retain single-use expiry/revoke and role/scope safeguards; accepting requires a verified matching email and explicit identity binding. Accounts are never linked automatically by an email claim. Known legacy WorkOS behavior remains behind the separate adapter for a controlled rollback; Keycloak mode makes no WorkOS login or invitation calls.

The separate customer-provisioning runner creates an HR activation link; it does not enroll the customer's first administrator in Keycloak or send identity mail. Until automated enrollment is integrated with that runner, the operator must create or locate that administrator in the private realm console, verify the exact invitation address through a `VERIFY_EMAIL` action email (and `UPDATE_PASSWORD` for a new local account), then hand off the operator console's activation link through the approved channel. The administrator must authenticate with that verified identity before activating HR access. Never mark customer onboarding complete from the provisioning runner's `done` state alone, enable public registration as a workaround, or assign a Keycloak administration role to a tenant's HR administrator.

## Mobile and on-premise

The native adapter supports Keycloak authorization code + PKCE through the system browser, form-encoded token exchange, refresh and provider logout. Credentials are scoped to API origin, issuer, provider and client; a changed deployment cannot reuse the stored refresh credential. Set the public variables in `mobile/.env.example` and ship the new capability in the shared binary. No client secret is bundled.

Trusted runtime organization profile enrollment in that shared binary is a separate remaining task. Build-time configuration alone does not yet let one installed binary select cloud and private deployments. Do not distribute arbitrary URL/JWKS pickers or claim private-network/device acceptance without testing it. A private installation needs internal DNS/TLS, reachable API and identity endpoints, internal directory/SSO federation where required and an internal recovery relay. Installing dependencies may require operator-supplied offline packages; login must not require external network access. Physical iOS/Android, internal SSO, blocked-egress and restore acceptance remain deployment checks.

## Rollback

Keep the pre-cutover app environment and proxy/tunnel configuration in root-owned backups. Roll back the environment to its previous explicit provider and restart the unchanged built app, restoring the tunnel upstream if needed. Preserve additive identity/session tables and all internal HR IDs. Do not turn on a hidden demo fallback when Keycloak is unavailable; the previous gated demo is an explicit emergency rollback decision only. Existing WorkOS configurations can use their legacy adapter. Never delete/rewrite attendance, leave, people or grants to roll authentication back.
