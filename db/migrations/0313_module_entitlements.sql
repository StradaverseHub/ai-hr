-- Slice 1 of the ADR-0077 platform program — the entitlement + settings substrate.
--
-- NO BEHAVIOUR CHANGES. Nothing reads these tables yet; slice 2 adds the resolver and slice 3 flips
-- the env gates onto it. This migration only has to be RIGHT, not active — which is why every grant
-- and policy below is asserted by test/module-entitlement-rls.test.ts rather than trusted.
--
-- THE ONE DEFECT THE CLEAN-ROOM CANNOT CATCH (F1)
-- ----------------------------------------------
-- deploy/bootstrap-db.sql:50-54 issues
--     ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
-- so EVERY table a migration creates is born fully writable by the application role. "Grant only
-- SELECT by omission" does not exist here. Worse, cleanroom-verify.sh:47-52 reproduces the same
-- ALTER DEFAULT PRIVILEGES, so the gate MASKS a missing GRANT and can never catch a missing REVOKE.
-- Every table below therefore carries an EXPLICIT REVOKE, and the RLS test asserts the resulting
-- privilege matrix by reading information_schema — the only thing that would notice a deleted line.
-- (0046 statutory_pack is the origin of this recipe; 0280 job_run and 0295 operator console copy it.)
--
-- RLS IS `ENABLE`d BUT NOT `FORCE`d, deliberately and throughout: ai_hr_owner owns these tables and
-- must keep writing them (migrations, the catalog seeder, provisioning, the test harness). FORCE
-- would bind the owner too and break all four. The boundary being defended is ai_hr_app.
--
-- POSTGRES 14 COMPATIBILITY. Local dev + the whole test/clean-room gate run 14.17; production runs
-- 16.14. `UNIQUE NULLS NOT DISTINCT` is 15+, so the nullable `company_id` grain below uses a COALESCE
-- expression index instead. Anything written for 16 would pass on the server and fail the gate.

-- ── 1. `module` — the catalog of things a customer can be entitled to ────────────────────────────
--
-- NOT tenant-scoped: one installation-wide list, seeded from packs/catalog.ts by
-- scripts/seed-catalogs.ts. The app can never write the catalog its own policies join against.
--
-- `code` is TEXT, not an enum: the 0275 widening lesson, and the value set is owned in code.
-- `parent_module` self-references because `toil` / `multi_cycle_payroll` / `typed_pay_components` are
-- BEHAVIOURS inside a parent pack's service and have no pack of their own — the catalog is not the
-- pack registry, and conflating the two is the mistake packs/catalog.ts's header exists to prevent.
CREATE TABLE module (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL,
  description   text NOT NULL DEFAULT '',
  depends_on    jsonb NOT NULL DEFAULT '[]'::jsonb,
  billable      boolean NOT NULL,
  is_core       boolean NOT NULL,
  parent_module text REFERENCES module(code),
  pack_backed   boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  CONSTRAINT module_category_check CHECK (category IN ('core', 'hr', 'payroll', 'platform')),
  -- A core module is never sold. Stated as a constraint so the two flags cannot drift apart in the
  -- seeder and quietly make Leave billable.
  CONSTRAINT module_core_not_billable_check CHECK (NOT (is_core AND billable))
);--> statement-breakpoint

ALTER TABLE module ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON module TO ai_hr_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON module FROM ai_hr_app;--> statement-breakpoint
-- USING (true): an installation-wide catalog. A tenant_id predicate would return zero rows and
-- silently disable every gate that joins against it (the 0046 lesson, verbatim).
CREATE POLICY module_read ON module FOR SELECT USING (true);--> statement-breakpoint

-- ── 2. `setting_definition` — the catalog of per-tenant behaviour values ─────────────────────────
--
-- `scope` is the column that makes "every flag lives in the database" safe. `platform` rows are
-- READABLE by the customer and writable only by Stradaverse; the rule is enforced by tenant_setting's
-- write policy below, in Postgres, so it binds any path that reaches the table rather than only the
-- screens we remembered to guard.
--
-- Deviation from the slice plan, deliberate: the plan said "GRANT SELECT on customer-visible columns
-- only". That conflates a ROW property with a COLUMN grant — `customer_visible` marks which settings
-- the customer settings screen renders, not which columns are readable. The catalog is not secret
-- (it ships in the source tree), and the slice-2 resolver needs `default_value` for every row
-- including hidden ones, so SELECT is granted on the table and the flag drives rendering.
CREATE TABLE setting_definition (
  key                text PRIMARY KEY,
  module_code        text REFERENCES module(code),
  scope              text NOT NULL,
  value_type         text NOT NULL,
  default_value      jsonb NOT NULL,
  -- Applied as a real tenant_setting row when the owning module is INSTALLED, so a purchased module
  -- arrives usable instead of inert (slice 7). NULL = nothing to apply on install.
  default_on_install jsonb,
  customer_visible   boolean NOT NULL DEFAULT true,
  description        text NOT NULL DEFAULT '',
  sort_order         integer NOT NULL DEFAULT 0,
  CONSTRAINT setting_definition_scope_check CHECK (scope IN ('tenant', 'platform')),
  CONSTRAINT setting_definition_value_type_check CHECK (value_type IN ('boolean', 'number', 'string', 'json'))
);--> statement-breakpoint

ALTER TABLE setting_definition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON setting_definition TO ai_hr_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON setting_definition FROM ai_hr_app;--> statement-breakpoint
CREATE POLICY setting_definition_read ON setting_definition FOR SELECT USING (true);--> statement-breakpoint

-- ── 3. `tenant_module` — the entitlement itself ──────────────────────────────────────────────────
--
-- READ-ONLY to the application role. A customer may SEE what they are entitled to; only the platform
-- (slice 7) and the owner-role runner (slice 5) may write it. This is F2: the house `tenant_isolation`
-- policy is scope-only FOR ALL, so riding it would have let any hr_admin grant themselves Payroll.
--
-- `company_id` NULL = tenant-wide; NON-NULL scopes the entitlement to one company, which slice 2
-- enforces per acting company. That is what makes "payroll for the MY entity only" a real boundary
-- rather than an honour-system note on an invoice.
--
-- No 'suspended' in `status`: suspension is a TENANT-level overlay (slice 9), not a per-module state.
-- Two places to switch a module off would be two places to forget.
CREATE TABLE tenant_module (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      uuid NOT NULL REFERENCES tenant(id),
  module_code                    text NOT NULL REFERENCES module(code),
  company_id                     uuid REFERENCES company(id),
  status                         text NOT NULL DEFAULT 'active',
  activated_at                   timestamptz NOT NULL DEFAULT now(),
  expires_at                     timestamptz,
  activated_by_platform_user_id  uuid,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_module_status_check CHECK (status IN ('active', 'trial', 'disabled'))
);--> statement-breakpoint

-- PG14: a PRIMARY KEY cannot contain NULLs and `UNIQUE NULLS NOT DISTINCT` is 15+, so the
-- one-row-per-(tenant, module, scope) grain is expressed as a COALESCE expression index. The all-zero
-- UUID is the tenant-wide sentinel; it is not a real company id, and company.id is
-- gen_random_uuid() so it can never collide.
CREATE UNIQUE INDEX tenant_module_grain_uq ON tenant_module (
  tenant_id, module_code, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)
);--> statement-breakpoint
CREATE INDEX tenant_module_tenant_idx ON tenant_module (tenant_id, status);--> statement-breakpoint

ALTER TABLE tenant_module ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON tenant_module FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT ON tenant_module TO ai_hr_app;--> statement-breakpoint
-- SELECT-only policy. There is deliberately no write policy at all: with INSERT/UPDATE/DELETE revoked
-- at the grant level, a write fails before RLS is consulted, and the absence of a policy means a
-- future re-grant does not silently open a hole.
CREATE POLICY tenant_module_read ON tenant_module FOR SELECT USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- Core modules get NO rows, ever. `isModuleEnabled` (slice 2) answers true for a core code straight
-- from packs/catalog.ts without touching the database, so a tenant with zero rows still has Leave and
-- ESS. This trigger is what keeps the two representations from disagreeing.
--
-- A TRIGGER, not a policy: policies do not bind the owner and are bypassed entirely by a BYPASSRLS
-- role, so the platform plane (slice 7) would sail straight through one. Triggers bind everybody.
CREATE OR REPLACE FUNCTION app.guard_tenant_module_core() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_code text := COALESCE(NEW.module_code, OLD.module_code);
  v_is_core boolean;
BEGIN
  SELECT m.is_core INTO v_is_core FROM public.module m WHERE m.code = v_code;
  IF COALESCE(v_is_core, false) THEN
    RAISE EXCEPTION 'core module % is always enabled and takes no tenant_module row', v_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER tenant_module_core_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_module
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_module_core();--> statement-breakpoint

-- ── 4. `tenant_setting` — the per-tenant value ───────────────────────────────────────────────────
--
-- THE SCOPE JOIN IN `WITH CHECK` IS THE LOAD-BEARING LINE OF THIS MIGRATION. It is what lets every
-- deployment-wide flag move into the database — the product requirement — while a customer still
-- cannot switch off their own audit chain. Expressed in Postgres, not in a server action, so it holds
-- for any path that reaches the table.
--
-- An UNKNOWN key fails closed: the EXISTS finds no definition row, so the WITH CHECK is false and the
-- write is refused. A typo cannot create a setting.
CREATE TABLE tenant_setting (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  key        text NOT NULL REFERENCES setting_definition(key),
  value      jsonb NOT NULL,
  source     text NOT NULL DEFAULT 'customer',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_setting_source_check CHECK (source IN ('default', 'customer', 'platform')),
  PRIMARY KEY (tenant_id, key)
);--> statement-breakpoint

ALTER TABLE tenant_setting ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON tenant_setting FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_setting TO ai_hr_app;--> statement-breakpoint
-- READ: a customer sees every setting of theirs, including platform-scoped ones — visibility is not
-- the boundary, writability is. The settings screen renders platform rows read-only.
CREATE POLICY tenant_setting_read ON tenant_setting FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
-- WRITE: own tenant AND an admin AND the definition is tenant-scoped. The same predicate in USING and
-- WITH CHECK so an UPDATE can neither escape the tenant nor walk a row onto a platform-scoped key.
CREATE POLICY tenant_setting_write ON tenant_setting FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND app.is_admin()
    AND EXISTS (SELECT 1 FROM public.setting_definition d WHERE d.key = tenant_setting.key AND d.scope = 'tenant')
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.is_admin()
    AND EXISTS (SELECT 1 FROM public.setting_definition d WHERE d.key = tenant_setting.key AND d.scope = 'tenant')
  );--> statement-breakpoint

-- ── 5. `tenant` — the commercial columns ─────────────────────────────────────────────────────────
--
-- `status` drives slice 9's suspension overlay. Defaulted 'active' so every existing tenant is
-- unchanged, which is the no-op guarantee for this slice.
ALTER TABLE tenant ADD COLUMN status text NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE tenant ADD COLUMN suspended_at timestamptz;--> statement-breakpoint
ALTER TABLE tenant ADD COLUMN plan text;--> statement-breakpoint
ALTER TABLE tenant ADD COLUMN primary_contact_email text;--> statement-breakpoint
ALTER TABLE tenant ADD COLUMN notes text;--> statement-breakpoint
ALTER TABLE tenant ADD COLUMN trial_ends_at timestamptz;--> statement-breakpoint
ALTER TABLE tenant ADD CONSTRAINT tenant_status_check CHECK (status IN ('active', 'trial', 'suspended', 'closed'));--> statement-breakpoint
-- No country column on purpose: country is a per-COMPANY fact (company.country) and, from slice 6, a
-- per-company entitlement. A tenant-level country would be wrong the moment an MNC adds its second
-- jurisdiction, which is the whole point of the program.

-- ── 6. `subscription` / `subscription_line` — the commercial record ──────────────────────────────
CREATE TABLE subscription (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  plan            text NOT NULL,
  seats_purchased integer,
  period_start    date,
  period_end      date,
  status          text NOT NULL DEFAULT 'active',
  amount          numeric(14, 2),
  currency        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_status_check CHECK (status IN ('active', 'past_due', 'cancelled'))
);--> statement-breakpoint
CREATE INDEX subscription_tenant_idx ON subscription (tenant_id, status);--> statement-breakpoint

-- `module_code` is TEXT and deliberately NOT a foreign key to the catalog (D-15). A sale is recorded
-- when it is AGREED, which is routinely before the thing exists in code — "SG payroll next quarter",
-- attendance for a country whose pack has not shipped. An FK here would make the commercial system
-- unable to record the commitment that funds the engineering, and would push that record off-system
-- into a spreadsheet. The slice-5 runner cross-checks grants against these rows.
CREATE TABLE subscription_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  module_code      text NOT NULL,
  scope_note       text,
  committed_at     timestamptz NOT NULL DEFAULT now(),
  activatable_from date,
  created_at       timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX subscription_line_tenant_idx ON subscription_line (tenant_id, module_code);--> statement-breakpoint

-- `usage_snapshot` is OVER-captured on purpose (D7): the pricing unit is still open (§7.1), and a
-- point-in-time row is the only thing that lets a bill be reproduced and disputed months later.
-- Per (tenant, company, day) so any future unit — per employee, per user, per module — re-derives
-- from history instead of needing a schema change nobody can backfill.
CREATE TABLE usage_snapshot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  company_id         uuid NOT NULL REFERENCES company(id),
  captured_on        date NOT NULL,
  country            text,
  active_employments integer NOT NULL DEFAULT 0,
  active_users       integer NOT NULL DEFAULT 0,
  payslips_generated integer NOT NULL DEFAULT 0,
  modules_active     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX usage_snapshot_grain_uq ON usage_snapshot (tenant_id, company_id, captured_on);--> statement-breakpoint

ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subscription_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE usage_snapshot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON subscription FROM ai_hr_app;--> statement-breakpoint
REVOKE ALL ON subscription_line FROM ai_hr_app;--> statement-breakpoint
REVOKE ALL ON usage_snapshot FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT ON subscription TO ai_hr_app;--> statement-breakpoint
GRANT SELECT ON subscription_line TO ai_hr_app;--> statement-breakpoint
GRANT SELECT ON usage_snapshot TO ai_hr_app;--> statement-breakpoint
CREATE POLICY subscription_read ON subscription FOR SELECT USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY subscription_line_read ON subscription_line FOR SELECT USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY usage_snapshot_read ON usage_snapshot FOR SELECT USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- ── 7. `platform_user` — Stradaverse staff, invisible to every tenant ────────────────────────────
--
-- Deliberately NOT app_user: Stradaverse staff are not employees of any customer, and putting them in
-- a tenant's identity table is exactly how a support login ends up inside a customer's user list.
-- No SELECT grant at all — ai_hr_app cannot read this table's existence, let alone its rows.
CREATE TABLE platform_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT 'readonly',
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_user_role_check CHECK (role IN ('owner', 'support', 'readonly'))
);--> statement-breakpoint
ALTER TABLE platform_user ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON platform_user FROM ai_hr_app;--> statement-breakpoint
-- No policy and no grant: unreachable by the app role by construction.

-- ── 8. Operator intake carries the sale ──────────────────────────────────────────────────────────
--
-- `country` is validated against the REGISTERED pack set at intake (an interim guard; slice 6's
-- two-tier model deliberately relaxes it once a non-statutory company tier exists).
ALTER TABLE tenant_provision_request ADD COLUMN plan text;--> statement-breakpoint
ALTER TABLE tenant_provision_request ADD COLUMN country text NOT NULL DEFAULT 'MY';--> statement-breakpoint

-- The picked modules, normalised. A jsonb array would have been fewer lines and would not have let
-- the runner's FK reject an unknown code before a tenant is created.
CREATE TABLE tenant_provision_request_module (
  request_id  uuid NOT NULL REFERENCES tenant_provision_request(id) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES module(code),
  PRIMARY KEY (request_id, module_code)
);--> statement-breakpoint
ALTER TABLE tenant_provision_request_module ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON tenant_provision_request_module FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON tenant_provision_request_module TO ai_hr_app;--> statement-breakpoint
-- Operator-only, mirroring 0295's policies on the parent request table.
CREATE POLICY tenant_provision_request_module_read ON tenant_provision_request_module FOR SELECT USING (app.is_operator());--> statement-breakpoint
CREATE POLICY tenant_provision_request_module_insert ON tenant_provision_request_module FOR INSERT WITH CHECK (app.is_operator());--> statement-breakpoint

-- 0295:168-171 granted SELECT on a NAMED COLUMN LIST so activation_url stays unreadable. A column
-- grant does not extend to columns added later, so the two new intake columns must be named here or
-- listProvisionRequests starts failing with a permission error the moment it selects them.
-- activation_url remains absent, which is the point of the whole construction.
GRANT SELECT (plan, country) ON tenant_provision_request TO ai_hr_app;
