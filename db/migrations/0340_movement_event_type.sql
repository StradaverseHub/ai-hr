-- r88 · 476f23ed — "Movement Settings for configurable career events".
--
-- ONE additive table. Nothing is backfilled, nothing is dropped, and no existing behaviour changes until a
-- tenant edits something on the new screen.
--
-- ── WHY AN OVERLAY AND NOT A REPLACEMENT ──────────────────────────────────────────────────────────
-- The obvious modelling is "move MOVEMENT_KINDS into a table and seed it per tenant". That is the wrong
-- shape here, for two reasons that are specific to this module:
--   1. Employment History is a read-time PROJECTION over domain_event (core/movement.ts). The projection
--      BRANCHES on specific kinds — confirmation, resignation, probationExtension, orgAssignmentChange,
--      gradeChange — to decide a row's kind, its effective-date source and its ordering. Those branches are
--      behaviour, not data, and they cannot be moved into a table without moving the code with them.
--   2. A seeded-per-tenant catalogue has to be kept in step with the code list forever: every future kind
--      needs a migration that tops up every tenant, and a tenant whose seed failed has NO movement types at
--      all. An overlay degrades the other way — a tenant with no rows behaves exactly as it does today.
-- So this table records what a tenant DID to the built-in list: renamed a label, switched a type off, or
-- added one of their own.
--
-- ── WHY `code` IS TEXT AND NOT AN ENUM ────────────────────────────────────────────────────────────
-- A new enum value CANNOT be used in the same transaction that added it — a trap this repo has hit, and the
-- reason migration 0338 kept employment.termination_reason_code as plain text. An event-type list is
-- precisely the kind of list that grows, and adding one must be a single ordinary INSERT from a settings
-- screen, not a migration split across two deployments.
--
-- ── WHAT STAYS FIXED ──────────────────────────────────────────────────────────────────────────────
-- `behaviour_kind` is a built-in MovementKind and is what the rest of the system reasons about. A custom
-- type MAPS onto one; it never invents one. The allowed set for a custom type is restricted in
-- core/movement-type.ts (CONFIGURABLE_BEHAVIOUR_KINDS) to the comparison kinds plus the two record-only
-- kinds — never Termination, Confirmation, Resignation, Probation Extension, Blacklist or either join-date
-- correction, because each of those drives a real consequence (ending employment, completing probation,
-- moving leave entitlement). You can change what a type is CALLED; you cannot change what Termination does.
--
-- ── DELETION ──────────────────────────────────────────────────────────────────────────────────────
-- No cascade and no FK from the ledger: history is a projection, and an event's movement tag stores the
-- CODE as text. Deleting a code that any domain_event references would render those rows unlabelled, so
-- the service refuses it (a type in use can only be deactivated). That rule lives on the write path rather
-- than in a constraint because the reference is inside a jsonb payload.
--
-- RLS mirrors profile_option (0180): tenant-read for every member, admin-only write. New tables never
-- inherit grants (ADR-0002) — grant ai_hr_app explicitly.

CREATE TABLE IF NOT EXISTS "movement_event_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"behaviour_kind" text NOT NULL,
	"label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movement_event_type_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "movement_event_type_tenant_idx" ON "movement_event_type" USING btree ("tenant_id");--> statement-breakpoint
-- One row per (tenant, code): the overlay key. An override of a built-in and a custom type share the
-- namespace on purpose — a tenant cannot create a custom type that shadows a built-in kind.
CREATE UNIQUE INDEX IF NOT EXISTS "movement_event_type_tenant_code_uq" ON "movement_event_type" USING btree ("tenant_id","code");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "movement_event_type" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "movement_event_type" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "movement_event_type_rls" ON "movement_event_type" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

COMMENT ON COLUMN "movement_event_type"."code" IS
  '476f23ed — stable identity written into the ledger as the movement tag''s `type`. Equals a built-in MovementKind when this row overrides a built-in; an admin-chosen slug for a custom type. Text, never an enum, so the list can grow from a settings screen.';
COMMENT ON COLUMN "movement_event_type"."behaviour_kind" IS
  '476f23ed — the built-in MovementKind whose semantics this type carries. Rename and enable/disable are free; behaviour stays with the built-in kind. Restricted for custom types by core/movement-type.ts CONFIGURABLE_BEHAVIOUR_KINDS.';
COMMENT ON COLUMN "movement_event_type"."label" IS
  '476f23ed — display text. NULL on a built-in override means "use the shipped translation", so a tenant that only deactivated a type still follows the six-locale catalogue.';
