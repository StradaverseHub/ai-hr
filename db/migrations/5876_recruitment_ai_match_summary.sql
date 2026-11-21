-- Recruitment slice 24 (docs/recruitment-reconstruction/specification.md "Slice 24"): AI match summary suggestions.
--
-- The owner decided (D-063) that AI may only suggest a match summary that people see; it never ranks, scores the list or
-- rejects, and there are no AI interviews. The suggestion is shown to the reviewer who asked and is never stored, so this
-- migration adds no table and nothing of a candidate. Details in D-069.
--
-- What this installs:
--   1. recruitment_company_setting.ai_match_summary_enabled (default false). The table's existing policies already let only
--      the company's recruitment administrators insert or update its row; no grant changes.
--   2. The AI Centre control key read:operation_recruitment_match_summary (default enabled, like every other operation key),
--      so an administrator can switch the operation off in the AI Centre and the existing SQL owner stops refusing it as an
--      unregistered key. This grants no provider use: the provider contract recruitment_match_summary_v1 has no owner approval
--      record, and the gateway refuses every send until the repository owner records one.
ALTER TABLE public.recruitment_company_setting ADD COLUMN ai_match_summary_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES ('read:operation_recruitment_match_summary',true);
