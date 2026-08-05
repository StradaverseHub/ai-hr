-- 6e9a126e RELEASE ONE — THE FIRST CAPTURE. Both layers, written to text, before anything can clear them.
--
-- The plan's own sequencing note is that the clearing happens LAST and that the archive's completeness is
-- the only promise it makes. This migration makes that promise true TODAY, two releases before anything
-- has the ability to clear: from the moment it runs, the reporter can open
-- /admin/leave/entitlements/archive and read every figure the reset will eventually take away.
--
-- Counted on production 2026-08-05, immediately before this build: 41 benefit schemes (all active),
-- 292 scheme entitlement rows, 67 leave policies, 16 grade groups / 54 members, 26 employments — of which
-- 9 resolve to a scheme and 17 fall through to leave_policy. TWO schemes carry zero entitlement rows.
-- Those two are the reason the scheme side is a LEFT JOIN: a scheme with no bands is still configuration
-- the reporter typed, and still has to appear in the record, or the archive quietly under-reports.
--
-- ── WHY THE CAPTURE IS A FUNCTION AND NOT AN INSERT ──────────────────────────────────────────────────
-- It has to run at least TWICE: now, and again immediately before release three clears anything, because
-- configuration can move between the two. A second copy of this rendering logic in that later migration
-- is exactly the duplicate-maintenance defect this whole feedback item is about — and the two copies
-- would be compared by nobody until the day the record they produce is the only thing left.
--
-- It is also what makes the archive TESTABLE. Migrations run against a database with no tenants in it, so
-- an INSERT here would be a capture of nothing that no test could ever exercise against real rows. As a
-- function, the same code path is called with seeded data by test/entitlement-reset-archive.test.ts.
--
-- SECURITY INVOKER (the default), deliberately: called by the migration role it sees every tenant and RLS
-- does not apply; called by the app it runs under the caller's RLS, so an admin re-capture can only ever
-- read and write their OWN tenant. One body, correct in both, with no SECURITY DEFINER escalation.

CREATE OR REPLACE FUNCTION app.capture_entitlement_reset_archive(p_tag text)
RETURNS TABLE (scheme_rows int, policy_rows int)
LANGUAGE plpgsql
AS $fn$
DECLARE
  n_scheme int;
  n_policy int;
BEGIN
  IF p_tag IS NULL OR btrim(p_tag) = '' THEN
    RAISE EXCEPTION 'capture_entitlement_reset_archive: a capture tag is required.';
  END IF;

  -- ── SCHEME SIDE ────────────────────────────────────────────────────────────────────────────────────
  -- benefit_scheme LEFT JOIN scheme_leave_entitlement: every scheme appears even with no band table.
  -- The grade GROUP survives the reset, but its MEMBERS are recorded anyway — "Grade 12-15 Permanent" is
  -- a name with no meaning unless the record says which grades were in it on the day.
  INSERT INTO entitlement_reset_archive (
    tenant_id, capture_tag, layer, scheme_name, scheme_category, leave_type_name, leave_type_code,
    company_name, scheme_grade_group_name, scheme_grade_group_members, employment_type,
    entitlement_text, valid_from_text, valid_to_text, note
  )
  SELECT
    bs.tenant_id,
    p_tag,
    'scheme',
    bs.name,
    bs.scheme_category,
    lt.name,
    lt.code,
    -- `company.name` does not exist: the column is `legal_name`, with `company_label` as an optional short
    -- form. The label is preferred when set because it is what HR calls the company in every picker.
    coalesce(c.company_label, c.legal_name),
    gg.name,
    (
      SELECT string_agg(jg.code || ' ' || jg.name, ', ' ORDER BY jg.rank, jg.code)
      FROM grade_group_member ggm
      JOIN job_grade jg ON jg.id = ggm.grade_id
      WHERE ggm.grade_group_id = bs.grade_group_id
    ),
    bs.employment_type::text,
    CASE
      WHEN sle.id IS NULL THEN NULL
      WHEN coalesce(jsonb_typeof(sle.service_bands), '') <> 'array'
        THEN 'UNREADABLE (the stored value is not a band table)'
      ELSE (
        -- Written the way the reporter's own table reads (From / To / Entitled Days / Max Brought Forward
        -- / Max Entitled + Brought Forward), because this text is what they retype from.
        SELECT string_agg(
          coalesce(b->>'fromYears', '?') || '-' || coalesce(b->>'toYears', 'no limit') || ' yrs: '
            || coalesce(b->>'days', '?') || ' days'
            || coalesce(', max brought forward ' || (b->>'carryForwardDays'), '')
            || coalesce(', max entitled + brought forward ' || (b->>'maxBalanceDays'), '')
            || coalesce(', carry expires ' || (b->>'carryForwardExpiryDay') || '/' || (b->>'carryForwardExpiryMonth'), ''),
          ' | ' ORDER BY ord)
        FROM jsonb_array_elements(sle.service_bands) WITH ORDINALITY AS t(b, ord)
      )
    END,
    -- The scheme layer has no valid_from / valid_to columns AT ALL. Saying so is the honest record; an
    -- invented window would be a figure the reporter could act on and we would have made it up.
    'not dated (the benefit scheme layer carries no effective dates)',
    'not dated (the benefit scheme layer carries no effective dates)',
    CASE
      WHEN sle.id IS NULL THEN 'This scheme carried NO entitlement table for any leave type.'
      WHEN bs.status <> 'active' THEN 'Scheme status: ' || bs.status
      ELSE NULL
    END
  FROM benefit_scheme bs
  LEFT JOIN scheme_leave_entitlement sle ON sle.benefit_scheme_id = bs.id
  LEFT JOIN leave_type lt ON lt.id = sle.leave_type_id
  LEFT JOIN company c ON c.id = bs.company_id
  LEFT JOIN grade_group gg ON gg.id = bs.grade_group_id
  -- Re-running the SAME tag must not double the record. A LATER tag is a new snapshot and is expected.
  WHERE NOT EXISTS (
    SELECT 1 FROM entitlement_reset_archive a
    WHERE a.tenant_id = bs.tenant_id AND a.capture_tag = p_tag AND a.layer = 'scheme'
  );
  GET DIAGNOSTICS n_scheme = ROW_COUNT;

  -- ── POLICY SIDE ────────────────────────────────────────────────────────────────────────────────────
  -- NOT OPTIONAL, and absent from revision 3 of the plan entirely. leave_policy is HALF of what release
  -- three clears, it is doing most of the work today (17 of 26 employments fall through to it), and it is
  -- the only DATED layer — so its windows are recorded per VERSION, not just the running one.
  INSERT INTO entitlement_reset_archive (
    tenant_id, capture_tag, layer, leave_type_name, leave_type_code, company_name, grade_name,
    entitlement_text, valid_from_text, valid_to_text, note
  )
  SELECT
    lp.tenant_id,
    p_tag,
    'policy',
    lt.name,
    lt.code,
    coalesce(c.company_label, c.legal_name),
    jg.name,
    -- The accrual figures, rendered. Bands are appended when the row carries them, because a banded
    -- policy's flat annualDays is NOT what its employees actually received.
    'Days: ' || coalesce(lp.accrual->>'annualDays', '0')
      || coalesce(' | earning method: ' || (lp.accrual->>'method'), '')
      || coalesce(' | max carry forward: ' || (lp.accrual->>'carryForwardMax'), '')
      || coalesce(' | carry expires: ' || (lp.accrual->>'carryForwardExpiryDay') || '/' || (lp.accrual->>'carryForwardExpiryMonth'), '')
      || coalesce(' | rounding: ' || (lp.accrual->>'roundingMethod'), '')
      -- ⚠️ `jsonb_typeof(missing_key)` is NULL, not a string, so a bare `<> 'array'` is NULL — which is
      -- NOT true, so the ELSE branch ran and printed a dangling "service bands:" label with nothing after
      -- it on every unbanded policy. Caught on a real render, not by a test. coalesce'd, and an EMPTY
      -- array is treated the same as an absent one for the same reason.
      || CASE
           WHEN coalesce(jsonb_typeof(lp.accrual->'serviceBands'), '') <> 'array'
             OR jsonb_array_length(lp.accrual->'serviceBands') = 0 THEN ''
           ELSE ' | service bands: ' || coalesce((
             SELECT string_agg(
               coalesce(b->>'fromYears', '?') || '-' || coalesce(b->>'toYears', 'no limit') || ' yrs: '
                 || coalesce(b->>'days', '?') || ' days'
                 || coalesce(', max brought forward ' || (b->>'carryForwardDays'), '')
                 || coalesce(', max entitled + brought forward ' || (b->>'maxBalanceDays'), ''),
               ' / ' ORDER BY ord)
             FROM jsonb_array_elements(lp.accrual->'serviceBands') WITH ORDINALITY AS t(b, ord)
           ), '')
         END,
    lp.valid_from::text,
    coalesce(lp.valid_to::text, 'still in force at capture'),
    CASE WHEN lp.company_id IS NULL THEN 'Group default (applied to every company).' ELSE NULL END
  FROM leave_policy lp
  LEFT JOIN leave_type lt ON lt.id = lp.leave_type_id
  LEFT JOIN company c ON c.id = lp.company_id
  LEFT JOIN job_grade jg ON jg.id = lp.grade_id
  WHERE NOT EXISTS (
    SELECT 1 FROM entitlement_reset_archive a
    WHERE a.tenant_id = lp.tenant_id AND a.capture_tag = p_tag AND a.layer = 'policy'
  );
  GET DIAGNOSTICS n_policy = ROW_COUNT;

  scheme_rows := n_scheme;
  policy_rows := n_policy;
  RETURN NEXT;
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.capture_entitlement_reset_archive(text) TO ai_hr_app;
--> statement-breakpoint

-- ── THE FIRST CAPTURE, AND ITS COUNTS IN THE DEPLOY LOG ──────────────────────────────────────────────
--
-- RAISE NOTICE reaches the deploy log and nobody else, which is exactly why it is NOT the archive's
-- reader — the admin listing is. It is still worth having: the number of rows captured on the day is the
-- figure to compare against the census before release three clears anything.
DO $$
DECLARE
  r record;
  n_schemes_src int;
  n_sle_src int;
  n_policy_src int;
  n_scheme_total int;
  n_policy_total int;
BEGIN
  SELECT * INTO r FROM app.capture_entitlement_reset_archive('0398-release-one');
  SELECT count(*) INTO n_schemes_src FROM benefit_scheme;
  SELECT count(*) INTO n_sle_src FROM scheme_leave_entitlement;
  SELECT count(*) INTO n_policy_src FROM leave_policy;
  SELECT count(*) INTO n_scheme_total FROM entitlement_reset_archive WHERE capture_tag = '0398-release-one' AND layer = 'scheme';
  SELECT count(*) INTO n_policy_total FROM entitlement_reset_archive WHERE capture_tag = '0398-release-one' AND layer = 'policy';
  RAISE NOTICE '0398 entitlement reset archive [0398-release-one]: captured % scheme rows (from % schemes / % entitlement rows) and % policy rows (from % leave_policy rows).',
    n_scheme_total, n_schemes_src, n_sle_src, n_policy_total, n_policy_src;

  -- Every leave_policy row must be captured. A shortfall means the record is incomplete, and the
  -- record's completeness is the ONLY promise the eventual clearing makes — so this ABORTS, not warns.
  IF n_policy_total <> n_policy_src THEN
    RAISE EXCEPTION '0398: captured % policy rows but leave_policy holds % — the archive would be incomplete.',
      n_policy_total, n_policy_src;
  END IF;
  -- The scheme side is a LEFT JOIN, so its row count is (entitlement rows) + (schemes with none).
  -- Anything below the number of entitlement rows means band tables were dropped on the floor.
  IF n_scheme_total < n_sle_src THEN
    RAISE EXCEPTION '0398: captured % scheme rows but scheme_leave_entitlement holds % — band tables were lost.',
      n_scheme_total, n_sle_src;
  END IF;
END $$;
