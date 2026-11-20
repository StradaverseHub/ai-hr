# Bound the work behind each interaction

**Status** Proposed, 21 November 2026

## Context

A page should be ready for its primary task while other users navigate, save changes and run bulk jobs. Shared code should enforce that property for every module. The current release rules require tenant and company isolation, set-based reads, shared locks on read paths and durable workers for bulk operations. [Scale and release rules](../SCALE-AND-RELEASE-RULES.md) · [AP-041](../ARCHITECTURE-PERFORMANCE-REMEDIATION.md)

On current main `f27f355c8`, the browser census observed 449 static routes. Only 26 signed-in cases had first and repeat usable-content measurements. Their medians were 2.19 s and 1.79 s respectively. The action audit observed 31 of 38 planned workflows. Dynamic records and actions outside that inventory still need coverage. [Route census](https://github.com/StradaverseHub/ai-hr/actions/runs/44789974570) · [Action audit](https://github.com/StradaverseHub/ai-hr/actions/runs/44796497003)

The matching application with the fictional load harness reached 500 concurrent users during the five-minute workload window. Of 500 sessions, 189 failed and 182 exited early. Employee, manager and company HR reads took roughly 71–72 s at the 95th percentile. Lock sampling observed blocking in 36 of 299 samples. Access proof accounted for 344 s of cumulative planning across 6,124 calls, or roughly 63% of the planning time in the sampled top-level statements. These durations sum work across concurrent requests. [Mixed-load baseline](https://github.com/StradaverseHub/ai-hr/actions/runs/44800424553)

## Proposed decision

| Shared boundary | Default contract |
| --- | --- |
| Signed-in navigation | Reuse the identity and company scope already resolved for the request. Render the required shell and page before passive counts and optional panels complete. Start destination reads on explicit navigation intent. |
| Database reads | Reuse an authorized snapshot within the request where its consistency rules allow. Page eligible rows in SQL before fetching details. Bind any reusable statement to explicit parameters and keep its access checks live. Cap optional reads so they cannot consume the pool needed by foreground actions. |
| Commands | Authorize and commit ordinary writes before reporting success. Refresh affected views. Acknowledge long operations with their durable job identity and track completion separately. Run bulk work on the existing kernel with a separate connection budget. |
| Browser readiness | Record first feedback, meaningful content and committed results separately. Enable a control when the client can handle its action. Keep the same readiness witnesses across builds and languages. |

Application requests continue to prove current identity, role and company scope. Query-plan reuse shares the plan structure while each execution binds its own values and applies RLS and transaction-local settings. Repeat an identical prepared statement across group-wide, selected-company, company-scoped and foreign-tenant transactions on the actual pool configuration. A fictional PgBouncer transaction-pool experiment preserved the expected results as clients alternated on one backend. A warmed group-wide execution took 58 ms with preparation and 87 ms without it. A change to the covered database client requires recorded owner approval and a release-coordinator rebind. [Pooler experiment](https://github.com/StradaverseHub/ai-hr/actions/runs/44786571021) · [Source-binding rule](../SCALE-AND-RELEASE-RULES.md#ai-approvals)

## Options and trade-offs

- **Individual screen changes** can remove verified fan-out and unblock slow actions. Shared query contracts and coverage then need to carry those gains to future screens. The workforce candidate passed 12 workflows with 70 companies and 1,000 active employments. [Workforce browser evidence](https://github.com/StradaverseHub/ai-hr/actions/runs/44805918154)
- **Shared request and database changes** address costs paid across modules and keep the current deployment model. They affect more callers and require explicit parity tests for revocation, mixed company grants, worker and web paths, retries and aborted transactions. Measure both fewer calls and lower cumulative work.
- **A native service or different web runtime** adds a service boundary, an operational dependency and a second implementation to qualify. Revisit this option if profiles isolate a large CPU-bound hot path outside PostgreSQL and a prototype shows a worthwhile gain end to end.

## Acceptance

- Cover the compiled route and action inventories by role and company scope. Include valid populated records, direct links, in-app opens, filters, saves and authorized denials. Report uncovered, sparse, failed and slow cases explicitly. Measure job acknowledgment and completion against their own workloads.
- Use fixed browser readiness witnesses on cold, repeat and mixed-load runs. The proposed targets are first feedback within 200 ms at p75, read and navigation readiness below 1 s at p95, and ordinary writes below 500 ms at p95. The five-minute 500-user test must complete with clean workflows and continuous lock observation.
- Compare exact builds and workloads on the same runner class. Keep elapsed browser time, shared database calls, planning and execution time, pool pressure, lock waits and job impact visible. Verify the exact installed build on staging before claiming system-wide acceptance.
