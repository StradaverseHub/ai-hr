-- HR-Admin Dashboard Card Master (feedback 1586d2f5) — a tenant-scoped catalog of the dashboard cards HR
-- can maintain: which cards exist, their type/status, whether employees may add them, whether they show by
-- default, whether they are mandatory (non-removable), and their display order. This is the MASTER only; the
-- employee dashboard customizer (feedback 578a2fcf) reads from it. card_key is a STABLE id binding a row to
-- the concrete renderer (the R39 block/card set). Additive + backward compatible: with no rows the current
-- hardcoded dashboard is unchanged.
--
-- RLS: readable tenant-wide (a member can resolve the catalog); writable only by an admin. Tenant-level config
-- (no company scope) — mirrors ai_provider_config's admin-write / tenant-read split.
CREATE TABLE IF NOT EXISTS "dashboard_card_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"card_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"card_type" text DEFAULT 'information' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"employee_selectable" boolean DEFAULT true NOT NULL,
	"default_display" boolean DEFAULT false NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_card_config_tenant_id_tenant_id_fk') THEN
		ALTER TABLE "dashboard_card_config" ADD CONSTRAINT "dashboard_card_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- One row per (tenant, card_key): card_key is the stable renderer binding, unique within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_card_config_tenant_key_uq" ON "dashboard_card_config" USING btree ("tenant_id","card_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_card_config_tenant_status_idx" ON "dashboard_card_config" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "dashboard_card_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboard_card_config" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_card_config_rls ON "dashboard_card_config";--> statement-breakpoint
CREATE POLICY dashboard_card_config_rls ON "dashboard_card_config" FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
-- Seed the existing R39 dashboard block/card set as default rows for every existing tenant, each as its own
-- card_key so the employee customizer (578a2fcf) can flatten to individually-selectable cards. Idempotent via
-- the (tenant_id, card_key) unique index. All currently render by default → default_display true; none is
-- mandatory yet (employees keep the current reorder freedom). Ordered to match lib/dashboard-layout DEFAULT_ORDER
-- (the three employee summary cards first, then the reorderable section blocks).
INSERT INTO "dashboard_card_config" ("tenant_id","card_key","name","description","card_type","status","employee_selectable","default_display","mandatory","display_order","href")
SELECT t.id, v.card_key, v.name, v.description, v.card_type, 'active', true, true, false, v.display_order, v.href
FROM "tenant" t
CROSS JOIN (VALUES
	('leaveBalance',    'Leave Balance',    'Your current leave balance at a glance.',              'information', 1, '/leave'),
	('nextHoliday',     'Upcoming Holidays','The next public holiday for your company.',            'information', 2, '#upcoming-events'),
	('pendingTasks',    'Pending Tasks',    'Self-service items that need your attention.',         'action',      3, '/me'),
	('plannedAbsences', 'Leave Calendar',   'Who is away, on a rolling timeline.',                  'information', 4, NULL),
	('recentlyJoined',  'Recently Joined',  'Colleagues who joined recently.',                      'information', 5, NULL),
	('upcomingEvents',  'Upcoming Events',  'Upcoming public holidays and company events.',         'information', 6, NULL),
	('recentActivity',  'Recent Activity',  'A feed of recent activity relevant to you.',           'information', 7, NULL)
) AS v(card_key, name, description, card_type, display_order, href)
ON CONFLICT (tenant_id, card_key) DO NOTHING;
