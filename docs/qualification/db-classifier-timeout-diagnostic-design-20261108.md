# Classifier correctness and 15-second timeout: source-only diagnosis/design

Target bd63c9f8559c037d4e29c8d738bced5c0aaf01a3; no source/runtime edits.
The owner of the normal CI repair remains root. This design does not dispatch,
raise a timeout, admit a classifier result or change the original failure.

## Observed facts

Run42458527894 completed failure after its controller checks. The actual failing
child is plan.mjs29–30: pinned Node22.23.3, --experimental-strip-types,
scripts/gate-db-classify.ts explain, timeout15000ms, SIGTERM, stdout/stderr empty.
Its complete source is9833 bytes, SHA256
cc77445ba5b8a702a5f8f4a4292bdcb99275d520ae4f13b16442a17e78f3f916.
That script is byte-identical at successful source9207661/run42454014564.
The sorted suite grew3594 to3627 (37 added/four removed); current test sources
contain46,320,793 bytes. Existing complete reconstruct steps took25 and26 seconds
in42454014564/42449534164; those are WHOLE-step timings, not classifier timings.
The current first normal controller517 run skipped reconstruction after its
independent control failures, so it supplies no same-source classifier timing.

The expensive complete singleton hashing in createPlan happens AFTER the child
returns. It cannot be the phase terminated by this ETIMEDOUT. The classifier
itself reads stdin, classifies the entire suite and only then prints output;
empty stdout does not identify startup versus IO versus lexical CPU work.

## Priority correctness lead: incomplete cycle results must not become NoDB

This is a source-derived counterexample, NOT an executed test or observed runtime
partition defect. The present implementation caches finished B as NoDB after
visiting A while A is in progress:

  A: import './b'; import 'postgres';
  B: import './a';

classifyTestFiles([A,B]) can finalize B from the temporary cycle=false before A
later discovers its real driver import. Reversing root order can classify both
DB. Existing r417 fixtures cover transitive helpers but contain no cycle/order
case. A source cache optimization must not preserve or accelerate that false
NoDB proof. Actual occurrence in the real repository is unknown.

First hosted red-capable control: feed these fixed in-memory source strings to
the ACTUAL original exported classifier, in both root orders and all rotations
of a longer cycle. Strings use the existing IMP placeholders in the test source
so the self-test itself stays NoDB. Require intended reachability: every node in
a cycle reaching a driver/text/unresolved/opaque-dynamic hazard is DB. Also retain
a pure hazard-free cycle, diamond, self cycle, absent helper, an early safe child
followed by a later hazard and the original first-rule reason cases. Record the
original order discrepancy; do not fake a pass against legacy behavior.

Correctness design: own one complete finite test-helper graph per classification
request. Preserve DB_TEXT precedence, opaque-dynamic precedence, exact resolver
suffix/stem order and test/-only recursion. Store ordered alternatives up to the
first direct hazard. Compute the reachable hazard closure by complete SCC or
reverse-edge propagation. Finalize NoDB only after all reachable components and
outgoing alternatives are resolved. Select the first deterministic reachable
hazard in original ordered DFS, avoiding cycle revisits; preserve existing first
reason bytes on all acyclic/original fixtures. Do not cache an in-progress cycle
as a final verdict, accept a cache from another Reader/run or silently classify
an unresolved component clean. Exported API/caller compatibility must be checked
before implementation; known callers include gate-affected-plan, gate-impact-run
and resolveSpecifier consumers in gate-impact.

No DB-to-NoDB transition may be adopted without root review plus actual complete
closed-port proof. Compare every real-suite decision and reason to the original
reference; root must inspect any intended NoDB-to-DB correction and its graph
witness. An old false NoDB cannot be an equivalence oracle. Unknown/dynamic/missing
cases stay DB. No hard-coded test allowlist, size-based exemption, truncation,
selector omission or dirty/unavailable-source fallback is acceptable.

## Ranked timeout hypotheses (dominance unproved)

1. Repeated filesystem/content work: resolveSpecifier calls read(cand) merely to
   test existence. CLI read performs stat plus full readFileSync every time,
   including product files that are then deliberately not traversed. The shared
   verdict cache does not cache these probes or misses. This amplification is
   concrete in source, but actual counts/time are unmeasured.
2. Lexical CPU: importSpecifiers scans raw text with two unbounded regexes; the
   static pattern has an optional broad lazy span and repeated whitespace. Large
   new fixture/text regions can change work nonlinearly. No backtracking hotspot
   has yet been observed, so a regex rewrite is not yet justified.
3. Startup/transport/host IO contention remain unknown. Pinned argv/version and
   one timeout do not prove an environment defect. The final db.includes output
   pass is quadratic but probably a smaller source lead; no timing claim follows.

## Fixed hosted metadata-only probe, before optimization

Use one new ordinary NoDB selector through the existing focused workflow, on a
frozen source with root/independent review. Its exact executable closure consists
only of a fixed probe, the exact classifier source and Node built-ins. No app,
compiler, model, driver, database, provider, package generator or credential is
loaded. No caller command, arbitrary path, URL, environment flag or test subset
can choose executable code. A reference source fixture is the exact original
classifier bytes; root reviews any private native-TS materialization needed for
an inert import. Source/selector/complete sorted Git inventory hashes are fixed.
No final classification from this diagnostic enters CI acceptance.

One baseline child runs the original CLI and its complete3627-path stdin with
EXACT15000ms admission, preserving its actual result/output. One separate profile
child calls the actual exported classifier with the same complete ordered suite
and real shared per-request semantics. Its Reader delegates to original native
stat/read behavior, adding counts, source-byte totals and monotonic IO intervals.
Bounded sidecar progress records source-owned stage, ordinal, completed count,
last source hash/byte count, native IO totals and before/after timestamps only;
never raw source contents, environment, keys, SQL, HR data or caller messages.
Publish a small initial marker before import/stdin and bounded partial markers
before/after the current file work, so a timeout leaves a truthful partial record.
The same original deadline owns startup and work; no new clock begins at launch.

Use the already qualified shared process kernel for group/pidfd/WNOWAIT/drain;
the closed owner supplies only this fixed Node command and15 seconds. Its clock
must return actual monotonic time unchanged. A bounded read-only sampler may
inspect ONLY the admitted monitor's exact native Node child, fenced by real
parent/session/start/executable identity, during that same native work loop.
Sample CPU ticks, RSS, native read/syscall counters and elapsed time; emit only
aggregate counters, not PID/path/proc contents. All commands/descendants/pipes must
settle before any terminal result. A dead/replaced/unknown sample is unavailable,
not zero cost or successful cleanup. Existing6-second kernel settlement is
separate from the unchanged15-second classifier work bound.

A high sampled CPU delta plus negligible actual Reader time points to CPU work;
large measured read/stat time and repeated-byte counts point to IO. Neither alone
proves a specific regex. If lexical work remains the lead, root selects the one
actual stalled source ordinal/hash for a second fixed15-second direct probe of
the original importSpecifiers function. That diagnostic records a lexical-phase
start before calling the real function, with a native parent CPU observation.
No arbitrary caller-selected path or reinterpretation of a partial result exists.
If the first child never reaches import/read stages, investigate runtime/input
startup instead. Retain every primary/cleanup result and actual source identity.

## Conditional optimization and comparison contract

Only after the measured work is known, change one owner at a time. If repeated
IO dominates, prefer a positive source-image cache scoped to one immutable CLI
request, not persisted between commits/runs. A cache must retain native stable
source identity/bytes and refuse any observed change/unavailability, including
before terminal output; it cannot turn a previously unreadable path clean or
reuse partial graph verdicts. Leave generic Reader/resolveSpecifier callers'
semantics unchanged unless separately reviewed. Preserve all lexical hazards.
If regex CPU dominates, design an equivalent bounded/linear lexical owner first;
an AST rewrite that ignores imports/text in strings/comments changes current
conservative semantics and requires separate correctness proof, not a speed fix.

Compare old/new on fresh native Node processes with empty JS/request caches,
interleaved fixed order. OS cache state is uncontrolled; do not call that a cold
filesystem or a production-equivalent result. Each sample keeps the SAME15-second
work deadline and declared standard runner resources. Require complete output
bytes (kind/path/reason/order), exact suite membership, no skips/duplicates,
unknown-case denial, controlled cycle correctness and all original fixture
intentions. Timeouts are failures/partial diagnostic evidence, never successful
classification or equivalent missing output. If the original cannot finish the
whole suite within15 seconds, preserve that failure; use the red-capable minimal
hotspot and fixed fixture/reference proofs, not a longer replacement acceptance
budget. Root must explicitly review the remaining whole-suite equivalence limit.

Finally the actual current complete createPlan must pass its unchanged15-second
child bound and independent complete-partition check, then all impacted classifier/
controller owners and the full NoDB closed-port proof run on standard hosted
Actions. The source hash/fingerprint/source closure must bind the new classifier;
no old plan/PASS is relabelled. No implementation, dispatch, native timing,
correctness PASS, source adoption or release is claimed here. Production held.
