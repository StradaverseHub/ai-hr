# Closed helper-phase and journal-census implementation candidate

Exact child of approved design847139e7a2f29faf7a00ffaf17b80739d53acc0e.
This is diagnostic source only, never environment acceptance or a release result.
No behavior/model/native operation has executed locally. Production/staging held.

## Actual source and retained failure

Actual failed093 run42462814358/artifact13611290137 remains at its own identity:
ZIP153a746132b21eeaaf30b0c0bf2f25b62af907a4e40a3d0bfac565b0fc719c6e.
Guard620, zero environment observations,7 worker journal records/1 trusted
controller record, absent unavailable flag and owned cleanup true are retained.
The unknown environment field/cause remains UNKNOWN. No allowlist repair follows
from a phase marker or an untrusted prefix count.

The native helper now tracks13 fixed entered phases and at most one terminal
marker. Actual order is timer-armed, context-read, profile-bound, helpers-bound,
observer-loaded, main-selector, declaration-before, process-before,
environment-read, environment-classified, process-after, custody-after,
environment-packet. The design's two adjacent labels were corrected to the
ACTUAL existing order: MAINPID parsing precedes entering the native observer's
custody course. No custody read or native operation was added/reordered to fit a
diagram. Root approved this precision correction; frozen design stays historical.

The new kind/prefix is OWNED_OBSERVER_PHASE_NOT_ENVIRONMENT_OR_ADMISSION /
AIHR_OWNED_ENV_OBSERVER_PHASE_V1. Its only fields are version, kind, subject,
sequence, phase, result and cause. Subjects are worker-1/worker-2; result is
entered/failed/finished; cause none/refused/budget/io/other. Exact sequence and
terminal rules refuse unknown/extra fields, bool-as-int, duplicated/out-of-order
or after-terminal records. An entered phase proves no completed custody check,
process identity, environment data, readiness or capability. Failure causes use
fixed Python exception families, never dynamic names/messages/errno/native data.

All writes use canonical LF framing, one write and exact full-write checking,
with no retry after uncertain/partial transport. Each phase frame is at most1024
bytes, at most14 phase frames plus the original4096-byte environment frame:
15 messages/18432 bytes maximum. Every operation/write is charged to the ORIGINAL
one-second SIGALRM slice. Expiry allows no further observation I/O; an occupied
timer is preserved and yields no observation as before. Failures can leave a last
entered marker or no marker at all. No empty result becomes a cause assertion.
Original FD/timer finally blocks and the entire main() unconditional scrubbed
controller exec remain unchanged. New tracing cannot authorize a worker, prevent
original admission exec or skip original cleanup.

## Original native environment proof and strict receiving

next_profile.py changes ONLY its optional private diagnostic hook argument and
six fixed hook calls. Removing those exact lines/signature reproduces the ENTIRE
parent file. Guard620, three environment acceptance sets, forbidden override
checks,59-label observational map, original environment classifier/validator and
all native source/process/custody/start/invocation/argv checks remain exact.
No pure/classifier/phase payload gains native provenance fields.

The original runtime_environment_journal_observation function is whole-byte
unchanged. A new optional wrapper first uses it for actual environment evidence.
Its separate phase receiver requires the same sealed helper/profile sources and
trusted root UID/Python exe/owned unit/invocation/exact helper argv. It compiles
only those already hash-verified fixed source bytes to use the actual helper
codec. A ledger must start at timer-armed; a host-hook subsequence is rejected as
full-helper evidence. Any malformed/duplicate transition makes the entire phase
ledger unavailable. Optional phase failure, including source loading/parsing,
retains any original validated environment observation. It never weakens the old
controller literal/exception receiver, whose complete function is also unchanged.

The new CLOSED_OBSERVER_PHASE_DIAGNOSTIC_NOT_ENVIRONMENT_OR_ADMISSION report has
unit, state, phases, census and phaseUnavailable. States are environment-observed,
phase-only, untrusted-candidates-only, no-candidates or receiver-unavailable.
The census kind is explicitly UNTRUSTED_PREFIX_TRANSPORT_COUNTS_NOT_HELPER_OR_ENVIRONMENT_PROOF:
records, environmentCandidates, phaseCandidates, trustedHelperCandidates,
metadataMatches(uid/executable/unit/invocation), and commandClasses(helper/
controller/other-or-missing). All counts are bounded by the original64 records;
no raw unknown message, metadata, name/value, private profile or argv is reflected.
A phase subsystem failure can carry census=null and phases=[] with unavailable;
that is absence of new evidence, not an accepted empty ledger. Valid original
environment observations are carried separately and are never derived from these
counts. A worker/controller printing a prefix cannot become a trusted helper.

Original journal aggregate caps remain64 records/131072 bytes, including unrelated
traffic; saturation refuses, never truncates into success. Original diagnostic
budget is unchanged. No subprocess/socket/file transport, manager environment,
resource or framework change is introduced. Observational failures remain
nonfatal to original admission and cannot discard original literal diagnostics.

## Host component and prepared controls

The existing same-unit host component collects the actual six shared observer
hooks on its existing native process: declaration-before, process-before,
environment-read, environment-classified, process-after, custody-after. Its new
strict TypeScript receiver requires that exact sequence and flags
fullHelperVerified=false,nextApplicationVerified=false,releaseEligible=false.
It does NOT execute the stock-Next full helper/declaration path and claims no such
coverage. Original actual environment proof, namespace/cache/resource/foreign/
stop/disposal assertions and20+7+3/35,15-second service and resource limits remain.

The source/model selector now declares24 cases: all original16 case bodies are
exact, plus8 substantive cases for the actual bounded tracker/full ledger;
closed error families/privacy; partial writes/expiry/occupied timers; actual
best-effort failure/timer restoration; trusted-metadata versus untrusted census;
malformed/terminal sequences with original-observation preservation; real shared
observer-model hook subsequence/refusal; and complete parent/native/validator/
main-source invariance. Its original10-second child allowance is unchanged.
These are models, never native receipts.

All original21 host-view,22 diagnostic and16 profile intentions remain. Source-
history consumers first reverse the new COMPLETE nine-parent-file inverse layer,
then the immutable093 observation/CPU/cleanup layers in their original order.
No old hash is recaptured; even both modified source-history consumers and the
TypeScript host receiver/wrapper are reconstructed completely. The new source
record retains every prior74 binding at current bytes plus this record, inverse
and immutable design source record. It is an explicit review/check closure, not
a complete installed/native/process qualification receipt.

## Required qualification and remaining limits

Root plus independent FULL code/model/inverse/closure review precede upload or
execution. Then run actual24/21/22/16 hosted models and existing one host component;
let all planned chunks finish before repairs. Authenticate actual source,
controller, complete counts, APIs and ZIPs. Retain earlier valid source-specific
results only under the recovery policy, without transferring them to this source.

Root alone may then consider ONE original full native attempt with a mandatory
NEW same-run canonical build. All original full worker/unit/profile/cleanup caps
and literal guard620 stay authoritative. Full-helper phase/census must establish
where evidence is available; no marker, last entered marker or controller-argv
candidate is an environment cause. A different transport or environment correction
requires its own concrete evidence/review. Full Next/browser preflight, all roles,
46 families/120 pages, resource-matched2/4/8 workers, zero Busy/crashes/blocking
application locks, source convergence and final release remain OPEN.
