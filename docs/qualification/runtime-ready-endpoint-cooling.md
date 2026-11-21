# Reserve cooling endpoints until the existing native proof succeeds

Status: isolated source/fixture repair; protocol/native hosted execution pending.
Production remains held. No controller or socket-policy bytes change.

## Observed cause and decision

Run42389593793 on0891265000d578117655ea7db8f82234d959758d established the exact
retention reason after drain/stop: saved worker dead, all old proxy readers dead,
native TCP state06/TIME_WAIT only, and an ordinary bind still refused. The native
death proof therefore correctly retained the generation. Preserve that failure;
do not reinterpret it as a passing run or infer that port reuse was safe.

Keep LinuxHost.port_free without SO_REUSEADDR, every native death predicate and
all production lifecycle transitions unchanged. Inventory already represents a
nonpublished stopped generation as retained until complete reclamation. Cooling
does not admit it or direct traffic to it. A replacement must reserve another
ordinary-bindable endpoint; exhaustion continues to refuse startup while its
ready peer remains available. A real installation still needs a measured pool
and restart/cooling envelope rather than an arbitrary endpoint count.

## Native proof and finite shared cooling

The owned fictional backend is asked to close one native health connection first;
the client reads EOF before closing. After stopping that worker, the fixture must
actually observe TCP06, zero saved/reader liveness, the unchanged endpoint-bound
refusal and retained inventory. It then proves peer traffic and a different
replacement port. No TIME_WAIT flag or missing socket is accepted as release.
An independent real unrelated listener must also fail the same native proof;
its negative input never enters controller state. Existing timed-out/live,
unknown identity, stopping process and retained-proxy-reader refusals remain.

Each stopped generation must still establish native process/cgroup/unit and
proxy-reader quiescence within the original15second interval. The accepted
result is either full native death or exactly the final endpoint-bound refusal.
No other uncertainty is waived. Only endpoint cooling waits at one shared final
barrier of at most75seconds, with actual reconciliation and ready-peer HTTP reads.
All six stopped generations must reach RELEASED. Immediately after every observed
release, before a later explicit start can reuse its port, an independent native
death/raw-bind/liveness proof is captured. A retained endpoint after the deadline
fails qualification. Both admitted current workers and unrelated vhost survive.

The outer native command remains240seconds and its test260seconds. Health8s,
activation3s, drain1s and every other existing process/reader/startup deadline are
unchanged. The75second cooling subphase must fit the existing outer envelope;
source preparation alone establishes no observed completion or recovery time.

## Complete endpoint accounting

| Scripted allocation | Cumulative generation maximum |
| --- | ---: |
| Initial two workers |2|
| First worker replacement |3|
| Second worker timed-out startup |4|
| Interrupted ADD candidate |5|
| Its cold replacement |6|
| Restored second worker |7|
| Post-exhaustion recovery |8|

Worst case is six concurrently retained stopped endpoints plus two ready workers,
within the existing12endpoint profile. The independent unknown-listener negative
temporarily uses one spare before subsequent starts and closes its own socket.
No pool expansion supplies a pass. The fixture checks unique reserved ports,
maximum allocated generations and observed reserved peak; all replacements must
be distinct from every currently retained endpoint. The existing full-pool bound
socket/exhaustion/startup refusal remains, including ready-peer traffic.

The deterministic model independently keeps a dead-but-unbindable generation
reserved through peer/replacement admission and releases it only after the bind
predicate becomes true. This is model coverage, not kernel TIME_WAIT evidence.
Root must review and run the affected protocol and sole native selectors before
claiming qualification. No local app/runtime/compiler/build checks, installation,
upload, provider call or deployment is performed by this repair.
