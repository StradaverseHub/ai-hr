# Application worker sizing

## Calculate a starting configuration, then qualify it

[Odoo 19 documents](https://www.odoo.com/documentation/19.0/administration/on_premise/deploy.html)
a CPU rule of thumb of `(CPUs × 2) + 1`, separate cron capacity and a weighted
light/heavy memory estimate. That model belongs to its multiprocessing request
workers. Our Node workers handle multiple asynchronous requests, and each owns
an application database pool. The [Node cluster example](https://nodejs.org/api/cluster.html)
starts one process per available CPU. Neither rule establishes workload capacity.

Our advisory starting ceiling is the smallest of:

1. Available CPU capacity, after explicit CPU reservations. Include process
   affinity, service quotas and all stricter ancestor cgroup quotas.
2. Usable service memory divided by a whole-process worker RSS budget. Include
   native allocations, buffers and runtime overhead, not just the V8 heap limit.
3. The aggregate web database connection budget divided by the minimum planned
   per-worker pool. Reserve independent workers, operations and PostgreSQL's
   reserved connections before allocating the web budget.

The memory planning policy stays below the lower of physical RAM after host
reservations, the service/cgroup hard maximum and its MemoryHigh pressure
threshold. MemoryHigh is not an OOM limit; treating it as an operating boundary
preserves room before reclaim pressure. Subtract service overhead and an explicit
headroom percentage. A measured RSS input needs representative sustained workload
and cold-start peaks. An assumed RSS input remains clearly labelled provisional.

## Verified production resources, 7 November 2026

Read-only inspection at 07:08–07:10 UTC found:

| Resource | Application VM | Database VM |
|---|---:|---:|
| Available vCPUs/affinity |16|16|
| Physical RAM reported by Linux |about 62.7 GiB|about 62.7 GiB|
| Application service MemoryHigh |10 GiB|n/a|
| Application service MemoryMax |12 GiB|n/a|
| Explicit service CPU quota |unlimited within VM|unlimited within VM|
| PostgreSQL maximum connections |n/a|100|

The application still has one observed Node 24.22.1 process. No production
configuration, worker count, service, data or load was changed by the inspection.
The complete physical VM RAM is not the application's current service budget.

For a planning example, reserve 2 CPUs, 4 GiB host memory,512 MiB service overhead,
20% memory headroom and assume 1.5 GiB whole-process RSS per worker. With a planned
16-connection web budget,2 connections per worker and 20 connections reserved for
non-web/administrative use, the calculator gives CPU 14, memory 5 and database 8.
It suggests 4 workers as a provisional starting bucket. This RSS is an assumption,
not a measured production peak and not activation approval. Eight workers must
demonstrate a suitable RSS envelope under the actual memory policy or receive
a separately reviewed service-memory change before production qualification.

The 16 vCPU/64 GB hardware can support plans above 4 workers. For example, a hypothetical
32 GiB pressure threshold/40 GiB hard service limit and 48 web connections under the
same planning assumptions produce a 12-worker starting bucket. This is arithmetic
for a proposed resource profile, not an installed setting or a performance result.

## Advisory tool and comparable tests

`scripts/performance/worker-capacity.mjs` reads a bounded JSON resource snapshot,
requires every planning assumption, and emits advisory JSON. It starts no worker,
changes no configuration and grants no release authority. The resource evidence
can include `ancestorLimits` and `processAffinityCpus`; missing ancestor inspection
is explicitly reported. Its whole-process RSS input must not be replaced with
`--max-old-space-size` alone.

Example, with a private read-only snapshot and explicitly assumed RSS:

```sh
node scripts/performance/worker-capacity.mjs \
  --app-resources /PRIVATE/application-resources.json \
  --postgres-max-connections 100 --web-connections 16 --nonweb-reserve 20 \
  --min-pool 2 --rss-budget-mib 1536 --rss-basis assumed \
  --reserve-cpus 2 --host-reserve-mib 4096 --service-reserve-mib 512 \
  --headroom-percent 20
```

The current 2/4/8 comparison fixes 16 total application connections: 8/4/2 per worker.
Increasing workers must never silently multiply pools. A future equal-budget
8/12/16 comparison could use 48 connections, giving 6/4/3 per worker, after independently
qualifying that database budget and the memory envelope. CPU, memory, request
mix, fixture data, sustained interval and error/latency thresholds must also match.

The standard CI host has 4 vCPUs/16 GiB and shares the host with its bounded database
container. It is not the two-VM production topology. Current Home preflight and
500-user qualification remain separate gates. Choose the final worker setting
from cold/steady latency, whole-process memory, event-loop delay, query/lock waits,
committed outcomes and zero page Busy; a hardware formula alone cannot prove them.
Production maintenance testing and deployment remain held.

## Resource-first correction, 7 November 2026

The owner directed that worker counts be calculated from resources before choosing
the comparison. Qualification on the standard4-vCPU host now uses2and4workers.
The8-worker runs on that host are retained as oversubscription diagnostics and
cannot establish production worker sizing or impose an8-worker production result.
The new Home8-worker run42350162510 was cancelled under this correction; its
source/evidence identity is retained. The same-source4-worker replacement is
42350733226. Production-sized8-worker or higher comparisons remain in the separate
maintenance-window plan after staging and safeguard review.

`isolatedWorkerCpuAdmission` refuses more application workers than available CPUs
before database setup or application startup. An explicit preflight-only diagnostic
can retain oversubscription evidence, labelled as such; it cannot run the sustained
qualification suite. This guard is a starting-envelope policy, not a claim that
operating systems cannot schedule more processes or that asynchronous workloads
always peak at one process per CPU.
