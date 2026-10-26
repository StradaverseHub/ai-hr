# Mobile improvement implementation progress — 27 October 2026

The approved order remains security/reliability, then attendance integrity, offline attendance and the
remaining employee/approver plans in the [review](mobile-app-deep-review-2026-10-27.md). This record
distinguishes implementation evidence from device acceptance and deployment. No phase is complete
merely because a targeted test passed.

## Security and transport foundation

Candidate `947b6b36628a3c7695b8ea15a55b66f739feed58` introduced shared PostgreSQL abuse budgets,
local admission, actor/source isolation, bounded request/response bodies and deadlines, native
response validation, same-scope refresh preservation and patched application Zod. The reviewed
ingress configuration is prepared but not installed or trusted on staging.

[Full CI run 40381186567](https://github.com/StradaverseHub/ai-hr/actions/runs/40381186567) reached its
terminal result without cancellation. All three browser engines completed, as did compiler, build,
migration checks and the complete test inventory. Its 50 test-unit reports record 28,116 executions,
28,114 passing and two failing in `test/mobile-composer-tasks.test.ts`. The final verification job
correctly refused release. These counts include repeated browser-engine executions; they are not
28,116 distinct test cases. The run has 59 jobs: 56 successful, two failed (test unit and verifier),
one skipped. Original reports retain their original SHA and failed observations.

Repair `42033decc` supplies the new budget dependency at that test's existing mocked service boundary,
asserts authenticated actor admission and verifies a refusal never reaches the inbox. All four
targeted cases pass. Production enforcement was not weakened. Current CI resume modules explicitly
emit assessment-only output and are not an activated release workflow, so this targeted repair
does not turn the old failed run into a passing release witness. The integrated candidate still
requires the official exact-candidate verification.

The owner-approved staging database read found migration watermark 498, matching the pre-change
journal; the server reported matching deployed/built source `2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f`
and no stale build. This was a read-only observation, not application of migration 0613 or a release.
No production system was changed.

The integrated follow-up also refuses missing/malformed trusted-ingress identity before session work
when operator trust is enabled. Native token, embedded sign-in and company discovery bodies share the
bounded streaming reader; shipped discovery callers explicitly supply Expo's streaming fetch.

## Submission recovery implementation

Checkpoint `5d138db4d` adds own-actor/active-employment receipt lookup independent of the current clock
day and leave history page. Its two database suites passed 43 cases; targeted screen checks passed.
The subsequent journal implementation adds:

- Exact command strings, immutable request IDs and evidence digests before first transmission.
- Native AES-256-GCM metadata/evidence, scope-bound authenticated data, and a device-only unlocked
  SecureStore key. A secure commit pointer selects the exact encrypted slot; corrupt committed data
  never silently falls back to an empty older slot.
- Same-actor/employment restart hydration after verified online `/me`, no automatic replay and
  explicit receipt lookup/retry. Another account cannot adopt the pending command.
- Foreground checks after encryption and immediately before write transport, including after refresh.
- Failure to persist prevents sending and reports that nothing was sent. Editable drafts remain
  temporary; unresolved encrypted submissions survive logout for the original actor.

Model/native-adapter tests exercise actual shipped orchestration with filesystem/Keychain/native
ports replaced; the encryption adapter fixture uses real AES-GCM. Targeted checks include corruption,
cross-scope ciphertext transplant, key loss, reinstall pointers, commit boundaries, stale accounts,
unmounted screens, duplicate taps, evidence changes and no-send on storage failure. These are not
physical-device, OS Keychain or power-loss proofs.

At the integrated checkpoint, 170 targeted cases pass across 14 files, and root/native TypeScript
checks pass. An initial compiler attempt caught new test type imports leaking native globals into the
server compiler; explicit VM port interfaces corrected that dependency, without changing compiler
strictness. Affected database revalidation and fresh platform exports are recorded separately below
once complete. The local host has no available `simctl`, so these exports cannot substitute for
simulator or physical-device acceptance.

Affected database validation then passed 52 cases across request budgets, mobile routes and native
journeys. A subsequent read/write serialization regression and its journal/native/hook consumers
passed 24 cases. Both platform Hermes exports completed with four journal modules and the SDK AES
adapter present; source-map inspection found no database client, server auth service, node-forge or
nested tooling Zod. The final frozen candidate retains separate compiler/export and CI evidence.

M01/M06 release work still includes real-device termination/upload/relaunch acceptance, backup/key
behavior, bounded retention/orphan cleanup and pending-aware voluntary logout. Cold-offline identity
restoration and offline punch capture are not enabled. Claims never become accepted attendance or
approved leave merely by being stored on a phone.

M03–M15 retain their original acceptance requirements. Hardware attestation, stronger geolocation,
offline adjudication, broader leave/approvals/documents/notifications/claims and accessibility/locales
are not declared complete by this foundation.
