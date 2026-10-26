# Separate native integrity primitives from verified attendance

This refines ADR-0088's platform assumptions using the [platform evidence](../research/mobile-review-2026-10-27/platform-evidence.md).
It does not activate a trust tier, change attendance policy or enable offline acceptance.

The local Expo module owns platform key operations and platform artifacts. A bounded JavaScript
boundary validates their representation and reports `not_verified`. The future server verifier owns
certificate and token validation, app/environment identity, actor/employment/installation binding,
fresh challenges or permits, assertion counters and revocation. The attendance kernel continues to
own punch acceptance. Neither a reported hardware level nor a false mock-location flag proves presence.

There is no extractable JavaScript signing fallback. Missing capability, provider outage, malformed
evidence and obsolete operation ownership remain different outcomes. Account changes invalidate an
operation even if a native callback succeeds later. A deadline does not cancel platform key creation
and must not trigger automatic replacement. Apple identifiers are committed to device-only Keychain
storage before delivery to JavaScript; Android refuses an existing alias. Enrollment must persist its
scope and challenge before key creation. Apple's server-unavailable retry retains the same key and
the same client data hash. Persistence, reinstall and process-kill boundaries still require devices.

Raw clock snapshots stay app-local. Apple's required-reason rules permit elapsed app-event durations,
not exporting raw uptime or boot information. Keep exact nanoseconds as decimal strings and derive an
interval using bracketed readings; do not lose precision through JavaScript numbers. The interval is
unverified evidence, not an accepted timestamp. Wall-clock changes do not establish continuity.
iOS has no boot UUID in this implementation: compare events within one process, and return unknown
after restart. Android may compare a locally available boot counter. Reboot, conflicting markers,
counter discontinuity or missing continuity requires an explicit unknown result.

M04 server verification, native location-source metadata, signed-device acceptance and M05 permit and
adjudication protocols remain required. App Attest assertions can be generated locally, but this does
not make initial attestation or Google verification offline, nor prove the actual device acceptance
matrix. Compilation, syntax checks and port tests establish narrower facts than hardware verification.

Online command binding uses `lib/mobile-clock-integrity.ts` for one versioned positional UTF-8
encoding on both platforms and the server. It covers deployment origin and installation identity,
tenant, actor, employment and enrolled key; the stored challenge ID, nonce and expiry; request ID,
direction, location, accuracy, sampled time and exact attachment digest/length/MIME; and reported app
identity/version and original location-source signals. UUID case is normalized. Missing source signals
stay null, distinct from false. Raw clock snapshots are not fields of this protocol. The attachment
digest covers transmitted bytes before image normalization, matching the existing photo owner's digest.

Hashing is not verification. The future challenge owner must persist an installation identity separately
from the public workplace setup label, generate random one-use challenges, and bind them to authenticated
scope and an enrolled key. The server reconstructs those fields from its records and deployment config,
compares the exact submitted command/attachment, verifies the vendor proof, and atomically consumes the
challenge/counter with the attendance result. An input object cannot establish its own actor, freshness,
key ownership or installation. The new helpers are protocol primitives only; existing v1 clock routes
and live attendance do not yet accept or trust this evidence. Offline permits require a distinct purpose
and protocol, rather than extending the online challenge's lifetime.

The server assertion primitive uses a pinned CBOR decoder with an 8 KiB input cap, finite nesting,
duplicate-key and trailing-byte refusal, exact map/byte fields and disabled semantic conversions.
It checks the supported 37-byte iOS authenticator header, deployment-owned App ID hash, a strictly
increasing unsigned 32-bit counter, and the P-256 DER signature for Apple's nonce construction.
It returns only a proposed next counter. Its public key must already have passed attestation verification;
the caller must reconstruct client data and atomically consume the stored challenge/update the counter
with the result. The helper is server-only and is not wired into v1 routes. Public interoperability
fixtures establish compatibility with that sample, not hardware origin or a verified enrollment.
Unknown authenticator extensions currently require explicit support rather than unparsed acceptance.
