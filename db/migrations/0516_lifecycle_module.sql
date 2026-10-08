-- ADR-0095 — the Lifecycle module: employee ONBOARDING / OFFBOARDING cases, IT requisitions, the asset
-- register and asset requests (CHGB handover, 2026-10-07). NOT the first-login product tour (ADR-0018).
--
-- Module staff are their own table (lc_staff): the handover's Agent / Manager roles are not line managers.
-- Any `manager` role-holder approving IT spend would be an authorization hole, so the module owns who may
-- work, approve and fulfil. hr_admin / super_admin (app.is_admin_for) are always staff at level 3.
--
-- Every table is tenant-scoped and company-scoped (the handover's "business group" IS a company here).
-- Grants are EXPLICIT per table: a dev restore has no default privileges and the suite connects as owner.

-- ── level helper: 0 none · 1 agent · 2 manager · 3 admin ──────────────────────────────────────────────
CREATE TABLE lc_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  -- NULL = every company in the tenant.
  company_id uuid REFERENCES company(id),
  level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_staff_level_ck CHECK (level IN ('agent', 'manager'))
);--> statement-breakpoint
CREATE UNIQUE INDEX lc_staff_uq ON lc_staff (tenant_id, user_id, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE lc_staff ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_staff_read ON lc_staff FOR SELECT USING (
  tenant_id = app.current_tenant_id() AND (app.is_admin() OR user_id = app.current_user_id()));--> statement-breakpoint
CREATE POLICY lc_staff_write ON lc_staff FOR ALL USING (
  tenant_id = app.current_tenant_id()
  AND ((company_id IS NULL AND app.is_group_admin()) OR (company_id IS NOT NULL AND app.is_admin_for(company_id)))
) WITH CHECK (
  tenant_id = app.current_tenant_id()
  AND ((company_id IS NULL AND app.is_group_admin()) OR (company_id IS NOT NULL AND app.is_admin_for(company_id))));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lc_staff TO ai_hr_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.lc_level(p_company uuid) RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT greatest(
    CASE WHEN p_company IS NULL THEN (CASE WHEN app.is_admin() THEN 3 ELSE 0 END)
         ELSE (CASE WHEN app.is_admin_for(p_company) THEN 3 ELSE 0 END) END,
    coalesce((
      SELECT max(CASE s.level WHEN 'manager' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END)
      FROM lc_staff s
      WHERE s.tenant_id = app.current_tenant_id() AND s.user_id = app.current_user_id()
        AND (p_company IS NULL OR s.company_id IS NULL OR s.company_id = p_company)
    ), 0));
$$;--> statement-breakpoint

-- Who can be named as a handler / assignee. A manager cannot read lc_staff (RLS: admins and the row's own
-- user only), so the directory is a SECURITY DEFINER read, tenant-bound and gated on the caller being staff.
-- Admins (hr_admin / super_admin for the company or group-wide) are staff at level 3 and are included.
CREATE OR REPLACE FUNCTION app.lc_staff_directory(p_company uuid)
  RETURNS TABLE (user_id uuid, full_name text, level text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.user_id, p.full_name, x.level FROM (
    SELECT s.user_id, s.level FROM lc_staff s
     WHERE s.tenant_id = app.current_tenant_id() AND (s.company_id IS NULL OR s.company_id = p_company)
    UNION
    SELECT ra.app_user_id, 'admin' FROM role_assignment ra
     WHERE ra.tenant_id = app.current_tenant_id() AND ra.role IN ('hr_admin', 'super_admin')
       AND (ra.company_id IS NULL OR ra.company_id = p_company)
  ) x
  JOIN app_user u ON u.id = x.user_id AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL
  LEFT JOIN person p ON p.id = u.person_id
  WHERE app.lc_level(p_company) >= 1
  ORDER BY p.full_name, x.user_id;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_staff_directory(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_staff_directory(uuid) TO ai_hr_app;--> statement-breakpoint

-- ── numbering: ONB- OFB- ITR- AR- and per BG-TYPE asset codes. SECURITY DEFINER so a plain employee
--    raising an asset request can take a number without any write grant on the counter. Tenant-bound. ──
CREATE TABLE lc_counter (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  prefix text NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, prefix)
);--> statement-breakpoint
ALTER TABLE lc_counter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_next_number(p_prefix text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'lc_next_number: no session';
  END IF;
  INSERT INTO lc_counter (tenant_id, prefix, last_value) VALUES (app.current_tenant_id(), p_prefix, 1)
  ON CONFLICT (tenant_id, prefix) DO UPDATE SET last_value = lc_counter.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_next_number(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_next_number(text) TO ai_hr_app;--> statement-breakpoint

-- ── configuration (Module Config) ─────────────────────────────────────────────────────────────────────
-- Onboarding / offboarding step definitions. company_id NULL = all companies. Defaults are seeded lazily
-- by the service (SQL cannot read the TypeScript defaults); an admin edit overrides them.
CREATE TABLE lc_step_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  company_id uuid REFERENCES company(id),
  step_key text NOT NULL,
  phase integer NOT NULL,
  label text NOT NULL,
  owner_team text NOT NULL DEFAULT '',
  hrms boolean NOT NULL DEFAULT false,
  -- always | carpark | laptop | outcome_accepted | outcome_rejected  (when the step applies)
  rule text NOT NULL DEFAULT 'always',
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT lc_step_def_kind_ck CHECK (kind IN ('onboarding', 'offboarding')),
  CONSTRAINT lc_step_def_rule_ck CHECK (rule IN ('always', 'carpark', 'laptop', 'outcome_accepted', 'outcome_rejected'))
);--> statement-breakpoint
CREATE UNIQUE INDEX lc_step_def_uq ON lc_step_def (tenant_id, kind, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), step_key);--> statement-breakpoint

-- IT requisition / return checklist definitions: company NULL = common to every company.
CREATE TABLE it_provision_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  company_id uuid REFERENCES company(id),
  item_key text NOT NULL,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT it_provision_def_kind_ck CHECK (kind IN ('requisition', 'return'))
);--> statement-breakpoint
CREATE UNIQUE INDEX it_provision_def_uq ON it_provision_def (tenant_id, kind, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), item_key);--> statement-breakpoint

-- Admin-defined extra staff-only fields on cases (max 40 per kind, enforced in the service).
CREATE TABLE lc_custom_field (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text',
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- empty = every company; otherwise only these companies
  company_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT lc_custom_field_kind_ck CHECK (kind IN ('onboarding', 'offboarding')),
  CONSTRAINT lc_custom_field_type_ck CHECK (field_type IN ('text', 'longtext', 'number', 'date', 'yesno', 'choice'))
);--> statement-breakpoint
CREATE UNIQUE INDEX lc_custom_field_uq ON lc_custom_field (tenant_id, kind, field_key);--> statement-breakpoint

-- Per-company module settings: IT approval levels (0, 1 or 2) and the access systems offered.
CREATE TABLE lc_company_config (
  company_id uuid PRIMARY KEY REFERENCES company(id),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  approval_levels integer NOT NULL DEFAULT 1,
  access_systems jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT lc_company_config_levels_ck CHECK (approval_levels IN (0, 1, 2))
);--> statement-breakpoint

-- ── onboarding / offboarding cases ────────────────────────────────────────────────────────────────────
CREATE TABLE lc_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  number text NOT NULL,
  company_id uuid NOT NULL REFERENCES company(id),
  status text NOT NULL DEFAULT 'in_progress',
  full_name text NOT NULL,
  employee_no text NOT NULL,
  job_title text,
  department text,
  supervisor text,
  gbs_ta text,
  -- onboarding
  join_date date,
  hire_type text NOT NULL DEFAULT 'new_hire',
  replaced_person text,
  laptop_required boolean NOT NULL DEFAULT true,
  device_type text,
  carpark_required boolean NOT NULL DEFAULT false,
  floor_building text,
  access_systems jsonb NOT NULL DEFAULT '[]'::jsonb,
  email_required boolean NOT NULL DEFAULT true,
  -- STAFF-ONLY sensitive fields: never in the new-hire view, never in an email, masked in exports.
  cost_centre text,
  nric_passport text,
  newhire_email text,
  it_owner_user_id uuid REFERENCES app_user(id),
  -- offboarding
  resignation_date date,
  last_working_day date,
  outcome text NOT NULL DEFAULT 'pending',
  outcome_set_by uuid,
  outcome_set_at timestamptz,
  work_location text,
  device_returned_date date,
  device_name text,
  balance_leave numeric(6,2),
  redeployed_to text,
  notes text,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional links into the identity graph: the new hire has no employment until HR creates it.
  person_id uuid REFERENCES person(id),
  employment_id uuid REFERENCES employment(id),
  -- Device Acceptance Acknowledgement: submitted by the new hire from their own signed-in checklist view
  -- (no public link, so the app's unauthenticated perimeter does not widen).
  daa_submitted_at timestamptz,
  daa jsonb,
  cancel_reason text,
  completed_at timestamptz,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_case_kind_ck CHECK (kind IN ('onboarding', 'offboarding')),
  CONSTRAINT lc_case_status_ck CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  CONSTRAINT lc_case_outcome_ck CHECK (outcome IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT lc_case_hire_type_ck CHECK (hire_type IN ('new_hire', 'replacement'))
);--> statement-breakpoint
CREATE UNIQUE INDEX lc_case_number_uq ON lc_case (tenant_id, number);--> statement-breakpoint
-- One ACTIVE case per employee number and per new-hire email, per kind. Enforced here AND in the service
-- (which reports it readably); this is the backstop for two staff submitting at once.
CREATE UNIQUE INDEX lc_case_active_empno_uq ON lc_case (tenant_id, kind, lower(employee_no)) WHERE status = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX lc_case_active_email_uq ON lc_case (tenant_id, kind, lower(newhire_email)) WHERE status = 'in_progress' AND newhire_email IS NOT NULL;--> statement-breakpoint
CREATE INDEX lc_case_list_idx ON lc_case (tenant_id, kind, status, created_at);--> statement-breakpoint

CREATE TABLE lc_case_step (
  case_id uuid NOT NULL REFERENCES lc_case(id),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  step_key text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_by uuid REFERENCES app_user(id),
  done_at timestamptz,
  reference text,
  notes text,
  PRIMARY KEY (case_id, step_key)
);--> statement-breakpoint

-- Case timeline for onboarding / offboarding / requisition (ref_type). The domain_event ledger carries the
-- audit; this is the readable timeline, written in the same transaction as the change.
CREATE TABLE lc_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  actor_name text,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_history_ref_ck CHECK (ref_type IN ('case', 'requisition', 'asset', 'asset_request'))
);--> statement-breakpoint
CREATE INDEX lc_history_ref_idx ON lc_history (tenant_id, ref_type, ref_id, at);--> statement-breakpoint

CREATE TABLE lc_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  case_id uuid NOT NULL REFERENCES lc_case(id),
  author_user_id uuid REFERENCES app_user(id),
  author_name text,
  body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ── IT requisitions ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE it_requisition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number text NOT NULL,
  kind text NOT NULL,
  company_id uuid NOT NULL REFERENCES company(id),
  case_id uuid REFERENCES lc_case(id),
  status text NOT NULL DEFAULT 'open',
  full_name text NOT NULL,
  employee_no text NOT NULL,
  job_title text,
  department text,
  cost_centre text,
  work_location text,
  contact text,
  username text,
  laptop_required boolean NOT NULL DEFAULT true,
  device_type text,
  accessories text,
  access_systems jsonb NOT NULL DEFAULT '[]'::jsonb,
  floor_building text,
  email_status text,
  ad_status text,
  assigned_to_user_id uuid REFERENCES app_user(id),
  notes text,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  return_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_levels integer NOT NULL DEFAULT 1,
  approval_status text NOT NULL DEFAULT 'pending',
  l1_by uuid, l1_at timestamptz, l1_action text,
  l2_by uuid, l2_at timestamptz, l2_action text,
  approval_notes text,
  cancel_reason text,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT it_requisition_kind_ck CHECK (kind IN ('requisition', 'return', 'standalone')),
  CONSTRAINT it_requisition_status_ck CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT it_requisition_approval_ck CHECK (approval_status IN ('pending', 'pending_l2', 'approved', 'rejected'))
);--> statement-breakpoint
CREATE UNIQUE INDEX it_requisition_number_uq ON it_requisition (tenant_id, number);--> statement-breakpoint
-- One OPEN return per offboarding case.
CREATE UNIQUE INDEX it_requisition_open_return_uq ON it_requisition (case_id) WHERE kind = 'return' AND status <> 'cancelled' AND case_id IS NOT NULL;--> statement-breakpoint
-- One requisition per onboarding case.
CREATE UNIQUE INDEX it_requisition_case_req_uq ON it_requisition (case_id) WHERE kind = 'requisition' AND status <> 'cancelled' AND case_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE it_requisition_item (
  requisition_id uuid NOT NULL REFERENCES it_requisition(id),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_key text NOT NULL,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  done_by uuid REFERENCES app_user(id),
  done_at timestamptz,
  note text,
  PRIMARY KEY (requisition_id, item_key),
  CONSTRAINT it_requisition_item_status_ck CHECK (status IN ('pending', 'done', 'na'))
);--> statement-breakpoint

-- ── asset register ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE it_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  asset_tag text,
  company_id uuid NOT NULL REFERENCES company(id),
  asset_type text NOT NULL,
  status text NOT NULL DEFAULT 'in_stock',
  manufacturer text, model text, serial_no text, hostname text, os text, cpu text, ram text, storage text,
  leased boolean NOT NULL DEFAULT false,
  lease_end date,
  purchase_date date,
  purchase_cost numeric(12,2),
  warranty_end date,
  licence jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_name text,
  user_employee_no text,
  user_department text,
  user_email text,
  issued_on date,
  location text,
  requisition_id uuid REFERENCES it_requisition(id),
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT it_asset_type_ck CHECK (asset_type IN ('laptop','desktop','tablet','monitor','printer','mobile','peripheral','other')),
  CONSTRAINT it_asset_status_ck CHECK (status IN ('in_stock','issued','returned','under_repair','retired','written_off'))
);--> statement-breakpoint
CREATE UNIQUE INDEX it_asset_code_uq ON it_asset (tenant_id, code);--> statement-breakpoint
CREATE INDEX it_asset_holder_idx ON it_asset (tenant_id, lower(user_employee_no)) WHERE status = 'issued';--> statement-breakpoint

-- ── asset requests ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE it_asset_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_code text NOT NULL,
  item_name text NOT NULL,
  category text NOT NULL,
  description text,
  approval_levels integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT it_asset_catalogue_cat_ck CHECK (category IN ('hardware', 'software')),
  CONSTRAINT it_asset_catalogue_levels_ck CHECK (approval_levels IN (1, 2))
);--> statement-breakpoint
CREATE UNIQUE INDEX it_asset_catalogue_uq ON it_asset_catalogue (tenant_id, item_code);--> statement-breakpoint

CREATE TABLE it_asset_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number text NOT NULL,
  catalogue_id uuid NOT NULL REFERENCES it_asset_catalogue(id),
  company_id uuid NOT NULL REFERENCES company(id),
  requester_user_id uuid NOT NULL REFERENCES app_user(id),
  full_name text NOT NULL,
  employee_no text,
  department text,
  job_title text,
  justification text,
  quantity integer NOT NULL DEFAULT 1,
  preferred_date date,
  handler_user_id uuid REFERENCES app_user(id),
  status text NOT NULL DEFAULT 'requested',
  approval_levels integer NOT NULL DEFAULT 1,
  l1_by uuid, l1_at timestamptz, l1_action text,
  l2_by uuid, l2_at timestamptz, l2_action text,
  approval_notes text,
  asset_id uuid REFERENCES it_asset(id),
  notes text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT it_asset_request_status_ck CHECK (status IN
    ('requested','pending_approval','approved','procured','tagged','assigned','completed','rejected','cancelled')),
  CONSTRAINT it_asset_request_qty_ck CHECK (quantity BETWEEN 1 AND 999)
);--> statement-breakpoint
CREATE UNIQUE INDEX it_asset_request_number_uq ON it_asset_request (tenant_id, number);--> statement-breakpoint
CREATE INDEX it_asset_request_requester_idx ON it_asset_request (tenant_id, requester_user_id);--> statement-breakpoint

-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────────
-- Config tables: staff may read, admins write.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lc_step_def','it_provision_def','lc_custom_field'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 1)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 3) WITH CHECK (tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 3)', t || '_write', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ai_hr_app', t);
  END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE lc_company_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_company_config_read ON lc_company_config FOR SELECT USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1);--> statement-breakpoint
CREATE POLICY lc_company_config_write ON lc_company_config FOR ALL USING (
  tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id)
) WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lc_company_config TO ai_hr_app;--> statement-breakpoint

-- Cases and requisitions: any staff of the company reads and writes; finer rules (undo, cancel, approve)
-- are the service's, because RLS here is the coarse company wall.
ALTER TABLE lc_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_case_staff ON lc_case FOR ALL USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1
) WITH CHECK (tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON lc_case TO ai_hr_app;--> statement-breakpoint

ALTER TABLE lc_case_step ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_case_step_staff ON lc_case_step FOR ALL USING (
  tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM lc_case c WHERE c.id = case_id AND c.tenant_id = lc_case_step.tenant_id AND app.lc_level(c.company_id) >= 1)
) WITH CHECK (tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM lc_case c WHERE c.id = case_id AND c.tenant_id = lc_case_step.tenant_id AND app.lc_level(c.company_id) >= 1));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON lc_case_step TO ai_hr_app;--> statement-breakpoint

ALTER TABLE lc_comment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_comment_staff ON lc_comment FOR ALL USING (
  tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM lc_case c WHERE c.id = case_id AND c.tenant_id = lc_comment.tenant_id AND app.lc_level(c.company_id) >= 1)
) WITH CHECK (tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM lc_case c WHERE c.id = case_id AND c.tenant_id = lc_comment.tenant_id AND app.lc_level(c.company_id) >= 1));--> statement-breakpoint
GRANT SELECT, INSERT ON lc_comment TO ai_hr_app;--> statement-breakpoint

ALTER TABLE it_requisition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY it_requisition_staff ON it_requisition FOR ALL USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1
) WITH CHECK (tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON it_requisition TO ai_hr_app;--> statement-breakpoint

ALTER TABLE it_requisition_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY it_requisition_item_staff ON it_requisition_item FOR ALL USING (
  tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM it_requisition r WHERE r.id = requisition_id AND r.tenant_id = it_requisition_item.tenant_id AND app.lc_level(r.company_id) >= 1)
) WITH CHECK (tenant_id = app.current_tenant_id()
  AND EXISTS (SELECT 1 FROM it_requisition r WHERE r.id = requisition_id AND r.tenant_id = it_requisition_item.tenant_id AND app.lc_level(r.company_id) >= 1));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON it_requisition_item TO ai_hr_app;--> statement-breakpoint

ALTER TABLE it_asset ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY it_asset_staff ON it_asset FOR ALL USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1
) WITH CHECK (tenant_id = app.current_tenant_id() AND app.lc_level(company_id) >= 1);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON it_asset TO ai_hr_app;--> statement-breakpoint

-- Timeline: readable by staff of the record's company. Insert-only (a history that can be edited is not one).
ALTER TABLE lc_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lc_history_read ON lc_history FOR SELECT USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 1);--> statement-breakpoint
CREATE POLICY lc_history_insert ON lc_history FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint
GRANT SELECT, INSERT ON lc_history TO ai_hr_app;--> statement-breakpoint

-- Catalogue: every signed-in user of the tenant reads the ACTIVE items; managers and admins maintain it.
ALTER TABLE it_asset_catalogue ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY it_asset_catalogue_read ON it_asset_catalogue FOR SELECT USING (
  tenant_id = app.current_tenant_id() AND (active OR app.lc_level(NULL) >= 2));--> statement-breakpoint
CREATE POLICY it_asset_catalogue_write ON it_asset_catalogue FOR ALL USING (
  tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 2
) WITH CHECK (tenant_id = app.current_tenant_id() AND app.lc_level(NULL) >= 2);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON it_asset_catalogue TO ai_hr_app;--> statement-breakpoint

-- Asset requests: a requester sees and cancels only their own; managers and admins see and work all.
ALTER TABLE it_asset_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY it_asset_request_read ON it_asset_request FOR SELECT USING (
  tenant_id = app.current_tenant_id()
  AND (requester_user_id = app.current_user_id() OR app.lc_level(company_id) >= 2));--> statement-breakpoint
CREATE POLICY it_asset_request_insert ON it_asset_request FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant_id()
  AND (requester_user_id = app.current_user_id() OR app.lc_level(company_id) >= 2));--> statement-breakpoint
CREATE POLICY it_asset_request_update ON it_asset_request FOR UPDATE USING (
  tenant_id = app.current_tenant_id()
  AND (requester_user_id = app.current_user_id() OR app.lc_level(company_id) >= 2)
) WITH CHECK (tenant_id = app.current_tenant_id()
  AND (requester_user_id = app.current_user_id() OR app.lc_level(company_id) >= 2));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON it_asset_request TO ai_hr_app;--> statement-breakpoint

-- ── new-hire self-service (login-gated) ───────────────────────────────────────────────────────────────
-- A new hire is not module staff, so RLS shows them nothing in lc_case. These two SECURITY DEFINER
-- functions are the ONLY door, tenant-bound, and the match is the signed-in user's own person email against
-- the case's new-hire email (case-insensitive). The first returns a FIXED allowlist of fields: never the
-- identity number, bank details, cost centre, temporary passwords, notes or custom fields.
CREATE OR REPLACE FUNCTION app.lc_my_case_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id FROM lc_case c
   JOIN app_user u ON u.id = app.current_user_id() AND u.tenant_id = c.tenant_id
   JOIN person p ON p.id = u.person_id AND p.tenant_id = c.tenant_id
  WHERE c.tenant_id = app.current_tenant_id() AND c.kind = 'onboarding' AND c.status <> 'cancelled'
    AND c.newhire_email IS NOT NULL AND lower(c.newhire_email) = lower(p.primary_email)
  ORDER BY c.created_at DESC LIMIT 1;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_my_view() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'case', jsonb_build_object(
      'number', c.number, 'status', c.status, 'fullName', c.full_name, 'jobTitle', c.job_title, 'department', c.department,
      'companyId', c.company_id, 'companyName', co.legal_name, 'joinDate', c.join_date, 'supervisor', c.supervisor, 'gbsTa', c.gbs_ta,
      'floorBuilding', c.floor_building, 'laptopRequired', c.laptop_required, 'carparkRequired', c.carpark_required,
      'employeeNo', c.employee_no, 'daaSubmittedAt', c.daa_submitted_at),
    'done', coalesce((SELECT jsonb_agg(s.step_key) FROM lc_case_step s WHERE s.case_id = c.id AND s.done), '[]'::jsonb),
    'defs', coalesce((SELECT jsonb_agg(jsonb_build_object('key', d.step_key, 'phase', d.phase, 'label', d.label,
              'ownerTeam', d.owner_team, 'rule', d.rule, 'sort', d.sort, 'active', d.active) ORDER BY d.phase, d.sort)
            FROM lc_step_def d WHERE d.tenant_id = c.tenant_id AND d.kind = 'onboarding'), '[]'::jsonb))
  FROM lc_case c JOIN company co ON co.id = c.company_id
  WHERE c.id = app.lc_my_case_id();
$$;--> statement-breakpoint
-- The new hire's one write: the Device Acceptance Acknowledgement. Refused unless a laptop is required, the
-- laptop was marked distributed, the case is in progress and nothing was submitted before. It ticks the
-- acknowledgement step (the new hire's own action, so the phase lock does not apply) and writes the
-- timeline row; the caller appends the audit event in the same transaction.
CREATE OR REPLACE FUNCTION app.lc_my_daa_submit(p_data jsonb) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_name text;
BEGIN
  v_id := app.lc_my_case_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'No onboarding case is linked to your account.' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM lc_case WHERE id = v_id AND status = 'in_progress' AND laptop_required AND daa_submitted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The acknowledgement is not available for this case.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM lc_case_step WHERE case_id = v_id AND step_key = 'laptop_dist' AND done;
  IF NOT FOUND THEN RAISE EXCEPTION 'Your laptop has not been marked as handed over yet.' USING ERRCODE = 'P0001'; END IF;
  UPDATE lc_case SET daa = p_data, daa_submitted_at = now() WHERE id = v_id;
  INSERT INTO lc_case_step (case_id, tenant_id, step_key, done, done_by, done_at)
    VALUES (v_id, app.current_tenant_id(), 'daa_ack', true, app.current_user_id(), now())
    ON CONFLICT (case_id, step_key) DO UPDATE SET done = true, done_by = app.current_user_id(), done_at = now();
  SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id = u.person_id WHERE u.id = app.current_user_id();
  INSERT INTO lc_history (tenant_id, ref_type, ref_id, action, detail, actor_user_id, actor_name)
    VALUES (app.current_tenant_id(), 'case', v_id, 'daa.submitted', '{}'::jsonb, app.current_user_id(), v_name);
  RETURN v_id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_my_case_id() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_my_view() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_my_daa_submit(jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_my_case_id() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_my_view() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_my_daa_submit(jsonb) TO ai_hr_app;
