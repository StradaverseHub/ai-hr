-- Personnel (Admin) — Age shows "Not Available" although the Date of Birth field appears filled
-- (feedback b9fd8fd5, follow-up to 354a500d / 9d13221c).
--
-- ROOT CAUSE: the Profile tab's DOB input is client-filled from the IC digits when person.date_of_birth
-- is NULL (components/ic-dob-autofill.tsx) — display-only, never persisted. The Age beside it correctly
-- reads the SAVED value (completedYearsAt(person.dateOfBirth)), finds NULL, and renders Not Available.
-- Affected: employees whose IC arrived via bulk import (core/import.ts wrote ic_number without a DOB) or
-- was saved before item 354a500d added the setIcAction persistence path.
--
-- ONE-TIME CORRECTION (data-only, idempotent, no schema change): for every person with NO saved DOB whose
-- statutory row carries a valid 12-digit IC, derive and SAVE the date of birth from the IC's first six
-- digits (YYMMDD) — the SAME derivation the screen already trusts for display (localization/my/ic-dob.ts
-- dobFromIC; SQL↔TS equivalence pinned by test/dob-backfill-from-ic.test.ts):
--   • rollover guard: a candidate is real only when (year, month, day) round-trip exactly — month 13,
--     day 00, 31 April, 29 Feb in a non-leap year are SKIPPED (row left alone), never rolled over or failed;
--   • century rule (most-recent-non-future): read YY as 2000+YY unless that date lies in the future,
--     in which case fall back to the 1900+YY reading.
-- An existing DOB is never touched (WHERE date_of_birth IS NULL — the dobOnlyIfEmpty semantics), and an IC
-- whose digits form no real date leaves the row alone (its Age stays honestly Not Available).
WITH candidate AS (
  SELECT p."id" AS person_id,
         regexp_replace(s."ic_number", '[^0-9]', '', 'g') AS ic
  FROM "person" p
  JOIN "employee_statutory_my" s ON s."person_id" = p."id"
  WHERE p."date_of_birth" IS NULL
    AND s."ic_number" IS NOT NULL
    AND regexp_replace(s."ic_number", '[^0-9]', '', 'g') ~ '^[0-9]{12}$'
), parsed AS (
  SELECT person_id,
         substring(ic FROM 1 FOR 2)::int AS yy,
         substring(ic FROM 3 FOR 2)::int AS mm,
         substring(ic FROM 5 FOR 2)::int AS dd
  FROM candidate
), derived AS (
  -- Per-century candidate, rollover-guarded: build "1 Jan of the year + (mm-1) months + (dd-1) days" and
  -- accept it only when the result round-trips to exactly (year, mm, dd) — mirrors the Date.UTC round-trip
  -- in isoIfRealDate (ic-dob.ts). make_date(y, mm, dd) is NOT used directly because it raises on an unreal
  -- date, and a bad legacy IC must skip its row, not abort the migration.
  SELECT parsed.person_id,
         CASE WHEN c2000.d IS NOT NULL AND c2000.d <= CURRENT_DATE THEN c2000.d ELSE c1900.d END AS dob
  FROM parsed
  CROSS JOIN LATERAL (
    SELECT CASE WHEN extract(year FROM t.x)::int = 2000 + parsed.yy
                 AND extract(month FROM t.x)::int = parsed.mm
                 AND extract(day FROM t.x)::int = parsed.dd
            THEN t.x END AS d
    FROM (SELECT (make_date(2000 + parsed.yy, 1, 1)
                  + make_interval(months => parsed.mm - 1, days => parsed.dd - 1))::date AS x) t
  ) c2000
  CROSS JOIN LATERAL (
    SELECT CASE WHEN extract(year FROM t.x)::int = 1900 + parsed.yy
                 AND extract(month FROM t.x)::int = parsed.mm
                 AND extract(day FROM t.x)::int = parsed.dd
            THEN t.x END AS d
    FROM (SELECT (make_date(1900 + parsed.yy, 1, 1)
                  + make_interval(months => parsed.mm - 1, days => parsed.dd - 1))::date AS x) t
  ) c1900
)
UPDATE "person" p
SET "date_of_birth" = derived.dob
FROM derived
WHERE p."id" = derived.person_id
  AND p."date_of_birth" IS NULL
  AND derived.dob IS NOT NULL;
