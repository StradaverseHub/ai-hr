# Design only: retain native custody on failed classifier stages

Exact child of frozen e4830a785fde97e0b664488141ba6df6c5f012b4. Its pure
protocol,38 controls,35/30 final member sets and every other executable remain
whole byte-exact. This proposes the finite NEXT protocol/native-owner contract;
it implements nothing, allocates no native profile/policy/workflow and authorizes
no upload, API operation, test or native execution. Root+Compiler review precedes
any subsequent implementation in a new child. ESS guard proposal remains separate.

## Concrete gap and chosen correction

Current e483 assigns native-ownership.jsonl to the last actual seal stage. Its
honest failed-phase prefix therefore cannot retain an earlier actual ownership
ledger. Failed CLI stdout is not proof that the source-bound kernel admitted,
stopped, drained and reaped the intended family. An empty/missing ledger cannot
mean no process started. The actual qualified cb1 kernel can fail opening a pidfd
AFTER fork but BEFORE its first event; event absence alone proves nothing.

Move native-ownership.jsonl OUT of seal's stage-produced output group into the
mandatory terminal-member set beside phase-seal.json. The same35/30 basenames
remain unchanged. The ledger is opened exclusively under actual private custody
BEFORE the first possible native invocation and appended incrementally from real
native observations. It is never created/rebuilt from a terminal result JSON,
filled with inferred successful rows, discarded on failure or deferred until a
future seal. Actual kernel settlement remains unchanged and owns its native events.

All OTHER data members retain the exact completed-stage plus failed-stage-output
PREFIX grammar. The last seal stage's ordinary member group becomes EMPTY; the
actual seal operation still exists with the same10s work+6s settlement and must
really run for native completion. Its presence/outcome is NOT inferred from the
terminal metadata file or the ledger. phase-seal still uses executed versus
not-reached; earlier failure cannot pretend the final stage executed.

## Fixed incremental ledger and actual evidence producers

The future implementation must preserve the ACTUAL cb1 kernel bytes and exact
four event families. No kernel fork/ACK/signal/deadline/handler/resource mutation.
The existing historical69f adapter provides a reviewed source reference: its
real event callback verifies upstream before ACK, then uses K.append_event, and
its finally settles/drains despite event failure. It is not a witness transferred
to the new source. The future owner must prove its own actual call/source context.

Proposed ledger rows are canonical single-LF JSON with dense global sequence,
version1, fixed stage (or null ONLY for root-owner boundary rows), and a closed
kind. Unlike e483's generic data placeholder, they preserve actual kernel packet
payloads; no unavailable PID/start/group field is invented to fill a flat shape.
Exact future codec rows must implement this closed union:

| kind | Exact payload course |
| --- | --- |
| owner-pinned | Actual root/closed-adapter PID/start/parent PID+start from before/after native reads, role root or stage-adapter, fixed stage; existing actual owner/pidfd context admission must succeed before accepting this row |
| kernel | EXACT native packet passed by the hash-qualified K.supervise event callback, fixed current stage; four packet variants below, without caller-selected event names or rewritten result fields |
| upstream-owner-lost | Actual pinned upstream PID/start whose existing pidfd became readable, fixed active stage (or null before stage); no numeric PID rebinding/foreign kill and no caller asserted lost bit |
| owner-close-observed | Actual SAME root/adapter identity after its mandatory close, fixed stage or null; native child set observation and owned-handle closure observations, with explicit unavailable variants when a check could not be made |

The proposed wrapper has EXACT keys version, sequence, stage, kind, payload.
kind fixes the payload schema; no optional arbitrary metadata bag. For owner-pinned,
payload keys are actorId, role, pid, startTicks, parentPid, parentStartTicks,
groupId, sessionId, uid, children; role is root or stage-adapter, actorId is a
dense first-observed ID, native numeric identities are positive safe integers
(uid may be0), start ticks are canonical decimal strings. children is exactly
{state:empty} or {state:nonempty,count:<positive integer>} or
{state:unavailable,reason:identity-read|owner-changed|read-bound}. Only an actual
empty native child observation can use empty; a nonempty/unknown baseline refuses
further work in these dedicated qualified actors and preserves foreign children.
For kernel, payload is exactly one of the four dictionaries below. For
upstream-owner-lost, payload is actorId, pid, startTicks, with the actual pinned
upstream identity and actual existing-pidfd readability. For owner-close-observed,
payload is actorId, identity, children, handles. identity is {state:matched} or
{state:unavailable,reason:identity-read|owner-changed|read-bound}; children uses
the same closed union. handles has EXACT writer, reader, stdout, stderr, pidfds,
kernelDescriptors keys. The first five each use closed, not-created or unknown;
kernelDescriptors uses kernel-returned-closed, not-entered or unknown. A real
stage-ended packet is emitted only AFTER cb1's descriptor-close finally, and its
whole-source path plus actual packet can support kernel-returned-closed. It is
not a guessed FD number or fabricated independent descriptor observation.
Other owned handle states require their actual close/EOF/finish/error course;
not-created is source-fenced, not a default after failed setup. Unknown never
counts as closed. Root boundary stage is null; stage-adapter/kernel rows have
the fixed actual stage. Actor IDs/roles never authorize a command or lookup.

The kernel packet variants remain EXACT cb1 payloads:

- session-admitted: kind, pid, start (actual reserved monitor; emitted BEFORE ACK).
- group-stop-before-reap: kind, reason (existing fixed K.REASONS enum).
- group-quiescent-then-reaped: kind, monitorExit, escapedSession.
- stage-ended: kind, reason, commandExit, admitted, reaped, groupQuiescent,
  escapedSession, releaseAuthorized=false, with actual existing return types.

Do not invent a command-started or workload-consumed-input event: cb1 emits
neither. A session-admitted callback alone is not proof that ACK succeeded or
that Node exec completed. Actual Node PID/start/exe/argv and stdin endpoint proof
remain the future native adapter's independently checked existing obligations;
where unavailable, that attempt cannot claim full actual-CLI conformance. Native
packets without PID fields link ONLY to that stage's actual qualified invocation,
never to a guessed/previous monitor. No actual-CLI time is fabricated for no-ACK.

Owner boundary payloads must be derived by actual source-executed identity/child/
pidfd/handle checks, not copied from a fixture or producer true flags. Closed
unavailable observations carry a fixed reason enum instead of zeros/empty sets.
The native owner/receiver source review must freeze the concrete native read
seams, actor count and identity relationships for these exact keys before implementation approval;
this document grants no arbitrary callback/command/role/event broker. Expected
maximum is one root and at most two additional declared actor contexts per fixed
stage; any need for more contexts requires review, not a dynamic actor registry.

Every successful append commits one complete actual observed row. The sink must
use a genuinely owned exclusive-created regular file, no symlink, one link,
correct native UID/mode, fixed actual path/FD identity and ordered append. Keep
actual kernel append's existing131072-byte bound in addition to the named16MiB
archive maximum: the stricter128KiB intersection wins. Do NOT increase it. At
most128 rows and1024 bytes per wrapped row fit within that total; no duplicate
retry on uncertain write. The kernel's original512-byte ready-packet bound is
unchanged;1024 is a wrapper-metadata bound, not a transport raise. Bound actor/
row counts and total bytes before writing. Actual complete fixed schedules fit
only if the future native source/control freeze verifies that arithmetic.

An append failure may throw into K's existing guarded emit; it MUST NOT throw
past mandatory kernel settlement or interrupt cleanup. K records event failure
and refuses/no-ACK or completes its required stop/reap, as its actual code does.
Logging exceptions never turn unknown process state into closed. Original native
failure and distinct ledger/close failures are retained separately. No timer
callback throws through cleanup; the actual owner-loss interrupt must retain
69f's exact qualified-handler code+globals checks, never SELF TERM under default
or foreign signal handlers. No new signal, process, pool, thread, retry or budget.

## Terminal custody state, without authority from JSON

phase-seal gains a proposed CLOSED custody object beside existing progress/seal.
It names the exact raw ledger byte count/SHA256, complete-LF-row count, framing
complete or truncated-tail, and the following state/closure relationship. The
future independent receiver recomputes all counts/digests and replays the actual
row lifecycle. These fields summarize observations; they grant no custody by
assertion. No generic complete=true or enum alone can satisfy a native proof.

| custody state | Required actual facts and honest closure |
| --- | --- |
| not-started | Source-owned launch fence proves NO native invocation was entered; real root owner before+after identities match, actual child baseline/final set has no newly owned child, and all owned handles close. Ledger contains genuine boundary observations, NOT empty fabricated success. No kernel event and no native process/clock/input-consumption claim. |
| closed | At least one real native invocation has a COMPLETE correctly ordered kernel lifecycle; every started/admitted family is actually reaped/quiescent without escape, all relevant identities/owned handles/EOF checks close, and all native/event/transport source guards match. Native command failure/deadline is still failure even when cleanup is closed. |
| owner-loss | Actual pinned upstream pidfd readability observed, immediately latching no later work. Closure independently closed, unsettled or unknown according to real kernel/handle observations. Even closed cleanup cannot recover adoption or native completion after owner loss. |
| incomplete | Any missing/truncated/failed ledger write, missing lifecycle row/result, owner identity uncertainty, escaped/unsettled family, open/unknown handle or missing required native observation. Closure is unsettled or unknown; observed empty local children alone is insufficient to assert complete family closure. |

An empty ledger, absent session event, missing timestamp, null result or wrapper
exit is NEVER not-started/no-process proof. The actual launch fence is set
conservatively BEFORE entering the sole qualified invocation seam; asynchronous
interruption in that interval means attempted/unknown, not a false no-start.
No kernel result after a pidfd-open/handshake failure is synthesized. A genuine
unadmitted-but-reaped cb1 lifecycle may prove cleanup closed (and no ACK workload
admission) through its actual event/result chain and owner boundary; it remains
failed admission, not a completed classifier invocation or a speed sample.

For an admitted invocation, require session-admitted, stop-before-reap,
quiescent-then-reaped and stage-ended in that order, one of each, matching current
stage/owner identity and exact qualified source. For an unadmitted invocation,
DO NOT require/fabricate session or group-stop packets; require its actual cb1
unadmitted/reaped/quiescent result plus actual close boundary. Missing native
result/event makes custody incomplete even if the wrapper exited0. No later
stage can appear after failure/owner loss, and a second terminal/sequence gap or
cross-stage reused identity refuses. Actual no-ACK and pidfd failure controls
must distinguish these courses rather than generalize from an exception class.

## Truncation, phase prefix and bounded close

The raw ledger survives byte-for-byte even when the last append is partial.
Do not trim the tail, append a repair LF, replay an uncertain row or rewrite an
invalid native value. An independent receiver may parse the COMPLETE LF-framed
prefix as partial observations, but a truncated/invalid/gapped ledger is always
custody incomplete. No missing event can be filled by phase-seal metadata or a
later genuine passing Vitest report. If the process dies before phase-seal is
written, the collector retains raw known-member failure data but cannot invent
a terminal metadata file or accept a complete/closed callback.

Mandatory terminal set is now binding/anchor/prerequisites + incremental ledger
+phase-seal (and actual three program bodies for semantic); report.json remains
EXCLUDED from callback. Ledger and phase-seal are terminal artifacts, not a claim
that either existed successfully at bootstrap. If exclusive creation or final
capture fails, the known raw failure files are retained as unavailable evidence;
the accepted callback grammar cannot synthesize their absence away. All ordinary
data files still equal completed-stage outputs + failed-stage member PREFIX.

The future producer must commit failed-phase data in that declared order. For
CLI, actual clock and stdin custody metadata precede admission/ACK; actual stdout
and stderr sinks may be prepared privately, then committed to their fixed member
names in prefix order BEFORE ACK. Callback refusal at that frontier means no CLI
workload was admitted; never manufacture a clock/endpoint to make a prefix fit.
Once ACK can run the CLI, those earlier members and the real raw log sinks are
already present. Native-result is committed only from the actual settled return;
if unavailable, retain the four earlier members and actual raw output prefix.
A producer that cannot maintain this ordering must refuse its framing rather
than drop nonempty raw output or fill metadata from defaults. No unreviewed
extra archive basename or partial-row merge resolves such a failure.

Native stage settlement retains its EXISTING6s reserve. The outer mandatory
owner-close also retains ONLY its EXISTING6s: stop new work, close/drain the owned
writer/reader/output handles, complete the existing required ownership checks,
flush/capture the actual bounded ledger and write terminal metadata. It cannot
run a later source/graph/classifier/seal stage, obtain an extra10s seal interval,
launch a new helper or repeat a failed cleanup. Metadata I/O/identity observation
must fit that same real close deadline. Expiry/blocked I/O/missing observations
leave custody unavailable; they do not extend the deadline or cause foreign
cleanup. If the underlying qualified family remains unsettled, close cannot
call it closed merely to fit the envelope. Preserve the uncertainty and hold.

The full native-success conjunction still requires ALL13/15 stages including
actual seal, complete source/graph/CLI requirements, valid incremental lifecycle,
actual handles/EOF/family cleanup, and subsequent genuine one-file/one-case PASS
report produced after callback and runner settlement. All35/30 final members
remain mandatory for that conjunction. Any partial/owner-loss/truncated outcome
is failed/unavailable even if data classification or Vitest shape looked green.
Later authenticated API/Git/source/runtime replay remains mandatory. No adoption,
zeroBusy/page speed, release or deployment authority follows from partial custody.

## Finite future changes and discriminating controls

AFTER this DESIGN is root+Compiler approved, prepare a NEW source child only:
update the pure protocol's ledger union/mandatory-terminal grammar/phase-seal
custody relation and controls; freeze exact source/whole inverses. Compiler owns
actual fixed native adapter/append/collector/source custody separately, with no
change to cb1 kernel or any algorithm/resource/clock/transport acceptance. Keep
all38 protocol and46 classifier intentions; no existing failing result relabel.

Required new controls/real native checks (counts frozen at implementation):

1. Source launch never entered + actual before/after no-child/closed handles:
   genuine not-started; an empty/missing ledger cannot substitute.
2. Kernel called but pre-event pidfd failure after fork: no fabricated admission,
   clock or closed family, actual no-ACK mandatory cleanup still runs.
3. Actual CLI deadline/command failure with COMPLETE stop/reap chain retained in
   ledger BEFORE later seal; callback failed, cleanup closed, raw stdout exact.
4. Upstream owner loss before ACK and after ACK: no late stage, proper existing
   qualified-handler interruption, actual mandatory settlement or uncertainty.
5. Event append fails/short-writes/loses final LF: real cleanup still attempted,
   tail retained unchanged, custody incomplete, no second terminal or retry.
6. Kernel result/monitor exit/group emptiness alone, reused PID/start/sequence,
   event omission/duplication/reordering, escaped descendant or unclosed EOF:
   native completion refuses; no JSON state or actual Vitest PASS overrides it.
7. Failed ordinary-phase prefix plus mandatory early ledger+seal-not-reached is
   honest failure; a future seal/native-result or later-stage member refuses.
8. Actual bound exhaustion/owner-close expiry cannot buy another stage/cleanup
   allowance or drop original rows; exact35/30/128KiB/128rows/1024row intersections.
9. Full successful actual lifecycle plus real final report still passes the
   independently authenticated whole conjunction only at its own frozen source.

Local work is DOCUMENTATION/SOURCE INSPECTION ONLY: read actual cb1 supervisor and
historical69f event/owner-loss/cleanup source, Git refs and bytes/hashes. No module,
model/test/native/API/DB/process behavior ran. The companion documentary source
map retains every31 e483 current binding, its3 historical source leads and all
3631 suite paths/digests unchanged. No executable or approval file is edited.
