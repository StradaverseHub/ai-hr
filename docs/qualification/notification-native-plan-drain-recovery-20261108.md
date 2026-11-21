# Drain native diagnostic work after timeout

Unrun child of `e42d4281ee2bb1c3ec318bc04fd033d014d905ec`. Independent Standards
review found a P2 before any hosted e42 dispatch: Vitest could finish a timed-out
case after closing its worker socket while its asynchronous native-log capture
and database-setting restoration continued. The next beforeEach could reset the
same fixture before that work completed. Closing sockets alone did not own the
full operation.

The case now registers its complete owned promise and onTestFinished drain before
starting asynchronous work. Both afterEach and afterAll await that same promise
before socket/fixture cleanup. The next beforeEach checks ownership before its
first truncate, reset or seed. Timeout immediately poisons the owner and permanently
refuses subsequent cases in this test process, even if a teardown hook itself
times out. Restoration or socket uncertainty also poisons the owner. Cleanup still
runs after poisoning; poisoning cannot short-circuit its own setting restoration.
An aborted/poisoned case cannot write `complete:true` after later capture succeeds.

Three pure promise/AbortController controls prove that delayed restoration blocks
both teardown drains, an aborted case prevents successor writes, healthy work
releases only after its finish hook, and restoration refusal retains the original
error while blocking later setup. These are ownership controls, not native SQL,
runtime timeout or successful application execution claims.

The native selector still has exactly three30-second cases; the pure selector now
contains the unchanged two parser cases plus three ownership cases. No worker,
native SQL, original51-case suite, runtime limits, statement20s/lock300ms budgets,
capture64MiB/20s bounds, resource profile or JIT behavior changes. Original5869
run42407886480 remains50 passed/1 failed; the five measured batch intervals and
61-event backlog remain unchanged evidence. e42 was never executed and has no
PASS claim to carry forward.

Root and independent review precede separate planned native/pure hosted chunks.
No local application, DB, compiler, build, provider or runtime checks, uploads,
installations, numbered migrations or deployments occurred. Rewards WIP remains
untouched in its separate worktree while this recovery is prepared.
