# Measure Leave inquiry cost before changing its presentation path

Status: test-only baseline prepared; hosted execution pending.

This checkpoint changes no application code, calculation, query population, migration,
database setting or runtime installation. It is based on architecture source
`a33e813e28ec7fd3f651a6bcf0bce7020eb1b41f`, before migration3001. The test records
the actual Employment policy and verifies the predecessor ANY membership is present.
Later gains from the separate Employment policy candidate must not be attributed to
a Leave inquiry implementation change.

## Questions and independent expectations

The current inquiry context reads the complete legacy employee DTO population,
including when the request selects one employee or only asks for records. Balance
membership is already separate from monetary hydration: it checks bounded100-employee
chunks, retains an exact total and applies JavaScript locale-aware ordering before
paging. The baseline must establish the actual cost of these distinct operations.

`test/leave-inquiry-read-cost.test.ts` runs only when explicitly selected alone on a
standard hosted Actions runner and proves that both database URLs address its local
disposable worker database. Its5,000-employment fixture has8 non-archived leave types,
one hidden from self-service but still present in the established HR population.
Independent expected membership is40,000 pairs, with50 default first/deep rows and
the original selected identity retained. Ended employments remain in the existing
population; no new active-only filter is introduced.

The actual canonical context, membership, records and selected balance-hydration
ports are timed. An observer records their real compiled SQL objects, parameter
counts, actual rows, DTO field/byte counts and native app-role transaction identity.
It saves an estimated plan for the full DTO and membership profile query rather than
replaying every query with EXPLAIN ANALYZE. Instrumentation and serialization add
overhead and are disclosed; these timings are component diagnostics, not an end-user
or production-capacity promise. No fixed speed threshold is invented before observing
the baseline.

A small populated control independently expects ledger balance10 and available9
after a pending day. It calls the complete canonical snapshot/hydration path while a
separate real transaction holds each actual tenant Access and Payroll History advisory
writer lock, releasing that writer only after the read finishes. This proves or
disproves actual blocking instead of assuming a barrier exists from a source grep.
Native read-only enforcement must reject a real update with25006, and a committed
administrator-role revocation must remove the next context's company and employee
population. All policies must remain unchanged.

The observer tightens unlimited or larger SQL/lock limits to20s/300ms; it never raises
an existing limit. Each selected diagnostic retains a300s test-case budget. No JIT,
memory, connection or PostgreSQL lock-capacity setting is changed. Original failures
and incomplete measurements remain evidence, not permission to skip controls or
relax a deadline.

## Follow-up boundaries

After every planned frozen job is terminal, use the measured bottleneck to select an
explicit presentation-only repair. Preserve native authority, company/tenant scope,
as-of eligibility, historical and zero eligible rows, locale ordering/ties, exact totals,
the existing10,000-row export contract and complete canonical money calculations.
Do not remove command/source locks or replace a complete population with a cap.

Existing Leave inquiry behavioral, snapshot, sorting, scope and export tests remain
required for a later implementation. This baseline supplies no release witness and
does not establish zero Busy or installed readiness. Production remains on hold.
