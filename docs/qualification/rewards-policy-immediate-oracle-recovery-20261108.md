# Same-transaction constraint timing and exact native frame expectations

Unexecuted verification-only successor of6907ecc5ceb52e7d04ff5fa996686c5fbb4fd6d8.
The original6907 remains frozen/unrun. Root's full review and independent
Standards review found one meaningful oracle gap before hosted execution:
case12 issued ALL IMMEDIATE again after the real RR/SERIALIZABLE probe, hiding
whether the helper had restored the prior constraint timing. Case13's separate
transaction could not establish that property for case12.

The original real ai_hr_app LOGIN event/probe cases remain. No app/private
INSERT or EXEC privilege is added. An independent native-owner control now runs
in actual RR and SERIALIZABLE modes, verifies real session/current canonical
owner plus20s/300ms/RW identity, sets ALL IMMEDIATE, and calls the actual guarded
canonical `_domain_event_next` -> snapshot helper. In that SAME transaction,
WITHOUT a second SET CONSTRAINTS, a savepoint encloses an invalid floor-marker
INSERT. It must raise native55000 during INSERT. A leaked deferred state makes
that assertion fail. A finally rollback/release always removes the control row
and any queued trigger, including the deliberately broken-state path, so this
control cannot COMMIT a fake floor. A later native SELECT proves the outer
transaction remains usable and no marker exists. This owner-only observation
is not a claim that the app LOGIN can access the private table.

Source self-review also found a fixture assumption in cases12/14/15: setup()
runs real audited commands, so its last committed transaction may legitimately
leave a false frame. RR writers intentionally do not run RC frame cleanup.
Asserting total tenant frames equal only the new writer count could reject
valid behavior. This was discovered from source; it is not a retained hosted
failure or a reason to weaken a native invariant.

The revised expectation captures EVERY existing tenant frame before the
controlled writers, without clipping. Each NEW writer captures its actual
root-XID/PID/exact backend-start BEFORE its event statement. A separate native
projection builds the independently expected full seven-field false frame from
those real identities, tenant and fixed version1. The complete post-state must
equal the full before-row multiset PLUS exactly those new rows. Unknown fields,
changed/removed before rows, extra/missing/duplicate frames, wrong root, PID,
start, tenant, version or floor bit cannot pass. Native JSON scalar encodings
remain native on both sides; timestamp precision is not converted through Date.
The owner RR/SERIALIZABLE controls use separate full before/after expectations;
they perform no RC cleanup and cannot erase earlier app frames.

Only the native case module and this verification documentation/request change.
SQL, generated canonical truth, all11 predecessor owners, every grant/profile,
source restoration, lifetime/child cleanup and family behavior remain byte
identical to6907. All24 declarations remain, including actual40001/no-event
checks, two-writer native blocking and first real receipt concurrency. No case,
SQL, lock, startup, resource or hook budget changes. Root and independent narrow
review must precede root-owned authenticated thin-selector/registry convergence.
The existing planned24 native + affected original16 + pure4+4 controls remain
unexecuted; no individual check or release is claimed successful.
