# Independent contention investigation

This review uses preserved fictional runner artifacts,not production records.
The investigation led to the isolated punch-audit batching candidate below.
No cache,lock-owner change,timeout change or load retry is included.

## Terminal advisory-blocker samples

For each captured waiter,follow only the captured advisory blocker graph to its
terminal nodes. Count each terminal process once per namespace per sample.
These are observations,not exclusive wall time,ultimate row-lock root causes or CPU.

|Failed profile|Access terminal idle-in-transaction/client samples|Audit terminal idle-in-transaction/client samples|
|---|---|---|
|Original1s41416183769|15|20|
|Original5s41416186817|16|10|

Active terminal Audit holders include domain-event insertion,Attendance correction
finalization and punch mutation; Access holders include Payroll protection and
Attendance policy/point reads. This shows client gaps as well as active SQL after
shared barriers are held; simply removing a lock or blaming one statement is not
supported. Reports:
`/private/tmp/aihr-feedback-{one,five}-terminal-blockers-20261102.json`.

## Node sampling

The Drizzle entity classifier's sampled self time is11.86s/12.62s across the two
profiles. Parent stacks map to recursive SQL construction and prepareTyping.
The saved reports include total,idle and non-idle V8 samples. Non-idle samples are
not a CPU utilization measurement; neither these samples nor nested database times
can be summed into end-to-end latency. This does not justify replacing ORM internals,
sharing mutable query parameters or introducing a permission/result cache.
Reports: `/private/tmp/aihr-feedback-{one,five}-drizzle-cpu-attribution-20261102.json`.

## Bounded native write-path probe

Test-only22537f2c772fa636dec97c5e28c9786f2cc0be95 /
[41429566947](https://github.com/StradaverseHub/ai-hr/actions/runs/41429566947)
PASS executes12 genuine v4 final approvals with distinct workers and approvers over
two tenants. Attendance and events source bytes match the failed f2b9 workload.
All12 decisions and resulting09:00/18:00 day facts pass; both audit chains validate
108 checked events with no interior gaps. Nothing is delayed,retried or bypassed.

First observed service append is `attendance.punch.voided` in all12 transactions,
earlier than `attendance-correction.effect.recorded`. Mean/median measurements:

|Envelope|Mean|Median|
|---|---|---|
|Admission,including BEGIN|168.09ms|30.25ms|
|Native command callback|1160.00ms|1152.38ms|
|First observed append wait plus SQL|394.03ms|457.36ms|
|Callback after that append completes|178.42ms|163.04ms|
|Commit/response settlement|0.81ms|0.54ms|

These are overlapping/nested envelopes,not additive CPU or pure lock duration.
Earlier native SQL may already have acquired audit ownership. This small controlled
fixture is not500-user acceptance. Artifacts:
`/private/tmp/aihr-attendance-audit-2253-attempt1`.

Narrow test-onlyce0a226f8c6d8fd362af7fac885544d8d5121710 /
[41432146400](https://github.com/StradaverseHub/ai-hr/actions/runs/41432146400)
also passes12 decisions and both108-event chains. It finds mean58.63ms/median45.75ms
from the first observed append completion to punch-owner exit,and mean130.64ms/
median115.91ms after that exit. This distinguishes a local batching seam from the
larger later canonical callback; it does not authorize cross-owner event deferral.
Artifacts: `/private/tmp/aihr-attendance-audit-ce0a-attempt1`.

Native writer-count redbb7c530dfd9174be540e7d74ceecac13b32b3a22 /
[41432938202](https://github.com/StradaverseHub/ai-hr/actions/runs/41432938202)
fails only the intended1-write assertion AFTER all12 decisions,day facts,exact punch
event ordering,actors,subjects and audit-chain checks pass. Each punch correction
has4 real audit events through4 writer calls; actual profiled multirow event SQL is
0 calls/0 rows. The original red is retained without weakening it.

An additional own-backend pg_locks observation in2170922cc6e8eea6cafa76bd795cd81331404ab1
checks whether the Audit lock is already held before the first service append.
This avoids claiming a service-local deferral removes an earlier native lock.
The first dispatch41433446712 was a controller-only source-resolution failure after
a failed push; selected tests were skipped. The push was then recovered and the
remote SHA verified before the valid diagnostic dispatch41433561940. This valid
run reaches the intended one-writer failure only: all12 transactions report the
Audit lock absent before the first service append; all functional/order/chain
controls pass and actual multirow event SQL remains0. The predicate has not been
separately positively calibrated against a known-held key; do not present it as
proof about every native lock or as an ultimate causal lock-duration measurement.

## Local punch-audit batching candidate

Owned application3a26f9b865cfac8873bc16956060b097f4b8fdbc replaces interleaved
single event writes only inside applyClockChangesTx with the canonical appendEvents.
The local queue keeps exact event arguments and order,flushes in chunks of500 before
the owner returns,and never crosses an owner or transaction boundary. Punch writes,
validation,baseline,authority,Payroll protection and return shape are unchanged.
No optional deferral or externally accessible event buffer is introduced.

Frozen7306b2b1b8a747956835394d6a85b5a9cb8e1cfc /
[41435188440](https://github.com/StradaverseHub/ai-hr/actions/runs/41435188440)
finishes FAIL and is retained. The whole compiler passes.255/256 selected checks
pass across19 files:45 nondatabase and210 database checks pass; the sole failure is
an existing self-approval fixture which pairs the administrator's login with the
worker's different personId. The current-principal guard rejects the request before
the changed punch owner is reached. The same fixture bytes exist in basef81af83f8;
no security guard is weakened to repair it.

The native diagnostic itself passes all12 real final approvals,corrected day facts,
exact ordered4-event payloads/actors/subjects and two valid108-event audit chains.
Actual profiled SQL is12 multirow calls/48 rows. A real P0001 from an AFTER INSERT
trigger on the last punch event rolls back every punch,journal event and participant
decision; pending status survives. Explicit recovery after removing the test trigger
passes and the resulting120-event chain has no interior gap.

The matched SQL-profiled2170 baseline has mean38.175ms remaining within the punch
owner after its first append;7306 has0.019ms. Overall callback874.045→963.206ms and
post-owner96.166→117.124ms are mixed:7306 ran alongside the broader affected suite,
so this is not a clean speed comparison and not a system improvement percentage.
Counters and local tail removal alone do not authorize a full load retry.

Test-only repair29f806a36a957fe808cdaf90d14e4ede853357cb uses a genuine HR login
bound to the worker,keeps explicit mismatched-principal refusal,and asserts pending
status after self-approval refusal. Only the failed file plus compiler is rerun in
41436873302: all20 file checks and fresh whole compiler PASS. Separate41436877396
also PASS repeats the same isolated12-case timing fixture as2170. All12 real decisions,
ordered payloads,12batchSQL/48rows,two108-event chains,final-audit SQL rollback,
participant rollback and120-event recovery chain pass again.

|Matched isolated envelope|2170 mean|29f8 mean|
|---|---|---|
|Native callback|874.045ms|704.370ms|
|After first observed append|134.341ms|76.179ms|
|Within punch owner after first append|38.175ms|0.017ms|
|After punch owner|96.166ms|76.162ms|

These are separate small-sample runner observations,not request-matched production
percentiles or an overall system percentage. Local tail removal and lower isolated
callback support one unchanged whole-system pair after correctness qualifies.
Exact frozen29f806a36 aliases run1s41438476472 and5s41438488700; both finish FAIL; full outcome follows.
500principals,two million retained Claims/Attendance rows,30route/six mixed workflow
coverage,six hydrated browser contexts,1worker,pool10,heap4096MiB,standard4CPU,
durable~2GiB PostgreSQL,5mhold,90srequests and600sparent remain unchanged. Benchmark,
fixture and workflow bytes equal f2b; the candidate uses retained07f application plus
only this punch repair,excluding the unaccepted f2b feedback change. No direct causal
percentage versus f2b is claimed. No rerun or target relaxation is authorized by a
failure; both original outcomes must be retained. Neither native probe is itself a
500-user test or release witness.

Generated provider/module manifests are97e6f041205951d088e09992934638be026387b83b36f568e117746565ff3f54
and28c25a7b234de8075e62b6e3daaaadf036cddc04c23aa091b4f540b0f27b0ae8.
Both canonical checks pass under the existing task-scoped human metadata approval.
Literal provider bindings remain byte-identical and provider egress blocked.
No SQL/journal change,foreign source edit,release admission or deployment follows.


## Original full pair: terminal failures retained

Exact29f8 runs41438476472/41438488700 both account for500 users and finish the
original HTTP stage within600s (579.720/593.691s).1s settles497/3,5s439/61;
all3/61 errors are request aborts. Both complete6/6 hydrated browser journeys and
all6 mixed workflow categories,but retain3 loaded Home failures and fail p95 targets.
No native SQL error appears in the bounded server metadata; this is not proof that
an earlier race is repaired. Both tenant chains validate (2823/2166 and2005/2166
checked,no interior gaps). Strict result JSON retains role percentiles,actual settings,
fixture counts,declared exclusions and original stages/errors. Neither profile accepts
a whole-system speed gain or promotes the local application into the primary draft.

New sampled Access/Audit waiter occurrences are187/129 and144/109 over426/431
samples. Recursive visibility statement1969980583505592512 records207865/183197
calls and166787.27/186296.50ms nested execution. Drizzle classifier sampled self time
is11.28/12.02s. These observations retain the visibility/authority and admission
pressure diagnosis; they do not justify ORM replacement,permission caching or
removing canonical locks. Source-compatible visibility implementation remains with
the independent security owner; its adjacent policy changes must be qualified.
Artifacts:/private/tmp/aihr-punch-audit-{one,five}-29f8-attempt1.
Strict extractor:/private/tmp/aihr-punch-audit-results-20261102.py.
Results:/private/tmp/aihr-punch-audit-terminal-results-20261102.json.
Remaining contention:/private/tmp/aihr-punch-audit-remaining-contention-20261102.json.
No blind full-load retry,resources/limits change or deployment follows.

Independent next attribution is test-onlyfde8ef786afdf33e6bc29d026d7dc0854e297ac5 /
41442927885,pending. It forwards the real overtime refresh,replacement-leave check
and service audit writes while recording bounded numeric spans after punch-owner
exit. All prior functional,payload,chain and final-audit rollback assertions remain.
It adds no application or policy change and cannot justify a broad load retry alone.
