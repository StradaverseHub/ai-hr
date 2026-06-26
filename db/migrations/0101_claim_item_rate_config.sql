-- Claim Submission Form enhancement (ADR-0021 follow-up): dependent Claim Item sub-category, per-type
-- rate/calculation config on the effective-dated policy, and mileage distance on the request.
--
-- Single file (per the 0090 precedent — table DDL + RLS co-located, one wrapping transaction). All columns
-- are additive + nullable, so a tenant with no items / no rate config behaves exactly as before:
--   • claim_item: a new, tenant-isolated CATALOG table (admin-write, member-read — mirrors claim_type).
--   • claim_policy.rate_config: nullable jsonb discriminated union (absent ⇒ receipt-driven, current behaviour).
--   • claim_request.claim_item_id (nullable FK) + quantity_km (nullable; km for mileage_flat only).

CREATE TABLE "claim_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_item" ADD CONSTRAINT "claim_item_claim_type_id_claim_type_fk" FOREIGN KEY ("claim_type_id") REFERENCES "public"."claim_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_item_type_idx" ON "claim_item" USING btree ("claim_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_item_type_code_uq" ON "claim_item" USING btree ("tenant_id","claim_type_id","code") WHERE "archived_at" IS NULL;--> statement-breakpoint

ALTER TABLE "claim_policy" ADD COLUMN "rate_config" jsonb;--> statement-breakpoint
ALTER TABLE "claim_request" ADD COLUMN "claim_item_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_request" ADD COLUMN "quantity_km" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_claim_item_id_claim_item_fk" FOREIGN KEY ("claim_item_id") REFERENCES "public"."claim_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- RLS: claim_item is a tenant-isolated CATALOG — every member reads, only an admin writes. Mirrors
-- claim_type / claim_policy (0048). No new policy for the claim_request columns — claim_request_rls (0048)
-- already covers the row. DELETE is granted for parity with 0048 though items are soft-deleted (archived_at).
ALTER TABLE claim_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_item TO ai_hr_app;--> statement-breakpoint
CREATE POLICY tenant_isolation ON claim_item FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
