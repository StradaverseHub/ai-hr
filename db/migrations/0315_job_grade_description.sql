-- Job Grade table standardisation (feedback e3c733df) — give job_grade the optional Description the
-- other System Label categories already have.
--
-- WHY A NEW COLUMN RATHER THAN A RENAME. The item asks to "rename Grade Name to Description" and add a
-- new Label column beside Code. Doing that literally would move every existing grade name ("Senior
-- Manager", "Executive") under a Description heading and leave Label blank on every row until someone
-- retyped them all — and Label is the field people read.
--
-- The stated GOAL is to match the pattern the other categories use, and that pattern is
-- profile_option: `value` is the code, `label` is the name people see, `description` is optional extra
-- detail (migration 0206 added exactly this column there, for exactly this reason). Matching the
-- pattern therefore means the existing `name` IS the Label, and Description is what is missing. That is
-- what this adds. The reasoning is recorded on the board item so the reporter can reject it if they did
-- mean the literal reading.
--
-- NULLABLE and with no default, so every existing grade is untouched and renders an em-dash until
-- someone fills it in. Nothing reads it for behaviour — it is display-only, like profile_option's.
ALTER TABLE "job_grade" ADD COLUMN "description" text;--> statement-breakpoint

-- NOT touched, deliberately: job_grade_code_uq and the case-insensitive active-only name uniqueness
-- index (feedback 728a7db6 / migration 0183). Adding a nullable display column must not widen or narrow
-- either, and a description is explicitly NOT part of a grade's identity — two grades may share one.
COMMENT ON COLUMN "job_grade"."description" IS
  'Optional free-text detail shown as the Description column on System Labels > Organization Label > Job Grade (e3c733df). Display-only; the grade name remains the Label.';
