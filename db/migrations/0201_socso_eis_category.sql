-- Item a7271737 — persisted SOCSO / EIS contribution-category override on employee_statutory_my
-- (additive, backward-compatible). Today the SOCSO category (First = Injury+Invalidity / Second = Injury-only)
-- and EIS eligibility are DERIVED per-employee in the payroll kernel from age + EPF citizenship. These two new
-- columns let HR OVERRIDE that derivation per scheme; 'auto' keeps the current automatic behaviour byte-for-byte.
--   • socso_category (text): auto | first | second | none.
--       auto   ⇒ kernel keeps the age/citizenship derivation (age>=60 or non-citizen ⇒ Second, else First).
--       first  ⇒ force First Category (Employment Injury + Invalidity).
--       second ⇒ force Second Category (Employment Injury only).
--       none   ⇒ no SOCSO contribution (same effect as subject_to_socso = false).
--   • eis_category (text): auto | none.
--       auto   ⇒ kernel keeps the current EIS derivation (eligible AND age<60 AND citizen).
--       none   ⇒ no EIS contribution (same effect as eis_eligible = false / "Subject to EIS" off).
-- The category is now the single per-scheme control: the setter derives the legacy booleans from it
-- (subject_to_socso = category != none; eis_eligible = category != none) so every downstream reader is unchanged.
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "socso_category" text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "eis_category" text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
-- Backfill so pre-existing rows keep today's behaviour exactly. A row whose "Subject to SOCSO" was turned OFF
-- becomes category 'none'; everything else stays 'auto' (the automatic derivation). Guarded to rows still at the
-- 'auto' default so a re-run never clobbers a deliberately-chosen first/second value. (Clean-room = 0 rows.)
UPDATE "employee_statutory_my" SET "socso_category" = 'none' WHERE "subject_to_socso" = false AND "socso_category" = 'auto';
--> statement-breakpoint
UPDATE "employee_statutory_my" SET "eis_category" = 'none' WHERE "eis_eligible" = false AND "eis_category" = 'auto';
