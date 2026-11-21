# Fixed local JIT policy for two measured presentation entries

Status: source candidate, native qualification pending. Base cd47c63c77d26431ee33de38b75790c62924a1ad.

The actual paired diagnostic42495324775 at f924732e677881d99a3c4af9e82f8cb1c973ebc8
observed Attendance ON1763/1580ms versus OFF933/901ms and Analytics ON5658/5883ms
versus OFF2744/2785ms on one warmed native application backend. All eight whole-read
DTO/query-parameter courses and twenty native shape plans passed. Final independent
receipt SHA256 d1e947b30ee9822fe8f0a3c6e78b7afdebb1cceb83c26bfabf7c1201035404d9
is a separate Markdown authentication summary; the raw JSON SHA256 is
0061539af385041a4fec0212387a0c4bf68be34878215d8aadc96984d9e2eb10.
These measurements support a narrow policy candidate, not production or load acceptance.

Only attendanceMonthSummaryPage and analyticsDashboard add the fixed statement
`SET LOCAL jit=off`. Attendance retains original date-window computation before it;
native principal, fresh entitlement and module admission precede the statement.
Analytics retains its actual native-principal boundary without inventing a new module
gate. Both statements precede business SELECTs on the existing RR/RO transaction.
All other product bodies, common read/guard/client owners, commands, exports and AI RC
seams remain whole. There is no product caller flag, shared policy helper, global/session
setting, new pool, timeout or cache change. PostgreSQL restores the session setting after
COMMIT or ROLLBACK. See [PG16 SET](https://www.postgresql.org/docs/16/sql-set.html) and
[PG16 JIT decisions](https://www.postgresql.org/docs/16/jit-decision.html).

The existing registered three-case diagnostic is adapted rather than left incompatible
with a fixed product policy. Four requested parent modes ON/OFF/OFF/ON now require
product-effective OFF in all eight whole-module calls. Receipts explicitly distinguish
requested mode, native mode at admission, effective mode after the actual product command
and effective mode at successful completion. These are policy/idempotence courses and
must never be reported as new balanced ON/OFF whole-read speed measurements.

The same five captured SELECT objects/digests and twenty native ON/OFF/OFF/ON EXPLAIN
controls remain. Their explicit direct native principal/module owners do not invoke the
product entries: every plan and receipt is labeled counterfactual shape diagnostics.
No production API exposes that test-only alternative. Native JIT options/timings, off
no-JIT, same-PID default restoration, fresh-plan/prepared audit, DTO/parameter equality,
2048-node/20-plan limits and whole catalogue/content fingerprints remain mandatory.

The preparation case retains its generic on commit/overlap and off rollback-sentinel
controls. It also uses actual native principal/module refusals before policy; real
post-policy division-by-zero and cancellation on each entry; and simultaneous distinct
application carriers proving product OFF versus ordinary ON. Native cancellation is
restricted to the captured owned PID, worker database, application LOGIN and unique
application name while it is sleeping. Started work settles before return, including
failure cleanup. The temporary second application carrier is max1, explicitly recorded
as a preparation maximum2, and closed before every max1 measured course. No new product
pool is created. Expected receipts are2 generic controls +6 policy controls +8 whole
policy calls +20 counterfactual plans =36; seven earlier admission refusals have their
own accounting. These are source expectations until hosted qualification executes them.

The one additional zero-row command changes expected ordinary query census from31 to32
for Attendance (208 returned rows unchanged) and124 to125 for Analytics (90091 unchanged).
Composition comparison separately asserts the one exact policy command before excluding
only that command from unchanged business-query equality. The actual policy-setting
observation is a separate test-only query; callback timings include and disclose that
observation/hook overhead. Ordinary native50k timing calls keep their prior real course.

Original3x300s cases,30s hooks,20min focused outer/120min singleton outer, PG profile2
and memory caps, maintenance bounds and owned5s closes remain unchanged. A slower fixture
may exhaust these limits; no increase or fit guarantee is claimed. CI owns any required
source-closure reconciliation for the current root. Root and independent source review
precede execution; this candidate has not run repository behavior locally or hosted.
Historical f924 PASS and earlier dba failure remain at their original source identities.

Analytics still returns50000 carry identities and40000 demographic rows on the measured
fixture, and OFF remains about2.7s. Later population/aggregation work needs separate exact
collation, financial, date and scope proof. This decision establishes neither one-second
latency nor full-module/browser/concurrent-load qualification or release authorization.
