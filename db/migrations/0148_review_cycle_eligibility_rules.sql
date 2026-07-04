-- Performance eligibility rules engine (Performance Review Cycle — Employee Eligibility Rules Engine).
--
-- Replaces the two-field exclusion (exclude_probation boolean, hired_before date) on review_cycle with a
-- single nullable JSONB `eligibility_rules` criteria object — same pattern as leave_type.eligibility.
-- Shape (all optional / AND-combined):
--   { companyIds?: uuid[], statuses?: assignment_status[], employmentTypes?: employment_type[],
--     minServiceMonths?: number, hiredBefore?: 'YYYY-MM-DD' | null }
--
-- Clean cutover: the Performance module ships with effectively no production rows, so we do NOT carry a
-- dual boolean+JSONB representation. To stay safe if any real cycle already exists, we backfill the old
-- pair into the new shape BEFORE dropping the columns — an exclude_probation=true cycle becomes a
-- statuses whitelist that omits 'probation'; a hired_before date carries straight over. Rows already
-- matching the default (exclude_probation=true, hired_before=null) become an explicit statuses whitelist
-- so their behaviour is preserved verbatim under the new evaluator.
--
-- RLS/policies/grants on review_cycle are unchanged (column drop/add only — table-level grants already
-- cover the new column). No new table, no new lookup table (Company references company.id from JSONB).

ALTER TABLE "review_cycle" ADD COLUMN "eligibility_rules" jsonb;

-- Backfill from the legacy pair. jsonb_strip_nulls keeps the object minimal (absent = "no such predicate").
UPDATE "review_cycle" SET "eligibility_rules" = jsonb_strip_nulls(
  jsonb_build_object(
    'statuses',
      CASE WHEN "exclude_probation"
        THEN '["active","on_leave","offboarding","terminated"]'::jsonb
        ELSE NULL END,
    'hiredBefore', to_jsonb("hired_before")
  )
);

ALTER TABLE "review_cycle" DROP COLUMN "exclude_probation";
ALTER TABLE "review_cycle" DROP COLUMN "hired_before";
