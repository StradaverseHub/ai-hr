-- Audit Trail filter lists (27 November 2026): core/read.ts auditActors walks the distinct actors of the tenant's
-- domain events by this index (a recursive skip scan, a few index probes per actor) instead of reading every visible
-- event and de-duplicating them. auditAggregateTypes uses the existing domain_event_aggregate_idx the same way.
-- Index only: no table, policy, function or row changes. CREATE INDEX takes a SHARE lock on domain_event for the
-- build (reads continue, event writes wait); the scale test records the build time.
CREATE INDEX IF NOT EXISTS domain_event_actor_idx ON public.domain_event (tenant_id, actor_id);
