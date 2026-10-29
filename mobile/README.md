# Native app foundation

Run EAS commands from `mobile/`. EAS uploads from the Git root; the root `.easignore`
admits only this app and its six shared contracts/helpers. The mobile `.easignore` also protects
standalone copies. Inspect the EAS archive before a cloud build; deployment settings,
server code, local credentials and generated native/build folders must be absent.
The backend release filter also excludes native build folders and signing inputs; mobile binaries
are delivered separately from the HR server deployment.
On iPhone, allow Local Network access if prompted when connecting to an HR server on the same
network. A denied or newly granted prompt may require retrying sign-in; this permission does not
replace trusted HTTPS certificates or the company's Wi-Fi/VPN connection. The standard test binary expects system-trusted certificates. Modern Android does not automatically trust a user-installed CA; private-CA customers need a separately reviewed domain-scoped enterprise trust configuration, or a publicly trusted certificate on their private DNS name.

The app uses Expo SDK 57, embedded HR username/password and MFA sign-in, and the shared `/api/mobile/v1` contract. The selected signed company profile chooses the cloud or private HR installation; its organization code then selects the tenant credential namespace. Embedded mode does not follow OIDC discovery or call an identity server. Legacy Keycloak/WorkOS adapters remain compatibility paths only; Keycloak activation was cancelled by the owner in ADR-0117.
For the legacy WorkOS build, run `npm ci` inside `mobile/`, copy `.env.example` to `.env.local`, set `EXPO_PUBLIC_RUNTIME_CONNECTIONS=0`, `EXPO_PUBLIC_AUTH_PROVIDER=workos`, the HTTPS API origin and the
matching public WorkOS client id, then use an iOS/Android development build. No API key or client
secret belongs in the app. Root TypeScript/build commands exclude this directory; run
`npm --prefix mobile run typecheck` separately under the repository test locks.
Root regression tests that exercise the native dependency callers also require `npm ci` in `mobile/`.

FACT (WorkOS Staging checked 2026-10-09): the dedicated **AI HR** application has public client id
`client_01KWPVYQVXS2MZJP0YY3JXZACB`, a five-minute access-token lifetime, and
`aihr://auth/callback` registered as both redirect and logout URI. The API server must verify that
same application's client id. This registration alone does not enable the server or link a user;
do not reuse another project's credentials. Server cutover and account bootstrap follow
`docs/WORKOS-CUTOVER.md` with the selected environment's secure settings.

## Session boundaries

- The refresh credential and WorkOS session id live in SecureStore with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. In embedded mode the stored refresh handle is opaque, bound to the installation namespace and rotated through the HR server. The access handle and API results stay in memory; a bounded server expiry schedules refresh without interpreting it as a JWT.
- Credential writes are serialized. A login generation owns each browser exchange, refresh and
  request. Logout immediately invalidates the generation and removes private screens. Late results
  cannot restore a session, overwrite a newer login or turn an old refusal into a new account's logout.
- Embedded sign-in verifies the selected company capability before sending credentials, requires initial password change and confirmed MFA, and shows one-time recovery codes before saving the full session. Password recovery opens the same HR server in the system browser.
- Each legacy provider sign-in attempt creates a new AuthRequest with fresh random state and PKCE values.
  A cancelled attempt's callback cannot be exchanged during a later attempt. The regression loads
  Expo's installed request, PKCE and callback parser alongside the actual sign-in screen.
- On first launch without the sandbox installation marker, surviving Keychain credentials are
  deleted before the marker is created. An OS/storage failure leaves the gate closed and retries.
  Explicit logout marks the sandbox as signed out before awaiting deletion. A surviving credential
  cannot be reopened after a deletion failure; only a successful current login clears that marker.
- Stored sessions require successful OS authentication. Passcode-only devices use the same prompt;
  unavailable credentials require full sign-in. A separate app PIN is deferred in ADR-0088.
- Inactive/background states hide private routes. Backgrounding or Android focus loss locks the
  session. Late unlock results after backgrounding/logout cannot reopen it. The OS prompt's transient
  inactive state is allowed, with the privacy curtain still visible.
- Native screen-capture protection and the iOS app-switcher overlay are enabled before private
  screens mount. Android photo/storage read permissions from the SDK are blocked. Its Android 14
  normal screen-capture detection permission remains declared because the native module registers
  a callback during initialization; this does not grant photo-library access or request a runtime prompt.
- Embedded sign-out invalidates local state synchronously, clears SecureStore, then makes a bounded revocation call to the pinned HR server. Refresh-handle reuse revokes the family; HR archive, offboarding and identity revocation are checked on every API session.
- Legacy sign-out clears local credentials first, then opens the documented WorkOS logout URL in
  the system browser. It sends `session_id` and the registered callback URI; browser/network failure cannot restore the local
  session. Provider revocation is not considered verified merely because the browser opened.
  Register `aihr://auth/callback` as both a redirect and logout URI in the matching WorkOS application.
  The logout browser session returns there; a callback route grants no session on its own.
- All builds require an HTTPS API origin without user info, path, query or fragment. The guard runs
  before reading or sending bearer credentials. Throttling/outages preserve refresh credentials.
- Employment changes immediately hide the prior employment's API data before the replacement
  request resolves. The server still decides identity, entitlement and employment scope per request.

## Release verification

FACT: regression tests exercise the actual credential/session controllers, installed OAuth request
and callback parser, client transport and rendered loading hook with injected OS/network ports. They do not exercise iOS Keychain,
Android Keystore, TLS negotiation, browser cookies or biometric hardware.

UNKNOWN until checked on staging and physical devices:

| Check | iOS | Android |
| --- | --- | --- |
| Embedded organization/password/MFA, initial password change, recovery codes | Required | Required |
| Legacy PKCE callback, cancel, double tap, changed account (when that adapter is selected) | Required | Required |
| Passcode only, enrolled biometrics, cancelled/failed prompt | Required | Required |
| Background during unlock, screen lock, app switcher, notification shade | Required | Required |
| Screenshot, screen recording, app-switcher snapshot privacy | Required | Required |
| Logout during refresh, provider session revoked, restart after logout | Required | Required |
| Reinstall, device backup/restore, SecureStore inaccessible | Required | Required |
| Offline, timeout, HR-server 429/5xx, rotated/expired/revoked refresh handle | Required | Required |
| Another employee/company/tenant and offboarded account | Required | Required |

RECOMMENDATION: use synthetic employee data until this matrix and the server authorization suite
pass against the intended embedded HR installation. `docs/WORKOS-CUTOVER.md` records the staging
host and the separate production TLS requirement. Confirm the environment rather than reusing a
different project's connected WorkOS credentials.

Server issuer default is WorkOS's documented `https://api.workos.com/`. Configure
`WORKOS_JWT_ISSUER` for an exact verified custom Auth API issuer. Configure `WORKOS_JWT_AUDIENCE`
only if the actual token profile supplies an audience; default AuthKit tokens do not document one.
The signed `client_id` must equal the server's `WORKOS_CLIENT_ID`; missing, wrong or malformed claims
are refused. FACT: the AI HR and default Stradaverse staging applications share a public signing key.
The JWKS URL alone does not bind an application. [WorkOS applications](https://workos.com/docs/authkit/applications)
documents `client_id` as the application context. Verify the actual issuer and claim profile during
staging sign-in before cutover; an environment-wide static JWT template is not an application boundary.
Signature verification alone does not establish immediate session revocation: measure the
access-token expiry window and verify WorkOS logout/revocation before a real-data pilot.

## Dependency maintenance

The official fixed URI decoder 0.5.0 is distributed locally with its MIT license and provenance hashes.
Only its ESM export is converted to CommonJS for Expo SDK 57's existing `query-string` caller; the
upstream algorithm is unchanged. Tests exercise valid PKCE/Unicode parameters and malformed input
through that actual caller. See `vendor/decode-uri-component/README.md` before updating/removing it.
The Xcode project's UUID dependency is overridden to the patched CommonJS-capable 11.1.1 and its
project-id generation is checked directly.

FACT (advisories checked 2026-10-09): the remaining `braces` and `node-forge` advisories list no patched
version ([braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv)). Installed dependency paths lead through
Metro file mapping/glob tooling and Expo CLI certificate tooling respectively. FACT: inspection of
both production Hermes export source maps on 2026-10-09 found neither package in the app module graphs
(1,298 Android modules, 1,167 iOS modules), and found the patched decoder in both. Expo's generated
Android manifest also marks both unused photo/storage permissions for removal. These checks cover
the exported JavaScript and configuration, not a signed APK/IPA or physical-device behavior.
Development/build inputs still need control while the two tooling advisories remain open. No audit
ignore or forced SDK downgrade conceals these findings.

Rechecked 2026-10-15: npm audit reports 19 high findings propagated from those two advisories.
The runtime-enabled Android/iOS Hermes export maps contain neither `braces` nor `node-forge`
(1,351 Android modules and 1,220 iOS modules); both contain the patched decoder and the signed-profile
verifier. This is exported-JavaScript evidence, separate from native binary/device verification.

## Online Monolith journeys

The Clock tab and Home share one private draft. A preparation slide collects one foreground location
and a camera photo when policy requires it. A separate review slide sends the command. Cancellation
never writes attendance. VoiceOver/TalkBack users have a labelled two-step tap confirmation. Reduced
motion disables the rail's return animation. Both clock directions remain available; the attendance
kernel decides the result, including corrected-day refusals, photo rules and geofences.

Preparation now asks the server for an own-employment location-quality preview through a bounded JSON
POST; coordinates are not URL parameters. The review shows the assigned site, measured distance,
radius and reported uncertainty when available. A preview never records attendance and never authorizes
the later command. Every enforced web/native punch requires distance plus reported uncertainty to fit
within an active assigned site open to the employment's current company. An optional company maximum
uncertainty is configured in Attendance company policy settings; blank adds no extra cap. Missing,
negative or invalid uncertainty cannot substitute for zero. Non-geofenced employees and manual HR
entries retain their established behavior.

Native preparation distinguishes blocked/approximate access, services disabled, mock flags, invalid
fixes and stale/future samples. Approximate permission alone never overrides the shared site rule:
if its reported uncertainty fits, preparation can continue. An approximate fix that fails the rule
offers explicit precise-permission Settings guidance.
Services discovery and one position request share a 20-second deadline; no automatic GPS retry follows
a timeout. A late services response cannot start a new position query. These checks validate reported
quality, not provider authenticity. Real indoor-site measurements, signed-device permission behavior
and hardware attestation remain acceptance requirements before broader rollout.

Preparation now saves an encrypted attempt before GPS or camera capture. If storage fails, preparation
stops before location acquisition. A restart can recover the unsent reference after fresh own-identity
verification; cancellation retains it, and a different direction requires review. The preparation
contains only the action, reference and phone-reported start. It cannot be sent as a clock command.
Its eventual command/evidence adopts the same reference atomically. Snapshot version 2 represents a
preparation; version 1 commands remain readable. Older binaries refuse version 2 without discarding it.

Employees can send the minimal attempt record separately. Confirmation also requires a receipt from
`POST /api/mobile/v1/clock-attempts` before sending attendance. The server records the claim once per
actor/employment/reference, distinguishes its receipt time from the unverified phone time, and never
creates attendance from this report. A failed/lost attempt receipt retains the command and prevents
attendance transmission. Deploy this server capability before distributing the new client; an older
server refusal retains local evidence. No background replay, offline acceptance or backdating is enabled.
The Clock screen also retrieves up to 20 recent reports for its selected employment and actor; it
shows the phone claim and server receipt separately from accepted clock history.

Native commands enforce registered-device policy. The registration token is stored in device-only
unlocked SecureStore, is scoped to employment, and is deleted on logout/reinstall. This registration
is **not device attestation**. One registration is retained locally; switching employment may require
registration again. Current legacy punch storage still uses `web`; the capture audit explicitly records
`native_online`. Offline/signed evidence, App Attest and Play Integrity remain separate ADR-0088 work.

Requests shows every canonical leave card, including masked values and shared-pool notices. Eligible
leave options, full/half/hour durations, attachment rules, emergency consent and maternity facts come
from the existing engine. Review displays deduction and conversion/split consent before submission.
Request, attachment and actor-scoped replay receipt commit in one transaction. Repeating an identical
submission returns its original receipt; a changed payload with the same reference is refused. The
request history currently displays up to 50 records and explicitly shows the total count.

Team availability uses the existing My Team membership and per-date leave projection. It exposes
names, dates, approval state and sessions, without reasons or payroll information. Pending leave is
never counted as approved absence. No caller-provided team or employment selector widens that scope.

In-progress journey state (entered fields, review previews and receipt metadata) remains in memory across the OS camera/document activity and subsequent
privacy lock. Private routes, API caches and tenant design still unmount behind the privacy gate.
Changing employment, changing account or signing out discards editable drafts. Selected documents/photos use
app-private temporary cache; cancellation/completion/scope change deletes owned files and cold launch
purges remaining journey/picker caches. Editable drafts are not persisted or submitted in the background.
An uncertain network result preserves the exact command reference and evidence for an explicit retry;
it never reports success without a server receipt. English/Malay copy ships in this foundation;
four other native locales remain deferred.

Add these physical-device checks to the release matrix above:

| Check | iOS | Android |
| --- | --- | --- |
| Slide completion/cancellation, VoiceOver/TalkBack, reduced motion | Required | Required |
| Denied/revoked foreground location, stale fix, mocked Android location | Required | Required |
| Camera cancel/deny, required/optional photo, picker return through OS unlock | Required | Required |
| Registered/revoked phone, tenant device policy changes during review | Required | Required |
| Clock/leave timeout after commit, exact retry, double confirmation | Required | Required |
| Document cancel/deny, size/MIME limits, cleanup after logout/crash | Required | Required |
| Full/half/hour leave, split/conversion consent, hidden balances, multiple employments | Required | Required |
| Light/dark tenant designs, narrow screens, large text, keyboard, denied team scope | Required | Required |

FACT: server integration tests use real handlers, RLS and the kernel; control tests render shipped React
components with injected native ports. Hermes exports and generated permissions are build evidence.
UNKNOWN: signed binaries, hardware permission/picker behavior and real OS accessibility until this
matrix passes. Do not use this development evidence as store/pilot readiness.

### Visual composer and deployment connections

The client opts in to mobile design schema 2. Home and custom screens render the bounded registered
section tree; published typography, palette, spacing, corners, button style and navigation are
consumed by native components. Schema 1 still renders the legacy layout. Preview and native share
the contract, not identical browser/OS primitives; physical-device visual/interaction verification
is still required before customer distribution.

Runtime company connection enrollment is separate from the visual composer. Set
`EXPO_PUBLIC_RUNTIME_CONNECTIONS=1` for the shared test binary. It verifies an operator-signed company
setup file against `connections/trust.json` before adopting any API or identity address. The public
profile pins installation ID, display name, cloud/on-premise hosting, HTTPS API origin, authentication provider and issuer,
public mobile client, API audience, API version and validity window. The same binary can import another
approved private installation without recompilation. It does not accept caller-supplied tenant IDs,
arbitrary JWKS or an untrusted key embedded in a file.

### Preparing company setup files

The current `AI HR Test` binary embeds a **test-only** public signing key. Its private key is stored
outside the repository and every build/upload input, in the operator's protected local key directory.
It must not be used for customer production distribution. A production operator must provision and
back up its signing key, embed the reviewed public anchors in the shared production binary, and sign
customer installation profiles offline. No central directory is needed at login. Adding a supported
customer uses a new signed profile; adding a new signing trust anchor requires an app update.

The offline operator tool supports:

```sh
node --import tsx scripts/mobile-company-profile.ts keygen /PRIVATE/operator.pem KEY_ID mobile/connections/trust.json
node --import tsx scripts/mobile-company-profile.ts sign /PRIVATE/operator.pem /PRIVATE/company.json /OUTPUT/company.aihr.json
```

Keep the private key outside the mobile project and source/upload tree. Key generation and signing
refuse to overwrite output files. Distribute only the signed public `.aihr.json` file through the
customer's approved channel. The profile contains no passwords, tokens, HR data or client secret.
Unsigned profile fields follow `CompanyProfile` in `lib/mobile-connection.ts`; profiles expire within
one year. Current app anchors provide offline authenticity, **not instant revocation**: issue bounded
lifetimes, remove an affected key in a new binary after compromise, and revoke affected identity/client
access on the server. Device clock and certificate trust remain platform/operator dependencies.

Employees import the file once, review the organization and installation addresses, and confirm. The selected
signed file is reverified on cold launch; expired or corrupt setup closes the connection gate. Before
sign-in, the app compares `/login/mobile-connection` against the pinned profile. Embedded mode then
uses the same HR origin; only the legacy Keycloak adapter checks OIDC discovery and S256 support.
The public metadata route reads only operator-owned configuration,
contains no HR/tenant data, and returns unavailable while internal authentication is disabled/demo.

### Workplace QR codes and setup links

One app supports several organizations on the same cloud URL and separate on-prem URLs. For a
workplace-specific setup, add `"organization": "customer-a"` to the unsigned **internal** profile before
signing. This is the operator-owned login organization code already bound to the tenant, not a tenant
UUID or a grant. Use a display name employees can recognize. Query parameters cannot override the
signed organization. Existing profiles without this field retain manual organization entry at sign-in.

From the repository root, use the existing private operator key to generate a new output directory:

```sh
node --import tsx scripts/mobile-company-profile.ts setup /PRIVATE/operator.pem /PRIVATE/company.json /OUTPUT/customer-a-setup
```

The directory contains `company.aihr.json`, `setup-link.txt` and `setup-qr.png`. Existing output paths
are refused. The QR encodes the HTTPS link, with the signed setup in its URL fragment. The same
installation hosts `/login/mobile-setup`; it needs no central cloud directory or identity provider.
The page offers an explicit **Open AI HR** button using the app's existing `aihr` scheme. It does not
automatically launch an app, request credentials, fetch a supplied URL or create a session. An app must
already be installed; otherwise the employee gets it from their administrator and reopens the original
link. This uses an ordinary HTTPS landing page, not per-customer Apple Universal Link / Android App
Link domain registrations.

Employees scan the QR with their phone's camera, tap a shared setup link, or paste it into
**Connect to your company → Paste setup link**. The app verifies the signature with its installed trust
anchors and presents the workplace, server and organization for review. Nothing is saved or signed out
until confirmation. Reviewing a link temporarily closes private screens while retaining the session,
employee drafts and attachments. Cancel and Android Back restore them; confirmation clears the old
session, private drafts, files and device registration
before changing workplaces. A malformed, expired or unapproved setup is refused. Organizations on one
cloud URL get separate credential storage namespaces, even when usernames match. Only one workplace
session is active at a time.

After confirmation the login form shows the selected organization and asks only for username/password
and normal MFA steps. First-password change and MFA enrollment still apply to new accounts. The server
owns tenant membership, HR identity and permissions. On-prem phones still need company Wi-Fi/VPN and
system-trusted HTTPS; a setup link cannot install a CA or bypass TLS.

New workplace links require an updated app; 1.0.2/build 3 does not support the organization field or
link handoff. Use production-approved trust anchors for customer bundles; the current test-only anchor
does not authorize customer distribution. Setup generation does not activate authentication: production
stays dormant until origin TLS and owner prerequisites pass. Physical camera/browser/app handoff and
employee journeys on both platforms remain separate from operator/contract/UI test evidence.
Profile changes hide private screens first, invalidate authentication, delete refresh/device credentials
and local capture/draft files, then persist and install the new connection. Cleanup failure keeps the
gate closed. Cookies are omitted from token/API/bootstrap requests and redirects are refused.

The server still owns exact identity-to-tenant binding and all HR permissions. Company setup does not
create a membership or adopt another tenant's user by email. The existing Me picker selects authorized
employments within the resolved tenant; a new cross-tenant identity-adoption flow is not included.
Private installations require reachable DNS, trusted HTTPS certificates and Wi-Fi/VPN access to the
HR server (and a separate identity server only when using a legacy adapter). Private certificate authorities require OS/customer provisioning and verification on each
supported OS/app; provisioning alone does not prove the app trusts that CA. There is no TLS bypass.
QR scanning uses the phone’s camera and the HTTPS setup page; there is no in-app scanner or hosted company directory.

### Installable test builds

`eas.json` defines a standalone preview APK and an ad hoc iPhone build, an Android cloud-compilation
profile without signing credentials, and an iOS simulator profile.
The preview app is `AI HR Test` / `ai.stradaverse.aihr.test`; it bundles JavaScript and does not need a
Metro server to run. Its existing `aihr://auth/callback` must be registered by the deployment operator.
Do not install another AI HR binary using that same custom scheme alongside it during callback tests.
Preserve a locally signed Android build's operator keystore outside source/build inputs and reuse its
certificate for updates. A new EAS signing key cannot update an APK signed by a different key.

```sh
cd mobile
npx eas-cli@24.10.0 login
npx eas-cli@24.10.0 init
npx eas-cli@24.10.0 build --platform android --profile android-local-signing --freeze-credentials --non-interactive
npx eas-cli@24.10.0 device:create
npx eas-cli@24.10.0 build --platform ios --profile preview
```

The `android-local-signing` output is an intermediate compilation artifact. Align it with Android
`zipalign -P 16 4`, sign it locally with the existing operator key using `apksigner`, and verify the
signature and certificate against the previous installed APK before distributing it. Keep signing
passwords in protected local files, outside shell arguments and upload inputs. Do not distribute the
intermediate Expo Android artifact. The `preview` Android profile instead uses EAS-managed signing;
switching signing keys prevents an in-place update of an existing locally signed test installation.

EAS cloud builds use the account's plan resources. iPhone installation requires Apple signing and an
ad hoc profile containing the test device UDID. Local SDK 57 iOS builds require Xcode 26.4+; Xcode 16
is insufficient. This request does not authorize public App Store/Play Store submission. Use synthetic
data until the physical-device matrix above passes. Installing a binary does not activate the current
server's internal login, enroll a user or activate SMTP.

### Reliability transport changes

The native API uses Expo's stream-capable fetch, validates successful responses with the shared
endpoint schemas, and bounds response reads to 1 MiB with a 15-second exchange deadline that remains
active through the body. Server-side mobile uploads have a 30-second body deadline as well as byte
limits. Malformed/oversized/stalled responses remain unavailable, never accepted command receipts.
Same-scope refresh keeps displayed data and offers an error/retry; scope changes still hide previous
results immediately. Concurrent identical reads share one bounded request within the same identity,
company connection and language. Each consumer can cancel independently; the last cancellation ends
the shared request. Completed response bodies are not kept in a global cache. Valid `Retry-After`
hints (up to one hour) delay repeated reads using a monotonic cooldown, with an explicit retry message
and no automatic background retry. Refresh and stale-data labels distinguish retained data from a
fresh response. Writes retain explicit immutable retry behavior.
Unexpected API failures return an optional support reference. The native client accepts only a
bounded UUID and can show it without displaying the server's raw error. The API wrapper's general
failure logs contain only a fixed stage/event and that reference; error objects, SQL parameters,
schema messages, URLs and HR payloads are not included. Expected authentication/rate refusals do not
create a per-request failure log. The reference grants no access and proves no attendance outcome.
Multipart attachments expose actual file bytes with their declared MIME, as required by Expo fetch;
URI-only React Native file parts are not accepted by that transport. Verify this on signed binaries
and through required/optional photo and document flows before distribution.

### Submission receipt lookup

`GET /api/mobile/v1/submission-receipt` resolves a clock or leave submission by its original request
reference and own active employment. Both reads also require the original authenticated actor.
Clock lookup reads the retained capture, independent of the current attendance-day projection;
leave lookup reads the original transactional event receipt, independent of the latest history page.
The existing Check receipt controls now use this endpoint. An unknown reference stays uncertain and
never authorizes a new command or reports success.

Before transmission, clock and leave save the exact command string, digest and owned attachment in
an AES-256-GCM journal. Metadata and evidence bind the authenticated actor, active employment and
installation namespace through authenticated encryption. The master key lives only in device-bound,
unlocked SecureStore. An encrypted inactive metadata slot is written before the SecureStore commit
pointer advances; a missing/corrupt committed slot refuses instead of falling back to an empty state.
Resolution commits removal before attachment cleanup. App sandbox installation reset rotates the key
and ignores surviving old Keychain pointers; restoring files without the device key quarantines them.

After an online `/me` verifies the same actor and employment, the screens restore a pending command
as uncertain and offer Check receipt or an explicit identical retry. They never replay automatically.
Another account cannot open/transmit the claim. Logout preserves encrypted unresolved claims for the
original authorized actor; decrypted temporary files and editable drafts are still cleared. A failure
to save prevents transmission and says nothing was sent. Attachments are capped at 2 MiB for clock
and 10 MiB for leave; only one unresolved command of each kind is admitted per scope.

The Pending requests screen shows the available own-employment count after fresh identity verification.
Me's voluntary logout/company-change paths offer receipt checks, review of the original submission,
explicit server-confirmed discard, or keeping encrypted requests while leaving. An unavailable count
is not displayed as zero, and leaving never waits for the inventory request. Forced revocation still
closes access immediately. Locked/setup screens retain privacy and explain that review requires returning
to the original account; setup links never authorize access to its pending evidence.

`POST /api/mobile/v1/submission-abandon` is ordered under the same lock as its clock/leave writer.
An accepted receipt wins without altering attendance, approval or leave balances. Otherwise, an immutable
actor/employment/kind/reference-scoped abandonment prevents late delivery from recording. The receipt
lookup's optional `abandoned` field recovers a lost discard response. Local evidence is resolved only
after a terminal server result. This is not withdrawal of accepted leave or correction of attendance.

New pending data uses a 64 MiB installation budget. Resolution can still commit at that cap, permitting
cleanup; authenticated orphan/inactive-slot cleanup never evicts a referenced pending attachment. Temporary
decrypted upload copies are removed when each attempt ends. Unresolved encrypted claims have no silent
expiry: explicit server reconciliation/abandonment closes them. OS uninstall/key loss cannot provide a
server decision and follows the quarantine/reset rules above. Device-bound at-rest encryption and app
actor checks do not replace the hardware integrity work under M04.

Pending claims are not accepted attendance or approved leave. Offline punch capture and cold-offline
identity restoration remain disabled. Real-device kill/upload/relaunch, OS-protected key and backup/restore
acceptance remain release work; model/adapter tests do not replace those checks.
