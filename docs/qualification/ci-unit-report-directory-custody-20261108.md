# Complete local unit-report directory custody

Source-only successor of `0273d581872dd9876642a7700aa98fefda716c0a`. The
reviewed merge and all original component requests remain immutable. No new
policy version, native PASS, release receipt or installation is declared.

## P2 closed in source, not yet executed

The move to `merge-multiple: false` correctly kept each artifact separate, but
verify-shards read only `plan.units.map(expected path)` and commissioning read
only each selected expected filename. Extra foreign/duplicate reports could be
ignored before the existing strict report verifier saw them. Required missing
reports did not become passing, and release API inventory checks remained strict,
but the local collector's exact report-inventory invariant was weakened.

One fixed shared reader now handles both CLI paths. Full mode requires exactly
the artifact-directory set derived from every complete planned unit. Commissioning
allows only a selected subset, retaining absent folders or a present folder's
missing report as an explicit missing outcome through the original summary.
Neither path silently ignores a foreign folder/report. Every actual member in
all present folders is scanned before even the first report is yielded. A report
is only the matching root-level `unit-<id>.json`; any other `unit-*.json`, even a
matching ID nested below another directory, refuses. The parsed report ID must
match that filename/expected unit. No second copy can disappear into an iterable.

The root/artifact/ancillary directories must be real nonsymlink directories,
owned by the current receiver. Every member is metadata-inventoried; symlinks,
nonregular members, report hardlinks, malformed structure and excessive counts /
bytes refuse. Directory enumeration uses bounded one-entry native iteration,
not an unbounded array read before checking a cap. Complete dev/inode/mode/owner/
link/size/nanosecond-time snapshots are rechecked before and after descriptor
report reading and final iterator completion. Replacement and late additions
cannot inherit the original inventory. Report reads use NOFOLLOW/NONBLOCK,
pre/post native descriptor identity, bounded EOF and exact UTF8 byte round-trip.
JSON failures do not reflect private report contents. Ancillary contents are never
opened or parsed: health/PDF/role receipts, native binary log parts and empty ready
directories retain their own separate semantic/API receiver owners.

Bounds are the existing values, not a smaller guessed cap: at most256 full units,
16 selected commissioning units, legacy100 entries /64MiB member /128MiB expanded
(from the unchanged legacy extractor), and the existing employee256-entry binary
receiver with the same64MiB member /128MiB expanded limits. Metadata includes
physical directory entries, matching the existing employee retained-byte reader.
No ZIP receiver, native parser, legacy extractor or original resource/job/case
budget changes. The helper opens only the matching report body, one at a time;
commissioning preserves its iterator and missing-outcome behavior. Full verification
still consumes all entries before publishing the existing complete receipt.

The existing API/ZIP controller/blob/source binding is unchanged. Local filesystem
custody is not proof of a real job, successful tests, native plans, speed, process
settlement or release authority. Those original conjunctions remain mandatory.

## Source and integration scope

Only the shared reader/models/thin wrapper, the two CLI call sites, native employee
source/critical-omission lists and this source record change. All3439 old source
members remain, with three additions: shared reader, its real filesystem models
and its thin test selector. The complete component list is3442; controller paths
derive65 from its original63 plus the two new CI files. Independent omission
controls cover all three additions. Old historical component hash maps are not
rewritten. Root owns the new global integrated map and fresh policyv21 audit.

Four complete parent-file inverses bind the integrations and source-list changes
to0273. The existing18 lifecycle and28 evidence intentions remain (the source
closure omission case grows without deleting prior owners). All original5 native
entry files, both native SQL bodies, shared kernel, PG custody owners, old role /
authority controls,44 phases/27 classic/22 ASCII pairs and1000ms whole-port targets
remain unchanged. Previous source-specific passes and failures keep their source
identities; no receipt is transplanted.

## Prospective hosted verification only

New `test/ci-unit-report-directory-contract.test.ts` wraps exactly12 real filesystem
models from `.github/ci/unit-report-directories.test.mjs`: mixed ordinary/browser/
legacy-native/employee artifacts and ancillary evidence; full expected-set
coverage; actual commissioning missing outcomes; foreign/duplicate/nested report
refusal before yield; root/directory/report/ancillary symlink refusal; hardlink /
nonregular/empty/oversize refusal; UTF8/JSON/ID mismatch; actual100/256 entries and
64MiB ancillary boundary; replacement after inventory; late reports/root replacement;
closed modes and unit limits. These are NOT actual API/native execution claims.

After root plus independent review: new12 filesystem models, affected18/28 source
wrappers and controller tests/complete planner checks on standard hosted Actions.
Root commissions all5 native units only after actual policy/admission review and
all prerequisites. The previous classic slow-port and ASCII external timeout
remain unresolved until actual qualified execution; no speed or restoration waiver.
No local tests, compiler, app, database, Docker, provider or deployment was run.
