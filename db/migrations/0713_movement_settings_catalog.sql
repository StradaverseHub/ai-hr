-- 1d58019a — "Movement Settings Enhancement", Step 1 (ADR-0165).
--
-- TWO ADDITIVE CHANGES. Nothing is backfilled, nothing is dropped, and no existing behaviour changes until a
-- tenant edits something on the Movement Settings screens.
--
-- ── 1. movement_event_type.description ──────────────────────────────────────────────────────────────
-- An optional note per event type, shown to HR under the event type on the New Event form. Nullable, so
-- every existing overlay row (and every built-in with no overlay row at all) simply has no description.
-- The only writer is core/movement-type.ts upsertTx, which trims and length-checks before this CHECK sees
-- it; the CHECK is the backstop, and it holds for every existing row because they are all NULL.
--
-- ── 2. termination_reason — the tenant overlay on the built-in exit-reason list ─────────────────────
-- The thirteen reasons in core/termination-reason.ts stay the STARTING list, exactly as movement_event_type
-- is an overlay on MOVEMENT_KINDS (0340): a tenant with no rows behaves exactly as before. A row either
-- renames / switches off a built-in reason (code = the built-in code) or adds one of the tenant's own.
--
-- `category` is one of the three FIXED groups. There is deliberately no stored termination_type: the
-- turnover classification has ONE owner, derived in code — a built-in reason keeps its shipped mapping
-- (retirement → retired, contract_expiry → contract_end, death → death), and a custom reason derives it
-- from its group (voluntary / involuntary / other). A stored copy beside the group could disagree with it.
-- For a built-in override the stored category is informational; the code constant wins on read.
--
-- employment.termination_reason_code stays plain TEXT (0338) and is NOT a foreign key: history keeps the
-- code it recorded whatever happens to this table, and deletion of a referenced code is refused by the
-- service (the reference also lives inside domain_event jsonb, which no constraint can see).
--
-- RLS: every member of the tenant may READ (the New Event form and the termination writer resolve reasons
-- for whoever records the movement); only an admin may INSERT, UPDATE or DELETE. Unlike 0340's single
-- FOR ALL policy, DELETE is admin-gated too — a USING-only tenant check would let any member delete.
-- New tables never inherit grants (ADR-0002), so ai_hr_app is granted explicitly.

ALTER TABLE "movement_event_type" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "movement_event_type" ADD CONSTRAINT "movement_event_type_description_len"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000);--> statement-breakpoint
COMMENT ON COLUMN "movement_event_type"."description" IS
  '1d58019a — optional note shown under the event type on the New Event form. NULL = no description. Written only by core/movement-type.ts.';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "termination_reason" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"category" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "termination_reason_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "termination_reason_category_check" CHECK ("category" IN ('voluntary', 'involuntary', 'other')),
	CONSTRAINT "termination_reason_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "termination_reason_label_check" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "termination_reason_tenant_idx" ON "termination_reason" USING btree ("tenant_id");--> statement-breakpoint
-- One row per (tenant, code): the overlay key. Built-in overrides and custom reasons share the namespace,
-- so a custom reason can never shadow a built-in code.
CREATE UNIQUE INDEX IF NOT EXISTS "termination_reason_tenant_code_uq" ON "termination_reason" USING btree ("tenant_id","code");--> statement-breakpoint

REVOKE ALL ON "termination_reason" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "termination_reason" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "termination_reason" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "termination_reason" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "termination_reason_read" ON "termination_reason" FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY "termination_reason_insert" ON "termination_reason" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY "termination_reason_update" ON "termination_reason" FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY "termination_reason_delete" ON "termination_reason" FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

COMMENT ON TABLE "termination_reason" IS
  '1d58019a — tenant overlay on the built-in exit reasons (core/termination-reason.ts). Rename/switch off a built-in, or add a custom reason in one of three fixed groups. Turnover classification is derived in code, never stored. ADR-0165.';--> statement-breakpoint
COMMENT ON COLUMN "termination_reason"."label" IS
  '1d58019a — display text. NULL on a built-in override means "use the shipped six-locale translation".';
