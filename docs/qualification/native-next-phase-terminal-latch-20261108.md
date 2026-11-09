# Observer terminal publication latch correction

Source-only child74de8af009aa0ed39d8077343d9662b5dc31bbc8, which stays frozen.
Root/independent review found a concrete asynchronous interruption boundary:
PhaseTracker.write published a complete finished frame, exited its write try,
then assigned terminal=True. An interruption at that post-write boundary could
reach the actual best-effort fail path while terminal was false, publish failed
as a second terminal frame and exceed the14-phase-frame contract. This is a
source correctness finding; no local model/native execution is claimed.

The ONLY runtime change moves the terminal latch BEFORE the single non-entered
write. Once terminal publication begins it cannot be retried, whether the write
succeeds, is partial, throws or is interrupted after returning. The existing
broken-transport latch remains. A pre-write uncertainty may leave no terminal
record; that is unavailable observation, never readiness or successful execution.
An explicit post-try return supplies a real observable model boundary after the
write without a second state transition. All entered stages, schema, original
native checks,1-second budget,15-total-message/18432-byte upper bound,64-record/
131072-byte transport, original environment proof and unconditional exec remain.

One meaningful HOSTED model is added for25 total, keeping the original24
intentions. It loads the entire hash-bound74 helper preimage and the actual
current helper. For each actual PhaseTracker.write code object, an AST-derived
line immediately after that method's real try/except is selected. The mock
transport first captures a complete finished frame. sys.settrace then raises
KeyboardInterrupt at that exact code-object/line boundary, exercising the same
real tracker.fail path as best-effort handling. The previous trace is restored in
finally and checked by identity. No arbitrary getter, fake tracker or result-only
model manufactures the race. The case requires old74 to produce finished+failed
and the corrected owner to produce finished only (15 versus14 phase records).
This red/green behavior remains prospective until the actual hosted model runs.
It separately requires partial and throwing terminal writes to stay both terminal
and broken and perform no second write after a later abort.

The10-second Python child allowance and all wrapper/native/cleanup limits are
unchanged. The source-history case first reverses the COMPLETE new four-file
parent layer, then its immutable847 layer. The existing host-view source-history
reader does the same before the original093/CPU/cleanup inverses. Both complete
modified source-history files and the count wrapper are included in the new
whole-parent inverse; historical files/maps remain unchanged. All other23 prior
environment case bodies are exact. Old21 host-view intentions remain, with only
its whole-source inverse composition changed. No original refusal or assertion
is dropped to reach a PASS.

The current80-member explicit source map retains all77 previous members at their
actual bytes and adds this record, new inverse and immutable74 source record.
All four complete74 Git preimages/current hashes and the older whole-source
chains are statically verified. Native profile, environment validator, receiver,
controller literal branch, full fixture, host native component, guards/resources,
framework, application, migrations, AI approvals and provider authority are
unchanged. The unknown actual Next environment cause is still UNKNOWN.

No application/module/trace/model/test/native behavior, upload or dispatch ran
locally. Root plus independent full review precede any upload/run. Run the actual
25-model selector and affected source-history checks on standard hosted Actions,
letting all planned chunks finish and retaining actual original failures/results.
Old74 is not a passing source and receives no transferred witness. Shared host
hooks still do not prove the full Next helper. One original full native attempt
still requires the mandatory NEW same-run canonical build after qualification.
Full browser/worker/zero Busy/release gates remain open; staging/production held.
