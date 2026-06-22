-- ADR-0034 slice 34-1: notification engine. Gated (NOTIFICATIONS_ENABLED) — additive, nothing reads it yet.
-- notification + notification_pref are recipient-only (RLS via app.is_self_person); notification_delivery +
-- notification_cursor are dispatcher-internal (app.is_admin). Explicit ai_hr_app grants.

CREATE TYPE "notification_severity" AS ENUM('info', 'action', 'warning');--> statement-breakpoint
CREATE TYPE "notification_channel" AS ENUM('in_app', 'email', 'whatsapp', 'push');--> statement-breakpoint
CREATE TYPE "notification_delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint

CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_employment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_path" text,
	"severity" "notification_severity" DEFAULT 'info' NOT NULL,
	"source_event_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_pref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_employment_id" uuid NOT NULL,
	"category" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"last_event_created_at" timestamp with time zone,
	"last_event_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_employment_id_employment_id_fk" FOREIGN KEY ("recipient_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_recipient_employment_id_employment_id_fk" FOREIGN KEY ("recipient_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_cursor" ADD CONSTRAINT "notification_cursor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notification" USING btree ("tenant_id","recipient_employment_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_unread_idx" ON "notification" USING btree ("tenant_id","recipient_employment_id") WHERE "read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_pref_uq" ON "notification_pref" USING btree ("tenant_id","recipient_employment_id","category","channel");--> statement-breakpoint
CREATE INDEX "notification_delivery_pending_idx" ON "notification_delivery" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_cursor_tenant_uq" ON "notification_cursor" USING btree ("tenant_id");--> statement-breakpoint

ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Recipient sees + marks-read only their own.
CREATE POLICY "notification_recipient_rls" ON "notification" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id = recipient_employment_id AND app.is_self_person(e.person_id)))
  WITH CHECK (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id = recipient_employment_id AND app.is_self_person(e.person_id)));--> statement-breakpoint
-- The dispatch sweep (admin/system) creates notifications for any recipient; admins still cannot READ others' (no USING here).
CREATE POLICY "notification_dispatch_insert" ON "notification" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "notification_pref" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_pref_rls" ON "notification_pref" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id = recipient_employment_id AND app.is_self_person(e.person_id)))
  WITH CHECK (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id = recipient_employment_id AND app.is_self_person(e.person_id)));--> statement-breakpoint

ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_delivery_rls" ON "notification_delivery" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "notification_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_cursor_rls" ON "notification_cursor" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_pref" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_delivery" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_cursor" TO ai_hr_app;
