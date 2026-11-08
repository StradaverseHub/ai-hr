# Observe the captured canonical Rewards failure boundaries

Exact parent: `5a8128da4b7a473fcc814c3c2de1eaa8dd18727f`. Its actual
24-case run `42444309382` finished with 19 passes and five failures (15–19),
zero pending. All 24 bounded diagnostic files were complete. Case 15 saw both
owned backends present, the waiter active, neither a lock wait nor the intended
holder blocking it. Cases 16/17 recorded only the real tenant callback with no
SQLSTATE; cases 18/19 recorded that callback with 42501. These observations do
not establish the five causes. In particular, an active statement after the
unchanged 200 ms window does not establish a timing remedy.

The retained failed24 artifact is `13602639958`, ZIP SHA-256
`205fe8bf83d10f1470f09bdedc82f2d74d7b706ef4f1cd8829a94f1616be4ac9`.
The original 83ac family16 pass and 5a8 pure3/controller passes retain their
identities. None becomes a pass at this successor source.

## Actual captured functions

Canonical review stores construct their specs at module initialization. The old
case-time source spies therefore missed captured `prepareNative` references;
Bank's same-module interval also calls its lexical actor function. Four Vitest
partial mocks now register before those factories load. Each imports the actual
module, retains its other exports and delegates the actual function with every
original argument. The Bank interval itself is observed, covering its lexical
actor call without replacing or duplicating that actor's native logic. The
observer records closed returned/refused boundaries and rethrows the original
error object. It never records return values or changes an authority result.

Only the two exact Bank/Catalogue specs receive new plain spec objects whose
`metadata` and `stored` schema references are transparent parse proxies. They
retain every other spec field/function and the actual schemas; `Reflect.apply`
preserves the original schema receiver and every parse argument. Human schemas,
Zod globals, source/permission values and database behavior are untouched. This
locates parse failures that would otherwise be hidden by the canonical generic
catch, while leaving that catch unchanged.

The preimport delegates consult one live case owner. Actual asynchronous work
is registered before invocation and fully drained before restoring the tenant
spy or resetting that owner. The entire tenant callback, including its existing
SET LOCAL statements, is included. There is no cached per-case spy that vanishes
after the first `restoreAllMocks`.

## Native wait observations

Case 15 also records four closed source callback steps: entered, stamped,
INSERT submitted, receipt finalization submitted. These are source observations,
not claims of native execution or readiness. They introduce no readiness wait
and do not move or extend the existing 200 ms blocking window.

The existing failure-only read-only observer still has max1, 2 s connect and
aggregate stop, 2 s SQL and 300 ms lock limits, awaited close and final native
absence. One existing query additionally returns three booleans: the exact owned
PID/full-start/database holds the floor relation's RowExclusiveLock; it holds
the tenant History advisory lock; its current statement has reached 200 ms on
the native clock. The advisory key uses the canonical owner's existing
`hashtext('audit-chain:' || tenant::text)` bigint derivation and PostgreSQL's
native lock-key halves. No query text, timestamp, raw activity, SQL parameter,
stack, message or private value is published. The old five native booleans and
all original witness assertions remain.

## Required qualification

Nine pure controls retain the original three intentions and add frozen captured
function forwarding, actual Zod/receiver/all-argument/synchronous identity,
deferred nested drain, closed source/native observations and actual delegate
source ownership. The shared full Rewards source closure adds the new observer
helper (1666 members) and its critical omission negative. These are source and
forwarding controls; they do not prove the native policy or identify a cause.

Root must review the frozen source independently, then run the affected pure9,
controller/source omission and complete-plan controls, followed by all24 native
policy cases. The original16 family is unchanged and is not requested again.
No application, native policy SQL/body, migration, financial calculation,
permission, guard/default/ABI, disclosure approval or resource/time budget is
changed. No local behavioral checks ran. Production stays held; staging still
requires all six architecture gates.
