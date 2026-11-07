# Roster statement size and command capacity

Status: implemented source; hosted qualification pending. No installation or deployment.

The Generate, bulk Shift, bulk Rest Day and Copy owners retain their existing native
authority, date/eligibility rules, dependency locks, payroll protection and transaction
boundaries. A reviewed target set can produce more bound values than PostgreSQL's
extended-query protocol permits in one statement. A valid transport payload does not
establish a valid database workload.

The three shared upsert primitives now issue at most 1,000 roster rows per SQL statement.
This bounds statement size, not the number of reviewed targets or dates. Every statement
uses the same existing transaction, and the original complete input checks run before
that primitive's first statement. No chunk commits independently. Existing manual-change
audits and the single existing bulk summary remain in that transaction; counts describe
the entire input. One update timestamp is captured per logical upsert. A later SQL
failure rolls back earlier chunks and all audits.

A single `ON CONFLICT DO UPDATE` rejects duplicate physical employee/date keys. The
new complete-input duplicate check preserves that refusal across chunk boundaries,
including UUID case/bracing/hyphen spelling aliases already parsed by the original
guards. It retains cardinality SQLSTATE `21000` but uses a safe service message rather
than exposing a driver's SQL/parameter wrapper. It does not silently choose a winning
duplicate.

Affected command, Duty and shift-eligibility ID predicates, including the shared live
arrangement resolver, use one bound UUID-array value. Each text-array element is quoted;
backslashes and quotes are escaped in the proper order. The generated array is a SQL
parameter, never interpolated executable text. PostgreSQL's UUID-array input parser
validates every element before execution, preserving its existing accepted UUID
spellings and invalid-input refusal even when the outer population is empty. Empty
arrays match no rows. The original filters, native RLS and explicit ordering remain.

Hosted tests must prove the actual server parameter type is UUID array (OID 2951), not
infer correctness from the SQL source alone. Tests cover all three upsert modes with
1,460 actual rows, complete dates/values/audits, repeated conflict updates, real failure
after a completed first statement, full rollback, duplicate targets beyond the statement
boundary, malformed array-element attacks and native tenant isolation. A separate
14,600-row predecessor query-builder check establishes that its original single
statement exceeds 65,535 parameters. That is a compilation claim, not execution or
large-command capacity evidence. No local application checks run.

## Remaining command admission work

SQL batching does not reduce advisory-lock ownership. The canonical guards retain
configuration, employment, payroll and overtime-day locks. A large target/date product
can exhaust PostgreSQL's shared lock table or the transaction's time/memory envelope.
Neither a 100,000-ID transport ceiling nor this source change establishes that such a
command is supportable. No database limits, timeouts or target sets were enlarged,
truncated or hidden. Very large command admission remains unqualified.

The long-term admission owner should work from the canonical dependency plan, not from
worker count or a guessed employee cap:

1. Capture the exact reviewed IDs, dates, command intent and relevant source versions.
   Ask the existing dependency owners for the complete unique lock/resource plan,
   including overtime-day and payroll keys. Never replace the target set with a newer
   population during admission or execution.
2. Bind an installation resource profile to measured command envelopes and the actual
   service/database limits. Include the shared lock pool and a reserve for other writers,
   aggregate database connections, web/worker memory and measured duration. Current
   free-lock counts alone are not reservations. A single admission owner must atomically
   reserve the supported participating workload; unrelated writers must be included
   before claiming system-wide protection.
3. Refuse unsupported work during preparation, before Review/Confirm, with the complete
   original target count and a safe explanation. Do not create an unusable confirmation,
   truncate to a subset, label a storage exception as Busy, or increase timeouts to hide
   missing capacity. The refusal threshold must come from the verified profile and
   dependency plan, not an invented fixed headcount.
4. If larger workloads are required, introduce a durable exact-plan job with fresh
   native authority at execution, idempotency, cancellation and bounded retries. Staging
   rows may be prepared in bounded transactions, but publishing a new roster must keep
   the existing all-or-none business promise. Committing target subsets independently
   is a behavior change and requires an explicit new domain contract. Moving the same
   unbounded transaction to a background worker does not solve lock capacity.
5. Qualify the installation profile with actual concurrent writer/read journeys and
   failure recovery before admitting those workloads. Source metadata, a CPU worker
   formula and successful small-command tests cannot stand in for this evidence.

This proposal does not add a job schema, authorization cache, worker principal,
capacity configuration or installation settings. Those require separately owned,
reviewed implementation and native qualification. Production remains on hold.
