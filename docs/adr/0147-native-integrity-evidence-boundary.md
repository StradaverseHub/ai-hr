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

Enrollment key proofs use a code-pinned Apple root and maintained bounded ASN.1/PKI parsers. They check
ordered certificate signatures and a PKIX path at server time, P-256 public-key identity, certificate
nonce, app/environment, zero initial counter, credential ID and matching COSE coordinates. A key proof
is distinct from metadata-complete enrollment: legacy proofs retain unavailable distribution/build
metadata, and the strict enrollment check refuses that state. Neither helper assigns a trust tier,
persists ownership, consumes a challenge or verifies the separate fraud receipt/current revocation.
The PKI/ASN.1 v4 dependencies require Node 20.19+ or 22.12+; actual release runtime compatibility must
be verified before rollout. No public API route currently imports this enrollment primitive.

The current Apple validation-guide sample is not a complete positive protocol witness: its certificate
nonce matches raw example-challenge bytes, while the documented algorithm and our native bridge use a
32-byte challenge hash. Keep that sample as a refusal case; never try alternate hash constructions to
pass it. The captured production/development fixtures validate key proofs at their historical issuance
times and lack modern metadata. Metadata-complete positive acceptance still needs a valid signed sample
from the supported device/build population. Missing evidence cannot become verified by fixture editing.

The Play standard-token boundary sends an opaque token only to Google's fixed HTTPS decode endpoint,
using a deployment-owned scoped access-token provider. It never accepts a phone-supplied decoded JSON
verdict. A single deadline covers credential acquisition, response headers and a bounded response body;
redirects and automatic retries are disabled. A late credential result cannot start a decode after timeout.
The server compares the canonical command hash, challenge window, request/package identity, all signer
digests and the allowed/claimed version before retaining vendor signals. Token time must fall after
server challenge issuance, before expiry, and no more than 30 seconds ahead of the checked server time.
This bounded online check does not authenticate an earlier offline location or claimed device wall time.

Recognition, licensing and device labels stay separate facts. Unknown labels grant no known assurance;
cleared/unevaluated verdicts remain unavailable. A decoded verdict alone establishes neither Keystore
private-key possession nor actor/employment ownership, and does not accept attendance. The future owner
must reconcile receipts before decoding again and persist command/challenge outcomes atomically: Google
may have consumed a token when a response is lost. No credentials are loaded and no endpoint is activated
by the primitive itself. Live service-account/project/distribution acceptance remains required.

## Recovering one-use Apple enrollment artifacts

The native Apple owner now records an immutable key/client-data-hash intent before invoking DeviceCheck.
It commits a successful artifact before resolving JavaScript, through a dedicated unlocked/device-only,
non-synchronizing Keychain service. Repeating the same completed key/hash reads those original bytes
without another vendor operation. A different hash for an existing key refuses. An interrupted or
unknown operation remains requested; it cannot silently become another attestation attempt. Only an
explicitly recognized `DCError.serverUnavailable` result records retryable state for a later explicit
same-key/same-hash call.

An artifact returned by DeviceCheck but not yet stored remains with the bounded live native owner.
Recovery reads first retry that storage commit. A lost storage reply can recover a committed artifact
after restart; an actual crash before artifact persistence remains uncertain. These states are reported
separately from absent, retryable and completed. Operation-generation tokens prevent a duplicate old
callback from replacing a newer retry or resolving it twice. The JavaScript bridge validates the
bounded canonical artifact, repeats operation-owner checks and continues to label all evidence
`not_verified`. Missing older-binary methods remain explicitly unsupported.

The mechanism reserves at most four active/uncommitted native operations and admits at most sixteen
persisted cache records. Unresolved evidence is never evicted to admit another key. Records are capped
at 90 KiB, including a permitted 64 KiB artifact and bounded metadata; JSON encoding disables slash
escaping so worst-case valid base64 remains within that cap. The iOS pod source glob includes the new
helper. Android exposes an explicit unsupported recovery method, with no signing fallback.

These records establish local recovery state only. They provide no certificate verification, actor
authorization, attendance acceptance or trusted time. The encrypted journal below adds JavaScript
recovery and server-receipt reconciliation. Receipt-driven cleanup replaces completed proof bytes with a
released binding tombstone; it never makes the key attestable again. Released tombstones still count
toward the sixteen-record bound. This bound is not a retention policy or a completed retirement lifecycle. Full iOS framework/signed-device/OS Keychain and process-loss
acceptance remain required; host model execution does not establish them.

## Encrypted enrollment journal

One journal belongs to the approved connection namespace, API origin, actual login actor and client app
installation UUID. An unresolved enrollment additionally retains its original employment and request.
It cannot be adopted by another employment or overwritten by a newly generated request. A completed
key keeps historical enrollment provenance; it is not a current permission or verified-presence claim.

The owner serializes all instances/generations for that scope in the JavaScript runtime and reads the
committed snapshot afresh for each operation. It persists requested, prepared, key-requested, key-ready,
attestation-requested and proof-ready transitions before their corresponding external operation. It
validates the server context, canonical hash and deterministic alias against current scope before key
generation, refreshes the same immutable context before resuming irreversible work, and refuses changed
nonce/target material. An older native binary without proof recovery and a known unsupported app build
cannot start key generation. Context freshness comes from the server, not the phone's claimed clock.

A key-requested interruption reads the original native alias; a missing reference requires recovery
instead of generating another key. Attestation-requested interruptions read the native cache. Only
recorded retryable state permits an explicit later same-key/hash call. Requested/unknown/absent recovery
state cannot trigger another one-use operation. Known vendor outage, temporary native unavailability,
missing references and unsupported capability remain distinct. Ownership is rechecked around every
await, including failed requests, so obsolete results cannot be adopted by another login/connection.

The exact artifact is committed before first transmission. Before resending it, the owner checks the
bounded own-key catalog for its original challenge. A matching receipt, including a revoked one, can
resolve the journal without another enrollment/configuration request. Catalog absence is not proof of
absence: only the same saved bytes/intent may be sent to the authoritative server receipt owner. Proof
is cleared from this journal only by the durable receipt transition. A failed local receipt commit
retains the proof; no automatic key replacement or background replay occurs.

Storage reuses the existing native AES-GCM master/installation quota, with purpose-separated AAD,
directory and SecureStore pointer. Enrollment slots allow 128 KiB for a full 64 KiB base64 artifact and
bounded context. Missing pointers with existing enrollment slots quarantine the state; they cannot
create an empty enrollment beside an uncertain native key. Missing/corrupt selected slots never fall
back to an older one. The established clock/leave slot format, purpose and bounds remain unchanged.
An app-installation UUID is committed in device-only SecureStore under the master generation; the
existing first-install reset changes that generation and clears these encrypted files.

The server receipt additionally carries an enrollment-specific SHA-256 digest of the canonical tuple
`["aihr.native-key-binding", 1, challengeId, vendorKeyId]`. The native owner checks this against its
retained SDK reference before committing the receipt or releasing native proof bytes. The digest is
scoped to this enrollment; it does not expose the SDK reference or assert physical presence. Key IDs,
hashes and proof encodings reject trailing whitespace rather than normalizing signed material.

Only after the matching receipt commits does the owner request native proof release. Known cleanup
unavailability leaves the committed receipt authoritative and retries cleanup on a later owned read.
Native release accepts only a completed matching key/hash, persists a released tombstone and refuses
in-flight or uncertain work. A released cache without a recoverable server receipt requires recovery;
it cannot initiate another attestation.

Verified first-install bootstrap invokes native alias/proof-service cleanup before replacing the AES
master and encrypted journals. Native cleanup must acknowledge success, or explicitly be unsupported
on an older/missing binary or Android; malformed/failed acknowledgements stop bootstrap before its
installation marker is created. Active or uncommitted native work blocks reset. Partial cleanup is
retryable while bootstrap remains incomplete. Ordinary logout does not invoke this reset. This deletes
local alias/cache metadata, not backend key registrations or the opaque DeviceCheck private key.
An older binary's reinstall followed by an upgrade can leave native state outside this marker's reset;
upgrade/reinstall/device acceptance and an explicit retirement owner are still required before activation.

This connects tested model/native-storage ports, not a UI or live API transport. Voluntary recovery and
retirement controls, authenticated app orchestration, registered-key use, supported route rollout and
real signed-device termination/restore/Keychain acceptance remain release work.
