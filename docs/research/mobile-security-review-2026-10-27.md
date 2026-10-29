# Mobile and API security follow-up — 27 October 2026

Source review of `67be2710c` with the mobile review at `f762945ba`. No active attack, live-server security audit or penetration test was performed. Findings distinguish source facts from deployment unknowns. This supplements [the functional review](mobile-app-deep-review-2026-10-27.md).

## Conclusion

Anyone who can reach the server can attempt requests without installing the app. That is expected for an internet-accessible API; possession of the app, a public client identifier or an `x-aihr-client: native` header is not authentication. The server must enforce credentials, authorization and resource limits independently. Current authentication has meaningful defenses, but abuse resistance is incomplete in the reviewed application boundary. No cross-tenant compromise or successful account takeover was demonstrated.

## Verified protections

| Control | FACT from source |
| --- | --- |
| Password attempts | `lib/internal-auth/service.ts:startLogin`: installation-wide 120 attempts per fixed minute; organization/username 10 attempts per fixed 15 minutes, backed by serialized database records. Both browser and native use this owner. All attempts consume budgets, not only failed passwords. |
| MFA | `verifyMfa` limits a subject to 15 calls per fixed 15 minutes; `withChallenge` permits at most five failed factor attempts per challenge. TOTP steps cannot be reused; recovery codes are consumed atomically. A password-only challenge grants no HR API session. |
| Recovery | Requests: 120 per installation/hour and three per organization/username/hour. Reset completion: ten per subject/15 minutes after a valid reset handle. Generic recovery confirmation, single-use expiring links, required existing MFA and session revocation after reset. |
| Invitations | Global and invitation-specific limits; a guessed invitation handle does not confer enrollment. Existing-account acceptance checks tenant issuer and verified email. |
| Password storage | Salted scrypt; same dummy comparison work for an unknown username; timing-safe derived-key comparison; bounded password length and two concurrent scrypt operations per process. Credential records encrypted separately from the database. This is not a defense against full application-process/key compromise. |
| Sessions | Random opaque handles, hashed lookup keys, expiring access/session/refresh records, refresh rotation/reuse revocation, current credential/principal checks, browser/native carrier separation. |
| API authorization | Bearer session resolution, own-employment checks, existing kernel services/RLS, strict command input schemas and response allowlists. Other employees' IDs are not authorization. These boundaries were inspected; their full refusal suites were not rerun now. |
| Browser mutations | Exact Origin checks, JSON body requirements and secure HttpOnly SameSite browser cookies. Native requests do not use browser cookies. The native header intentionally selects a carrier and can be copied; it does not bypass password/MFA or grant a session. |
| Payloads | Login body limited to 8 KiB, native clock multipart 3 MiB, leave multipart 11 MiB; command/photo/document validation and transactional receipts. Limits prevent individual unbounded buffers but do not bound request concurrency or bandwidth by themselves. |
| Phone/server connection | HTTPS origin validation, operator-signed workplace setup and pinned endpoint metadata, no redirects for credential/API transport; device-only credential storage and generation checks. |

Sources: [auth service](../../lib/internal-auth/service.ts), [crypto](../../lib/internal-auth/crypto.ts), [recovery](../../lib/internal-auth/recovery.ts), [invitations](../../lib/internal-auth/invitations.ts), [login route](../../app/login/api/[operation]/route.ts), [API wrapper](../../lib/mobile-api/handler.ts), [API input limits](../../lib/mobile-api/body.ts).

## Findings and prioritized plans

### S01 · P1 · Public abuse can exhaust shared authentication budgets

**FACT:** global limits are installation-wide, not tenant- or source-isolated. Login consumes the global budget before checking the target username's budget; recovery and invitation starts also consume global budgets. A target username's budget includes valid password attempts. The source therefore permits abuse to cause legitimate login/recovery throttling without the attacker obtaining an account. A fixed-window limiter also permits bursts around the window boundary.

**RISK:** availability disruption, especially in a shared multi-tenant installation. This is source-level reasoning, not a demonstrated outage. The two-scrypt cap protects memory but can return unavailable to legitimate concurrent sign-ins.

**PLAN:** enforce layered edge/source, endpoint, tenant and target-account budgets, plus bounded concurrent expensive operations. Retain cross-source account controls to resist distributed guessing while avoiding a single public installation counter as the primary fairness mechanism. Use trusted-proxy-derived source identity; never trust arbitrary X-Forwarded-For from the internet. Design measured backoff/risk challenges and recovery paths without converting them into a permanent account lockout. Keep caps appropriate for shared office/carrier NATs.

**ACCEPTANCE:** controlled synthetic tests demonstrate guessing resistance, password spraying, distributed sources, one targeted account, shared-NAT employees, several tenants and window-boundary bursts. Legitimate users in another tenant retain service under the agreed attack budget. Limits work across application processes and survive restarts. No tests target real employee accounts.

### S02 · P1 · Mobile API lacks a common abuse budget

**FACT:** the reviewed `mobileRoute` wrapper resolves a session and invokes a handler without a general request-rate or concurrency limiter. Device registration has no count/creation budget in its service. Refresh/logout and invalid session/handle lookups do not use a broad request limiter here. Some reads return unpaged datasets; photo decode, uploads and database-backed session checks cost resources even when individual payloads are bounded.

**RISK:** unauthenticated requests can consume session-resolution/database work; an authenticated abusive user or stolen token can consume queries, storage, upload bandwidth and device registrations. Authentication alone is not resource protection. A UUID/256-bit handle search is not a plausible credential recovery strategy, but rejecting unlimited guesses still costs capacity.

**PLAN:** cheap ingress limits before database/crypto, then actor/tenant/route budgets after authentication, weighted for uploads/expensive operations. Bound upload concurrency, registration count/replacement, queries, result pages and administrative exports. Emit 429 with correct retry guidance. Make command retry/idempotency semantics compatible with limits and reserve a recovery path for queued evidence without bypassing authorization.

**ACCEPTANCE:** approved staging load tests cover unknown/expired/valid tokens, excessive registration, expensive reads, repeated uploads and noisy tenants. Capacity/latency remains within agreed targets and no unauthorized business write succeeds. A duplicate command remains the same command, not a new side effect.

### S03 · P1 · Slow requests and live edge controls need verification

**FACT:** body readers cap byte totals but show no application-level read deadline. The mobile client's API timer is cleared at response headers, before JSON finishes. No `limit_req`/`limit_conn` implementation was found in the searched tracked deployment configuration; hosting guidance asks operators to configure edge limits. The active proxy/firewall configuration was not inspected.

**UNKNOWN:** live per-source rates, connection/body/header timeouts, request size limits, DDoS protection, direct-origin bypass, management/DB port exposure and correct proxy-header handling.

**PLAN:** inspect the actual intended staging/live ingress, apply bounded header/body/idle/total deadlines and connection limits, and prove direct-origin policy. Verify TLS/certificate renewal and security headers on the real endpoint. Application deadlines complement edge protection rather than assuming it exists.

**ACCEPTANCE:** isolated slow-header/body/response tests, oversized/chunked bodies, disconnect/cancel, high concurrency and direct-origin requests terminate predictably. Database/request capacity recovers after the test. A documentation checklist alone is insufficient evidence.

### S04 · P1 · Client integrity and captured attendance are not server proof

**FACT:** mock GPS rejection runs on the phone, registered-device identity is a copyable UUID bearer credential, and the clock API does not require verified hardware-bound signed location evidence. Coordinates and photos may be fabricated by an authorized modified client. Geofence uncertainty is also ignored by the current spatial decision.

**PLAN:** implement M03–M05 in the functional review: shared accuracy policy, attested key/command binding, evidence-aware deterministic adjudication and an HR exception path. Limit and audit device enrollment/replacement. An app-store build, CORS, obfuscation, certificate pinning or a static API key cannot substitute for backend authorization and evidence verification. Attestation raises assurance without proving location or preventing every compromised device.

### S05 · P1 · Reverify authorization across every new front door

**FACT:** existing mobile own-employment selection and schema/RLS boundaries are useful. They do not automatically prove every future document/approval/export/attachment endpoint safe. Company/grant/employment changes must still apply during submission, not just screen loading.

**PLAN:** a reusable negative test matrix for anonymous, partial MFA, expired/revoked token, offboarded user, peer ID, other company/tenant, downgraded role, changed reporting relationship, expired delegation, guessed document and concurrency/replay. Recheck device revocation and workflow state inside the business transaction. Keep server actions, browser routes and native routes on the same canonical owner. Route-level role checks alone are insufficient object authorization.

**ACCEPTANCE:** each endpoint proves both denial and absence of side effects/data fields. Salary, medical documents and private manager notes need explicit self/audience tests. Reuse valid existing tests, but rerun those affected by changed owners.

### S06 · P2 · Protect the app from hostile or faulty server responses

**FACT:** signed workplace routing and HTTPS defend endpoint selection, while business response JSON is only cast to a TypeScript type. A malformed/oversized response or stalled body can harm availability; this review does not establish remote code execution. A compromised approved server is still inside the credential/HR trust boundary.

**PLAN:** runtime response validation, bounded streaming/deadlines, safe errors, controlled attachment rendering and typed internal links. Verify company signing-anchor provisioning/rotation/expiry and restore/reinstall behavior. Keep test anchors out of customer production distributions. Do not turn off certificate checks to solve private-network problems. Keep sensitive data out of logs, screenshots/app switcher, crash reports, push payloads and durable unapproved caches.

### S07 · P2 · Detection, credential hygiene and incident response

**FACT:** login/MFA refusals create audit events. That does not demonstrate operational alerting or an exercised response. The reviewed password validator enforces length/content bounds but contains no common/breached-password blocklist lookup.

**PLAN:** privacy-safe alerts for spraying, repeated throttles, unusual enrollment, recovery changes, refresh reuse, tenant-boundary refusals and upload abuse. Test incident revocation of sessions/device keys, signing-anchor response, key rotation and secure backups/restore. Add maintained weak/breached-password rejection without disclosing passwords externally; consider phishing-resistant authentication as a separately scoped capability. Dependency/binary/storage/TLS review must cover the actual app and server artifacts, not only package manifests.

## Staging security acceptance

Use an isolated test tenant and synthetic accounts. First verify ingress configuration read-only. Then run a bounded, agreed test budget against authentication, tokens, object access and expensive endpoints, recording 401/403/429, latency, database/CPU/memory and legitimate-user availability. Stop on agreed impact thresholds. No live password spraying, employee lockouts, production stress test or external scanning was performed or authorized by this report.

**RECOMMENDATION:** treat S01–S05 and the missing live-edge evidence as release requirements before a wider real-data pilot. This is a prioritized security review, not a clean bill of health. The highest-confidence gaps concern availability/abuse protection and client-evidence trust; account takeover and cross-tenant access were not demonstrated.

## Guidance checked

[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) recommends login throttling and cautions that lockout can itself deny legitimate users access. [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html) covers per-endpoint access controls, input bounds and rate-limit responses. These support the recommendations; repository code is the evidence for the application-specific findings above.
