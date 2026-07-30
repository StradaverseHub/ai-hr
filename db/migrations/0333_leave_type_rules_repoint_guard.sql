-- r83a · 9816a5ad STEP 2 OF 3 — "Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements".
--
-- ── WHAT THIS MIGRATION IS ─────────────────────────────────────────────────────────────────────────
-- ASSERTION ONLY. It creates nothing, alters nothing, backfills nothing and drops nothing. Step 2 is a
-- CODE change — the four named `core/leave.ts` call sites (and the four further readers enumerated in the
-- release notes) stop reading their rules from `leave_policy.accrual` and read them from the ten
-- `leave_type` columns migration 0325 added and left inert. There is no schema work to do.
--
-- What there IS, is a way for that code change to silently reprice a real customer's employees, and this
-- file is the tripwire under it. The whole of step 2's risk is one sentence: THE BALANCES MUST NOT MOVE.
--
-- ── WHY 0325's ASSERTION IS NOT ENOUGH ─────────────────────────────────────────────────────────────
-- 0325 refused to collapse a type whose policy rows DISAGREED about a rule — it asserted, per type per
-- rule, `count(DISTINCT sanitised_value) <= 1`. That is the right check for the collapse, and it passed on
-- production with zero conflicts across all ten rule keys. But `count(DISTINCT …)` IGNORES NULLS, and
-- 0325's header draws the wrong conclusion from that:
--
--     "a type where most rows simply omit a key and one row sets it is NOT a disagreement — the one
--      stated value wins and the silent rows follow it, which is exactly how the runtime resolver
--      already reads them."
--
-- The runtime resolver does NOT read them that way. It resolves ONE winning policy row per employee
-- (resolveGradePolicy: company tier, then grade tier, then most-generous days) and reads the rules off
-- THAT ROW ALONE. A silent row does not inherit a stated value from a sibling row it never consults — it
-- falls back to the field's documented default: an absent `method` is the LUMP-SUM path, an absent
-- `carryForwardMax` is 0, an absent `roundingMethod` is no rounding, an absent band `maxBalanceDays` is
-- no cap.
--
-- So a type can pass 0325 and still be repriced by step 2. Concretely, and this is not hypothetical
-- arithmetic — it is the shape production is already in, with 57 of 67 policy rows `earned_monthly`:
--
--     policy A (grade Exec, 20 days) : {"annualDays": 20, "method": "earned_monthly", "carryForwardMax": 5}
--     policy B (all grades, 16 days) : {"annualDays": 16, "method": "earned_monthly"}
--
--     count(DISTINCT carryForwardMax) = 1  ⇒ 0325 asserts cleanly and backfills carry_forward_max = 5.
--     TODAY  an ungraded employee resolves B ⇒ carryMax 0 ⇒ their whole prior balance is forfeited at
--            year-open.
--     AFTER  step 2 they resolve carryMax 5 ⇒ five days survive the year-open that used to be forfeited.
--
-- Same for `method`: one row omitting it while its siblings say `earned_monthly` would flip that cohort
-- from a lump grant at year-open to twelve monthly accruals — a different balance on every day of the
-- year. These are the two most damaging fields and they are the two most likely to be silent, because
-- core/admin.ts's writer emits `method` and `roundingMethod` as `undefined` (key omitted) when unset,
-- while it always writes `carryForwardMax` as a number.
--
-- ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────────────────────────────
-- For every leave type that step 2 will actually READ type-level rules for — i.e. every type carrying at
-- least one of the nine behaviour-bearing columns, matching `hasAnyLeaveTypeRule` in core/leave-compute.ts
-- exactly — every one of its `leave_policy` rows must ALREADY resolve to the same rule the type now
-- carries. Not "no two rows disagree": every row agrees with the TYPE, silence included, measured against
-- each field's real default.
--
-- If that holds, step 2 cannot change any employee's rule, whichever policy row they resolve, at any
-- service length, in any leave year — because every row they could possibly resolve says what the type
-- says. That is the strongest guarantee available without enumerating employees, and it is exactly the
-- "balances must not move" claim the release is making.
--
-- All rows are checked, including superseded ones (valid_to in the past), because expireCarriedLeave
-- reconstructs historical leave years from the policy version active at each year's open — a rule that
-- only ever existed on a closed version still governs a sweep of that year.
--
-- ── AND THE PER-BAND CARRY-FORWARD DECISION ────────────────────────────────────────────────────────
-- 0325 flagged the per-band `carryForwardDays` and per-band carry expiry (feedback 9d8cf621) as STRANDED
-- and left the decision to step 2. Step 2 decides: they are COLLAPSED INTO THE TYPE-LEVEL CARRY-FORWARD
-- SETTING AND STOP BEING READ. They are not among the agreed five settings; the reporter's target
-- structure is "the rules are the same for everyone and only the entitlement days differ by grade", and a
-- carry cap that differs per service band is by definition the duplication this item exists to remove.
-- The columns are NOT dropped — the JSONB keys, the `ServiceBand` fields and the `bandCarryMax` /
-- `bandCarryExpiry` readers all survive, and still govern any type step 1 never consolidated.
--
-- Production has zero policies using either, so the decision is free TODAY and would be expensive once a
-- customer configures one. The final check below is what keeps it free: if any consolidated type has a
-- band carrying a carry-forward override the pre-consolidation resolver would have ACTED on, this refuses
-- the release rather than silently ignoring that customer's configuration.
--
-- ── SANITISATION ───────────────────────────────────────────────────────────────────────────────────
-- Every JSONB read below applies the SAME filters 0325's backfill applied, which are in turn the filters
-- the defensive runtime resolvers apply (jsonb_typeof gates before every cast; only 'up'/'down' rounding;
-- isValidMonthDay for the date pair with February taken from a leap year). It has to be the same, or this
-- would fire on a difference the engine already discards — and a false alarm on a safety check is how
-- safety checks get disabled.
--
-- ── NO ENUM, NO DDL, IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────────────
-- Nothing here adds or compares a Postgres enum value, so the "a new enum value cannot be used in the
-- transaction that added it" trap (which breaks a fresh install replaying the whole chain in ONE
-- transaction, while passing on a live server) cannot apply. A read-only assertion is trivially
-- re-runnable. On an empty database — every fresh install and every vitest template — `leave_policy` has
-- no rows, so this is a no-op.

DO $$
DECLARE
	conflicts text;
BEGIN
	WITH
	-- The types step 2 will actually read rules for. Mirrors hasAnyLeaveTypeRule(): the nine
	-- behaviour-bearing columns only. `carry_forward_include_earned` is EXCLUDED on both sides — it is
	-- config-only, read by no engine, and must not by itself flip a type onto the type-level rule set.
	consolidated AS (
		SELECT * FROM leave_type lt
		WHERE lt.accrual_method               IS NOT NULL
		   OR lt.carry_forward_max            IS NOT NULL
		   OR lt.carry_forward_enabled        IS NOT NULL
		   OR lt.carry_forward_expiry_mode    IS NOT NULL
		   OR lt.carry_forward_expiry_months  IS NOT NULL
		   OR lt.carry_forward_expiry_month   IS NOT NULL
		   OR lt.carry_forward_expiry_day     IS NOT NULL
		   OR lt.rounding_method              IS NOT NULL
		   OR lt.max_balance_days             IS NOT NULL
	),
	-- Each policy row's rules, sanitised exactly as 0325 sanitised them.
	pol AS (
		SELECT
			lp.id,
			lp.leave_type_id,
			NULLIF(lp.accrual ->> 'method', '') AS method,
			CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardMax') = 'number'
				THEN (lp.accrual ->> 'carryForwardMax')::numeric END AS cf_max_raw,
			CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardEnabled') = 'boolean'
				THEN (lp.accrual ->> 'carryForwardEnabled')::boolean END AS cf_enabled,
			CASE WHEN lp.accrual ->> 'carryForwardExpiryMode' IN ('date', 'months')
				THEN lp.accrual ->> 'carryForwardExpiryMode' END AS cf_mode,
			CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryMonths') = 'number'
				THEN (lp.accrual ->> 'carryForwardExpiryMonths')::numeric END AS cf_months_raw,
			CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryMonth') = 'number'
				THEN (lp.accrual ->> 'carryForwardExpiryMonth')::numeric END AS cf_month_raw,
			CASE WHEN jsonb_typeof(lp.accrual -> 'carryForwardExpiryDay') = 'number'
				THEN (lp.accrual ->> 'carryForwardExpiryDay')::numeric END AS cf_day_raw,
			CASE WHEN lp.accrual ->> 'roundingMethod' IN ('up', 'down')
				THEN lp.accrual ->> 'roundingMethod' END AS rounding,
			CASE WHEN jsonb_typeof(lp.accrual -> 'serviceBands') = 'array'
				THEN lp.accrual -> 'serviceBands' ELSE '[]'::jsonb END AS bands
		FROM leave_policy lp
	),
	clean AS (
		SELECT
			id, leave_type_id, method, cf_enabled, cf_mode, rounding, bands,
			CASE WHEN cf_max_raw IS NOT NULL AND cf_max_raw BETWEEN 0 AND 9999.99
				THEN round(cf_max_raw, 2) END AS cf_max,
			CASE WHEN cf_months_raw IS NOT NULL
			           AND cf_months_raw = trunc(cf_months_raw)
			           AND cf_months_raw BETWEEN 1 AND 12
				THEN cf_months_raw::int END AS cf_months,
			-- isValidMonthDay in SQL: the day bound comes from a LEAP year so a savable 29-Feb passes,
			-- and the month range GUARDS the array subscript / the ::int cast (nested CASE, never an AND
			-- chain — SQL does not promise left-to-right evaluation).
			CASE WHEN cf_month_raw IS NOT NULL
			           AND cf_month_raw = trunc(cf_month_raw)
			           AND cf_month_raw BETWEEN 1 AND 12
				THEN CASE WHEN cf_day_raw IS NOT NULL
				               AND cf_day_raw = trunc(cf_day_raw)
				               AND cf_day_raw >= 1
				               AND cf_day_raw <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[cf_month_raw::int]
					THEN cf_month_raw::int END END AS cf_month,
			CASE WHEN cf_month_raw IS NOT NULL
			           AND cf_month_raw = trunc(cf_month_raw)
			           AND cf_month_raw BETWEEN 1 AND 12
				THEN CASE WHEN cf_day_raw IS NOT NULL
				               AND cf_day_raw = trunc(cf_day_raw)
				               AND cf_day_raw >= 1
				               AND cf_day_raw <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[cf_month_raw::int]
					THEN cf_day_raw::int END END AS cf_day
		FROM pol
	),
	-- Per-band facts, one row per band. `maxBalanceDays` is the only band value step 2 keeps reading (as a
	-- type-level rule); the two carry-forward overrides are checked for PRESENCE because step 2 stops
	-- reading them. "Present" means what bandCarryMax / bandCarryExpiry would have ACTED on — a finite
	-- number >= 0, and a valid (month, day) pair — not merely "the key exists".
	band AS (
		SELECT
			c.id,
			c.leave_type_id,
			CASE WHEN jsonb_typeof(b -> 'maxBalanceDays') = 'number'
				THEN CASE WHEN (b ->> 'maxBalanceDays')::numeric BETWEEN 0 AND 9999.99
					THEN round((b ->> 'maxBalanceDays')::numeric, 2) END END AS max_balance,
			(jsonb_typeof(b -> 'carryForwardDays') = 'number'
				AND (b ->> 'carryForwardDays')::numeric >= 0) AS has_band_carry,
			(jsonb_typeof(b -> 'carryForwardExpiryMonth') = 'number'
				AND jsonb_typeof(b -> 'carryForwardExpiryDay') = 'number'
				AND (b ->> 'carryForwardExpiryMonth')::numeric = trunc((b ->> 'carryForwardExpiryMonth')::numeric)
				AND (b ->> 'carryForwardExpiryMonth')::numeric BETWEEN 1 AND 12
				AND (b ->> 'carryForwardExpiryDay')::numeric = trunc((b ->> 'carryForwardExpiryDay')::numeric)
				AND (b ->> 'carryForwardExpiryDay')::numeric >= 1
				AND (b ->> 'carryForwardExpiryDay')::numeric
				    <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[
				         greatest(1, least(12, (b ->> 'carryForwardExpiryMonth')::numeric))::int]
			) AS has_band_expiry
		FROM clean c
		CROSS JOIN LATERAL jsonb_array_elements(c.bands) AS b
	),
	-- One row per (policy, rule) that step 2 would resolve DIFFERENTLY from today.
	mismatch AS (
		-- The eight scalar rules. `IS DISTINCT FROM` is null-aware, which is the entire point: a silent
		-- policy row (NULL) against a stated type value (non-NULL) is a MISMATCH, and that is precisely
		-- the case 0325's count(DISTINCT …) could not see.
		SELECT lt.code, lt.id AS type_id, v.rule
		FROM consolidated lt
		JOIN clean c ON c.leave_type_id = lt.id
		CROSS JOIN LATERAL (
			VALUES
				('method',                   c.method    IS DISTINCT FROM lt.accrual_method),
				-- carryForwardMax alone has a NON-NULL default: absent reads as 0, so a silent row and a
				-- type-level 0 genuinely agree and must not be reported.
				('carryForwardMax',          COALESCE(c.cf_max, 0) IS DISTINCT FROM COALESCE(lt.carry_forward_max, 0)),
				('carryForwardEnabled',      c.cf_enabled IS DISTINCT FROM lt.carry_forward_enabled),
				('carryForwardExpiryMode',   c.cf_mode    IS DISTINCT FROM lt.carry_forward_expiry_mode),
				('carryForwardExpiryMonths', c.cf_months  IS DISTINCT FROM lt.carry_forward_expiry_months),
				('carryForwardExpiryMonth',  c.cf_month   IS DISTINCT FROM lt.carry_forward_expiry_month),
				('carryForwardExpiryDay',    c.cf_day     IS DISTINCT FROM lt.carry_forward_expiry_day),
				('roundingMethod',           c.rounding   IS DISTINCT FROM lt.rounding_method)
		) AS v(rule, bad)
		WHERE v.bad

		UNION ALL

		-- Maximum Balance, which lives one level deeper: every BAND of every policy must already carry the
		-- cap the type now states.
		SELECT lt.code, lt.id, 'serviceBands[].maxBalanceDays'
		FROM consolidated lt
		JOIN band b ON b.leave_type_id = lt.id
		WHERE b.max_balance IS DISTINCT FROM lt.max_balance_days

		UNION ALL

		-- …and a policy with NO bands resolves bandMaxBalance(null) = null = NO CAP today. If the type now
		-- states a cap, that policy's employees would newly be capped. Reported separately so the message
		-- names the real cause rather than blaming a band that does not exist.
		SELECT lt.code, lt.id, 'maxBalanceDays (policy has no service bands, so no cap applies today)'
		FROM consolidated lt
		JOIN clean c ON c.leave_type_id = lt.id
		WHERE lt.max_balance_days IS NOT NULL
		  AND jsonb_array_length(c.bands) = 0

		UNION ALL

		-- The per-band carry-forward decision (see the header). Step 2 stops reading these; if a band
		-- actually uses one, stopping would change that cohort's carry, so refuse instead.
		SELECT lt.code, lt.id, 'serviceBands[].carryForwardDays (step 2 stops reading per-band carry)'
		FROM consolidated lt
		JOIN band b ON b.leave_type_id = lt.id
		WHERE b.has_band_carry

		UNION ALL

		SELECT lt.code, lt.id, 'serviceBands[].carryForwardExpiry (step 2 stops reading per-band expiry)'
		FROM consolidated lt
		JOIN band b ON b.leave_type_id = lt.id
		WHERE b.has_band_expiry
	)
	SELECT string_agg(msg, '; ' ORDER BY msg) INTO conflicts
	FROM (
		SELECT DISTINCT format('leave type %s (%s): %s policy row(s) resolve a different %s than the type does',
		                       COALESCE(code, '?'), type_id, count(*) OVER (PARTITION BY type_id, rule), rule) AS msg
		FROM mismatch
	) q;

	IF conflicts IS NOT NULL THEN
		RAISE EXCEPTION
			'[0333_leave_type_rules_repoint_guard] refusing to repoint the leave engines onto leave_type: %', conflicts
			USING HINT =
				'Reading these rules from the leave type instead of leave_policy would change what at least '
				'one employee is entitled to, carries forward, or accrues — the one thing step 2 promises '
				'it cannot do. This is almost always a policy row that is SILENT on a rule while a sibling '
				'row states it: 0325''s count(DISTINCT ...) ignores NULLs, but the runtime resolver reads '
				'the winning row ALONE and falls back to the field default. Decide the correct value, make '
				'every leave_policy row of that type state it explicitly, then re-run. Do NOT relax this '
				'check, and do NOT fix it by clearing the leave_type column — that only moves the '
				'disagreement out of sight.';
	END IF;
END $$;
