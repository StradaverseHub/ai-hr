# Closed observer-phase recovery — proposed design only

Base093633d3fc1bb26b66aa106c839e3fd6e0e283b0. No code, guard, allowlist,
resource, timeout, profile, framework, deployment or provider change is made here.
Root review precedes implementation; no local/native behavior has run.

## Actual failure, without an invented cause

Retained actual full native run42462814358 failed at source093 before the first
worker admission. Artifact13611290137 ZIP SHA256
153a746132b21eeaaf30b0c0bf2f25b62af907a4e40a3d0bfac565b0fc719c6e
was independently rehashed; runtime-next-admission-native.json reports guard620,
environmentObservations=[],7 worker-1 journal records/1 trusted controller record,
no environmentObservationUnavailable flag, ownedRuntimeCleaned=true. Worker-2
has no current invocation. These facts do not identify an unknown key or value.

Actual source explains the ambiguity: next_fixture_poststart.best_effort_observation
swallows every failure and occupied-timer case, then unconditionally execs the
original scrubbed controller. The optional strict journal receiver can also
return [] after filtering every message without raising. The missing flag means
that receiving/parsing did not throw; it does NOT prove the helper succeeded.

The existing canonical() already frames its message with LF. No newline repair
is justified. Full helper source/custody/declaration/module/selector/native-proc/
environment/classifier/budget/write failure and trusted-metadata filtering remain
possible. Journal collection of process metadata around the SAME PID's exec is
an unproven alternative; do not admit controller argv as helper argv on that
premise. Do not infer proc-read denial from CapabilityBoundingSet alone: the
actual ExecStartPost uses systemd's '+' prefix. No environment cause is proven.

## Minimal two-part diagnostic

Add ONLY bounded, closed phase observations and a receiver-side fixed census.
The original actual environment observation remains the SOLE environment-image
claim. Guard620, all acceptance sets, forbidden predicate,59-name observational
vocabulary and original controller literal/exception branch stay byte-identical.
No name/value, hash/length of a value, raw exception, errno/path/argv/PID, native
source payload or arbitrary enum is published by the new phase channel.

1. A source-owned progress hook marks13 fixed stages in order: timer-armed,
   context-read, profile-bound, helpers-bound, observer-loaded,
   declaration-before, main-selector, process-before, environment-read,
   environment-classified, process-after, custody-after, environment-packet.
   A stage marker means execution entered that stage, NOT successful custody,
   stable process, observed environment or admission. Add at most one closed
   terminal failed/finished marker; duplicates/out-of-order/foreign-subject
   sequences refuse diagnostic acceptance.
2. Use a NEW distinct fixed prefix/kind, subject worker-1/worker-2, version,
   phase, result entered/failed/finished, and cause none/refused/budget/io/other.
   Failed causes map only fixed exception families; never stringify an error or
   report its dynamic class. No sourceVerified/processStable/readiness flag.
   A pure classifier or copied JSON cannot mint environment/native authority.
3. A marker is emitted as one canonical LF-framed write, max1024 bytes, with
   actual full-write verification. All writes, source work and native reads are
   charged to the SAME existing one-second SIGALRM slice. No work/write after
   expiry, no subprocess, retries, new socket, file transport or manager change.
   If an old timer is occupied, preserve it and skip observation as today; do no
   new unbudgeted I/O. A failed/incomplete phase write ends optional observation,
   closes owned descriptors and still reaches the unchanged original exec.
   An expiry can leave only a last entered marker; absence is not a timeout proof.
4. The hook is a private fixed diagnostic callback in the sealed actual native
   owner, not a public configurable command/validator/permission API. The helper
   owns the enum and monotonic sequence; the observer supplies only fixed stage
   calls around its existing operations. Actual source/process/declaration
   before/after validation remains unchanged. Original finally blocks close all
   FDs/timers and restore the handler; KeyboardInterrupt/telemetry failure cannot
   skip original admission exec or original native cleanup.

With13 entered markers+one terminal marker+one existing environment message,
new traffic is at most15 messages and18432 bytes (14*1024+4096), inside unchanged
64 records/131072-byte transport. Existing unrelated journal traffic still
counts toward those ORIGINAL aggregate limits: saturation refuses diagnostics,
never truncates a record set into success or raises a cap. The one-second total
must cover all overhead; no assumption that a timestamp check bounds a blocked
operation without the existing real timer. Full/host/native work, cleanup and
outer case limits remain unchanged.

## Trusted receiver and honest absence states

In the separate optional observer branch, verify sealed profile/helper source
hashes, actual owned unit/declaration, exact root UID/Python executable/unit/
invocation AND helper argv as today before accepting a phase payload. The new
phase payload proves only a trusted helper phase observation, never main-process
identity or an environment classification. Validate exact keys/types/enums,
duplicate JSON keys/records, monotonic bounded stages, message/transport bounds
and terminal transitions. Do not let a parsed phase packet authorize the old
actual-environment record. Keep that record's existing validator unchanged.

Independently return a closed census even when no trusted phase/environment
packet is accepted: total journal records; counts of candidates with the two
fixed prefixes; trusted-helper records; and counts in the fixed command classes
helper/controller/other-or-missing. Include only aggregate counts and fixed
metadata-match booleans/counters for UID/exe/unit/invocation/argv. Never echo
unknown native fields, command strings, message bodies or untrusted phase data.
Candidate counts are explicitly UNTRUSTED transport observations, not source,
helper-execution or environment evidence. An arbitrary worker printing a prefix
cannot acquire authority. A malformed optional packet records only a fixed
unavailable reason and leaves original controller diagnostics intact.

Final states distinguish: trusted actual environment observation; trusted phase
only; untrusted-prefix candidates only; no matching candidates; and receiver
unavailable. They must not collapse all four failures to [] or treat a missing
record as success. With trusted phase only, report the last entered phase and
closed terminal cause if actually received. With no trusted marker, do not claim
the helper was reached, its timer was occupied, or a custody check failed.

This separates a helper/source/native-read failure from a trust-metadata mismatch
when real evidence permits. It does not guarantee that journald delivers any
packet under every failure. If the only matching candidate carries controller
argv, that remains rejected; a later ownership-preserving transport design needs
root review. No automatic receiver relaxation or additional full build by default.

## Proposed files and discriminating hosted proof

Implementation scope, only after root approves:
- deploy/admission/next_fixture_poststart.py: private phase tracker/writer around
  existing bounded helper course; original unconditional scrubbed exec remains.
- deploy/admission/next_profile.py: fixed diagnostic phase hook points/schema,
  with original environment validator/acceptance/native proof unchanged.
- deploy/admission/test_next_native.py: separate typed phase receiver/census;
  preserve old controller branch and original overall diagnostic budget.
- Existing Python source/model and TypeScript receiver tests, current source map
  and COMPLETE new whole-parent inverse layer; historical72-member declaration
  and old CPU/cleanup/guard inverses remain immutable and correctly composed.

Preserve old16 environment,21 host-view,22 diagnostic and16 profile model
intentions. Add meaningful source/model controls for actual phase sites/order;
each closed failure family; every native metadata mismatch; untrusted controller/
worker prefix; duplicate/extra/raw-private payloads; malformed/partial write;
expiry/occupied timer; unconditional exec and descriptor/timer restoration.
Use current real receiver and helper seams, not a second harness codec. Freeze
actual case counts/source closure before publishing; no source/model execution
locally and no newly allocated case/native time allowance.

Use the existing same-unit host component to check the shared native process
observation/hook under its existing20+7+3/35 envelope and unchanged resources.
It currently calls observe_owned_environment directly; it does NOT execute the
stock-Next full_observation helper/declaration path. Do not pretend that component
proves the missing full helper phase. It may validate shared hooks and receiver
mechanism only, without weakening stock argv checks or inventing a fake Next
receipt. Additional full-helper components require a separate concrete review.

Only after source/models/component acceptance may root consider ONE original
full native unit with a mandatory NEW same-run canonical build, exact source/
controller/API/ZIP custody, all current guards/resources/cleanup and no environment
acceptance correction. Require closed phase/census evidence; preserve the actual
failed093 witness. An unknown field/ownership/value/lifecycle correction is a
separate design justified by an actual native observation, never a guessed list.
Full Next/browser/capacity/zero Busy/release remain OPEN; staging/production held.
