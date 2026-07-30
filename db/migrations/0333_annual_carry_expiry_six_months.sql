-- r85 · 9816a5ad step 2 — harmonise Annual Leave's carry-forward expiry to SIX months.
--
-- WHY THIS EXISTS, AND WHY IT IS A SEPARATE MIGRATION FROM THE GUARD.
-- 0333 refuses the release when any policy row of a consolidated leave type would resolve a different rule
-- than the type itself now carries. Run against production on 2026-07-30 it FIRED, on exactly one thing:
--     leave type ANNUAL, rule carryForwardExpiryMonths, 1 policy row disagreeing
-- 56 of 57 ANNUAL policy rows read 8 months; one read 6. The audit trail settles that it was a LIVE EDIT
-- and not stale data — leave-policy.updated carries 8 at 10:06 that morning and 6 at 11:10 the same day.
--
-- The reporter then answered the plan directly: "the Carry Forward Expiry for Annual Leave should be
-- updated to 6 months, as this is the new policy. Please use 6 months as the shared Leave Type setting
-- instead of 8 months."
--
-- So the resolution is NOT to weaken 0333 and NOT to overwrite the reporter's edit back to 8. It is to
-- make the data say what they have decided: six months, everywhere, for Annual Leave.
--
-- THIS CHANGES BEHAVIOUR, DELIBERATELY. Carried Annual Leave will be forfeited two months earlier than it
-- is today. That is the reporter's stated new policy and it is disclosed in the plan they approved; it is
-- recorded here so nobody later reads this as a tidy-up.
--
-- ORDERING IS THE WHOLE POINT. This is 0333 and the guard is 0334, so the data is corrected BEFORE the
-- assertion runs. Numbered the other way round the guard fires first and refuses the very release that
-- fixes it — which is exactly the mistake this file was written with, and caught, before it shipped.
-- (The guard was 0328 until r85 renumbered it above the deployed watermark.)
--
-- SCOPE. ANNUAL only, and only the expiry-months rule. Every other type and rule is left exactly alone —
-- 0333 found no other disagreement, and widening this would be changing settings nobody asked about.

DO $$
DECLARE
  types_touched int;
  policies_touched int;
BEGIN
  -- 1. The leave type's own consolidated value (what the engines read after step 2).
  UPDATE leave_type
  SET carry_forward_expiry_months = 6
  WHERE code = 'ANNUAL'
    AND carry_forward_expiry_mode = 'months'
    AND carry_forward_expiry_months IS DISTINCT FROM 6;
  GET DIAGNOSTICS types_touched = ROW_COUNT;

  -- 2. Every ANNUAL policy row, so 0333's type-vs-policy assertion holds. jsonb_set with create_if_missing
  -- FALSE: a row that never stated an expiry stays silent rather than gaining one, because 0333 compares
  -- the resolved value and a row that is silent on the rule resolves to the type's own.
  UPDATE leave_policy lp
  SET accrual = jsonb_set(lp.accrual, '{carryForwardExpiryMonths}', '6'::jsonb, false)
  FROM leave_type lt
  WHERE lt.id = lp.leave_type_id
    AND lt.code = 'ANNUAL'
    AND jsonb_typeof(lp.accrual -> 'carryForwardExpiryMonths') = 'number'
    AND (lp.accrual ->> 'carryForwardExpiryMonths')::numeric IS DISTINCT FROM 6;
  GET DIAGNOSTICS policies_touched = ROW_COUNT;

  RAISE NOTICE '[0333] Annual carry-forward expiry set to 6 months: % leave type(s), % policy row(s).',
    types_touched, policies_touched;
END $$;
