-- 4a1abc4a — the custom rounding table moves to TWO decimal places, and its rows are joined up.
--
-- ⚠️ THIS ONE CHANGES A CALCULATION, in exactly two places, and the reporter was told so in the plan
-- before approving it. Read the delta before changing a character of this file.
--
-- ── WHAT IS STORED TODAY, measured on production 2026-08-07 ─────────────────────────────────────────
-- Three leave types carry `rounding_bands` — ANNUAL, CGL, CPL — and all three hold the identical table:
--
--     from 0      to 0.4    result 0
--     from 0.401  to 0.7    result 0.5
--     from 0.701  to 1      result 1
--
-- A query for any band figure that is not an exact multiple of 0.01 returns exactly 0.401 and 0.701, on
-- each of the three. There is no genuine third-decimal usage anywhere: those two are "one notch above
-- 0.400 / 0.700", typed because each row stops just BEFORE its Round To (`applyRoundingBands` matches
-- from <= f < to) and the next row had to start somewhere.
--
-- ── THE BEHAVIOUR DELTA, STATED PLAINLY ─────────────────────────────────────────────────────────────
-- The notches leave two HOLES. Row 1 covers 0.000 <= f < 0.400 and row 2 starts at 0.401, so a fraction
-- of exactly 0.400 is in NEITHER: it matches no band and `applyRoundingBands` leaves the value exactly as
-- calculated. The same at exactly 0.700. After this migration row 2 starts at 0.40 and row 3 at 0.70, so:
--
--     a fraction of exactly 0.400 now rounds to half a day  (was: left unrounded)
--     a fraction of exactly 0.700 now rounds to a whole day (was: left unrounded)
--
-- Nothing else moves. Every other fraction lands in the same band it landed in before, because the only
-- boundaries that shift are 0.401 -> 0.40 and 0.701 -> 0.70, and the range between the old and the new
-- boundary is precisely the hole. NO LEDGER ROW IS TOUCHED and nothing is recalculated: this is
-- configuration, and it applies the next time an entitlement is worked out.
--
-- ── NO ENGINE CHANGE IS REQUIRED, and this is why ───────────────────────────────────────────────────
-- `applyRoundingBands` snaps the fraction under test to three decimals and `bandRound` widens each stored
-- boundary the same way, so a stored 0.40 is compared as 0.400. The comparison is unchanged; only the
-- numbers it compares are. core/leave-compute.ts is deliberately untouched by this item.
--
-- ── WHY THIS IS WRITTEN OVER THE DATA AND NOT AS THREE UPDATEs ──────────────────────────────────────
-- Production's nine rows are known, but a tenant on another database is not, and a hardcoded rewrite
-- would leave any other table at three decimals with the code that renders it at two. So each row's From
-- is set to the PREVIOUS row's To (0.00 for the first) and its To/Result are rounded to 2dp, in array
-- order, for every well-shaped table there is. That is the same rule `fromText` now applies in the
-- editor, which is what makes a gap between rows unrepresentable from here on.
--
-- Idempotent twice over: re-running produces the same array, and the `IS DISTINCT FROM` guard makes the
-- second run update nothing. A malformed table (a non-array, an element that is not an object, or a
-- from/to/result that is not a JSON number) is SKIPPED rather than repaired — `applyRoundingBands`
-- already ignores such a table and leaves the value as calculated, and inventing figures for it here
-- would turn a rule nobody can read into a rule that silently starts moving days.
--
-- Data-only on an existing, already-granted table (`leave_type`). No DDL, so no GRANT.
WITH shaped AS (
  SELECT lt.id,
         e.ord,
         round((e.value ->> 'to')::numeric, 2)     AS to_v,
         round((e.value ->> 'result')::numeric, 2) AS result_v,
         -- The stored From, rounded but NOT yet snapped to the row above — `joined` decides whether the gap
         -- it leaves is a fencepost worth absorbing or a decision worth keeping.
         round((e.value ->> 'from')::numeric, 2)   AS from_v_raw
  FROM leave_type lt
  CROSS JOIN LATERAL jsonb_array_elements(lt.rounding_bands) WITH ORDINALITY AS e(value, ord)
  WHERE jsonb_typeof(lt.rounding_bands) = 'array'
    AND jsonb_array_length(lt.rounding_bands) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(lt.rounding_bands) AS x(v)
      WHERE jsonb_typeof(x.v) <> 'object'
         OR jsonb_typeof(x.v -> 'from') <> 'number'
         OR jsonb_typeof(x.v -> 'to') <> 'number'
         OR jsonb_typeof(x.v -> 'result') <> 'number'
    )
),
joined AS (
  -- CLOSE A FENCEPOST NOTCH, PRESERVE A DELIBERATE GAP.
  --
  -- Found in verification. The first version set From to the row above's To unconditionally, which is right
  -- for the three tables that exist on production (their 0.401 / 0.701 are "one notch above 0.400", typed
  -- because a row stops just before its Round To) but WRONG in general: a table that deliberately leaves a
  -- fraction uncovered — a single row [0.50, 1.00], which is legal and savable today — would have had that
  -- gap silently closed and started rounding fractions it was written to leave alone.
  --
  -- So the rule is narrow: only absorb a gap SMALLER THAN ONE HUNDREDTH, which is exactly a boundary that
  -- 2dp cannot express and therefore can only be a fencepost. Anything 0.01 or wider is a decision somebody
  -- made, and it survives, rounded to 2dp like everything else.
  SELECT id,
         ord,
         CASE
           -- The FIRST row has no row above it, so its fencepost reference is 0 rather than a lag. Same
           -- rule: absorb a sub-hundredth notch (a stored 0.001), keep anything wider. Forcing it to 0.00
           -- unconditionally is what destroyed a single-row table like [{from: 0.50, to: 1.00}] — legal and
           -- savable today — by making it round the whole lower half it was written to leave alone.
           WHEN lag(to_v) OVER (PARTITION BY id ORDER BY ord) IS NULL
             THEN CASE WHEN from_v_raw < 0.01 THEN round(0::numeric, 2) ELSE from_v_raw END
           WHEN from_v_raw - lag(to_v) OVER (PARTITION BY id ORDER BY ord) < 0.01
             THEN lag(to_v) OVER (PARTITION BY id ORDER BY ord)
           ELSE from_v_raw
         END AS from_v,
         to_v,
         result_v
  FROM shaped
),
rebuilt AS (
  SELECT id,
         jsonb_agg(
           jsonb_build_object('from', from_v, 'to', to_v, 'result', result_v)
           ORDER BY ord
         ) AS bands
  FROM joined
  GROUP BY id
)
UPDATE leave_type lt
SET rounding_bands = r.bands
FROM rebuilt r
WHERE lt.id = r.id
  AND lt.rounding_bands IS DISTINCT FROM r.bands;
