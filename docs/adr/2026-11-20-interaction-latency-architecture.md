# Bound the work behind each interaction

**Status** Proposed, 20 November 2026

## Context

The product goal is a responsive application across modules and roles. The existing [architecture remediation ledger](../ARCHITECTURE-PERFORMANCE-REMEDIATION.md) tracks known reads, writes, and worker issues. AP-041 is the cross-application acceptance gap. This proposal addresses how to make performance a property of the standard interaction path and how to prove it.

On staging source `d6bfd00891e4db5d25d5f0027d0b14b0383ef6fd`, build `kPIRX2RNPn5opx9RjY7C3`, a signed-in HR user with 71 companies saw single menu clicks take 6.4 s for Employee Leave Inquiry, 5.6 s for Personnel Management, 5.2 s for New Joiners, 4.1 s for Recruitment, 3.0 s for Employee Attendance, and 2.4 s for Reports. Payroll Transaction View remained on its loading state past 15 s on a repeat click. The corresponding live-payslip statement was sampled active in PostgreSQL through 31 s without a reported database wait event. A separate retained-document statement exceeded 8 s. The host also showed active swap-ins during the observation window. These are spot checks to visible headings on one role and device, with browser automation overhead. They are useful for reproducing the problem. They establish neither tail percentiles nor the contribution of swapping to each route.

The existing implementation already has pieces to build on: request-scoped read snapshots, row-level permissions, pool admission, durable bulk jobs, and a role-aware browser load driver. The installed shell still awaits several independent navigation and queue read groups before it can return on a full load. Module flyout mount also focuses the first link, which the generic intent link treats as a reason to fetch its entire route. Payroll History demonstrates the distinction between limiting the number of displayed rows and limiting the work PostgreSQL performs to find them.

## Proposed direction

Make interactive work explicit and bounded at the shared application boundaries. Keep the current web runtime and domain modules for the first experiment. Borrow the design principle behind Rust ownership: move enforcement of an invariant into a common boundary so every caller benefits by default. [The Rust Book explains how compiler-checked ownership avoids runtime overhead.](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)

| Boundary | Default interaction contract |
| --- | --- |
| Signed-in shell | Resolve identity, current company scope, and required access before rendering. Keep the shell mounted during navigation. Stream passive counts with their own pending and unavailable states and give them a smaller resource budget. Only load optional panels when opened. Opening a navigation menu does not render any of its destinations. |
| Page data | Authorize once per compatible request snapshot. Select visible IDs and a bounded ordered page before joining display details or decoding large payloads. Check the actual scan and policy work under the application role. Give alternate views, filters, and detail disclosures their own bounded contracts. |
| Commands | Ordinary saves validate and commit their narrow write before showing success. Refresh the affected data, with explicit handling for stale or denied state. Long-running operations acknowledge a durable job quickly and finish on a worker with a separate budget, idempotency, progress, and atomic publication where needed. |
| Load isolation | Budget interactive work, optional reads, and bulk work independently across the web process, database connections, and worker. Compare mixed-load and quiet-tenant tail latency. Size the host using measured CPU, memory, I/O and swap pressure. |

Synchronous authorization and fresh row visibility remain part of each command or read. A shared projection may contain stable identifiers and display facts when the requesting session still proves current tenant, company, and row access before selecting them. A workflow may report pending before completion. Completion and publication remain authoritative, audited outcomes. Never reuse payroll, Personnel, or access results across identities or scope changes.

## Alternatives and the deciding evidence

- **Continue optimizing individual screens.** Keep this as a way to remedy a verified slow owner, especially when common contracts expose the violation. Individual fixes cannot enforce the same latency envelope on a newly added screen.
- **Change the application architecture incrementally.** Start at the shared shell and one bounded database read, compare both with the same frozen baseline, and expand only where work and timing improve. This uses the current permission, migration, and release boundaries. It requires changes in how navigation, reads and writes declare their critical work.
- **Build a Rust service or replace the runtime.** Prototype a narrow function if profiles identify meaningful CPU time outside PostgreSQL and a benchmark shows a useful end-to-end gain after crossing the service boundary. A second runtime adds build, operations and parity costs. The observed long-running SQL would still execute in PostgreSQL after a web-runtime change.

## How to qualify the design

1. Trace browser intent, first feedback, first usable content or committed result, then correlate those phases with handler, admission, and SQL spans. Use fixed route templates and action identifiers. Omit parameters, identities, HR payloads, and credentials. Record response bytes, database round trips, relevant query plans, optional-work concurrency and host pressure alongside timings.
2. Restore a supported hosted lane for the existing development browser and load owners. Seed synthetic data across at least 70 companies and 1,000 employments, with deeper Payroll and Personnel history for the tail probes. Cover employee, manager, company HR, group HR, and applicable partner roles. Exercise all-company and single-company modes and permission denials. Inventory the reachable routes and separate direct entry, in-app navigation, filters, disclosures, ordinary writes, and job acknowledgment/completion. Explicitly report missing routes and actions. Run real destructive or financial workflows only in the isolated synthetic fixture.
3. Compare the same journeys before and after on the same resources, with a cold browser, a warm browser and mixed traffic. Set the first browser-feedback target at p75 ≤200 ms, and use the existing steady-state thresholds of <1 s at p95 for each covered read and navigation and <500 ms at p95 for each ordinary write. Track job acknowledgment and completion independently. Flag sparse samples, failures, correctness mismatches and missing observations. [Interaction to Next Paint guidance](https://web.dev/articles/optimize-inp)
4. Start with the shared navigation prefetch regression. In the browser, check keyboard and touch navigation and count server work generated by opening or sweeping menus, then time navigation to actual content. Next, measure a shell with deferred passive reads and a batch-first Payroll history selector, preserving all current and retained history visibility. Use the results to choose which changes become the default for every module. Repeat the load measures against the exact installed candidate before recording a system-wide improvement.
