# Controlled native wait and restoration ownership

Unexecuted successor of `be983be314ee1ee1630365acd8915e090b39e351`.
Both be983 and original6907 remain frozen/unrun. Root confirmed a source P2:
cases14/15 awaited holder unlock before mandatory native task drain. An unlock
failure could skip the drain and restore an instrumented function while its
native users were still running. Related finally blocks could replace the
original assertion/native error with a restoration error, or silently ignore an
unexpected rejection through allSettled. This is a source correction, not a
claim of an observed hosted failure.

A test-only closed controlled-wait owner registers each factory BEFORE its first
microtask. It stores the actual native outcome privately. Readiness races record
an outcome as observed only if that actual settlement wins; merely attaching a
then callback, starting value(), or winning readiness does not consume a later
failure. A value() read alone never consumes a failure. After the existing awaited strict
assertion/refusal, explicit consumption must identify the exact already-settled
private failure object; a premature or different failure is refused. No expected-error flag or permission callback is introduced.
After work it closes new admission, attempts release, ALWAYS drains every
registered task, records all unconsumed failures, then removes abort listeners
and restores observers. Cleanup uncertainty poisons successor admission.
Distinct failure objects are preserved with the original primary cause; the
same exact object already retained in an aggregate/cause is not repeated.

The audit covers every controlled asynchronous branch in the new policy case
module: active-frame case7, stale-writer9, stale-reader13, two-writer14,
probe/receipt15, Bank16/17 and Catalogue18/19. Shared inner/outer scopes drain
both command and receipt BEFORE probe/counterexample source restoration.
Catalogue transparent observers are both restored after drain even if one
restoration fails. Case8 LOGIN restoration, case12 savepoint restoration, all
cases' budget spy restoration, and cases20/21 process stops preserve compound
failures. Owner probe/counterexample wrappers and constructor cleanup likewise
preserve primary plus restoration failure. Child startup retains a spawn error
until the actual close event and preserves it alongside stop failure.

This is not a rewrite or a blanket closure claim for the inherited controller,
family or outer fixture teardown. Their fixed ownership, guarded cleanup,
poison/refusal and hook/socket deadlines remain unchanged. In particular,
unknown native constructor ownership still cannot authorize guessed SQL cleanup;
a failed exact restore still blocks later destructive restoration. The existing
outer owned lifetime remains responsible for aborted-case socket stop and
onTestFinished drain before any successor. No error is converted to success.

Static self-inspection found all24 native declarations unchanged and all168
backtick template bodies in the native case module byte-identical. Native SQL,
canonical truth and all11 PRE owners, grants/roles/profiles, timing/resource
budgets, money/history/permission assertions and application code are unchanged.
This source observation is not native execution or acceptance evidence.

Six new pure cases exercise deferred registration/drain, compound unlock/native
failure, strict consumed versus unobserved refusal, readiness race loser, abort
and exact-identity deduplication, and shared nested drain-before-restoration.
The planned pure total is explicitly **14 = existing4 contract +4 lifetime +6
new controlled-wait**. Planned native qualification remains24 policy +16 original
family affected by6907's prior startup-option change. Original a2 native16,
old315 pure3 and legacy323 retain their own source/run identities; they are not
relabelled onto this candidate. No check ran locally.

Root must normal-merge this source into qualified CI and provide a thin actual
admitSingletonTest entrypoint before registration; this old315-derived component
is not an authenticated standalone selector. Bind the entire transitive native
case graph: all policy owner/controller/lifetime/contract/SQL/predecessor and
reader-process/child/startup files, the new wait helper, legacy audited-read
factory/port/family/SQL and canonical query owners, plus every actual imported
business owner and its declared native migration closure (Bank, Catalogue,
statutory, org/comp, assistant, audit and session/RLS). Preserve the installed
controlled-database-v1 singleton/grants/limits and exact source hashes. The
existing16 selector imports the same family/owner graph and also needs current
source binding; no CI files or registry entries are edited here. Record native
artifacts under the actual run/unit evidence path, with no caller PASS receipt.

Root and independent review precede hosted execution. Still uninstalled;
releaseAuthorized=false, combined readiness=false, production held.
