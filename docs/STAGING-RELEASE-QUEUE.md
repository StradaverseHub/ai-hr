# Shared staging release queue

Owner decision: 30 October 2026. Implement a durable release queue and shared lease across Claude,
Codex and human operator sessions, then pilot small batches while preserving existing release safeguards.
Implementation source: `scripts/staging/`. This document describes the protocol; commissioning and
pilot evidence must be recorded separately. Source presence is not proof of installed enforcement.

## Authority and state

The staging host owns `/var/tmp/aihr-deploy/staging-release-queue/`: a private SQLite database,
operation lock and reviewed coordinator, outside application rsync. Every model uses the same CLI
and protocol. Session names are audit labels; authentication is the existing private staging SSH
access. This is coordination among authorized operators, not a security boundary against someone
who can run arbitrary commands as the deployment user or root.

The queue never issues a gate receipt, CI witness, human acceptance, production package approval or
production deployment permission. Existing source/controller/run identity, complete coverage,
failed-area recovery policy, migration hashes and watermarks, runtime profile, build arrival,
rendered journeys, permissions, health and private publication checks still apply. Queue member
passes do not transfer to a combined candidate. `complete` means the operator recorded orchestration
handback with its evidence reference; it is not an independently authenticated acceptance certificate.

Tickets move through `queued → prepared → complete/failed`, with explicit `blocked` and `cancelled`
states before preparation. Dependencies must already be complete or included in the same batch.
The CLI verifies every member and base is an ancestor of the clean exact combined candidate before
preparation. Only one to three members are allowed; migration-bearing or isolated-risk changes
release alone in v1. Freeze the aggregate before its release checks. Queue records are immutable;
source repairs get new tickets and retain the old evidence identities.

Prepared batches are claimed in preparation order. A stale baseline refuses admission. Requeue an
unclaimed stale batch with a reason, update/revalidate its integrated candidate, and prepare again;
blocked builders hold no staging lease. This explicit requeue prevents a stale head from silently
blocking every subsequent batch. No background daemon automatically merges, tests, deploys or accepts.
The controller is an operator session driving the shared protocol, not a privileged model.

Lease phases are `claimed → installing → arrived → accepting → capturing` (capture is optional).
Arrival, acceptance and capture bind the actual running source and build. Lease credentials are
0600 local files; output/status/audit records omit tokens. Epochs increase on every claim. Leases
never expire automatically. A lost watcher or disconnected SSH session retains ownership while its
detached deployment continues. Cross-host operators see the same authoritative lease.

The server guard holds a shared kernel lock while the actual command runs. Handback and recovery
require the exclusive lock, so neither can replace ownership during transfer, deployment, or capture.
CI and legacy release clients guard canonical source rsync, packet transfer and remote commands.
Commissioned server entry points additionally guard deployment, state mutation and the CI installer.
The publisher holds the same guard during snapshots and runtime capture. The application directories,
service and private production installation are not alternative queue targets.

## Session protocol

Read `CLAUDE.md`, the repository/environment policy and production release handoff first. Use Actions
for verification. Preserve other sessions' branches, processes, leases and migration allocations.
Use an owned clean worktree and the current main/alpha history. Keep all request JSON, credentials,
acceptance references and evidence in private ignored paths outside public Actions artifacts.

The shared CLI needs Python 3, Git and existing private OpenSSH access; it has no application or
model SDK dependency. Run it from the reviewed controller checkout. Both AI tools use identical commands:

```sh
python3 scripts/staging/queue.py status --actor SESSION_ID --ssh-config /PRIVATE/ssh_config
python3 scripts/staging/queue.py submit --actor SESSION_ID --ssh-config /PRIVATE/ssh_config --request /PRIVATE/ticket.json
python3 scripts/staging/queue.py prepare --actor CONTROLLER_ID --ssh-config /PRIVATE/ssh_config --worktree /ABSOLUTE/CANDIDATE --request /PRIVATE/batch.json
python3 scripts/staging/queue.py claim --actor CONTROLLER_ID --ssh-config /PRIVATE/ssh_config --request /PRIVATE/claim.json --lease-file /PRIVATE/new-lease.json
```

Ticket request fields:

```json
{"spec":{"id":"UUID","source":"FULL_MEMBER_SHA","base":"FULL_BASE_SHA","dependencies":[],"risk":"ordinary","migrations":[],"acceptance":"Specific changed journeys and denied actions","evidence":"Private original evidence reference; no credential"}}
```

Prepare request: `{"tickets":["UUID","UUID"],"candidate":"FULL_COMBINED_SHA","baseline":"ACTUAL_STAGING_SHA","baselineBuild":"ACTUAL_BUILD_ID"}`.
Claim request: `{"batch":"PREPARED_BATCH_UUID"}`. Keep the returned credential file through acceptance/capture.
A failed/uncertain claim preserves its destination file: inspect remote status before retrying. Recover
an abandoned lease explicitly if the credential response was lost; never assume timeout means idle.

Set `AIHR_STAGING_LEASE_FILE=/PRIVATE/new-lease.json` and `AIHR_SSH_CONFIG=/PRIVATE/ssh_config` for the
existing authenticated `operator-release.mjs` route. Its `verify` remains read-only and needs no
lease; `deploy` and `deploy-recovery` require the matching lease. The operator enters `installing`
and `arrived` without releasing the lease. Continue the existing human acceptance and capture process;
use the same credential for `approve_staging.py`. Production remains separately authorized.

```sh
python3 scripts/staging/queue.py phase --actor CONTROLLER_ID --request /PRIVATE/accepting.json --lease-file /PRIVATE/new-lease.json --ssh-config /PRIVATE/ssh_config
python3 scripts/staging/queue.py finish --actor CONTROLLER_ID --request /PRIVATE/handback.json --lease-file /PRIVATE/new-lease.json --ssh-config /PRIVATE/ssh_config
```

Phase request: `{"phase":"accepting","build":"EXACT_RUNNING_BUILD_ID"}` (or `capturing`).
Handback request: `{"reason":"Private original arrival, acceptance, branch/board and capture evidence references; capture complete or explicitly not requested"}`.
Finish requires a healthy exact candidate/build and an acceptance/capture phase. It never runs a
migration, changes branch refs, marks board items, publishes a package or accepts on a human's behalf.
Complete those existing safeguards explicitly before handback. Preserve aligned main/alpha through
normal history-preserving integration; advancing a branch is not a deployment.

`block`, `unblock`, `cancel` use `{"id":"TICKET_UUID","reason":"WHY"}`. `requeue` uses
`{"batch":"BATCH_UUID","reason":"WHY"}` and only affects an unclaimed batch. `abort` requires an
unmutated claimed phase and the unchanged healthy baseline. After mutation or uncertainty, diagnose
first and use explicit `recover`: exact batch/epoch/candidate, `acknowledgeUncertainAttempt:true`,
`observedSource`, `observedBuild`, and an audit reason referencing detached-process, source checksum,
ledger, service and recovery evidence. Recovery never kills a process or removes files and refuses
while an operation holds the kernel lock or staging is unhealthy. The private SSH operator may recover
lost credentials by naming the exact abandoned lease in the request, without `--lease-file`.

## Commissioning and pilots

1. Run the controller checks and isolated two-session/two-member pilot on Actions. The workflow's
   controller-only mode runs no application/database/build/deployment checks and is not a release witness.
2. Inspect the current release owner's window and healthy exact source/build. Commission only the
   reviewed coordinator using `python3 scripts/staging/install.py --ssh-config /PRIVATE/ssh_config`.
   It refuses a different existing coordinator. It does not deploy source or restart anything.
3. Before declaring enforcement active across sessions, release the guarded client/server sources
   through the existing exact-candidate gate and coordinated staging window. Existing installed scripts
   predating this protocol do not gain enforcement merely because the coordinator is installed.
   Legacy checkout clients must adopt the reviewed controller; arbitrary raw SSH/rsync is outside the
   supported release protocol. Publish the instruction pointer on aligned main/alpha and update shared memory.
4. Pilot a two-member ordinary batch, preserving dependencies, verified aggregate SHA, baseline/build,
   original evidence and changed journeys. One deployment receives one explicit acceptance target.
   A coordination rehearsal using an already installed candidate must be labelled as such; it does
   not prove a new batch installation or authorize acceptance.
5. Record submission, preparation, claim, arrival and finish event times, queue wait, occupied staging
   duration and failures. Compare equal scopes before claiming a performance improvement. The initial
   three-member cap is a conservative pilot limit, not a measured optimum.

Keep required private capture inside the lease. Slow human acceptance can still dominate occupancy;
measure it before introducing preview installations or changing acceptance policy. Rollback of queue
adoption is explicit operator recovery after all operations stop; never delete the database, reset
fencing epochs or silently remove enforcement from an occupied staging target.
