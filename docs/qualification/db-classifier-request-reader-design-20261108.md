# Proposed: one complete Reader snapshot per classifier request

Status: Proposed, NOT authorized for implementation. Design-only child of
2e9a1e244558a493959fea95af187c2ddfae6f86. Actual corrected69f6 profile counters
and root approval are prerequisites to code. No algorithm, test, runtime, policy,
clock, budget, source-map admission or release change is made by this document.

## Actual evidence and remaining uncertainty

Authenticated original-source diagnostic run42463469685 reached a15s original
CLI deadline with owned group cleanup/reaping,297 samples, last rchar3576420617,
syscr449278, userTicks1197/systemTicks314, peak sampled RSS103555072bytes and
physical read_bytes0. Inventory passed. Profile exited1 before any progress due
to the Python relative/absolute argv mismatch. Frozen69f6 fixes that invocation
without weakening its exact native guard. Its actual counter result is pending.
The failed run is not a PASS or a reason to alter the15s planning deadline.
Root authenticated corrected69f controls2PASS at42464134878; native causal
run42464762896 is dispatched and its actual profile counters remain PENDING.

Source directly shows resolveSpecifier calls the COMPLETE content Reader merely
to test candidate existence, tries both stems even when equal, and may try the
same candidate across many imports. Discovery then reads the resolved helper
again. The native CLI Reader performs statSync and full UTF8 readFileSync each
time; null/dirs/missing candidates are probed repeatedly too. The observed IO
volume supports amplification as a concrete lead; its per-path multiplicities,
read/regex CPU shares and attainable improvement still require actual counters.
Physical read_bytes0 suggests this run's data came from OS cache; it does not
make syscalls, decoding or repeated allocation free, prove a cold cache, or
establish equivalent cache conditions across later jobs.

## Minimal decision, conditional on measured confirmation

Only classifyRequest receives a private per-invocation memoized Reader around
its supplied Reader. Keep the underlying Reader under a separate local name.
Use a local Map<string,string|null> keyed by the EXACT requested path spelling.
Before invoking the underlying Reader, check Map.has; after a successful return,
store and return the COMPLETE string or null. Map.has is essential: empty string
is a present file and null is a cached complete missing/nonfile observation.
Do not translate thrown Reader errors to null; retain their existing propagation.
The CLI's own existing filesystem catch-to-null contract is unchanged.

Both graph inspection AND resolveSpecifier inside this request use that SAME
local Reader. There is no new public API/export, global state, WeakMap keyed by
Reader identity, disk cache, caller cache input or cross-request reuse. Batch
classification owns one cache for its complete ordered roots; each single-file
API call owns a fresh cache. The existing third parameter remains a result sink,
never a source or verdict cache. Standalone exported resolveSpecifier keeps its
current API and behavior when given a caller Reader; it does not gain persistent
state or an implicit cross-call cache.

No graph, regex, DB_TEXT/DB_MODULES/package rule, suffix/stem loop, first-rule
precedence, test-only helper traversal, work queue, reverse hazard closure,
ordered reason DFS, CLI mode/output/order or planner code changes. Do not remove
the duplicate resolver stem or replace full content reads with existence checks
in this slice: memoization removes repeated physical work while preserving the
exact resolver decision course and first-observation order. Cache only completed
Reader returns, never in-progress graph verdicts or provisional clean states.
Unknown/missing still seeds a hazard; no source size exemption, truncation,
manual classification, omitted helper/root or DB-to-NoDB shortcut is permitted.

## Source lifetime and memory contract

As already documented by2e9, a request uses one immutable Reader/source view.
The memo stores each path's first COMPLETE observation for that synchronous
request; it is not an atomic filesystem snapshot. A Reader that changes one
path during a request is unsupported. Hosted callers must retain actual frozen
candidate/controller/source identity before/after the owned operation. Do not
pretend an ignored/generated path or external writer is frozen solely because
HEAD is unchanged; account for the actual resolver/read closure in conformance
witnesses. A detected source/custody change refuses the observation/adoption.

Changes BETWEEN requests, including the SAME Reader function, must be observed.
Deleted/new helper, previously missing path appearing, driver/text added and
previously hazardous file becoming clean all require fresh reads and fresh
complete graph construction. Distinct Readers never share state. The optional
legacy result map may contain any stale output without affecting current inputs.

Peak extra memory is O(sum of UTF8-decoded source code units for distinct
successful reads + all distinct candidate-path keys, including null misses).
Product sources read for existence still consume complete content memory even
though their imports are not traversed. Contents are retained until this request
returns; no reference/cache is returned to callers, so they become collectible.
Do not add eviction, long-lived closure, heap increase or file-size waiver to
make the first implementation fit. Measure actual peak RSS, distinct bytes and
candidate counts on the same frozen whole suite. If memory is unacceptable,
return to design; do not silently lose sources or infer zero cost from OS cache.

## Discriminating controls (not implemented or counted yet)

Keep all existing38 rules: original28, cycle4, complete-graph6, including original
bodies and the2500-node chain. Add actual counting/mutating Reader intentions:

- Repeated/diamond/shared helper imports and duplicate root inputs invoke the
  underlying Reader at most once for each exact candidate path per batch, while
  preserving requested db/nodb order, reasons and output multiplicity.
- Repeated unresolved candidates and identical stem fallback cache null. An
  actually present empty source remains resolved/clean, independently of null.
- A late hazard in a COMPLETE large helper remains DB; no prefix/size shortcut.
  ESM fallback/suffix precedence and product-only boundary remain unchanged.
- The same Reader closure changes content, deletes a helper or creates a prior
  missing candidate BETWEEN two requests; both batch and single-file calls must
  re-read and report the new actual verdict/reason. Different Readers and a stale
  supplied result map must never borrow a clean result.
- A thrown Reader error preserves exact error identity and prevents clean
  publication. Partial/in-progress cycles cannot seed a false cached clean value.
- Actual first-observed distinct path order is identical to the unoptimized2e9
  request on a frozen view; only repeated underlying reads disappear. A fixture
  removing Map.has/null caching or accidentally sharing a cache across requests
  must fail these controls. No fake parser/count-only implementation substitutes.

A counting Reader is the actual public supplied Reader around the unchanged
classification APIs; tests must call those APIs and assert native returned
partitions/reasons, rather than testing a separately invented cache helper.
Final implemented control counts must be read from actual source, not this plan.

## Complete semantic witness before adoption

Maintain THREE separate identities: A=originalcc77445 classifier; B=reviewed
complete-graph2e9; C=B plus this future minimal Reader repair. Preserve actual
A failures. For B→C on one frozen source view, require byte-exact ordered complete
DB/NODB output and first-rule reasons for EVERY actual current suite root, not a
sample or changed subset. Bind the current Git-owned full test inventory and its
JSON/stdin digest;3630 was the diagnostic inventory, but final convergence must
recompute its actual362x/363x count instead of hardcoding a historical number.

A15s old native deadline cannot provide missing full verdicts. A separately
reviewed FIXED source-only equivalence witness may materialize C's complete
first-observed path→(whole text|null) Reader snapshot and run B and C against
that SAME immutable snapshot, avoiding filesystem timing as a semantic oracle.
An unexpected probe outside the captured universe MUST throw, never default to
null. Bind complete first-seen order, all contents/nulls and their digests;
reconstruct exact probe/resolver/helper edges and direct hazard seeds from those
bytes. Independently replay reverse reachability and the ordered first reachable
reason for every root; compare both algorithms' complete results. This is a
hosted metadata/source witness, not actual filesystem CLI performance evidence.
Its worker/inputs/source/runtime/time/output bounds require separate root review;
no larger timeout or arbitrary command broker is authorized here. If it cannot
complete within its approved bound, semantic equivalence remains unqualified.

For A→B/C, record EVERY partition AND reason delta separately. Cycle correction
may legitimately turn false NoDB into DB; list each old/new reason, complete
reachable helper/resolver graph and direct native hazard source. The old result
is not correctness truth. Any actual DB→NoDB transition requires specific root
review of the complete graph/source reason and execution of the entire proposed
NoDB partition with all four DB URLs at the fixed closed port and
GATE_NODB_PROOF=1; no DB setup, skip or fallback. Do not combine intentional
reachability corrections with unexplained cache deltas. If A cannot produce a
complete native output in15s, obtain its complete semantic witness under the
separately reviewed fixed Reader-snapshot course; never fill its missing rows
with C's output, claim the timeout passed or silently drop those roots.

## Actual performance and instrumentation course

The corrected69f6 original profile deliberately loops classifyTestFile with the
original shared result map to reproduce A. Copying that loop onto B/C would
create fresh single-file requests because2e9's third map is a result sink; it
would NOT measure one complete batch. A future B/C profile must execute the
actual classifyTestFiles(fullSuite, instrumentedReader) once. Keep API-specific
controls separate; do not persist a cache across different request APIs.

Instrumentation adds per-read stat/read timers, hashes, counters and progress
writes. Report those costs separately, without subtracting guessed overhead
from wall time or treating unread/unsampled periods as zero. Partial15s progress
must preserve missing counts honestly. Originalcc profile counters identify its
lead; they do not by themselves prove B/C's gain. No forced OS-cache flush,
privileged host tuning or assumption that sequential baseline/new runs are equally
cold/warm. Record actual runner/Node/source/controller and exact work transport.

After root approves measured cause and implementation freeze/review, run existing38
plus actual new controls on standard hosted Actions. Run actual COMPLETE B/C CLI
with the same full stdin, original Node/runtime/reader, planner15s work and6s
owned settlement, without instrumentation replacing CLI behavior. Preserve any
B timeout, require C complete output/exit0 and authenticated actual counters/RSS/
family cleanup, then apply the complete semantic/delta/closed-port requirements.
Two cold Node processes do not imply cold filesystem caches. A successful faster
C result is source-specific evidence, not authority to skip any remaining normal
CI or change its policy/clock. Root owns coherent source selection/merge/rebinding
with b6 and the current compiler/normal-CI work. No upload, implementation,
policy allocation, release/staging/production action is authorized by this design.
