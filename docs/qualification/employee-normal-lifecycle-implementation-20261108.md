# Closed employee lifecycle source integration

This is source implementation, not commissioning or release acceptance. Base
`7168310233f4bdf9dbe9308c1b783a8592c1ca8c` was explicitly chosen for its reviewed
five focused routes. A normal merge of approved design
`0d1950df1b85cf77d4cf79dcaedc8d55226e4dbb` produced clean union
`04c478818ac8dcadfee0c63377de844898953b22`. That merge retains the design's broader
5af lineage; it is not described or qualified as a two-document-only merge.
The implementation diff and request are against this clean union. Fresh fetched
main/alpha were both ancestors of716 (803 ahead/zero behind). No trunk mutation,
server access, live SQL, provider call or deployment is involved.

The approved three-file ADR now extends to exactly five reviewed files. One
source JSON registry owns file/stage/count/envelope/clock identity:

| file suffix | stage | cases | outer/file seconds | plan phases/call pairs |
|---|---|---:|---:|---:|
| native-purpose-plan |benchmark|6|960/900|44/27|
| benchmark-owner-native |native-controls|2|180/no file clock|0/0|
| native-owner-factory |native-factory|3|206/no file clock|0/0|
| exact-ascii-purpose |ascii-purpose|9|960/900|0/0|
| exact-ascii-plan |ascii-plan|6|960/900|44/22|

No file borrows another's allowance. The native180/206 retain128 setup plus
2/3×26 owners. All900 clocks retain840 work/60 drain, construction300,
case/hook30, native work18/total26, SQL20s/lock300ms and1000ms speed targets.
Existing application/native SQL template bytes and the qualified756 shared
process kernel remain unchanged. The focused adapter reads the registry and
retains1170s accounting/commands/ACK behavior, with an exact whole-source inverse
back to716 before the existing756/c73 inverse. All15 existing Linux ownership
controls remain. No new process loop, arbitrary argv or numeric PID kill exists.

## Private normal controller interface

`employee-lifecycle.mjs` exposes four operations to root's real run-unit:

- `prepareEmployeeLifecycle(file)` reconstructs the actual complete plan and
  actualSingletonHost before any reset/SQL. It requires exactly the registered
  one-file controlled DB unit, current clean source/controller, real Node native
  process/full-start/executable/canonical four-argument run-unit command and the
  real first-step private anchor. A WeakMap-held opaque owner is returned.
- `runEmployeeLifecycleStage(owner, fixedStage, actualStageEnvironment)` permits
  only fixed source commands. It preserves actual authority/run/source/process,
  startup/loader/Docker environment identity. Reset→migrate→test is ordered and
  single use; failed or uncertain stages hard-close later SQL while observations
  and mandatory stop remain available. No caller argv/function is accepted.
- `authorizeEmployeeLifecycleTest(owner, bindingPath)` requires completed owned
  reset/migration, re-admits actual host and verifies the existing real native
  singleton prerequisite binding and complete source hashes. Only then does it
  publish the private test context and return its exact environment path.
- `closeEmployeeLifecycle(owner)` attempts mandatory fixed PG stop BEFORE all
  terminal reads/publication. It then attempts every bounded collection and
  publishes `${unit}-employee-lifecycle.json`, including failed/incomplete facts.
  It returns `{proof,path,complete}` or retains a compound stop/publication
  failure; repeated close cannot silently convert a failure into success.

The first executable workflow step must create the0700 evidence directory and
exclusive0600 `${unit}-employee-job-anchor.json` before either checkout. Env
`AIHR_EMPLOYEE_JOB_ANCHOR` is that exact path. Its closed fields are version1,
run, attempt, job=`test`, unit, source, controller, bootId, startNs, wallTimeNs.
Actual native monotonic post-anchor allowance is1770s within the proposed1800s
job, retaining30s pre-anchor reserve. Stage admission separately retains120s
artifact tail,15s stop and6s shared-kernel settlement; entire960/180/206 stages
must fit or refuse before new work. Focused1170 is unchanged. The independent
API verifier must corroborate anchor wall time against actual job.startedAt in
0..30s; the anchor does not authenticate itself.

The normal Python adapter source-loads ONLY qualified756's kernel, verifies its
actual Node parent/full-start/executable/argv and fixed controller bytes, current
actual source/unit/run/anchor and private context. It constructs fixed commands
from the same registry, not supplied argv. The actual monitor witness is
published during the kernel's native session-admission event BEFORE its ACK
admits workload. The test helper calls real `admitSingletonTest(file)` FIRST,
then corroborates that monitor, Python ancestor, Node parent and source/binding
bytes. No JSON object/factory/flag can replace those live checks. Focused mode
corroborates its actual existing focused supervisor/session instead, without
setting focused or GitHub flags. Normal mode has no db-1/evidence fallback.
Normal Vitest output remains the standard `${unit}-batch-0.json`.

## Terminal evidence contract

The terminal object binds source/controller/run/attempt/unit/file/fingerprint,
registry digest, expected case/plan counts, original anchor bytes+closed fields,
preparation/singleton/test-context/monitor/file-clock/ACK/log/member hashes,
actual ordered stage outcomes, exact expected Vitest counts, verified pre-stop
resource member, mandatory stop result and closed failure labels. Every stage
retains actual kernel reason/exit/admitted/reaped/group-quiescence/noescape.
Events retain actual native monotonic and wall clocks for independent chronology.
Source code writes no fabricated API job facts or PASS receipt.

`complete` means only the bounded lifecycle/fixed-stage conjunction. It cannot
infer pre-stop semantic restoration from container deletion. Classic and ASCII
plan reports retain their existing full native cleanup/config/authority and
44/27 or44/22 oracles; native2/factory3/ASCIIpurpose retain their original native
case/afterAll assertions and exact complete Vitest counts. Root's strict verifier
must assess those source-bound native oracles and independently corroborate
post-stop owned-resource absence. It must retain latency target failures even
when lifecycle/correctness succeeds. These prototypes remain unadopted.

## Operational gates deliberately still closed

Root owns normal-merge integration, real singleton registration and complete
critical closure, actual five-unit30min matrix/first-step anchor, canonical Node
launcher, full role/native prerequisite handshake, stage hooks, partial-binding
PG reconciliation and independent always-stop, verify-shards/API job provenance,
commissioning source trust and any global policy allocation. This branch changes
NONE of those owners. Its normal constructor therefore remains unadmitted until
that actual integration exists. No descriptors-only waiver, focused impersonation,
policyv21 allocation or approval literal change is made.

The existing singleton source validator must recognize the exact five-file
shared admission owner (whose first statement is real admitSingletonTest), bound
with complete critical closure and omission negatives. Duplicating complete plan
reconstruction twice per file is not proposed. The old pure focused descriptor
helpers are no longer used by these native entries; they are not normal authority.

Required hosted checks after full root/independent source review: all16 new Node
registry/context controls (one bounded wrapper case) and original15 Linux kernel
controls, current controller/complete-plan/source-omission/refusal/API checks.
Actual normal commissioning must then run all6/2/3/9/6 cases and their native
oracles on standard hosted resources after root's operational integration. No
local behavioral/import/DB/process/compiler/build/test execution occurred; static
syntax/hash/Git/source checks only. Production stays held and staging remains
behind all six architecture acceptance gates.

### Pre-review checkpoint and resource wire hold

This checkpoint is still WIP awaiting full self-review, complete source request
and independent review. Root is implementing the separately owned fixed
`employee-postgres-resource.py` reset/stats/stop owner and independent always
cleanup. Normal commands require that exact source before preparation can
succeed; they do not use the legacy name/label-only postgres.sh removal path.
The missing resource helper therefore intentionally blocks actual normal use.

Before reset the opaque owner creates0700
`RUNNER_TEMP/aihr-employee-private/<unit>` and0600 `resource.json`, outside the
uploaded evidence tree. Its cryptorandom32-byte nonce never enters public
preparation/terminal data. The private closed payload binds actual source,
controller, run, unit, fingerprint, native Node owner, original anchor hash and
actual `plan.execution.postgres`. Public data carries only nonce/context hashes.
`employeeLifecycleResourceEnvironment(owner)` exposes the fixed private path to
root's closed resource operations; only reset/stats/stop inherit it. Test stages
refuse that hint. Root's resource owner must retain actual Docker CREATE ID before
START and distinguish outcome-unknown cleanup from admission. Matching name or
labels alone are not native CID/image/birth/replacement custody. The terminal
scope does not claim that proof until root's native owner/verifier integration
exists and actually qualifies.
