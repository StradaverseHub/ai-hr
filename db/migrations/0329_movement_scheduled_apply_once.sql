-- r83b · 941c9dac — "Syncing movement effective dates with employment data": APPLY-ONCE, enforced by the data.
--
-- ── WHAT THIS ITEM ADDED, AND WHY IT NEEDS ALMOST NO SCHEMA ────────────────────────────────────────
-- A future-dated movement is now recorded as an INTENT (`employment.movement.scheduled`) and put into
-- effect by the nightly sweep on the morning of its effective date (`employment.movement.applied`).
-- Both are ordinary rows in the existing append-only `domain_event` ledger: `event_type` is TEXT, not an
-- enum, so no type is extended and no new table appears. Employment History stays what it has been since
-- 78853b97 — a PROJECTION over that ledger — and the Pending / Applied / Superseded / Reversed set is
-- DERIVED at read time from the events plus today's date. There is deliberately no status column: a
-- mutable status is the one thing that can drift out of step with the ledger it summarises.
--
-- ── NO ENUM IS TOUCHED (THE TRAP THAT HAS ALREADY BROKEN A MIGRATION HERE) ─────────────────────────
-- Adding statuses is exactly the shape of change that hits "a newly-added enum value cannot be USED in
-- the same transaction that added it" — which passes on a live server, where the ALTER TYPE committed in
-- an earlier deploy, and fails on a fresh install, where the whole chain replays in ONE transaction.
-- This migration sidesteps it structurally rather than by careful casting: the statuses are not stored at
-- all, so there is no enum to extend, and the two literals below are compared against a TEXT column.
--
-- ── WHAT THE INDEX IS FOR ──────────────────────────────────────────────────────────────────────────
-- The sweep must be safe to run twice on the same morning. That is achieved in the DATA, not by trusting
-- the scheduler to fire once: a movement is due iff the ledger holds no application for it, and applying
-- it appends the application. A probe-then-insert is still a race between two concurrent sweeps, so the
-- partial UNIQUE INDEX below closes it — the second writer gets a unique violation and its transaction
-- rolls back whole, including every assignment / compensation / grade leg it had written. One movement
-- can therefore take effect exactly once, no matter how the job is invoked.
--
-- `payload ->> 'scheduledId'` is the id of the scheduled domain_event, which is a globally unique uuid;
-- tenant_id leads the key anyway so the index stays useful for per-tenant lookups and matches the
-- tenant-scoped access pattern of every other index on this table.
--
-- ── IDEMPOTENCE AND FRESH-VS-POPULATED ─────────────────────────────────────────────────────────────
-- CREATE INDEX IF NOT EXISTS, so a replay is a no-op. There is NO backfill and none is possible to get
-- wrong: `employment.movement.applied` is a brand-new event type, so the predicate matches zero rows on a
-- fresh empty chain AND zero rows on the populated production database. Neither index can fail to build
-- on existing data, and no historical movement is re-dated or re-interpreted by this release — the change
-- is to how NEW movements behave.
--
-- Not CONCURRENTLY: drizzle-kit runs migrations inside a transaction, where CONCURRENTLY is illegal. Both
-- indexes are partial and match no existing rows, so the build is instant and the lock is not felt.

-- Apply-once. One application per scheduled movement, per tenant, forever.
CREATE UNIQUE INDEX IF NOT EXISTS "domain_event_movement_applied_once"
	ON "domain_event" ("tenant_id", (("payload" ->> 'scheduledId')))
	WHERE "event_type" = 'employment.movement.applied';--> statement-breakpoint

-- The sweep's candidate scan: scheduled movements whose effective date has arrived. Without this the
-- nightly pass sequentially scans the whole event ledger once per tenant, and domain_event is the largest
-- and fastest-growing table in the system.
CREATE INDEX IF NOT EXISTS "domain_event_movement_scheduled_idx"
	ON "domain_event" ("tenant_id", (("payload" ->> 'effectiveDate')))
	WHERE "event_type" = 'employment.movement.scheduled';--> statement-breakpoint

-- No RLS or grant change: domain_event keeps the policies and grants it already has, and both objects
-- here are indexes on an existing table. Re-stated per the migration standard as a no-op.
GRANT SELECT, INSERT ON "domain_event" TO ai_hr_app;
