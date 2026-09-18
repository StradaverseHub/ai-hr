-- 0474 — r306 (44bc1c33) "Attendance – Card Assignment and Employee Card ID Mapping".
--
-- WHAT THE GAP ACTUALLY WAS. `importAttendancePunches` (core/attendance.ts) matches a clocking device's
-- own identifier against exactly two things: `employment.employee_code` (lowercased) and `person.ic`
-- (digits only). Anything else is reported back as unmatched and never guessed — which is the right
-- behaviour, and also why a company whose terminal records its own card numbers could not import at all.
-- This adds the THIRD key.
--
-- ── ONE COLUMN, ONE OWNER ───────────────────────────────────────────────────────────────────────────
-- The reporter's requirement 7 is that the Card Assignment screen and Personnel › Employee › Attendance
-- are "two interfaces for managing the same Card ID data, not separate data fields". A column on
-- `employment` satisfies that BY CONSTRUCTION: both screens read and write this one column, so there is
-- no second field that could drift. A `card_assignment` table would have been a second source of truth
-- for one fact.
--
-- ── TEXT, NEVER A NUMBER ────────────────────────────────────────────────────────────────────────────
-- Card numbers carry leading zeros. '007' and '7' are different cards, and a numeric column silently
-- makes them the same one — which mis-attributes attendance, which feeds overtime, which is pay.
--
-- ── UNIQUENESS IS PER TENANT, AND PARTIAL ───────────────────────────────────────────────────────────
-- Two employees must never hold one card, or a punch is attributed by a coin toss. NULL is not a value
-- here (it means "this employee is matched by code or IC, as today"), so the index is partial: any number
-- of employees may have no card at all. A tenant-wide scope rather than per-company is deliberate — a
-- device file does not carry a company, so the matcher resolves across the whole tenant and a card that
-- is unique only within a company would still be ambiguous at import time.
--
-- ⚠️ THE COLLISION THIS INDEX DOES NOT CATCH is a card_id equal to ANOTHER employee's employee_code or
-- ic. That one cannot be expressed as a database constraint (it is a cross-column, cross-row rule) and it
-- is the dangerous one, because the matcher builds all three into one map. It is enforced in the service
-- that decides it (core/attendance-card.ts `assertCardIdFree`) and pinned by test — CLAUDE.md section 6:
-- "Enforce how a row is decided in the service that decides it; keep the column nullable."
--
-- NO BACKFILL. Every existing employment keeps card_id NULL and continues to match on code / IC exactly
-- as it does today. A tenant that turns on "Card ID is the same as Employee ID" DERIVES the value at
-- read time; nothing is copied into this column for that setting (see core/attendance-card.ts for why).
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "card_id" text;--> statement-breakpoint

COMMENT ON COLUMN "employment"."card_id" IS
  '44bc1c33 — the Card / Clocking ID recorded by a physical attendance device when it differs from employee_code. NULL = match this employee on employee_code / ic as before. Never derived-and-stored: the "same as Employee ID" setting resolves at read time.';--> statement-breakpoint

-- Partial + per tenant. `employment` is RLS-scoped by tenant_id, and the index carries tenant_id so the
-- constraint cannot be satisfied across a tenant boundary.
CREATE UNIQUE INDEX IF NOT EXISTS "employment_tenant_card_id_uq"
  ON "employment" ("tenant_id", "card_id")
  WHERE "card_id" IS NOT NULL;--> statement-breakpoint

-- No GRANT statement: this adds a column to an existing table, and `ai_hr_app` already holds
-- SELECT/INSERT/UPDATE on `employment`. (CLAUDE.md section 6's GRANT rule is about CREATE TABLE, which
-- this migration deliberately does not do.)
