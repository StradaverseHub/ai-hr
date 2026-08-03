-- 0358 — the custom rounding table replaces the fixed rounding methods (8fec719e).
--
-- WHAT THE REPORTER ASKED FOR. Rounding offered four fixed choices and only one of them could be tuned,
-- behind an extra checkbox. It is now TWO: No Rounding, or Custom Rounding with a table the administrator
-- writes themselves (From / Round To / Rounded Result, over the decimal portion 0.000-1.000). And every
-- leave type is RESET to No Rounding, so nobody is left rounding by a rule they did not choose.
--
-- THIS MIGRATION MOVES BALANCES, AND THAT IS THE POINT. Two production leave types round UP today (Annual
-- Leave and Compassionate Leave; the other 23 already round nothing). Turning that off restores the exact
-- unrounded entitlement, so those figures go DOWN — by at most a fraction of a day, on the whole
-- workforce, for the CURRENTLY OPEN cycle only. Closed prior years are protected by the effective-date
-- guards in reprojectEntitlementForPolicy (validFrom > asOf / closed historical version) and are never
-- rewritten. The reporter approved the item with that disclosure in the plan.
--
-- ADR/PLAN: .plans/8fec719e.txt

-- ── 1. The new column ────────────────────────────────────────────────────────────────────────────────
--
-- An ordered jsonb array of {from, to, result} rows over the DECIMAL PORTION of a calculated entitlement.
-- NULL = no table, which is every row this migration leaves behind. The rows have no identity of their
-- own — never referenced, never audited individually, never queried across types, always read and written
-- whole — which is why they are one jsonb value and not a child table, exactly like leave_policy.accrual's
-- service_bands. NO GRANT STATEMENT IS NEEDED OR CORRECT HERE: this adds a COLUMN to an existing table,
-- and column privileges are inherited from the table grant. (A migration that CREATES a table does need
-- its own GRANT — 0353 forgot one and only production's ALTER DEFAULT PRIVILEGES hid it.)
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "rounding_bands" jsonb;--> statement-breakpoint

-- The DB check asserts only that it is an ARRAY. The SHAPE (bounds, ordering, overlaps, duplicates) is
-- validated by checkRoundingBands in core/leave-compute.ts — the same function the editor draws its live
-- warnings from and setLeaveTypeRules calls before writing, so the screen and the guard cannot drift. A
-- SQL re-implementation would be a third opinion, and the one nobody would remember to update.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_rounding_bands_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_rounding_bands_check"
	CHECK ("rounding_bands" IS NULL OR jsonb_typeof("rounding_bands") = 'array');--> statement-breakpoint

-- ── 2. The two existing CHECKs, dropped and re-added ─────────────────────────────────────────────────
--
-- rounding_method gains 'custom'. 0325 wrote the check as IN ('none','up','down'); 0335 widened it to
-- admit 'nearest_half'. The three legacy values STAY IN THE CHECK deliberately even though nothing may
-- write them again: applyRounding still evaluates them, so a seed, a fixture or a hand-written row that
-- this migration's reset does not reach keeps producing the figure it always produced. Retiring a CHOICE
-- and re-interpreting every value already stored under it are different changes, and only the first was
-- asked for. The writer (setLeaveTypeRules) is what refuses to store them again.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_rounding_method_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_rounding_method_check"
	CHECK ("rounding_method" IS NULL OR "rounding_method" IN ('none', 'up', 'down', 'nearest_half', 'custom'));--> statement-breakpoint

-- rounding_threshold's check is UNCHANGED in meaning and is re-stated rather than left alone, so the two
-- rounding constraints are defined in one place after this release instead of one here and one in 0335.
-- The column itself survives: 'nearest_half' is still readable, and cleared below rather than dropped —
-- dropping a column is not reversible in a rollback and this item did not ask for it.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_rounding_threshold_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_rounding_threshold_check"
	CHECK ("rounding_threshold" IS NULL OR ("rounding_threshold" > 0 AND "rounding_threshold" <= 1));--> statement-breakpoint

-- ── 3. THE RESET, surface 1: leave_type ──────────────────────────────────────────────────────────────
--
-- THE UNRULED FALL-THROUGH, and why this is not a plain `SET rounding_method = NULL`.
--
-- hasAnyLeaveTypeRule (core/leave-compute.ts) is a NULL test across the rule columns, and
-- applyLeaveTypeRules returns the LEGACY GRADE POLICY VERBATIM when it says false. So on a leave type
-- whose ONLY remaining rule is its rounding, nulling rounding_method does not merely switch rounding off:
-- it flips the type to "unruled" and silently restores its entire legacy leave_policy.accrual rule set —
-- a different earning method, a different carry cap, a different balance — under the heading of a
-- rounding change. That is the identical failure 7cd914b1 hit with carry_forward_percent.
--
-- So: a type that would be left with NO other rule gets the explicit string 'none' instead of NULL. It is
-- a value, so the type stays ruled; isEngineRoundingMethod('none') is false, so applyLeaveTypeRules
-- resolves it to undefined and nothing is rounded. Same behaviour, no fall-through.
--
-- The column list below is hasAnyLeaveTypeRule's disjunction, exactly: ten columns, and NOT
-- carry_forward_include_earned, which that function excludes on purpose (it is config-only, read by no
-- engine, so on its own it says nothing about whether a type's rules were ever consolidated). Keeping the
-- two lists identical is what makes this guard correct rather than approximately correct. The same guard
-- lives in setLeaveTypeRules, because this fixes the rows that exist on deploy day and that fixes every
-- save afterwards — the trap re-arms itself the moment a type later loses its other rules.
UPDATE "leave_type" SET
	"rounding_method" = CASE
		WHEN "accrual_method" IS NULL
			AND "carry_forward_max" IS NULL
			AND "carry_forward_percent" IS NULL
			AND "carry_forward_enabled" IS NULL
			AND "carry_forward_expiry_mode" IS NULL
			AND "carry_forward_expiry_months" IS NULL
			AND "carry_forward_expiry_month" IS NULL
			AND "carry_forward_expiry_day" IS NULL
			AND "max_balance_days" IS NULL
			AND "rounding_bands" IS NULL
		THEN 'none'
		ELSE NULL
	END,
	-- The threshold belonged to 'nearest_half', which no longer exists as a choice. Left behind it would be
	-- a stored number attached to a method nobody can select — the kind of thing that reads as live
	-- configuration to the next person. Production has 0 rows set, so this clears nothing today; it is
	-- correctness for the seeds and non-production tenants no count was taken on.
	"rounding_threshold" = NULL
WHERE "rounding_method" IS NOT NULL OR "rounding_threshold" IS NOT NULL;--> statement-breakpoint

-- ── 4. THE RESET, surface 2: leave_policy.accrual ────────────────────────────────────────────────────
--
-- THE SECOND SURFACE, and clearing it is a JUDGEMENT the reporter's request did not spell out. 58
-- production policy rows carry accrual->>'roundingMethod' = 'up' in the legacy JSONB that predates the
-- 9816a5ad consolidation. The type-level overlay hides them for any type that carries rules — but "for any
-- type that carries rules" is the whole problem: leaving them makes the reset CONDITIONAL on each type
-- keeping its other rules forever, and a type that later loses them would silently start rounding up
-- again, years after somebody was told rounding was off. A reset that can undo itself is not a reset.
--
-- Only the two rounding keys are removed. Everything else in the JSONB — days, method, carry, bands — is
-- untouched, and the row's `-` is a no-op on a policy that never had them.
--
-- WHY THIS DOES NOT REPROJECT ANYTHING BY ITSELF: reprojectEntitlementForPolicy runs inside
-- updateLeavePolicy, not inside a migration. This statement changes stored configuration; the balances
-- follow through the ordinary engines (year open, earned accrual, the recalc kernel), all of which read
-- the reset rules and are guarded to the current open cycle.
UPDATE "leave_policy"
SET "accrual" = ("accrual" - 'roundingMethod') - 'roundingThreshold'
WHERE "accrual" ? 'roundingMethod' OR "accrual" ? 'roundingThreshold';
