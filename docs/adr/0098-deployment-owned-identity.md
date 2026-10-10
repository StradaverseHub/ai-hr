# ADR-0098: Deployment-owned identity for cloud and on-premise

Status: Accepted implementation direction, 2026-10-11. The owner approved Keycloak for the current system and cloud/on-premise installations. The initial system administrator for each installation is yanli.lam@stradaverse.ai. Implementation and cutover require separately verified deployment evidence; approval is not evidence of a running service.

## Requirement and recommendation

One store-installed mobile application must connect to both the hosted product and a customer's private deployment. Each deployment owns its data, identity configuration and published tenant design. Private deployments must not need WorkOS or a platform-hosted login service to authenticate. Recommend deployment-owned OpenID Connect (OIDC), with self-hosted Keycloak as the supported default. Customers can federate their existing enterprise identity through that service. Do not implement password hashing, recovery tokens or an SSO protocol from scratch in the HR application.

Cloud runs our operated identity service; an on-premise installation runs its own identity service or connects to a validated customer OIDC provider. A fully internal installation must choose an internal upstream provider, internal mail/recovery infrastructure and a trusted certificate chain. Federation to a cloud provider would deliberately introduce an external dependency. On-premise is not automatically offline: the phone and system browser must reach both the HR server and identity server, through the customer's network/VPN when private.

Self-hosting and product integration are separate decisions. Package the identity service with the supported installation, theme its login/recovery pages and expose routine user administration through the HR product where appropriate. Customers should experience one product, while identity remains a separately maintained component. Native sign-in still uses the system browser with PKCE, rather than an embedded password form or WebView collecting enterprise credentials.

An authentication library embedded in the HR application is a viable alternative for a smaller account/password scope; it need not mean writing cryptography from scratch. For this product's enterprise federation, internal directory, MFA, recovery and cross-application SSO requirements, recommend the dedicated service. Its cost is another service to configure, monitor, patch and restore. Embedding authentication reduces that deployment footprint but makes the HR application responsible for integrating and maintaining those identity capabilities. This is an architectural recommendation, not a claim that either option is automatically secure.

## Verified current state and graph impact

FACT from current source: `lib/workos.ts` wraps web session/login/logout and invitation/reset operations. `middleware.ts`, the callback route and login/invitation screens integrate AuthKit. `core/auth.ts` has an injectable provider seam but its default still loads WorkOS. `lib/session.ts` verifies mobile WorkOS tokens using `lib/mobile-api/jwt.ts`; that verifier requires a WorkOS `client_id` profile and is not a generic OIDC verifier. `app_user.workos_user_id` is the persisted external subject. Native `config.ts` has build-time API URL/client ID; `auth.ts` has fixed WorkOS endpoints; `provider-logout.ts` is WorkOS-specific. The proposed deployment switch therefore is not implemented by changing one URL.

Target graph:

- Deployment → approved connection profile → API origin + identity issuer/client/capabilities.
- Deployment → identity provider → external identity `(issuer, subject)` → internal app user.
- Internal app user → tenant membership/grants → person/employment context → existing `SessionContext` and RLS.
- Tenant → private design draft → immutable published design → supported renderer in the shared binary.
- Deployment + user + employment + session generation → tokens, device registration, requests and transient journey drafts.

Identity providers authenticate users. The HR kernel remains the authoritative owner of tenant membership, grants, employment visibility and entitlements. Token roles, domain names, email addresses and selected tenant branding must never grant HR access by themselves. Authentication changes must not recreate persons, employments, grants or audit actors.

## Connection trust and credential boundaries

An organization connection is provisioned through managed app configuration or an offline-verifiable signed profile/QR carrying public configuration only. The app must have a pre-established signing trust anchor; a key contained only inside the same QR cannot prove that QR is trusted. A signed offline profile supports private networks without a mandatory platform directory. Profile signing, rotation, expiry/revocation and customer distribution belong to the deployment operator. Display the organization, server and identity domain before first login. No arbitrary URL change while retaining a token, no user-editable JWKS, no remote code, no TLS bypass, no secrets in profiles.

Pin the exact API origin, issuer, public mobile client ID, allowed authorization/token/logout endpoints, redirect URI and API resource audience to the selected verified profile. Discovery must match the configured issuer; endpoints are separately approved because valid providers can use another host. Never infer trust from an unverified JWT's issuer or key URL. Use bounded requests and reject redirects for token/API traffic. The server loads its provider configuration from operator-owned deployment settings, never from caller-supplied issuer URLs.

Native sign-in uses the system browser, authorization code with fresh state/nonce and PKCE S256. Validate the complete OIDC response with a maintained library. API bearer verification accepts access tokens intended for this API, not an ID token substituted as a bearer. Validate signature/algorithm/key provenance, issuer, audience, time claims and the approved access-token profile. WorkOS verification remains a separate migration adapter until retired. Opaque-token providers need explicitly supported introspection; they are not silently treated as JWT providers.

Switching deployments ends local authentication and increments the generation before changing endpoints, unmounts private views, discards drafts and local attachments, clears device registration and credentials, and ignores old in-flight completions. Re-authentication is mandatory; credentials are never forwarded to another deployment. Session storage keys/records include the deployment and issuer identity so a cold launch cannot reuse a credential after a profile change. Cleanup failures fail closed. Lock and sign-out retain their existing privacy guarantees.

Web login uses a server-side OIDC code flow, protected callback/state/nonce/PKCE, secure HttpOnly cookies, session rotation and CSRF controls. Keep an explicit distinction between local session termination and upstream SSO logout. Test provider outages separately from revoked credentials. Offboarding and archive checks stay server-authoritative on every session resolution; identity provider availability must never trigger a demo-user fallback.

## Identity migration and account lifecycle

Add a provider-neutral external-identity mapping keyed by exact issuer and subject, linked to the existing internal app user. Design multi-tenant account selection explicitly: a shared email is not authority to bind an identity to another tenant. Retain existing internal IDs, histories and grants. Backfill the known WorkOS issuer/subject as legacy mappings before enabling another provider. Link a new identity only through an administrator-controlled, audited enrollment flow with ownership proof. Never auto-link by an email claim, even if marked verified.

Replace invite, activation, expiry/revoke, password reset, MFA/recovery, logout/revocation and administrative lifecycle operations as part of the migration. WorkOS password/hash export capability is UNKNOWN; do not promise transparent password migration. Plan controlled re-enrollment where credentials cannot be migrated, and test enterprise federation separately. Keep a documented, audited emergency-access procedure; it must not bypass tenant authorization or become a hidden dev login in production.

## Delivery and acceptance sequence

1. Introduce provider-neutral identity/session interfaces, external-identity mapping and deployment configuration validation, with the current WorkOS adapter preserving behavior. No default change.
2. Build a reproducible internal identity deployment and OIDC adapter for both web and mobile. Include local recovery delivery, MFA/passkeys policy, key rotation, backups/restore, patching, monitoring and operator-owned administration. Validate server versions before production use.
3. Implement trusted runtime organization enrollment and deployment-scoped session/device/draft cleanup. Both cloud and private profiles consume the same versioned mobile API and builder contract. Negotiate capabilities and fail explicitly on unsupported server versions.
4. Exercise an entirely private staging deployment with external network access blocked. Prove initial login, refresh, expired/revoked credentials, logout, invitations/recovery, tenant design, attendance and leave on physical iOS/Android devices and web.
5. Migrate a controlled pilot, rehearse rollback with preserved internal IDs, then migrate cloud accounts. Retire WorkOS configuration/SDK only after there are no remaining login or lifecycle consumers.

Required adversarial cases include forged/expired connection profiles, wrong issuer/audience/client, ID-token substitution, `alg:none`/algorithm confusion, unknown/rotated keys, malicious discovery/redirects, callback replay/mix-up, cross-tenant email collision, archived/suspended accounts, stale refresh and API completions during deployment switching, keychain cold-launch mismatch, failed cleanup, local attachment disposal, private CA/VPN outage, MFA/recovery abuse and rate limiting. A cloud success is not evidence of an internal-network success.

## Tradeoffs and status

Self-hosting gives deployment control and removes a mandatory hosted identity dependency. It transfers identity-service uptime, security updates, key management, recovery delivery and incident response to us or the customer's operator. It is not inherently safer than managed identity. App-store identity stays shared; supported tenant presentation changes do not require separate customer binaries, while a new authentication capability requires shipping that capability in a shared binary first.

This ADR records the approved migration direction. The Keycloak adapter, additive identity mapping, native exchange and installation package are being implemented under the approved work. Their existence in source is not evidence of a completed production cutover. Trusted runtime connection enrollment, private-network/device acceptance and WorkOS retirement remain explicit delivery stages. The visual composer remains a separate implementation workstream and must not control authentication endpoints or credentials.

## Standards and provider references (checked 2026-10-10)

- [Keycloak administration](https://www.keycloak.org/docs/latest/server_admin/index.html): identity brokering, OIDC/SAML, LDAP/Active Directory, passkeys and session administration.
- [Keycloak OIDC interfaces](https://www.keycloak.org/securing-apps/oidc-layers).
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html): issuer/subject identity and token validation.
- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252): native apps, external browser and PKCE.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700): OAuth security best current practice.
