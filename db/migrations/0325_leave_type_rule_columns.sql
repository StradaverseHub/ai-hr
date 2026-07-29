-- r81a · 9816a5ad STEP 1 OF 3 — "Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements".
--
-- ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────────────────────────────
-- The approved plan consolidates leave configuration into two homes: the LEAVE TYPE owns the RULES (how
-- days are earned, carried, rounded and capped) and the BENEFIT SCHEME owns the DAYS (per scheme × grade ×
-- service band). Today the rules do not live on the leave type at all — they are copied into
-- `leave_policy.accrual` once per (company, grade) combination. ANNUAL alone has 57 such copies, and all 57
-- say exactly the same thing.
--
-- The plan ships in THREE releases with a checkpoint between each:
--   (1) THIS ONE — add the rule columns to `leave_type` and backfill them from the single distinct value
--       per type. NOTHING READS THEM. The system must behave byte-identically afterwards.
--   (2) repoint the four `core/leave.ts` call sites (openLeaveYear, accrueEarnedLeave,
--       projectExpectedEntitlement, the a2c correction) to read the rules from the type. Balances move
--       there, not here.
--   (3) zero and disconnect `leave_policy`, remove the Company Entitlements service-length band surface.
--
-- This migration is therefore ADDITIVE AND INERT BY CONSTRUCTION: every column is new and nullable, no
-- existing column is read, written, altered or dropped, and no code path in the release selects any of
-- them. If an employee's entitlement, accrual, carry-forward or rounding changes as a result of this
-- migration, that is a BUG in step 1, not step 2 arriving early.
--
-- ── WHY THE COLLAPSE IS SAFE, AND WHY IT ASSERTS RATHER THAN ASSUMES ────────────────────────────────
-- Verified against production: grouping `leave_policy` by leave type, EVERY type has exactly ONE distinct
-- `method`, ONE `carryForwardMax` and ONE `roundingMethod` across all of its rows. The collapse is
-- therefore lossless against the data that exists — but "lossless today" is not a property a migration may
-- take on faith, because a database that disagrees would have its employees' leave silently rewritten by
-- whichever row a `LIMIT 1` happened to pick.
--
-- So the distinctness is ASSERTED, per leave type, per rule, and the migration RAISES and rolls the whole
-- release back if any type carries two different values. That is deliberate. A failure here is not a
-- defect in this migration: it means that database genuinely disagrees about what a rule should be, the
-- collapse would change somebody's entitlement, and a HUMAN must decide which value wins before step 2 can
-- ship. Failing loudly at step 1 (inert, nothing has moved yet) is enormously cheaper than discovering it
-- at step 2 (balances already recomputed).
--
-- Distinctness is measured over ALL rows of a type, including superseded ones (valid_to in the past), which
-- is the same grouping the production check used. `count(DISTINCT …)` ignores NULLs, so a type where most
-- rows simply omit a key and one row sets it is NOT a disagreement — the one stated value wins and the
-- silent rows follow it, which is exactly how the runtime resolver already reads them.
--
-- ── SANITISATION: THE VALUES ARE READ THE WAY THE ENGINE READS THEM ────────────────────────────────
-- `leave_policy.accrual` is an untyped JSONB extension point, and the runtime resolvers are DEFENSIVE BY
-- DESIGN (core/leave-compute.ts: parseCarryExpiry rejects a stored 31-Feb; resolveGradePolicy honours only
-- 'up'/'down' rounding; bandMaxBalance takes only a finite number >= 0) precisely because seeds and
-- hand-written rows bypass write-time validation. This migration applies the SAME filters, for two reasons:
--
--   * CORRECTNESS — the value carried across must be the value the engine actually acts on today. Carrying
--     a stored 31-Feb verbatim would make step 2 read a rule that step 1's system was ignoring, i.e. a
--     behaviour change smuggled in as a data move.
--   * HONESTY OF THE ASSERTION — a type whose rows are {31-Feb, 31-March} does not disagree about
--     behaviour; one of those is garbage the engine already discards. Asserting on raw bytes would fire on
--     a difference that has no effect, and a false alarm on a safety check is how safety checks get
--     disabled.
--
-- Garbage therefore lands as NULL, which every consumer already reads as "not configured" — the same
-- answer the engine gives today.
--
-- ── COLUMN SET: THE FIVE NAMED SETTINGS, PLUS THE TWO THAT CARRY THE FIFTH ─────────────────────────
-- The plan names five settings: earning method · carry-forward (max / enabled / expiry mode / expiry
-- months / include-earned) · rounding · maximum balance days. `leave_type.year_cycle_override` (Leave Year
-- Type) already lives on the type and is untouched.
--
-- Carry-forward expiry has TWO modes in the engine, not one. 'months' mode stores
-- `carryForwardExpiryMonths`; 'date' mode — the back-compat default when no mode is stored at all, and the
-- one every pre-R4 policy uses — stores `carryForwardExpiryMonth` + `carryForwardExpiryDay`. Storing the
-- mode without the date pair would leave every date-mode expiry with nowhere to live, and step 2 would
-- read "expiry configured, offset unknown" and forfeit nothing. Both columns are therefore added here.
-- They are inert like the rest; the alternative was a landmine under step 2.
--
-- `max_balance_days` has one wrinkle worth stating: it exists TODAY only inside
-- `accrual.serviceBands[].maxBalanceDays` (a per-band cap read by bandMaxBalance), never at policy level.
-- The service bands are the DAYS half of the split and move to `scheme_leave_entitlement.service_bands`,
-- so the cap has no home there and must become type-level. It is collapsed across every band of every
-- policy of the type under the same one-distinct-value assertion: if two bands genuinely cap differently,
-- that is a real disagreement and a human decides.
--
-- KNOWN STRANDED, DELIBERATELY NOT MOVED HERE (flagged for step 2): the per-band `carryForwardDays` and
-- per-band `carryForwardExpiryMonth`/`Day` overrides (feedback 9d8cf621) are also band-level rules that
-- lose their home when bands become days-only. They are NOT in the approved five and collapsing them into
-- the type-level carry cap would be a product decision, not a data move. Step 2 must decide explicitly.
--
-- ── NO ENUM IS TOUCHED ─────────────────────────────────────────────────────────────────────────────
-- Every new column is text / integer / numeric / boolean with a named CHECK. Nothing here adds or reads a
-- Postgres enum value, so the "a new enum value cannot be used in the transaction that added it" trap —
-- which breaks fresh installs while passing on a live server, because a fresh database replays the whole
-- chain in ONE transaction — does not apply. No `col = 'newvalue'` comparison exists below.
--
-- ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────────
-- Every DDL statement is IF NOT EXISTS or guarded on pg_constraint. The backfill reads `leave_policy`,
-- which this migration never modifies, so recomputing it yields the same answer — and it is additionally
-- guarded to fire ONLY on a leave type whose ten rule columns are ALL still NULL. That guard is what makes
-- the migration safe to replay after step 2 ships: once a rule is edited on the type, no re-run can drag
-- it back to whatever `leave_policy` still says.

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "accrual_method" text;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_max" numeric(6, 2);--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_enabled" boolean;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_expiry_mode" text;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_expiry_months" integer;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_expiry_month" integer;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_expiry_day" integer;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "carry_forward_include_earned" boolean;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "rounding_method" text;--> statement-breakpoint

ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "max_balance_days" numeric(6, 2);--> statement-breakpoint

-- Named CHECKs, mirroring the service-side readers. ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded
-- on pg_constraint.
--
-- There is deliberately NO CHECK on `accrual_method`. The engine's own contract for that field is open —
-- isEarnedMethod() recognises 'earned_monthly' / 'earned_quarterly' and treats EVERYTHING else, including
-- absent, as the lump-sum path — so a closed value list would add no safety while giving a legacy value in
-- some tenant's database the power to abort a deploy. Every other field genuinely has a closed set, and
-- the backfill below can only ever produce a conforming value for it.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_carry_forward_max_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_carry_forward_max_check"
			CHECK ("carry_forward_max" IS NULL OR "carry_forward_max" >= 0);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_carry_forward_expiry_mode_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_carry_forward_expiry_mode_check"
			CHECK ("carry_forward_expiry_mode" IS NULL OR "carry_forward_expiry_mode" IN ('date', 'months'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_carry_forward_expiry_months_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_carry_forward_expiry_months_check"
			CHECK ("carry_forward_expiry_months" IS NULL OR "carry_forward_expiry_months" BETWEEN 1 AND 12);
	END IF;
	-- The date-mode offset is a PAIR: both set or both unset. A half-configured (month, day) is exactly the
	-- legacy garbage parseCarryExpiry already discards, and it must not be storable here.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_carry_forward_expiry_date_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_carry_forward_expiry_date_check"
			CHECK (
				("carry_forward_expiry_month" IS NULL AND "carry_forward_expiry_day" IS NULL)
				OR (
					"carry_forward_expiry_month" BETWEEN 1 AND 12
					AND "carry_forward_expiry_day" BETWEEN 1 AND 31
				)
			);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_rounding_method_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_rounding_method_check"
			CHECK ("rounding_method" IS NULL OR "rounding_method" IN ('none', 'up', 'down'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_max_balance_days_check') THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_max_balance_days_check"
			CHECK ("max_balance_days" IS NULL OR "max_balance_days" >= 0);
	END IF;
END $$;--> statement-breakpoint

-- The collapse, expressed once as a view so the ASSERTION and the BACKFILL can never read different
-- numbers. It is created, used twice and dropped inside this migration; nothing outside it ever sees it.
--
-- Per leave type it emits, for each rule, the count of DISTINCT sanitised values found across all of that
-- type's `leave_policy` rows, and the single value itself (min()/bool_and() over a set that the assertion
-- has proven holds at most ONE non-null member — so the aggregate is a READ of that member, not a choice
-- between candidates. That is the whole difference between this and the `LIMIT 1` the plan forbids).
CREATE OR REPLACE VIEW "_r0325_leave_type_rule_source" AS
WITH raw AS (
	SELECT
		lp.leave_type_id,
		-- Earning method: carried verbatim (open value set, see the CHECK note above). Empty string ⇒ NULL,
		-- since '' is not a method the engine recognises any more than absence is.
		NULLIF(lp.accrual ->> 'method', '')                                                       AS accrual_method,
		-- Every numeric/boolean read is gated on jsonb_typeof so a string "3" or a null never reaches a cast.
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardMax') = 'number'
			THEN (lp.accrual ->> 'carryForwardMax')::numeric END                                    AS carry_forward_max_raw,
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardEnabled') = 'boolean'
			THEN (lp.accrual ->> 'carryForwardEnabled')::boolean END                                AS carry_forward_enabled,
		-- Mode is authoritative in parseCarryExpiry; an unrecognised mode is read as the 'date' back-compat
		-- branch, which is what an absent mode already means — so it stores as NULL rather than as garbage.
		CASE WHEN lp.accrual ->> 'carryForwardExpiryMode' IN ('date', 'months')
			THEN lp.accrual ->> 'carryForwardExpiryMode' END                                        AS carry_forward_expiry_mode,
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryMonths') = 'number'
			THEN (lp.accrual ->> 'carryForwardExpiryMonths')::numeric END                           AS cf_months_raw,
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryMonth') = 'number'
			THEN (lp.accrual ->> 'carryForwardExpiryMonth')::numeric END                            AS cf_month_raw,
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryDay') = 'number'
			THEN (lp.accrual ->> 'carryForwardExpiryDay')::numeric END                              AS cf_day_raw,
		CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardIncludeEarned') = 'boolean'
			THEN (lp.accrual ->> 'carryForwardIncludeEarned')::boolean END                          AS carry_forward_include_earned,
		-- resolveGradePolicy honours ONLY 'up' / 'down'; anything else resolves to undefined ⇒ no rounding.
		-- Storing NULL for "no rounding" matches that exactly, and matches how b81d3c52 persists it (the key
		-- is OMITTED rather than written as 'none', so an untouched policy stays byte-identical).
		CASE WHEN lp.accrual ->> 'roundingMethod' IN ('up', 'down')
			THEN lp.accrual ->> 'roundingMethod' END                                                AS rounding_method
	FROM leave_policy lp
),
clean AS (
	SELECT
		leave_type_id,
		accrual_method,
		-- 0 .. 9999.99 is the numeric(6,2) domain; a "carry cap" outside it is not a leave-day figure and is
		-- treated as unset, exactly as a non-numeric already is. Nested CASEs, never a single AND chain:
		-- SQL does not promise left-to-right evaluation, so the range test must GUARD the cast, not sit
		-- beside it.
		CASE WHEN carry_forward_max_raw IS NOT NULL AND carry_forward_max_raw BETWEEN 0 AND 9999.99
			THEN round(carry_forward_max_raw, 2) END                                                AS carry_forward_max,
		carry_forward_enabled,
		carry_forward_expiry_mode,
		CASE WHEN cf_months_raw IS NOT NULL
		           AND cf_months_raw = trunc(cf_months_raw)
		           AND cf_months_raw BETWEEN 1 AND 12
			THEN cf_months_raw::int END                                                             AS carry_forward_expiry_months,
		-- isValidMonthDay (core/leave-compute.ts) in SQL: integer month 1..12, integer day 1..last-real-day,
		-- with February taken from a LEAP year so a savable 29-Feb passes — the same 2024 the TS uses. The
		-- array subscript yields NULL (never an error) for an out-of-range index, and the outer CASE has
		-- already bounded the month before the ::int cast can run.
		CASE WHEN cf_month_raw IS NOT NULL
		           AND cf_month_raw = trunc(cf_month_raw)
		           AND cf_month_raw BETWEEN 1 AND 12
			THEN CASE WHEN cf_day_raw IS NOT NULL
			               AND cf_day_raw = trunc(cf_day_raw)
			               AND cf_day_raw >= 1
			               AND cf_day_raw <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[cf_month_raw::int]
				THEN cf_month_raw::int END END                                                        AS carry_forward_expiry_month,
		CASE WHEN cf_month_raw IS NOT NULL
		           AND cf_month_raw = trunc(cf_month_raw)
		           AND cf_month_raw BETWEEN 1 AND 12
			THEN CASE WHEN cf_day_raw IS NOT NULL
			               AND cf_day_raw = trunc(cf_day_raw)
			               AND cf_day_raw >= 1
			               AND cf_day_raw <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[cf_month_raw::int]
				THEN cf_day_raw::int END END                                                          AS carry_forward_expiry_day,
		carry_forward_include_earned,
		rounding_method
	FROM raw
),
-- Maximum Balance Days lives one level deeper — inside each service band of each policy — so it is
-- expanded row-per-band and collapsed across ALL bands of ALL policies of the type. A non-array
-- serviceBands (the JSONB is unvalidated) expands to nothing rather than throwing, matching bandFor's
-- "ignore malformed bands entirely" contract.
bands AS (
	SELECT
		lp.leave_type_id,
		CASE WHEN jsonb_typeof(band -> 'maxBalanceDays') = 'number'
			THEN CASE WHEN (band ->> 'maxBalanceDays')::numeric BETWEEN 0 AND 9999.99
				THEN round((band ->> 'maxBalanceDays')::numeric, 2) END END AS max_balance_days
	FROM leave_policy lp
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof(lp.accrual -> 'serviceBands') = 'array'
			THEN lp.accrual -> 'serviceBands' ELSE '[]'::jsonb END
	) AS band
),
band_agg AS (
	SELECT leave_type_id,
	       count(DISTINCT max_balance_days) AS n_max_balance_days,
	       min(max_balance_days)            AS max_balance_days
	FROM bands
	GROUP BY leave_type_id
)
SELECT
	c.leave_type_id,
	count(DISTINCT c.accrual_method)                 AS n_accrual_method,
	min(c.accrual_method)                            AS accrual_method,
	count(DISTINCT c.carry_forward_max)              AS n_carry_forward_max,
	min(c.carry_forward_max)                         AS carry_forward_max,
	count(DISTINCT c.carry_forward_enabled)          AS n_carry_forward_enabled,
	bool_and(c.carry_forward_enabled)                AS carry_forward_enabled,
	count(DISTINCT c.carry_forward_expiry_mode)      AS n_carry_forward_expiry_mode,
	min(c.carry_forward_expiry_mode)                 AS carry_forward_expiry_mode,
	count(DISTINCT c.carry_forward_expiry_months)    AS n_carry_forward_expiry_months,
	min(c.carry_forward_expiry_months)               AS carry_forward_expiry_months,
	count(DISTINCT c.carry_forward_expiry_month)     AS n_carry_forward_expiry_month,
	min(c.carry_forward_expiry_month)                AS carry_forward_expiry_month,
	count(DISTINCT c.carry_forward_expiry_day)       AS n_carry_forward_expiry_day,
	min(c.carry_forward_expiry_day)                  AS carry_forward_expiry_day,
	count(DISTINCT c.carry_forward_include_earned)   AS n_carry_forward_include_earned,
	bool_and(c.carry_forward_include_earned)         AS carry_forward_include_earned,
	count(DISTINCT c.rounding_method)                AS n_rounding_method,
	min(c.rounding_method)                           AS rounding_method,
	COALESCE(max(ba.n_max_balance_days), 0)          AS n_max_balance_days,
	max(ba.max_balance_days)                         AS max_balance_days
FROM clean c
LEFT JOIN band_agg ba ON ba.leave_type_id = c.leave_type_id
GROUP BY c.leave_type_id;--> statement-breakpoint

-- THE ASSERTION. Fires BEFORE anything is written, names every offending (leave type, rule) pair, and
-- aborts the whole release. See the header for why this is a feature and not an obstacle.
DO $$
DECLARE
	conflicts text;
BEGIN
	SELECT string_agg(msg, '; ' ORDER BY msg) INTO conflicts
	FROM (
		SELECT format('leave type %s (%s) has %s distinct values for %s',
		              COALESCE(lt.code, '?'), s.leave_type_id, v.n, v.rule) AS msg
		FROM "_r0325_leave_type_rule_source" s
		LEFT JOIN leave_type lt ON lt.id = s.leave_type_id
		CROSS JOIN LATERAL (
			VALUES
				('method',                     s.n_accrual_method),
				('carryForwardMax',            s.n_carry_forward_max),
				('carryForwardEnabled',        s.n_carry_forward_enabled),
				('carryForwardExpiryMode',     s.n_carry_forward_expiry_mode),
				('carryForwardExpiryMonths',   s.n_carry_forward_expiry_months),
				('carryForwardExpiryMonth',    s.n_carry_forward_expiry_month),
				('carryForwardExpiryDay',      s.n_carry_forward_expiry_day),
				('carryForwardIncludeEarned',  s.n_carry_forward_include_earned),
				('roundingMethod',             s.n_rounding_method),
				('serviceBands[].maxBalanceDays', s.n_max_balance_days)
		) AS v(rule, n)
		WHERE v.n > 1
	) q;

	IF conflicts IS NOT NULL THEN
		RAISE EXCEPTION
			'[0325_leave_type_rule_columns] refusing to collapse leave_policy onto leave_type: %', conflicts
			USING HINT =
				'This database disagrees with itself about a type-level leave rule, so collapsing it would '
				'change somebody''s entitlement. Decide which value is correct, make leave_policy agree, '
				'then re-run. Do NOT relax this check.';
	END IF;
END $$;--> statement-breakpoint

-- THE BACKFILL. Reads the same view the assertion just cleared.
--
-- The guard is "every one of the ten rule columns is still NULL" — i.e. this leave type has never had its
-- rules filled in. It makes a re-run a no-op the moment step 2 gives an admin a way to edit these fields,
-- so a replay can never drag a deliberate edit back to whatever leave_policy still says. A type with no
-- policy rows at all is not matched by the join and stays entirely NULL, which is correct: there is no
-- rule to move.
UPDATE "leave_type" lt
SET "accrual_method"               = s.accrual_method,
    "carry_forward_max"            = s.carry_forward_max,
    "carry_forward_enabled"        = s.carry_forward_enabled,
    "carry_forward_expiry_mode"    = s.carry_forward_expiry_mode,
    "carry_forward_expiry_months"  = s.carry_forward_expiry_months,
    "carry_forward_expiry_month"   = s.carry_forward_expiry_month,
    "carry_forward_expiry_day"     = s.carry_forward_expiry_day,
    "carry_forward_include_earned" = s.carry_forward_include_earned,
    "rounding_method"              = s.rounding_method,
    "max_balance_days"             = s.max_balance_days
FROM "_r0325_leave_type_rule_source" s
WHERE s.leave_type_id = lt."id"
  AND lt."accrual_method"               IS NULL
  AND lt."carry_forward_max"            IS NULL
  AND lt."carry_forward_enabled"        IS NULL
  AND lt."carry_forward_expiry_mode"    IS NULL
  AND lt."carry_forward_expiry_months"  IS NULL
  AND lt."carry_forward_expiry_month"   IS NULL
  AND lt."carry_forward_expiry_day"     IS NULL
  AND lt."carry_forward_include_earned" IS NULL
  AND lt."rounding_method"              IS NULL
  AND lt."max_balance_days"             IS NULL;--> statement-breakpoint

DROP VIEW IF EXISTS "_r0325_leave_type_rule_source";--> statement-breakpoint

-- No RLS change: `leave_type` keeps its existing tenant-read / admin-write policies, and additive columns
-- need no policy change. The grant is re-stated explicitly rather than assumed, per the migration standard
-- — a no-op re-grant on an existing table, and the guarantee that the ten new columns are reachable by the
-- app role when step 2 starts reading them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_type" TO ai_hr_app;
