# AI HR integrity primitives

This local Expo SDK 57 module provides App Attest key/assertion operations, Android Keystore P-256
keys and signatures, Play Integrity standard tokens, and app-local sleep-inclusive clock readings.
It is not an attendance adjudicator. No response, certificate chain, hardware hint or token from it
is a verified trust verdict. Server certificate/token, app/environment, challenge, actor/employment,
device ownership, counter and revocation verification remain required before M04 can be activated.
The owned enrollment and signed-clock assemblies use this module. Server-backed signed-clock
routes and screen recovery are implemented behind default-disabled deployment rollout. Neither
local bridge availability nor successful port tests enable that rollout.

`mobile/lib/integrity-bridge.ts` validates native outputs and returns evidence explicitly marked
`verification: not_verified`, or a named unsupported/unavailable/invalid outcome. Missing bridges
(including older binaries and Expo Go) have no JavaScript signing fallback. Callers must supply an
operation-owner check covering the authenticated actor, connection namespace, employment and auth
generation before using a response. Timeouts never automatically retry key generation or switch
to a different hardware option. Play provider expiry requires an explicit new preparation.

The enrollment owner must commit its scope, alias and server challenge/hash before calling native
key creation. Aliases are `aihr_` plus a lowercase SHA-256 hex value derived from the scoped enrollment
identity, including the installation. App Attest identifiers are committed to a device-only unlocked
Keychain item before native completion is delivered; the same alias recovers an existing identifier.
Concurrent generation is bounded and persistence failures retain the identifier in process memory.
The OS/API-to-Keychain process-kill boundary still needs physical-device acceptance. Missing or invalid
keys require explicit enrollment reconciliation, never silent replacement. Android key generation
serializes the alias existence check and generation and refuses an existing alias. Private key bytes
are never returned; public certificates/SPKI and signatures remain unverified evidence.

Apple's `serverUnavailable` requires retrying the same key **and the same client data hash**.
See [Apple's guidance](https://developer.apple.com/documentation/devicecheck/dcerror-swift.struct/serverunavailable).
The Play Integrity dependency is pinned to 1.6.0 from the [official setup instructions](https://developer.android.com/google/play/integrity/setup).
Tokens must be verified by the backend against the exact [request hash](https://developer.android.com/google/play/integrity/standard).

Clock snapshots are **app-local only**: raw uptime, wall-time/uptime pairs and boot identifiers must
not be sent to the API, signing-envelope transport or general telemetry. The privacy manifest declares
35F9.1 for elapsed app-event timing; its exception permits elapsed durations, not raw boot time.
See [Apple's API reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).
`clock-elapsed.ts` emits only an elapsed interval and an unverified continuity result. iOS deliberately
has no boot identifier: [iOS 18 removed access](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-18-release-notes).
An opaque runtime identifier permits comparison within one process; after restart, missing continuity
requires review rather than wall-clock reconstruction. Android may compare a locally stored boot count.
Neither result establishes an accepted timestamp, identity, location or offline attendance fact.

The generated ignored `mobile/android` project is only a local build harness. Historical Android/iOS
native builds and simulator setup launches, hosted compiler checks, and signed-clock recovery port
tests are recorded in the [platform evidence](../../../docs/research/mobile-review-2026-10-27/platform-evidence.md).
They do not establish release signing, Apple entitlements, a valid vendor attestation or physical
device behavior. No physical test Android phone or iPhone is currently available. The signed-device
airplane-mode, sleep, restart/reboot, reinstall, quota/outage and copied-token field matrix remains
unverified. The current Expo location adapter reports its actual mock flag and preserves missing
provider/simulation/accessory facts as null; native source-information APIs, HR integrity review and
offline adjudication remain implementation work. No store upload, EAS build or runtime rollout is
implied by this module.
