-- Slow-page indexes (27 November 2026). Index only: no table, policy, function or row changes. CREATE INDEX takes a
-- SHARE lock on each table for its build (reads continue, writes to that table wait); the scale test records builds.
--
-- Audit Trail filter lists: core/read.ts auditActors walks the distinct actors of the tenant's domain events by this
-- index (a recursive skip scan, a few index probes per actor) instead of reading every visible event and
-- de-duplicating them. auditAggregateTypes uses the existing domain_event_aggregate_idx the same way.
CREATE INDEX IF NOT EXISTS domain_event_actor_idx ON public.domain_event (tenant_id, actor_id);
--> statement-breakpoint
-- Payment method projection: core/employment-payment-method.ts asks, per employment, whether it has ANY history row
-- (current or superseded) and its current method. The only index was partial (current rows), so "any row" could not
-- be answered by an index and the planner read the whole tenant's history under row security. This covers every row.
CREATE INDEX IF NOT EXISTS employment_payment_method_history_employment_idx
 ON public.employment_payment_method_history (tenant_id, employment_id);
