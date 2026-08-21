-- e4b541c6 — the two CP39 columns the schema could not fill, added as data rather than guessed at.
--
-- WHY THESE TWO AND NOTHING ELSE. The printed CP39 has a `No. K/P Lama` column and, for foreign workers,
-- a `Kod Negara` column. `lib/cp39-form.ts` has carried both as fields since it was written, with headers
-- saying plainly that each is ALWAYS EMPTY because nothing in the schema can produce it. That was true:
-- `employee_statutory_my` held `ic_number` and a passport block and nothing else.
--
-- ⚠️ THE COUNTRY CODE IS A NEW COLUMN, NOT A DERIVATION, AND THAT IS THE POINT. The existing
-- `passport_issuing_country` is fed from the tenant's own NATIONALITY option list, so it holds a demonym
-- ("Malaysian"), not a country name — and `lib/countries.ts` maps ISO codes to country NAMES. Mapping
-- "Malaysian" to "MY" by guesswork would put an invented country code on a tax document, which is the
-- one thing cp39-form.ts's header refuses to do. HR picks the code; nothing is inferred. (Measured
-- 2026-08-21: all 33 rows on production have `passport_issuing_country` NULL, so nothing is being
-- migrated away from either.)
--
-- BOTH NULLABLE AND ADDITIVE. Every existing row keeps rendering the blank column it renders today, and
-- an employer who has neither never sees a difference. No GRANT is needed: these are columns on a table
-- that already has its grants (rule 5 applies to CREATE TABLE, not ALTER).

ALTER TABLE "employee_statutory_my"
  ADD COLUMN IF NOT EXISTS "old_ic_number" text,
  ADD COLUMN IF NOT EXISTS "passport_issuing_country_code" text;

COMMENT ON COLUMN "employee_statutory_my"."old_ic_number" IS
  'CP39 No. K/P Lama — the pre-1990 identity card number, for employees who still have one. Free text: the old format is not uniform and validating it would refuse valid cards.';

COMMENT ON COLUMN "employee_statutory_my"."passport_issuing_country_code" IS
  'CP39 Kod Negara — ISO 3166-1 alpha-2, chosen by HR from lib/countries.ts. NOT derived from passport_issuing_country, which holds a nationality demonym.';
