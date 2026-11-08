# Preserve the owned PostgreSQL scope across systemd reloads

Source preparation only on a1bf606b6c8c51eda0d1d1895b318d687fef7f28.
Native run42433237988 recorded an initial PostgreSQL memorySwapMax of0 and a
final null value (the collector serializes nonnumeric max as null), while Docker
still declared equal memory/swap caps. Its native boot failure remains failed.

The [upstream cgroups issue74](https://github.com/opencontainers/cgroups/issues/74)
describes the same systemd/v2 persistence defect: the kernel zero can be omitted
from the scope's manager properties, and daemon-reload reapplies infinity. This
is a source-matched explanation pending the actual owned-host proof here.

The existing sealed stdlib native fixture now registers MemorySwapMax=0 with
ONLY its actual existing job-container scope BEFORE the first manager reload.
It fixes no global service, Docker daemon configuration, prefix drop-in, runner
resource policy or foreign container. Actual local Docker identity must bind the
fixed run/first-attempt/unit owner label,64-hex container ID, PID/start time,
running state and original equal2113929216-byte limits. The actual systemd/v2
scope ID/control group and the native PID's /proc cgroup must agree. The kernel
must ALREADY report the original memory cap and zero swap before registration.
A changed identity or prior drift refuses before manager mutation.

The runtime property remains with that disposable container until its normal
job-owned teardown. No after-reload reset repairs or hides an invalid interval.
Closed manager and kernel observations are required before and after BOTH
configuration and cleanup reloads and at final cleanup. A missing/changed/foreign
scope, drift, malformed manager response or unacknowledged property write fails;
no observation is appended for failure. Only the actual identity digest and
bounded resource facts appear in the artifact, without names or paths.
The final unit's independent PostgreSQL resource verifier remains unchanged.

Six pure models exercise pre-reload persistence and exact ordering, foreign
container/manager/native process, changed identity, initial/later resource drift,
unacknowledged mutation, ambiguous manager data and closed non-replayable stages.
They invoke no real root, Docker, systemd, PostgreSQL or Next process. The native
selector additionally requires all six exact successful resource observations.
Only actual native execution can establish persistence on the job host.

The affected31-model observer selector from a1bf run42434866867 failed solely
because an independent source-location expectation retained old relative()
line58..61 after the new path helper moved it. All16 path/profile models passed.
That failure is preserved. The location oracle now independently locates the
unique actual relative function's first require call and asserts the complete
AST span, with the existing code-identity, forged-source and redaction controls
retained. No guard predicate, model count, skip or refusal is relaxed.

After root and independent review, run only the affected31 observer and6 scope
models plus the current complete controller plan; retain the valid16 profile
models at a1bf. Then create a new same-source canonical build and execute the
actual native boot case. All original fixture/SQL/startup/CPU/memory/connection
and artifact limits remain unchanged. No new result, full module preflight,
worker capacity, staging or production qualification is claimed. Production held.
