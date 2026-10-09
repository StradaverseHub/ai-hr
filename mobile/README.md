# Native app foundation

The app uses Expo SDK 57, hosted WorkOS AuthKit with PKCE and the shared `/api/mobile/v1` contract.
Run `npm ci` inside `mobile/`, copy `.env.example` to `.env.local`, set the HTTPS API origin and the
matching public WorkOS client id, then use an iOS/Android development build. No API key or client
secret belongs in the app. Root TypeScript/build commands exclude this directory; run
`npm --prefix mobile run typecheck` separately under the repository test locks.

## Session boundaries

- The refresh credential and WorkOS session id live in SecureStore with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The access token and API results stay in memory.
- Credential writes are serialized. A login generation owns each browser exchange, refresh and
  request. Logout immediately invalidates the generation and removes private screens. Late results
  cannot restore a session, overwrite a newer login or turn an old refusal into a new account's logout.
- On first launch without the sandbox installation marker, surviving Keychain credentials are
  deleted before the marker is created. An OS/storage failure leaves the gate closed and retries.
  Explicit logout marks the sandbox as signed out before awaiting deletion. A surviving credential
  cannot be reopened after a deletion failure; only a successful current login clears that marker.
- Stored sessions require successful OS authentication. Passcode-only devices use the same prompt;
  unavailable credentials require hosted sign-in. A separate app PIN is deferred in ADR-0088.
- Inactive/background states hide private routes. Backgrounding or Android focus loss locks the
  session. Late unlock results after backgrounding/logout cannot reopen it. The OS prompt's transient
  inactive state is allowed, with the privacy curtain still visible.
- Native screen-capture protection and the iOS app-switcher overlay are enabled before private
  screens mount. No screenshot-detection permission is requested.
- Explicit sign-out clears local credentials first, then opens the documented WorkOS logout URL in
  the system browser. It sends only `session_id`; browser/network failure cannot restore the local
  session. Provider revocation is not considered verified merely because the browser opened.
- All builds require an HTTPS API origin without user info, path, query or fragment. The guard runs
  before reading or sending bearer credentials. Throttling/outages preserve refresh credentials.
- Employment changes immediately hide the prior employment's API data before the replacement
  request resolves. The server still decides identity, entitlement and employment scope per request.

## Release verification

FACT: regression tests exercise the actual credential/session controllers and the client transport
and rendered loading hook with injected OS/network ports. They do not exercise iOS Keychain,
Android Keystore, TLS negotiation, browser cookies or biometric hardware.

UNKNOWN until checked on staging and physical devices:

| Check | iOS | Android |
| --- | --- | --- |
| Hosted PKCE callback, cancel, double tap, changed account | Required | Required |
| Passcode only, enrolled biometrics, cancelled/failed prompt | Required | Required |
| Background during unlock, screen lock, app switcher, notification shade | Required | Required |
| Screenshot, screen recording, app-switcher snapshot privacy | Required | Required |
| Logout during refresh, provider session revoked, restart after logout | Required | Required |
| Reinstall, device backup/restore, SecureStore inaccessible | Required | Required |
| Offline, timeout, WorkOS 429/5xx, expired/revoked refresh token | Required | Required |
| Another employee/company/tenant and offboarded account | Required | Required |

RECOMMENDATION: use synthetic employee data until this matrix and the server authorization suite
pass against the intended AI HR WorkOS application. `docs/WORKOS-CUTOVER.md` records the staging
host and the separate production TLS requirement. Confirm the environment rather than reusing a
different project's connected WorkOS credentials.

Server issuer default is WorkOS's documented `https://api.workos.com/`. Configure
`WORKOS_JWT_ISSUER` for an exact verified custom Auth API issuer. Configure `WORKOS_JWT_AUDIENCE`
only if the actual token profile supplies an audience; default AuthKit tokens do not document one.
Signature verification alone does not establish immediate session revocation: measure the
access-token expiry window and verify WorkOS logout/revocation before a real-data pilot.
