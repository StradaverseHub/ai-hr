-- 0475 — r313 (845903a3) "Annual Leave entitlement proration": a SECOND rounding configuration, used
-- only for the displayed ENTITLEMENT figure, kept strictly apart from the one that rounds accrual.
--
-- WHY A PARALLEL TRIO AND NOT A NEW TABLE. The reporter asked for two logically separate rounding
-- purposes and said, in their own words, to reuse the existing framework rather than build a separate
-- mechanism. That framework is three columns on leave_type (rounding_method / rounding_threshold /
-- rounding_bands) evaluated by applyRounding, which takes its configuration as ARGUMENTS — so the same
-- function rounds the new figure with no change to it at all. Mirroring the shape exactly is what lets
-- the editor, the validator (checkRoundingBands) and the evaluator be reused rather than re-written.
--
-- ⚠️ THESE COLUMNS ARE DISPLAY-ONLY AND MUST STAY OUT OF leaveTypeRuleColumns. That map exists so the
-- granting engines (the hire grant, openLeaveYear, accrueEarnedLeave) and the projection kernel read
-- the IDENTICAL rule set — a rule one reads and the other does not posts a permanent oscillating delta
-- on every reproject, which 7cd914b1 proved twice. Entitlement rounding must never reach a ledger
-- write, so it is selected explicitly by the one read that renders it and deliberately not spread into
-- that map. The reporter's requirement is the same one from the other side: EARNED TO DATE must not
-- change.
--
-- ADDITIVE AND ALL NULLABLE. Every existing row reads as "no entitlement rounding", which resolves to
-- the exact prorated figure, so no displayed number moves when this deploys. rounding_method and
-- rounding_bands are BOTH required to round, the same containment the accrual trio already has: a
-- table left behind with the method back on 'none' is dormant, not deleted, so the reporter can switch
-- the rule off and on without retyping it.

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "entitlement_rounding_method" text;--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "entitlement_rounding_threshold" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "entitlement_rounding_bands" jsonb;--> statement-breakpoint

-- Same value set as rounding_method (0358). 'custom' is the only value the editor writes beside 'none';
-- the three legacy methods stay accepted because applyRounding still evaluates them and this column is
-- passed to that same function.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_entitlement_rounding_method_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_entitlement_rounding_method_check"
	CHECK ("entitlement_rounding_method" IS NULL OR "entitlement_rounding_method" IN ('none', 'up', 'down', 'nearest_half', 'custom'));--> statement-breakpoint

-- The DB asserts only "an array", exactly as 0358 does for rounding_bands. The SHAPE (0.00-1.00 rows,
-- two decimals, inclusive ranges, no gaps or overlaps) is validated by checkRoundingBands, which is the
-- same function the editor draws its live warnings from — so the screen and the guard cannot drift.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_entitlement_rounding_bands_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_entitlement_rounding_bands_check"
	CHECK ("entitlement_rounding_bands" IS NULL OR jsonb_typeof("entitlement_rounding_bands") = 'array');
