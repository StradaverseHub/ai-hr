-- Item 3a25f5ee — Personnel Contact & Address: split the single structured home address into two
-- independent addresses, a PERMANENT address (where the employee actually lives) and a CORRESPONDENCE
-- address (their official mailing / IC-registered address). Purely ADDITIVE + backward-compatible:
--   • 7 permanent_* columns + 7 correspondence_* columns, all NULLABLE text (mirrors the existing
--     address_line1/2/3, postcode, city, state, country shape added in 0168).
--   • One-time idempotent backfill: the existing single address (address_line1..country, itself backfilled
--     from the legacy free-text `address` in 0168) becomes the PERMANENT address so no data is lost. The
--     product decision (approved) is: today's stored address = Permanent; Correspondence starts empty.
--   • The legacy single-address columns are RETAINED for rollback / PDPA history and are no longer written
--     by the Contact & Address form (the form now writes permanent_* / correspondence_* only).
--
-- person RLS is DELIBERATELY UNCHANGED: person_rls (0001) already scopes read = tenant AND
-- app.can_see_person(id) and write = tenant AND app.is_admin(), so these new scalar person columns inherit
-- exactly that posture with no policy edit (same rationale as 0168's structured-address columns).
ALTER TABLE "person"
  ADD COLUMN IF NOT EXISTS "permanent_address_line1" text,
  ADD COLUMN IF NOT EXISTS "permanent_address_line2" text,
  ADD COLUMN IF NOT EXISTS "permanent_address_line3" text,
  ADD COLUMN IF NOT EXISTS "permanent_postcode" text,
  ADD COLUMN IF NOT EXISTS "permanent_city" text,
  ADD COLUMN IF NOT EXISTS "permanent_state" text,
  ADD COLUMN IF NOT EXISTS "permanent_country" text,
  ADD COLUMN IF NOT EXISTS "correspondence_address_line1" text,
  ADD COLUMN IF NOT EXISTS "correspondence_address_line2" text,
  ADD COLUMN IF NOT EXISTS "correspondence_address_line3" text,
  ADD COLUMN IF NOT EXISTS "correspondence_postcode" text,
  ADD COLUMN IF NOT EXISTS "correspondence_city" text,
  ADD COLUMN IF NOT EXISTS "correspondence_state" text,
  ADD COLUMN IF NOT EXISTS "correspondence_country" text;
--> statement-breakpoint

-- One-time idempotent backfill: map the existing structured address into the PERMANENT block. COALESCE keeps
-- any already-populated permanent value, so re-running is a no-op; the WHERE only touches rows that actually
-- carry a legacy address. Correspondence is intentionally left NULL until HR fills it in.
UPDATE "person" SET
  "permanent_address_line1" = COALESCE("permanent_address_line1", "address_line1"),
  "permanent_address_line2" = COALESCE("permanent_address_line2", "address_line2"),
  "permanent_address_line3" = COALESCE("permanent_address_line3", "address_line3"),
  "permanent_postcode"      = COALESCE("permanent_postcode", "postcode"),
  "permanent_city"          = COALESCE("permanent_city", "city"),
  "permanent_state"         = COALESCE("permanent_state", "state"),
  "permanent_country"       = COALESCE("permanent_country", "country")
WHERE "address_line1" IS NOT NULL OR "address_line2" IS NOT NULL OR "address_line3" IS NOT NULL
   OR "postcode" IS NOT NULL OR "city" IS NOT NULL OR "state" IS NOT NULL OR "country" IS NOT NULL;
