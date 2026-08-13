-- 7c834696 contested · OT rounding gets a DIRECTION.
--
-- WHAT WAS WRONG. `attendance_rule_ot_row.rounding` was a boolean, and core/attendance-rule.ts
-- applyOtRuleRows only ever ran `Math.floor`. So the reporter's "I cannot find round up" was accurate in
-- the strongest sense: round up had never been implemented. The boolean could express "round" and "do not
-- round", and the direction was hard-coded out of sight in one line of TypeScript.
--
-- THE REPLACEMENT. One text column with a CHECK — text + CHECK rather than a pgEnum for the widening
-- reason recorded on OT_REASON_CATEGORIES in db/schema.ts (an enum value cannot be USED in the transaction
-- that adds it — the 0275 lesson).
--
--   'none' — the exact minutes are used. Nothing is dropped.
--   'down' — the largest multiple of round_to_minutes that does not exceed the overtime.
--   'up'   — the smallest multiple of round_to_minutes that is not below the overtime.
--
-- NO BAND CHANGES BEHAVIOUR. The backfill is exactly the identity the engine already implemented:
--     rounding = true  -> 'down'   (Math.floor, verbatim)
--     rounding = false -> 'none'   (the guard never fired)
-- so every row saved before this release keeps calculating the same minutes. That is the whole reason the
-- mapping is written this way round and not the intuitive-looking true -> 'up'.
--
-- MEASURED ON PRODUCTION 2026-08-13 (read-only, before writing this): attendance_rule_ot_row holds FOUR
-- rows across two rules. Two carry rounding = false with round_to_minutes NULL, two carry rounding = true
-- with round_to_minutes = 60. After the backfill that is two 'none' rows and two 'down' rows, and every
-- one of them satisfies the pair CHECK below — which is why the CHECK can be added unconditionally
-- instead of being deferred (rule 14: a migration whose precondition is DATA aborts on the row that
-- breaks it, and gate:shadow cannot see that because it applies the journal to an EMPTY database).
--
-- THE PAIR CHECK is new law, not a restatement. `round_to_minutes = 0` with rounding on used to be
-- accepted by the column and then silently ignored by the engine's `> 0` guard — indistinguishable from
-- 'none' by accident. With three modes that ambiguity has to go: a mode other than 'none' now REQUIRES a
-- positive step, in the database as well as in core/attendance-rule.ts normalizeInput.
--
-- THE BOOLEAN IS DROPPED, not left behind. Two columns describing one decision is a drift waiting to
-- happen, and there is no reader left: db/schema.ts, core/attendance-rule.ts, the server action and the
-- editor island all move to rounding_mode in the same release.
--
-- No RLS change and no new table, so no GRANT is owed for the columns; attendance_rule_ot_row's existing
-- policy already covers every column on the table. The GRANT is re-stated per the migration standard —
-- a no-op on an existing table.

ALTER TABLE "attendance_rule_ot_row"
  ADD COLUMN IF NOT EXISTS "rounding_mode" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint

-- The backfill. Guarded on the old column still existing so a database where it was already removed by
-- hand converges to the same place rather than erroring on a missing column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'attendance_rule_ot_row' AND column_name = 'rounding'
  ) THEN
    UPDATE "attendance_rule_ot_row"
      SET "rounding_mode" = CASE WHEN "rounding" THEN 'down' ELSE 'none' END;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "attendance_rule_ot_row"
  DROP CONSTRAINT IF EXISTS "attendance_rule_ot_row_rounding_mode_ck";
--> statement-breakpoint
ALTER TABLE "attendance_rule_ot_row"
  ADD CONSTRAINT "attendance_rule_ot_row_rounding_mode_ck"
  CHECK ("rounding_mode" IN ('none', 'down', 'up'));
--> statement-breakpoint

ALTER TABLE "attendance_rule_ot_row"
  DROP CONSTRAINT IF EXISTS "attendance_rule_ot_row_round_to_pair_ck";
--> statement-breakpoint
ALTER TABLE "attendance_rule_ot_row"
  ADD CONSTRAINT "attendance_rule_ot_row_round_to_pair_ck"
  CHECK ("rounding_mode" = 'none' OR ("round_to_minutes" IS NOT NULL AND "round_to_minutes" > 0));
--> statement-breakpoint

ALTER TABLE "attendance_rule_ot_row" DROP COLUMN IF EXISTS "rounding";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_rule_ot_row" TO ai_hr_app;
