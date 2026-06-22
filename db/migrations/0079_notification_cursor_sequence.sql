-- ADR-0034 34-2 fix: the dispatch cursor must key on the exact monotonic domain_event.sequence, not
-- (occurred_at, id) — a JS Date loses sub-millisecond precision on the round-trip, so the stored cursor read
-- as slightly earlier than the event and the dispatcher re-processed it. No rows exist yet (gated/fresh).
ALTER TABLE "notification_cursor" DROP COLUMN "last_event_created_at";--> statement-breakpoint
ALTER TABLE "notification_cursor" DROP COLUMN "last_event_id";--> statement-breakpoint
ALTER TABLE "notification_cursor" ADD COLUMN "last_sequence" bigint;
