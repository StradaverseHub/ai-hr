-- dafd475a — System Labels standardization. Profile Options is rebuilt into a table matching the standard
-- master-data column set (Code, Label, Description, Criteria, Status, Action). It previously had no
-- Description, so this ADDITIVE, backward-compatible column carries it. Nullable + IF NOT EXISTS: a tenant
-- with no descriptions behaves exactly as before, and a re-run on a partially-migrated DB is safe.
ALTER TABLE "profile_option" ADD COLUMN IF NOT EXISTS "description" text;
