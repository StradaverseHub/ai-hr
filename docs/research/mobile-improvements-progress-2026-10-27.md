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

## Verified foundation and M06 follow-up

[Run 40388034577](https://github.com/StradaverseHub/ai-hr/actions/runs/40388034577) successfully completed
the complete official gate for frozen `9634f36148af78a46f7b99bc734a6121aeb5cb6a`, controlled by
`67be2710c35035af433bdb2fcdfb2cb30277ceda`. All 59 jobs reached terminal state: the required compiler,
build, migrations, complete unit inventory, all three browser engines, final verifier and deployment
hold passed; optional diagnostics stayed skipped. Its 50 unit reports contain 2,032 file executions
and 28,156 test executions with zero failing tests. Original run 40381186567 remains failed at its
actual source; it was not relabelled. No staging deployment or branch alignment follows merely from CI.

The isolated follow-up implements server-ordered abandonment, pending-aware voluntary exit and bounded
quarantine cleanup under [ADR-0143](../adr/0143-mobile-submission-abandonment.md). Its first 24 database
cases and subsequent 65 consumer checks passed, with further unattributed-record and terminal-response
coverage added before final validation. These follow-up changes are not covered by run 40388034577.

The integrated `08a2f0412` follow-up retains verified alpha ancestry and appends the unchanged budget
migration after its existing journal prefix. Affected database suites passed 62 cases; nine guard and
native-consumer files passed 69 cases. Native TypeScript and both Hermes exports passed. A deliberate
temporary removal of the two abandonment writer checks made both corresponding tests fail by accepting
the abandoned requests; restoring the checks made both pass. These mutation results establish that
the refusal tests exercise the writer guards rather than an unrelated RLS or environment failure.

## M02 shared reads and retry handling

The native read coordinator shares concurrent identical GETs within an identity, company profile,
origin and language, with independent consumer cancellation and a bounded 64-key in-flight inventory.
It retains no completed HR response globally. Safe server retry hints create bounded monotonic
cooldowns; nothing automatically retries in the background. Same-scope retained data now shows
refresh/stale status, while account, connection and language changes reject obsolete results before
screen or sign-out side effects. Writes retain the existing explicit immutable-command behavior.

Focused validation passed 43 cases across five files, plus native TypeScript. Final language-change
coverage then passed all 30 cases in the affected transport, coordinator and load-state files. These
targeted results do not substitute for a complete frozen-candidate gate or signed-device acceptance.

## M03 reported uncertainty and own-employment preview

The isolated follow-up implements shared `distance + reported accuracy <= site radius` containment
for every enforced punch path and its own-employment preview. Company policy may supply an additional
positive uncertainty cap; migration 0621 adds a nullable column without selecting a universal default.
An older policy writer preserves the configured cap, while explicit null removes it. The existing
settings editor and six catalogs expose the option. Assignments still require an active site open to
the employment's current company; manual/non-geofenced paths keep their prior behavior.

The bounded, authenticated preview POST keeps coordinates out of URLs, writes no attendance, and
returns typed quality reasons. Native review shows available site, distance, radius, uncertainty and
company cap. Permission/service/fix failures remain distinct, with an explicit Settings recovery path.
Services discovery and one fix share a 20-second deadline; late discovery cannot initiate another fix.
The command rechecks current policy and includes an additive typed location-refusal reason while
preserving existing v1 outcome codes. Neither reported accuracy nor a negative mock flag proves presence.

At `79867f209`, six database/API/migration files passed 127 of 128 cases. The one new fixture first
lacked its entitlement snapshot and then its existing account-bound clock context. Those production
guards stayed intact. At `e44a797d3`, the corrected fixture passed separately. The original failed
attempt and both fixture repair logs remain separate. Five native consumer files passed 49 cases;
native TypeScript and both Hermes exports passed. Export maps contain 1,327 iOS and 1,458 Android
sources, with no database client, server auth service, node-forge or nested Zod 3 modules.

The deliberate temporary containment mutation accepted an otherwise refused punch and made the
database test fail. Restoring the exact committed helper made that same test pass. The initial root
compiler exhausted its default 4 GiB heap; the 8 GiB retry passed without relaxing type checking.
The final 8 GiB repository compiler check then passed, along with all 20 cases in the six-locale
coverage and attendance-settings consumer files. These are focused checks, not a complete gate.

The staging-shaped shadow rehearsal could not establish its SSH connection from this isolated
checkout and remains failed/unverified. A clean-database migration-chain pass is not a substitute for
that live-baseline check. No staging source, runtime or database was changed. Real indoor-device
measurements, signed-build acceptance, durable failed-preparation attempts, M04 attestation and M05
offline adjudication remain open; no offline punch acceptance has been enabled.
