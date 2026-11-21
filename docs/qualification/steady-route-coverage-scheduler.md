# Steady per-role navigation protocol revision

Source-only recovery from frozen `fe26d003b9750478e4d434cc9dd22b59092ae830`.
Original Actions `42390723421` remains failed: selected35PASS/1 real route-scheduling
failure; full compiler independently failed with V8 OOM/no TypeScript diagnostic.
The original evidence is retained. No local app/runtime/compiler/build check has run.
No performance result or staging/release acceptance is established by this source.

The actual sparse Group HR cohort has two actors at index0/250, arriving at0/5s.
At5s think time and900msGET/400msPOST, the old unit model with six reads every
cycle offers only71 steady
read admissions for72 required Group HR routes during the10s ramp+5min hold.
That model also omitted the actual driver first-cycle override: its18 exclusive
priorities produce9 reads per Group HR actor before subsequent six-read cycles.
The actual old first cycle therefore differed from the lane cursor used by its unit
model. Neither the failing model nor a corrected model alone is measured coverage.
Moving a route to the front merely changes which one misses; the other roles' global coverage cannot satisfy this role's obligation.

`steady-role-coverage-v2` is an explicit benchmark workload revision. All newly
compared2/4/8-worker runs must use the same frozen source, scenario set, selected
read budget, pace, fixture and window. Prior runs retain their original protocol;
none is relabeled or compared as if its read/write mix were unchanged.

The same slot scheduler now drives both capacity modeling and real HTTP selection:

- Shared pending/inflight/completed state belongs to each actual role. A concrete
  route remains pending after a ramp visit or failed request. A completion counts
  only after the existing request assertions (and Home replay, where applicable)
  succeed and the document navigation started within the fixed steady window.
- Pending obligations are reserved before each individual request, so a batch that
  crosses ramp/steady does not carry an obsolete phase decision. Concurrent actors
  claim different pending routes. Failure releases its reservation and still fails
  the native lane; another actor completing the route cannot erase that failure.
- The reviewed first Group HR exclusive destinations remain early priorities. These
  first-cycle slot counts (currently9 per actor) are preserved in full. The shared
  priority queue may change which actor visits a priority route first; these hints never erase ordinary per-role obligations or count another role's traffic.
  If all pending work is already in flight, ordinary disjoint lanes keep producing
  traffic; after coverage, full traffic/mutations continue until the unchanged end.
- Group HR receives at least7 and at most12 read slots per cycle (including the
  larger reviewed first-cycle priority batch), with the smallest
  modeled feasible budget selected deterministically. Other roles retain3. Every
  original native mutation step and activity pause is retained, including initial
  Payroll processing+CSV and subsequent create/edit/delete/import actions. The
  higher read share lowers Group HR write-iteration frequency: this changed mix is
  declared in the report, not described as an application speed improvement.

The bounded planning model uses actual500 actor identities/order/role counts,
index-times20ms arrival, both allowed think times,1000msGET/500msPOST admission
ceilings, first Payroll/export versus later ordinary mutation actions, company HR
import steps and the additional parallel Home API replay bound. The prepared test
also models900/400ms costs. Planning happens before measured CPU/time baselines.
Future route additions must fit the bounded budget or refuse explicitly. A30s
whole-system window that cannot meet the obligations is refused; it does not become
an incomplete broad-coverage PASS. Claims-heavy and workflow-preflight are unchanged.

This is a scheduling capacity estimate, not a latency/throughput measurement. Native
persistence verification, observer overhead, event-loop delay and actual server cost
are not known in advance. A feasible plan provides no application acceptance. The
real final report separately records measured per-role pending/inflight work; the
existing strict per-role/per-route latency buckets remain authoritative, along with
500 live lanes, no early exits, full mutations, HTTP/browser errors, zero Busy and
native database/lock checks.1000ms read/navigation and500ms write ceilings,5min hold,
10s ramp,500 actors, browser contexts and resource grants are unchanged. Sparse
percentile caveats remain. No all222-destination coverage claim is introduced.

Prepared checks cover ramp boundary/cross-window completions, failures and retries,
concurrent reservations, role separation, no early completion/stalling, actual
first-cycle priorities, both paces/cost pairs, future route growth and honest refusal.
The tests exercise the same scheduler the driver imports. Source guards additionally
pin its integration and unchanged mixed-workflow owners; those guards alone do not
prove native execution. Hosted focused checks/compiler/build and subsequent frozen
2/4/8-worker measured runs remain pending. Production stays on hold.
