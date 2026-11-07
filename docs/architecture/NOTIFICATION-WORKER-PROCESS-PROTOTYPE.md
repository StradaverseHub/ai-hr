# Native notification process prototype

Source-only, **UNINSTALLED and nonpackaged**. Base is exact
`c861ac060b942280e3200e8c39f6964a05c3e7b9`; freshly fetched main and alpha were
`b7c0393aa3c7606a33dd15103426e5c535324065`. The explicit task base retains its
notification-stage ancestry; it is not a substitute for integrating current main.
No local application/DB/runtime/compiler/build checks, provider calls, upload,
installation, numbered SQL or page catch-up removal occurred.

## Process boundary

`lib/notification-worker/process.ts` calls the existing lifecycle and canonical
projection adapters over one `max:1` dedicated actual worker LOGIN. The first
application capability is `open_run`, whose native admission validates the real
login/profile/backend. Driver catalogue discovery is not business authority.
No application pool, owner credential, arbitrary SQL broker or provider client is
part of the child runtime import closure. Static declaration analysis identifies
21 relative runtime files / 28 edges; this is source analysis, not execution proof.

Fixed process bounds are 20 events/batch, 8 batches, 50 tenants, 240 seconds and
25 scopes/page, below the owned native 25-event/10-batch/100-tenant/300-second
profile. Native bounds remain independent hard refusals. This does not establish
compatibility with an installation or activate configurable production defaults.
The native 20-second statement and 300ms lock timeouts remain unchanged. The local
clock bounds new work between operations; native admission remains authoritative.

Scopes come only from native enumeration. Strict decoded standing/module facts
feed canonical `toSnapshot` / `isModuleEnabled` before admission, retaining
`MODULE_KILL`. Native current standing and consumer are rechecked inside each
batch. Reminder settings and `SETTING_KILL` continue through their existing native
snapshot and canonical evaluator. Unknown/unimplemented families refuse the whole
admission and preserve pending intent. The existing dispatcher/catch-up remains.

`projectBatch` resolves after COMMIT. Only then does the process emit committed
counts. A deterministic `UnsupportedNotificationFacts` rollback can record its
closed native failure reason. Other SQL/transport/commit errors stop the process:
no business retry, reconnection-based repair or guessed terminal counter occurs.
The underlying driver may reconnect an unrelated later query; the runner submits
no later work after an unknown error, and backend-bound native authority refuses
using an old run on a new backend.

SIGTERM/SIGINT stop new admissions and await an already running batch. The sole
native `fail_run` change admits the additive fixed reason `interrupted`; all other
body bytes, metadata, ACL, native CAS and counter logic remain unchanged. Original
stage3 installations do not implicitly support this new reason. A full drain alone
calls native `finish_run`; unsupported, capped and interrupted work is never success.

## Native commit and abandonment boundary

The unnumbered process fixture requires exact source bodies and metadata for all
29 prior worker functions before changing anything. Guards include owner, namespace,
argument/result shapes, language, volatility, security, cost/rows, configuration and
exact ACLs. No original admission/helper contract is weakened or broadly replaced.

A BEFORE DELETE trigger on the protected batch captures its exact event/consumer/
sequence/disposition and native created counts after `finish_batch` updates receipts
and counters. It validates those completed native receipts and cumulative totals.
The new private committed ledger is written in the **same settlement transaction**;
rollback removes it with every effect. No caller supplies counts to this ledger.

Four owner-only functions seal the resulting 33 full function metadata records,
three protected triggers (including the existing deferred settlement constraint),
new relation columns/constraints/ACLs and owned class inventory. Profile drift or
unexpected added objects refuses both process admission and recovery. Helpers and
ledger tables grant no PUBLIC/app/worker authority. Test-owned pause/refusal
triggers are invoker functions with revoked execution grants, bounded fixed bodies
and exact function/trigger identity checks before cleanup.

`recover_abandoned_run(uuid)` is **owner-only**, not a worker capability. It requires
the actual session/effective owner, exact active run/job/login identity, same native
singleton lock, no live recorded PID (including a reused PID with different start),
no extant admission batch, matching committed ledger/receipts and protected totals.
It CAS-marks only that still-running job/run failed with `abandoned`, preserving
native committed counts and pending scope observations, then clears only the exact
active run. It never deletes/reconciles an unknown batch or changes HR, notification,
outbox, processing intent or cursor facts. Every tested recovery/refusal hashes all
columns of 15 business tables before/after. Repeated recovery cannot clear a newer run.

A committed extant batch is refused in source. The original deferred constraint
prevents producing one through the canonical APIs. This prototype does not disable
that trigger or invent a corrupt committed row to claim a tested reconciliation;
operational handling of such corruption remains unsupported and retains evidence.
Retention and reconciliation after legitimate source/receipt pruning remain future
work: missing evidence refuses instead of guessing.

## Prepared native proof and honest limits

The existing sole serialized LOGIN-owning test file is extended, avoiding a second
test file racing the cluster-wide role. Root's prior actual c861 collection is
**41 cases**. New source declares **10 cases** (six plain plus two two-value
parameterized cases), so expected combined collection is **51**, not an executed
result. The narrow manifest also retains the pure task-shape fixture check.

The actual child uses test-only `node --import tsx`, private fixed-message IPC and
an explicit eight-key environment allowlist. It receives only the worker URL and
owned database name, never app/owner credentials, provider keys or inherited loader
variables. It exposes no SQL request channel. Native owner observation verifies the
real backend PID/start/login at the admitted-open pause before resuming the process.
Transition reports carry only fixed kinds, run IDs and native committed counts;
unknown errors are redacted and bounded output refuses credential patterns.

Prepared cases cover independent nonempty Leave notification text/recipient and
consent outbox, truthful native run/ledger counts, actual in-flight SIGTERM, real
SIGKILL before and after COMMIT, owner-observed backend disappearance, refused
automatic replacement while abandoned, native owner recovery followed by a fresh
pending-only run with zero duplicates, unknown SQL refusal without retry, an actually
unsupported canonical family, MODULE_KILL, 161 events proving the eight-batch cap,
owner/app/worker/PUBLIC refusals, live/reused-PID/profile/counter drift and old
invalid failure reasons. The fixed pre-COMMIT pause uses a real held advisory key
with bounded try-lock/sleep; timeouts are not increased. The post-COMMIT pause is
observation instrumentation after the actual awaited commit, not a synthetic receipt.

This does **not** directly inject a TCP proxy loss of a COMMIT acknowledgement,
prove every event family, exercise production environment secrets, authenticate an
installed invocation, qualify retention or establish accepted scheduling freshness.
It does not execute SMTP/providers. Canonical stage3 projection/reminder/registry
bytes are unchanged; earlier evidence retains its original source/run identities.

Root and independent review precede hosted native qualification, compiler and any
subsequent adoption. Future production requires a protected built entrypoint,
accepted package/runtime/profile, startup/admission/secret closure, safe invocation,
installation/scheduler/failure evidence and complete supported-family coverage.
This functional prototype cannot remove page catch-up, pass scheduling acceptance,
authorize a staging deployment or release the production hold.
