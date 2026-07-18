-- Employee ID Auto Running Number — template enhancement (R45 7bf025f0).
--
-- Grows the single-format Employee-ID setup toward template-based numbering. This migration adds the three
-- ADDITIVE, backward-compatible columns the new template features need; the generator (core/employee-id-config)
-- is updated in the same build to emit an optional suffix and to expose the template name + manual-override
-- flag on the admin screen.
--
--   • template_name          — an optional human label so several numbering formats can run side by side
--                              (e.g. "Malaysia Employee", "HQ Staff"). NULL for existing rows (unnamed).
--   • suffix                 — text appended AFTER the zero-padded running number (e.g. EMP0001MY). Defaults
--                              to '' so every existing config formats EXACTLY as before (prefix + number).
--   • allow_manual_override  — captures whether HR may hand-key an Employee ID for this scope. Defaults to
--                              false; existing configs are unchanged.
--
-- All three are nullable/defaulted, so every existing employee_id_config row is unaffected and no data
-- backfill is required (existing configs keep generating identical codes). IF NOT EXISTS keeps a re-run on a
-- partially-migrated DB idempotent. No RLS change — employee_id_config already carries its tenant/admin
-- policy (migration 0211); these scalar columns inherit it, matching the additive-column pattern used
-- elsewhere (e.g. migration 0240 on employment).
ALTER TABLE "employee_id_config" ADD COLUMN IF NOT EXISTS "template_name" text;--> statement-breakpoint
ALTER TABLE "employee_id_config" ADD COLUMN IF NOT EXISTS "suffix" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "employee_id_config" ADD COLUMN IF NOT EXISTS "allow_manual_override" boolean NOT NULL DEFAULT false;
