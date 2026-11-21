-- Security Center Users list Last Login (board 07c98c36), 10 November 2026.
-- core/last-sign-in.ts reads the newest app-user.logged-in event for each listed app user. The existing
-- domain_event_aggregate_idx (tenant_id, aggregate_type, aggregate_id) makes that read every event the user
-- has ever produced (sign-ins, MFA, account actions) and sort them; this partial index holds only sign-ins,
-- newest first per user, so each lookup is one index seek and the index stays a small slice of the table.
-- Plain CREATE INDEX (not CONCURRENTLY): the migration runner wraps statements in a transaction, and the
-- populated staging table (hundreds of sign-in rows) builds in well under a second, as 0455 measured for
-- the whole ~10k-row production table. IF NOT EXISTS keeps a rehearsed re-run harmless. No data changes.
CREATE INDEX IF NOT EXISTS "domain_event_app_user_last_login_idx" ON "domain_event" ("tenant_id","aggregate_id","occurred_at" DESC)
 WHERE "aggregate_type"='app-user' AND "event_type"='app-user.logged-in';
