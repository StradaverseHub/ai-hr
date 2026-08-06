-- e7eb5d83 — Configurable Claim Management: the two things that genuinely did not exist.
--
-- Measured on production 2026-08-06 before any of this was written: claim_type 4 · claim_item 7 ·
-- claim_policy 4 · claim_policy rows with a non-null grade_id ZERO · job_grade 55 · claim_request ZERO.
-- Zero claims filed is why every column below can be additive and nullable with no backfill: there is no
-- history to migrate, only a shape to make configurable.
--
-- The THIRD part of that item — the grade-first Claim Limits screen — is deliberately absent from this
-- file. It needed no schema change at all; claim_policy has carried (claim_type_id, grade_id, per_claim_cap,
-- monthly_limit, annual_budget, lifetime_limit, max_claims_per_year, valid_from/valid_to) since 0164. What
-- failed the reporter there was the screen, and a migration would have been the wrong answer.
--
-- Single file (0101 precedent — table DDL + RLS co-located):
--   • claim_mileage_rate: banded, vehicle-classed, GRADE-SCOPED, effective-dated mileage rates.
--   • claim_request.mileage_rate_applied: the rate stamped onto a claim at submit.
--   • claim_form_field: per-claim-type custom fields (the form designer).
--   • claim_request.field_values: the answers to those fields.

-- ─────────────────────────── claim_mileage_rate ───────────────────────────
--
-- Replaces (without removing) the single scalar in claim_policy.rate_config = {kind:'mileage_flat',
-- ratePerKm}. That scalar stays valid and stays the fallback: a claim type with a mileage rate_config but no
-- rows here prices exactly as it did before, so this migration cannot change any existing configuration.
--
-- grade_id NULL = the company-wide table. A row set carrying the employee's grade wins over it, and within
-- the winning tier the latest valid_from ≤ the claim date is active. That is claim_policy's rule verbatim,
-- reused rather than reimplemented — see resolveMileageRateBands in core/claims.ts.
--
-- A "table" is the SET of rows sharing (claim_type_id, grade_id, vehicle_class, valid_from): one row per
-- distance band, the last of which has to_km NULL ("and above"). Editing is append-only close+insert on the
-- whole set, which is what keeps last year's table readable at last year's date.
CREATE TABLE IF NOT EXISTS "claim_mileage_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_type_id" uuid NOT NULL,
	-- NULL ⇒ company-wide fallback. Plain FK with no ON DELETE, matching claim_policy.grade_id: the
	-- in-use predicate in listJobGrades / deleteJobGrade (core/read.ts, core/admin.ts) has been extended to
	-- cover this table so a grade referenced only by a mileage rate reports inUse and cannot raise a raw 23503.
	"grade_id" uuid,
	"vehicle_class" text DEFAULT 'any' NOT NULL,
	"from_km" numeric(10, 2) DEFAULT '0' NOT NULL,
	-- NULL = the open top band ("and above"). Exactly one per table, enforced in core/claims.ts.
	"to_km" numeric(10, 2),
	-- 4dp: fuel-rate policies are routinely quoted to a tenth of a sen (0.4500, 0.6250).
	"rate_per_km" numeric(10, 4) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_mileage_rate" ADD CONSTRAINT "claim_mileage_rate_claim_type_id_claim_type_fk" FOREIGN KEY ("claim_type_id") REFERENCES "public"."claim_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_mileage_rate" ADD CONSTRAINT "claim_mileage_rate_grade_id_job_grade_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_mileage_rate_lookup_idx" ON "claim_mileage_rate" USING btree ("claim_type_id","grade_id","vehicle_class","valid_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_mileage_rate_tenant_idx" ON "claim_mileage_rate" USING btree ("tenant_id");--> statement-breakpoint

-- ─────────────────────────── claim_form_field ───────────────────────────
--
-- ⚠️ THE FOUR BUILT-INS ARE NOT ROWS IN THIS TABLE AND MUST NEVER BECOME ROWS. amount, incurred_on,
-- description and the receipt attachment are real columns on claim_request with real behaviour hanging off
-- them: per-claim cap / monthly / annual / lifetime arithmetic, the receipt-age window, taxable routing into
-- payroll. Modelling them as configurable fields would put the limit engine behind a jsonb blob and let an
-- admin delete the column the money is computed from. createClaimFormField refuses their keys outright
-- (BUILT_IN_FIELD_KEYS in core/claims.ts), so a forged POST cannot smuggle one in either.
--
-- field_key is immutable once created — renaming it would orphan every answer already stored under it. The
-- label is what an admin edits. Removal is ARCHIVE, not DELETE, for the same reason.
CREATE TABLE IF NOT EXISTS "claim_form_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_type_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	-- CLAIM_FIELD_KINDS in core/claims.ts: text | number | money | date | select | boolean. Free text with no
	-- CHECK, matching leave_generation_run_item.outcome (0400): a new kind must be able to start being stored
	-- in the same commit that introduces it, and the TypeScript union is pinned by test instead — which is
	-- where a divergence is actually fixable.
	"kind" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_form_field" ADD CONSTRAINT "claim_form_field_claim_type_id_claim_type_fk" FOREIGN KEY ("claim_type_id") REFERENCES "public"."claim_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_form_field_type_idx" ON "claim_form_field" USING btree ("claim_type_id","sort_order");--> statement-breakpoint
-- One LIVE key per claim type; archived rows may re-use a key (mirrors claim_item_type_code_uq, 0101).
CREATE UNIQUE INDEX IF NOT EXISTS "claim_form_field_type_key_uq" ON "claim_form_field" USING btree ("tenant_id","claim_type_id","field_key") WHERE "archived_at" IS NULL;--> statement-breakpoint

-- ─────────────────────────── claim_request: two additive, nullable columns ───────────────────────────
--
-- mileage_rate_applied is the STAMP. `amount` was already stored so nothing recomputes; this exists so the
-- stored figure can be EXPLAINED a year later. Editing the rate table never touches it, which is what makes
-- "changing a rate never changes a claim already submitted" a property of the data rather than a promise.
ALTER TABLE "claim_request" ADD COLUMN IF NOT EXISTS "mileage_rate_applied" jsonb;--> statement-breakpoint
-- The answers to the claim type's custom fields, keyed by field_key. NULL / {} = the four built-ins only,
-- which is every claim filed before a form was designed.
ALTER TABLE "claim_request" ADD COLUMN IF NOT EXISTS "field_values" jsonb;--> statement-breakpoint

-- ─────────────────────────── GRANTS + RLS ───────────────────────────
--
-- Explicit GRANTs: production's ALTER DEFAULT PRIVILEGES masks an omission and a developer cluster does not,
-- so the first real render is where it would surface (0399 / 0400 / 0396 say the same).
--
-- Both tables are tenant-isolated CATALOGS — every member READS (the employee claim form has to resolve the
-- rate table and render the custom fields), only an admin WRITES. Byte-identical to claim_item (0101) and
-- claim_type / claim_policy (0048). No new policy for the claim_request columns: claim_request_rls (0048)
-- already covers the row they sit on.
GRANT SELECT, INSERT, UPDATE, DELETE ON "claim_mileage_rate" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "claim_mileage_rate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "claim_mileage_rate";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "claim_mileage_rate" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "claim_form_field" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "claim_form_field" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "claim_form_field";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "claim_form_field" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
