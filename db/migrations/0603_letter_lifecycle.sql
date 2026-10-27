-- Letters: versioned configuration and content, ordered decisions, sealed artifacts and private recipients.
-- Existing employee/employment/company and DomainEvent owners remain authoritative.
CREATE TABLE letter_verification_rate (
 scope text NOT NULL CHECK(scope='global' OR scope ~ '^[0-9a-f]{64}$'),bucket bigint NOT NULL,hits integer NOT NULL CHECK(hits>0),PRIMARY KEY(scope,bucket)
);
ALTER TABLE letter_verification_rate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON letter_verification_rate FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE letter_capability_grant (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 capability text NOT NULL CHECK(capability IN ('read','template','generate','approve','issue','report','settings')),role text NOT NULL,allowed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT letter_capability_role_uq UNIQUE(tenant_id,company_id,capability,role)
);
--> statement-breakpoint
CREATE TABLE letter_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),owner_user_id uuid NOT NULL REFERENCES app_user(id),
 kind text NOT NULL CHECK(kind IN ('letterhead','signature')),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),mime_type text NOT NULL CHECK(mime_type='image/png'),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 24 AND 2097152),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE letter_policy_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),category text NOT NULL CHECK(length(category) BETWEEN 1 AND 100),ordinal integer NOT NULL CHECK(ordinal>0),enabled boolean NOT NULL,
 policy jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_policy_version_uq UNIQUE(tenant_id,company_id,category,ordinal)
);
--> statement-breakpoint
CREATE TABLE letter_merge_field_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),key text NOT NULL CHECK(key ~ '^[a-z][a-zA-Z0-9_.]{0,79}$'),ordinal integer NOT NULL CHECK(ordinal>0),active boolean NOT NULL,
 definition jsonb NOT NULL CHECK(definition->>'key'=key),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_merge_field_version_uq UNIQUE(tenant_id,company_id,key,ordinal)
);
--> statement-breakpoint
CREATE TABLE letter_template (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),code text NOT NULL CHECK(length(code) BETWEEN 1 AND 80),created_by uuid NOT NULL REFERENCES app_user(id),
 deactivated boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_template_code_uq UNIQUE(tenant_id,company_id,code)
);
--> statement-breakpoint
CREATE TABLE letter_template_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),template_id uuid NOT NULL REFERENCES letter_template(id),ordinal integer NOT NULL CHECK(ordinal>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),category text NOT NULL CHECK(length(category) BETWEEN 1 AND 100),document jsonb NOT NULL,effective_from date NOT NULL,presentation jsonb,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),created_by uuid NOT NULL REFERENCES app_user(id),approved_by uuid REFERENCES app_user(id),approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_template_version_uq UNIQUE(template_id,ordinal)
);
--> statement-breakpoint
CREATE TABLE letter_template_field (
 tenant_id uuid NOT NULL REFERENCES tenant(id),template_version_id uuid NOT NULL REFERENCES letter_template_version(id),field_version_id uuid NOT NULL REFERENCES letter_merge_field_version(id),PRIMARY KEY(template_version_id,field_version_id)
);
--> statement-breakpoint
CREATE TABLE letter_generation_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),template_version_id uuid NOT NULL REFERENCES letter_template_version(id),policy_version_id uuid NOT NULL REFERENCES letter_policy_version(id),
 selection jsonb NOT NULL,input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),created_by uuid NOT NULL REFERENCES app_user(id),operation_key uuid NOT NULL,source_event_id uuid REFERENCES domain_event(id),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_batch_operation_uq UNIQUE(tenant_id,created_by,operation_key),CONSTRAINT letter_batch_source_event_uq UNIQUE(tenant_id,source_event_id,template_version_id)
);
--> statement-breakpoint
CREATE TABLE letter_record (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),batch_id uuid NOT NULL REFERENCES letter_generation_batch(id),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),created_by uuid NOT NULL REFERENCES app_user(id),current_revision_id uuid,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','returned','rejected','approved','issued','void','withdrawn')),stage_index integer NOT NULL DEFAULT 0 CHECK(stage_index BETWEEN 0 AND 9),lock_version integer NOT NULL DEFAULT 1 CHECK(lock_version>0),confidential boolean NOT NULL,
 original_letter_id uuid REFERENCES letter_record(id),legal_hold boolean NOT NULL DEFAULT false,retain_until date NOT NULL,submitted_at timestamptz,approved_at timestamptz,issued_at timestamptz,voided_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_reference_uq UNIQUE(tenant_id,reference),CONSTRAINT letter_record_batch_employment_uq UNIQUE(tenant_id,batch_id,employment_id)
);
--> statement-breakpoint
CREATE TABLE letter_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),letter_id uuid NOT NULL REFERENCES letter_record(id),ordinal integer NOT NULL CHECK(ordinal>0),
 document jsonb NOT NULL,"values" jsonb NOT NULL,editable_values jsonb NOT NULL,source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_revision_ordinal_uq UNIQUE(letter_id,ordinal)
);
--> statement-breakpoint
CREATE TABLE letter_approval_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),letter_id uuid NOT NULL REFERENCES letter_record(id),revision_id uuid NOT NULL REFERENCES letter_revision(id),stage_index integer NOT NULL CHECK(stage_index BETWEEN 0 AND 9),
 actor_id uuid NOT NULL REFERENCES app_user(id),action text NOT NULL CHECK(action IN ('approve','reject','return','delegate')),comment text NOT NULL CHECK(length(comment)<=2000),delegated_to uuid REFERENCES app_user(id),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE letter_artifact (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),letter_id uuid NOT NULL REFERENCES letter_record(id),revision_id uuid NOT NULL REFERENCES letter_revision(id),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 5 AND 15728640),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),signatory_user_id uuid NOT NULL REFERENCES app_user(id),signing_mode text NOT NULL CHECK(signing_mode IN ('authenticated','stamp')),authenticity_token_hash text NOT NULL CHECK(authenticity_token_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_artifact_revision_uq UNIQUE(revision_id),CONSTRAINT letter_authenticity_hash_uq UNIQUE(authenticity_token_hash)
);
--> statement-breakpoint
CREATE TABLE letter_recipient_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),letter_id uuid NOT NULL REFERENCES letter_record(id),artifact_id uuid NOT NULL REFERENCES letter_artifact(id),actor_id uuid NOT NULL REFERENCES app_user(id),
 kind text NOT NULL CHECK(kind IN ('viewed','acknowledged','signed')),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),intent text NOT NULL CHECK(length(intent)<=2000),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_recipient_action_once_uq UNIQUE(artifact_id,actor_id,kind)
);
--> statement-breakpoint
CREATE TABLE letter_access_token (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),artifact_id uuid NOT NULL REFERENCES letter_artifact(id),audience_user_id uuid NOT NULL REFERENCES app_user(id),token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_access_token_hash_uq UNIQUE(token_hash)
);
--> statement-breakpoint
CREATE TABLE letter_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),letter_id uuid REFERENCES letter_record(id),
 kind text NOT NULL CHECK(kind IN ('notification','approvalReminder','acknowledgementReminder','escalation','eventDraft')),recipient_user_id uuid REFERENCES app_user(id),source_event_id uuid REFERENCES domain_event(id),
 dedupe_key text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','completed','failed','cancelled')),due_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error text,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_job_dedupe_uq UNIQUE(tenant_id,dedupe_key)
);
--> statement-breakpoint
CREATE TABLE letter_counter (
 tenant_id uuid NOT NULL REFERENCES tenant(id),year text NOT NULL CHECK(year ~ '^[0-9]{4}$'),next_value bigint NOT NULL CHECK(next_value>0),PRIMARY KEY(tenant_id,year)
);
--> statement-breakpoint
ALTER TABLE letter_record ADD CONSTRAINT letter_current_revision_fk FOREIGN KEY(current_revision_id) REFERENCES letter_revision(id);
ALTER TABLE employee_document ADD COLUMN letter_artifact_id uuid REFERENCES letter_artifact(id);
CREATE UNIQUE INDEX employee_document_letter_artifact_uq ON employee_document(letter_artifact_id) WHERE letter_artifact_id IS NOT NULL;
CREATE UNIQUE INDEX letter_approve_stage_once_uq ON letter_approval_decision(revision_id,stage_index) WHERE action='approve';
CREATE INDEX letter_record_scope_idx ON letter_record(tenant_id,company_id,employment_id);
--> statement-breakpoint
-- The private delivery service derives tenant from its leased row; it never borrows a web principal.
CREATE FUNCTION app.letter_permission_for_user_at(wanted_tenant uuid,subject uuid,co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT cap IN ('read','template','generate','approve','issue','report','settings') AND EXISTS(SELECT 1 FROM public.company c JOIN public.app_user u ON u.tenant_id=c.tenant_id AND u.id=subject AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  WHERE c.id=co AND c.tenant_id=wanted_tenant AND c.archived_at IS NULL
  AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=c.tenant_id AND r.app_user_id=u.id AND app.access_scope_covers(r.company_id,c.id,c.tenant_id)
    AND coalesce((SELECT g.allowed FROM public.letter_capability_grant g WHERE g.tenant_id=c.tenant_id AND g.company_id=c.id AND g.capability=cap AND g.role=r.role::text),r.role::text IN ('super_admin','hr_admin'))))
$$;
REVOKE ALL ON FUNCTION app.letter_permission_for_user_at(uuid,uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.letter_permission_for_user(subject uuid,co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.letter_permission_for_user_at(app.current_tenant_id(),subject,co,cap)
$$;
CREATE FUNCTION app.letter_permission(co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND app.letter_permission_for_user(app.current_user_id(),co,cap)
$$;
CREATE FUNCTION app.letter_can_read(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.letter_record l
  JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id
  WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND
   ((l.state IN ('issued','void') AND app.is_self_person(e.person_id)) OR
    (app.letter_permission(l.company_id,'read') AND (NOT l.confidential OR app.can_admin_payroll_for(l.company_id)))))
$$;
REVOKE ALL ON FUNCTION app.letter_permission_for_user(uuid,uuid,text),app.letter_permission(uuid,text),app.letter_can_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_permission_for_user(uuid,uuid,text),app.letter_permission(uuid,text),app.letter_can_read(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_capability_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_capability_grant_read ON letter_capability_grant FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'settings')));
CREATE POLICY letter_capability_grant_insert ON letter_capability_grant FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'settings')));
GRANT SELECT,INSERT ON letter_capability_grant TO ai_hr_app;
CREATE POLICY letter_capability_grant_update ON letter_capability_grant FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'settings'))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'settings')));
GRANT UPDATE ON letter_capability_grant TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_asset_read ON letter_asset FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (kind='letterhead' AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template')) OR owner_user_id=app.current_user_id()));
CREATE POLICY letter_asset_insert ON letter_asset FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (owner_user_id=app.current_user_id() AND (app.letter_permission(company_id,'settings') OR kind='signature' AND app.letter_permission(company_id,'approve'))));
GRANT SELECT,INSERT ON letter_asset TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_policy_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_policy_version_read ON letter_policy_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'settings')));
CREATE POLICY letter_policy_version_insert ON letter_policy_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (created_by=app.current_user_id() AND app.letter_permission(company_id,'settings')));
GRANT SELECT,INSERT ON letter_policy_version TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_merge_field_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_merge_field_version_read ON letter_merge_field_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template')) AND (NOT coalesce((definition->>'sensitive')::boolean,true) OR app.can_admin_payroll_for(company_id)));
CREATE POLICY letter_merge_field_version_insert ON letter_merge_field_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (created_by=app.current_user_id() AND app.letter_permission(company_id,'template')));
GRANT SELECT,INSERT ON letter_merge_field_version TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_template_read ON letter_template FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template')));
CREATE POLICY letter_template_insert ON letter_template FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (created_by=app.current_user_id() AND app.letter_permission(company_id,'template')));
GRANT SELECT,INSERT ON letter_template TO ai_hr_app;
CREATE POLICY letter_template_update ON letter_template FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'template'))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'template')));
GRANT UPDATE ON letter_template TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_template_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_template_version_read ON letter_template_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template')));
CREATE POLICY letter_template_version_insert ON letter_template_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (created_by=app.current_user_id() AND app.letter_permission(company_id,'template') AND status='draft' AND approved_by IS NULL AND approved_at IS NULL));
GRANT SELECT,INSERT ON letter_template_version TO ai_hr_app;
CREATE POLICY letter_template_version_update ON letter_template_version FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'template'))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'template')));
GRANT UPDATE ON letter_template_version TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_generation_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_generation_batch_read ON letter_generation_batch FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read')));
CREATE POLICY letter_generation_batch_insert ON letter_generation_batch FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (created_by=app.current_user_id() AND app.letter_permission(company_id,'generate')));
GRANT SELECT,INSERT ON letter_generation_batch TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_job_read ON letter_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (letter_id IS NOT NULL AND app.letter_permission(company_id,'read') AND app.letter_can_read(letter_id) OR letter_id IS NULL AND app.letter_permission(company_id,'settings')));
CREATE POLICY letter_job_insert ON letter_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue')));
GRANT SELECT,INSERT ON letter_job TO ai_hr_app;
CREATE POLICY letter_job_update ON letter_job FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.letter_can_read(letter_id) AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue'))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.letter_can_read(letter_id) AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue')));
GRANT UPDATE ON letter_job TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_template_field ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_template_field_read ON letter_template_field FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM letter_template_version v WHERE v.id=template_version_id AND v.tenant_id=letter_template_field.tenant_id));
CREATE POLICY letter_template_field_insert ON letter_template_field FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM letter_template_version v JOIN letter_merge_field_version f ON f.id=field_version_id WHERE v.id=template_version_id AND v.tenant_id=letter_template_field.tenant_id AND f.tenant_id=v.tenant_id AND f.company_id=v.company_id AND v.status='draft' AND app.letter_permission(v.company_id,'template')));
GRANT SELECT,INSERT ON letter_template_field TO ai_hr_app;
ALTER TABLE letter_record ENABLE ROW LEVEL SECURITY;
-- Inline new-row visibility supports INSERT RETURNING without a same-command helper lookup.
CREATE POLICY letter_record_read ON letter_record FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
 ((app.letter_permission(company_id,'read') AND (NOT confidential OR app.can_admin_payroll_for(company_id))) OR
  (state IN ('issued','void') AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=letter_record.tenant_id AND app.is_self_person(e.person_id)))));
CREATE POLICY letter_record_insert ON letter_record FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.letter_permission(company_id,'generate'));
-- Scoped issuers may file an immutable artifact without gaining generic document upload permission.
-- The folder binding trigger additionally verifies exact identity, state, byte length and PDF metadata.
CREATE POLICY employee_document_letter_insert ON employee_document FOR INSERT WITH CHECK(
 tenant_id=app.current_tenant_id() AND letter_artifact_id IS NOT NULL AND app.principal_snapshot_current() AND
 EXISTS(SELECT 1 FROM letter_artifact a JOIN letter_record l ON l.id=a.letter_id WHERE a.id=employee_document.letter_artifact_id AND l.tenant_id=employee_document.tenant_id AND l.employment_id=employee_document.employment_id AND app.letter_permission(l.company_id,'issue')));
--> statement-breakpoint
-- Recipient reads reveal only the two bound delivery settings, never staff policy or approver identities.
CREATE FUNCTION app.letter_recipient_mode(subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT p.policy->>'acknowledgement' FROM public.letter_record l
 JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id
 JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
 JOIN public.letter_policy_version p ON p.id=b.policy_version_id AND p.tenant_id=l.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND l.state IN ('issued','void') AND app.principal_snapshot_current() AND app.is_self_person(e.person_id)
$$;
CREATE FUNCTION app.letter_recipient_link_minutes(subject uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT (p.policy->>'sensitiveLinkMinutes')::integer FROM public.letter_record l
 JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id
 JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
 JOIN public.letter_policy_version p ON p.id=b.policy_version_id AND p.tenant_id=l.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND l.state='issued' AND app.principal_snapshot_current() AND app.is_self_person(e.person_id)
$$;
REVOKE ALL ON FUNCTION app.letter_recipient_mode(uuid),app.letter_recipient_link_minutes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_recipient_mode(uuid),app.letter_recipient_link_minutes(uuid) TO ai_hr_app;
CREATE POLICY letter_record_update ON letter_record FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.letter_can_read(id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.letter_can_read(id));
GRANT SELECT,INSERT,UPDATE ON letter_record TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_revision_read ON letter_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id));
CREATE POLICY letter_revision_insert ON letter_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id) AND (EXISTS(SELECT 1 FROM letter_record l WHERE l.id=letter_id AND l.tenant_id=letter_revision.tenant_id AND app.letter_permission(l.company_id,'generate'))));
GRANT SELECT,INSERT ON letter_revision TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_approval_decision ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_approval_decision_read ON letter_approval_decision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id));
CREATE POLICY letter_approval_decision_insert ON letter_approval_decision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id) AND (EXISTS(SELECT 1 FROM letter_record l WHERE l.id=letter_id AND l.tenant_id=letter_approval_decision.tenant_id AND app.letter_permission(l.company_id,'approve'))));
GRANT SELECT,INSERT ON letter_approval_decision TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_artifact ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_artifact_read ON letter_artifact FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id));
CREATE POLICY letter_artifact_insert ON letter_artifact FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id) AND (EXISTS(SELECT 1 FROM letter_record l WHERE l.id=letter_id AND l.tenant_id=letter_artifact.tenant_id AND app.letter_permission(l.company_id,'approve'))));
GRANT SELECT,INSERT ON letter_artifact TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_recipient_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_recipient_event_read ON letter_recipient_event FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id));
CREATE POLICY letter_recipient_event_insert ON letter_recipient_event FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.letter_can_read(letter_id) AND (actor_id=app.current_user_id() AND EXISTS(SELECT 1 FROM letter_record l JOIN employment e ON e.id=l.employment_id WHERE l.id=letter_id AND l.tenant_id=letter_recipient_event.tenant_id AND l.state='issued' AND app.is_self_person(e.person_id))));
GRANT SELECT,INSERT ON letter_recipient_event TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE letter_access_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_access_token_read ON letter_access_token FOR SELECT USING(tenant_id=app.current_tenant_id() AND audience_user_id=app.current_user_id() AND app.principal_snapshot_current() AND expires_at>now());
CREATE POLICY letter_access_token_insert ON letter_access_token FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND audience_user_id=app.current_user_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM letter_artifact a JOIN letter_record l ON l.id=a.letter_id JOIN employment e ON e.id=l.employment_id WHERE a.id=artifact_id AND a.tenant_id=letter_access_token.tenant_id AND l.state='issued' AND app.is_self_person(e.person_id)));
GRANT SELECT,INSERT ON letter_access_token TO ai_hr_app;
ALTER TABLE letter_counter ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_counter_scope ON letter_counter FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=letter_counter.tenant_id AND app.letter_permission(c.id,'generate'))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=letter_counter.tenant_id AND app.letter_permission(c.id,'generate')));
GRANT SELECT,INSERT,UPDATE ON letter_counter TO ai_hr_app;
CREATE POLICY letter_document_scope ON employee_document AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(letter_artifact_id IS NULL OR EXISTS(SELECT 1 FROM letter_artifact a WHERE a.id=letter_artifact_id AND a.tenant_id=employee_document.tenant_id AND app.letter_can_read(a.letter_id)));
--> statement-breakpoint
CREATE FUNCTION app.letter_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Letter evidence is immutable; create a new version' USING ERRCODE='check_violation'; END $$;
CREATE TRIGGER letter_asset_immutable BEFORE UPDATE OR DELETE ON letter_asset FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_policy_version_immutable BEFORE UPDATE OR DELETE ON letter_policy_version FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_merge_field_version_immutable BEFORE UPDATE OR DELETE ON letter_merge_field_version FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_template_field_immutable BEFORE UPDATE OR DELETE ON letter_template_field FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_generation_batch_immutable BEFORE UPDATE OR DELETE ON letter_generation_batch FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_revision_immutable BEFORE UPDATE OR DELETE ON letter_revision FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_approval_decision_immutable BEFORE UPDATE OR DELETE ON letter_approval_decision FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_artifact_immutable BEFORE UPDATE OR DELETE ON letter_artifact FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_recipient_event_immutable BEFORE UPDATE OR DELETE ON letter_recipient_event FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_access_token_immutable BEFORE UPDATE OR DELETE ON letter_access_token FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_template_no_delete BEFORE DELETE ON letter_template FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_record_no_delete BEFORE DELETE ON letter_record FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
CREATE TRIGGER letter_template_version_no_delete BEFORE DELETE ON letter_template_version FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
--> statement-breakpoint
CREATE FUNCTION app.letter_bind_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE row_data jsonb:=to_jsonb(NEW);co uuid;v public.letter_template_version;b public.letter_generation_batch;l public.letter_record;r public.letter_revision;p public.letter_policy_version;
 a public.letter_artifact;stage jsonb;delegate uuid;next_ordinal integer;automation boolean;
BEGIN
 automation:=app.letter_automation_insert_allowed(TG_TABLE_NAME,row_data);
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT automation AND NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Letter principal is unavailable' USING ERRCODE='insufficient_privilege'; END IF;
 IF TG_TABLE_NAME='letter_job' AND row_data->>'kind'='eventDraft' AND NOT automation THEN RAISE EXCEPTION 'Automatic draft intents require the maintenance connection' USING ERRCODE='insufficient_privilege';END IF;
 IF row_data ? 'company_id' THEN
  co:=(row_data->>'company_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=NEW.tenant_id AND c.archived_at IS NULL) THEN RAISE EXCEPTION 'Letter company identity mismatch';END IF;
 END IF;
 IF NOT automation AND row_data ? 'created_by' AND (row_data->>'created_by')::uuid IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Letter actor identity mismatch';END IF;
 IF TG_TABLE_NAME='letter_asset' THEN
  IF NEW.owner_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.owner_user_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL)
    OR encode(sha256(NEW.content),'hex')<>NEW.content_hash OR substring(NEW.content from 1 for 8)<>decode('89504e470d0a1a0a','hex')
  THEN RAISE EXCEPTION 'Letter asset identity or content mismatch';END IF;
 ELSIF TG_TABLE_NAME='letter_policy_version' THEN
  IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=(NEW.policy->>'signatoryUserId')::uuid AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL) THEN RAISE EXCEPTION 'Letter signatory unavailable';END IF;
  IF NEW.policy->>'signatureAssetId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.letter_asset x WHERE x.id=(NEW.policy->>'signatureAssetId')::uuid AND x.tenant_id=NEW.tenant_id AND x.company_id=NEW.company_id AND x.owner_user_id=(NEW.policy->>'signatoryUserId')::uuid AND x.kind='signature') THEN RAISE EXCEPTION 'Letter signature asset mismatch';END IF;
  IF NEW.policy->>'letterheadAssetId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.letter_asset x WHERE x.id=(NEW.policy->>'letterheadAssetId')::uuid AND x.tenant_id=NEW.tenant_id AND x.company_id=NEW.company_id AND x.kind='letterhead') THEN RAISE EXCEPTION 'Letterhead asset mismatch';END IF;
 ELSIF TG_TABLE_NAME='letter_merge_field_version' THEN
  IF jsonb_typeof(NEW.definition) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid typed field definition' USING ERRCODE='check_violation';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.definition) AS keys(name) WHERE keys.name NOT IN ('key','label','description','kind','source','required','editable','sensitive')) OR jsonb_typeof(NEW.definition->'key') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.definition->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.definition->'description') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.definition->'source') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.definition->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(NEW.definition->'editable') IS DISTINCT FROM 'boolean' OR jsonb_typeof(NEW.definition->'sensitive') IS DISTINCT FROM 'boolean'
   OR NEW.key !~ '^[a-z][a-zA-Z0-9_.]{0,79}$' OR length(trim(NEW.definition->>'label')) NOT BETWEEN 1 AND 160 OR length(NEW.definition->>'description')>1000 OR NEW.definition->>'source' NOT IN ('employee.name','employee.code','employment.hiredOn','employment.jobTitle','employment.department','company.name','company.registration','company.address','compensation.basicSalary','custom.text','custom.date','custom.currency')
   OR (NEW.definition->>'kind') IS DISTINCT FROM (CASE WHEN NEW.definition->>'source' IN ('compensation.basicSalary','custom.currency') THEN 'currency' WHEN NEW.definition->>'source' IN ('employment.hiredOn','custom.date') THEN 'date' ELSE 'text' END)
  THEN RAISE EXCEPTION 'Invalid typed field definition' USING ERRCODE='check_violation';END IF;
  IF (NEW.definition->>'editable')::boolean AND NEW.definition->>'source' NOT LIKE 'custom.%' OR NEW.definition->>'source' IN ('compensation.basicSalary','custom.currency') AND NOT (NEW.definition->>'sensitive')::boolean THEN RAISE EXCEPTION 'Invalid editable or confidential field mapping' USING ERRCODE='check_violation';END IF;
  SELECT coalesce(max(f.ordinal),0)+1 INTO next_ordinal FROM public.letter_merge_field_version f WHERE f.tenant_id=NEW.tenant_id AND f.company_id=NEW.company_id AND f.key=NEW.key;
  IF NEW.ordinal<>next_ordinal OR NEW.key IS DISTINCT FROM NEW.definition->>'key' THEN RAISE EXCEPTION 'Field mapping requires the next immutable version';END IF;
  IF NOT app.can_admin_payroll_for(NEW.company_id) AND (coalesce((NEW.definition->>'sensitive')::boolean,true) OR NEW.definition->>'source' IN ('compensation.basicSalary','custom.currency') OR coalesce((SELECT (f.definition->>'sensitive')::boolean FROM public.letter_merge_field_version f WHERE f.tenant_id=NEW.tenant_id AND f.company_id=NEW.company_id AND f.key=NEW.key ORDER BY f.ordinal DESC LIMIT 1),false)) THEN RAISE EXCEPTION 'Confidential field mapping permission unavailable' USING ERRCODE='insufficient_privilege';END IF;
  IF NOT NEW.active AND app.letter_field_in_use(NEW.company_id,NEW.key) THEN RAISE EXCEPTION 'An active template still uses this field' USING ERRCODE='check_violation';END IF;
 ELSIF TG_TABLE_NAME='letter_template_version' THEN
  PERFORM 1 FROM public.letter_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Letter template identity mismatch';END IF;
  SELECT coalesce(max(x.ordinal),0)+1 INTO next_ordinal FROM public.letter_template_version x WHERE x.template_id=NEW.template_id;
  IF NEW.ordinal<>next_ordinal OR NEW.status<>'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN RAISE EXCEPTION 'Create a fresh letter template draft';END IF;
  IF NEW.presentation IS NOT NULL THEN
   IF jsonb_typeof(NEW.presentation)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.presentation))<>2
    OR NOT (NEW.presentation ?& ARRAY['letterheadAssetId','signatoryUserId']) OR jsonb_typeof(NEW.presentation->'signatoryUserId')<>'string'
    OR jsonb_typeof(NEW.presentation->'letterheadAssetId') NOT IN ('string','null')
   THEN RAISE EXCEPTION 'Invalid letter presentation' USING ERRCODE='check_violation';END IF;
   IF NOT app.letter_permission_for_user((NEW.presentation->>'signatoryUserId')::uuid,NEW.company_id,'approve')
    OR NOT app.letter_permission_for_user((NEW.presentation->>'signatoryUserId')::uuid,NEW.company_id,'read')
    OR (NEW.presentation->>'letterheadAssetId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.letter_asset head_asset WHERE head_asset.id=(NEW.presentation->>'letterheadAssetId')::uuid AND head_asset.tenant_id=NEW.tenant_id AND head_asset.company_id=NEW.company_id AND head_asset.kind='letterhead'))
   THEN RAISE EXCEPTION 'Letter presentation identity mismatch' USING ERRCODE='check_violation';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='letter_template_field' THEN
  IF NOT EXISTS(SELECT 1 FROM public.letter_template_version x JOIN public.letter_merge_field_version f ON f.id=NEW.field_version_id WHERE x.id=NEW.template_version_id AND x.tenant_id=NEW.tenant_id AND f.tenant_id=x.tenant_id AND f.company_id=x.company_id AND x.status='draft' AND f.active AND f.id=app.letter_field_latest_version(x.company_id,f.key) AND (NOT coalesce((f.definition->>'sensitive')::boolean,true) OR app.can_admin_payroll_for(x.company_id))) THEN RAISE EXCEPTION 'Letter field binding mismatch';END IF;
 ELSIF TG_TABLE_NAME='letter_generation_batch' THEN
  IF NOT automation AND EXISTS(SELECT 1 FROM public.letter_job reserved WHERE reserved.id=NEW.operation_key AND reserved.tenant_id=NEW.tenant_id AND reserved.kind='eventDraft') THEN RAISE EXCEPTION 'Automatic draft operation identity is reserved';END IF;
  SELECT * INTO v FROM public.letter_template_version WHERE id=NEW.template_version_id;
  SELECT * INTO p FROM public.letter_policy_version WHERE id=NEW.policy_version_id;
  IF v.id IS NULL OR p.id IS NULL OR v.tenant_id<>NEW.tenant_id OR p.tenant_id<>NEW.tenant_id OR v.company_id<>NEW.company_id OR p.company_id<>NEW.company_id OR p.category<>v.category OR NOT p.enabled OR v.status<>'approved'
   OR v.effective_from>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR EXISTS(SELECT 1 FROM public.letter_template t WHERE t.id=v.template_id AND t.deactivated)
   OR (v.presentation IS NOT NULL AND v.presentation->>'signatoryUserId' IS DISTINCT FROM p.policy->>'signatoryUserId')
   OR EXISTS(SELECT 1 FROM public.letter_template_version n WHERE n.template_id=v.template_id AND n.status='approved' AND n.effective_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND n.ordinal>v.ordinal)
  THEN RAISE EXCEPTION 'An effective approved template and configured policy are required';END IF;
  IF NEW.source_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=NEW.source_event_id AND e.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Letter source event mismatch';END IF;
 ELSIF TG_TABLE_NAME='letter_record' THEN
  SELECT * INTO b FROM public.letter_generation_batch WHERE id=NEW.batch_id;
  IF b.id IS NULL OR b.tenant_id<>NEW.tenant_id OR b.company_id<>NEW.company_id OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.selection->'employmentIds') selected(value) WHERE selected.value::uuid=NEW.employment_id) THEN RAISE EXCEPTION 'Letter employment or batch identity mismatch';END IF;
  IF NEW.original_letter_id IS NOT NULL AND (NOT app.letter_permission(NEW.company_id,'issue') OR NOT app.letter_can_read(NEW.original_letter_id) OR NOT EXISTS(SELECT 1 FROM public.letter_record original WHERE original.id=NEW.original_letter_id AND original.tenant_id=NEW.tenant_id AND original.company_id=NEW.company_id AND original.employment_id=NEW.employment_id AND original.state IN ('issued','void'))) THEN RAISE EXCEPTION 'Reissue requires an authorised original for the same employee';END IF;
  IF NEW.state<>'draft' OR NEW.current_revision_id IS NOT NULL OR NEW.stage_index<>0 OR NEW.lock_version<>1 OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN RAISE EXCEPTION 'New letters must start as drafts';END IF;
  IF NEW.original_letter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.letter_record prior WHERE prior.id=NEW.original_letter_id AND prior.tenant_id=NEW.tenant_id AND prior.company_id=NEW.company_id AND prior.employment_id=NEW.employment_id AND prior.state IN ('issued','void')) THEN RAISE EXCEPTION 'Reissue identity mismatch';END IF;
 ELSIF TG_TABLE_NAME IN ('letter_revision','letter_approval_decision','letter_artifact','letter_recipient_event') THEN
  SELECT * INTO l FROM public.letter_record WHERE id=(row_data->>'letter_id')::uuid FOR UPDATE;
  IF l.id IS NULL OR l.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'Letter identity mismatch';END IF;
  SELECT * INTO b FROM public.letter_generation_batch WHERE id=l.batch_id;
  SELECT * INTO p FROM public.letter_policy_version WHERE id=b.policy_version_id;
  IF TG_TABLE_NAME='letter_revision' THEN
   SELECT coalesce(max(x.ordinal),0)+1 INTO next_ordinal FROM public.letter_revision x WHERE x.letter_id=l.id;
   IF l.state NOT IN ('draft','returned','rejected') OR NEW.ordinal<>next_ordinal THEN RAISE EXCEPTION 'Create a new editable letter revision';END IF;
  ELSIF TG_TABLE_NAME IN ('letter_approval_decision','letter_artifact') THEN
   SELECT * INTO r FROM public.letter_revision WHERE id=(row_data->>'revision_id')::uuid;
   stage:=p.policy->'stages'->l.stage_index;
   IF l.state<>'submitted' OR r.id IS NULL OR r.letter_id<>l.id OR r.tenant_id<>l.tenant_id OR r.id IS DISTINCT FROM l.current_revision_id THEN RAISE EXCEPTION 'Letter revision changed';END IF;
   IF TG_TABLE_NAME='letter_approval_decision' THEN
    IF NOT app.letter_automation_source_current(l.id) THEN RAISE EXCEPTION 'The employee event that created this letter changed' USING ERRCODE='check_violation';END IF;
    IF NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NEW.actor_id=l.created_by OR NEW.stage_index<>l.stage_index OR NEW.content_hash<>r.content_hash THEN RAISE EXCEPTION 'Letter decision identity mismatch';END IF;
    SELECT d.delegated_to INTO delegate FROM public.letter_approval_decision d WHERE d.revision_id=r.id AND d.stage_index=l.stage_index AND d.action='delegate' ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
    IF (delegate IS NOT NULL AND delegate<>NEW.actor_id) OR (delegate IS NULL AND NOT coalesce(stage->'userIds' ? NEW.actor_id::text,false)) THEN RAISE EXCEPTION 'Letter stage belongs to another approver';END IF;
    IF NEW.action IN ('reject','return','delegate') AND length(trim(NEW.comment))=0 THEN RAISE EXCEPTION 'A decision reason is required';END IF;
    IF NEW.action='delegate' THEN
     IF NOT coalesce((stage->>'allowDelegation')::boolean,false) OR NEW.delegated_to IS NULL OR NEW.delegated_to=l.created_by OR NEW.delegated_to=NEW.actor_id OR NOT app.letter_approver_eligible(NEW.delegated_to,l.company_id,l.confidential) THEN RAISE EXCEPTION 'Choose an eligible separate delegated approver';END IF;
    ELSIF NEW.delegated_to IS NOT NULL THEN RAISE EXCEPTION 'Only a delegation may change its recipient';END IF;
    IF l.stage_index=jsonb_array_length(p.policy->'stages')-1 AND (NEW.actor_id<>(p.policy->>'signatoryUserId')::uuid OR NEW.action='delegate') THEN RAISE EXCEPTION 'The final authorised signatory must act personally';END IF;
   ELSE
    IF NEW.signatory_user_id IS DISTINCT FROM app.current_user_id() OR NEW.signatory_user_id=l.created_by OR NEW.signatory_user_id<>(p.policy->>'signatoryUserId')::uuid OR NEW.signing_mode<>p.policy->>'signingMode'
     OR l.stage_index<>jsonb_array_length(p.policy->'stages')-1 OR NOT EXISTS(SELECT 1 FROM public.letter_approval_decision d WHERE d.revision_id=r.id AND d.stage_index=l.stage_index AND d.action='approve' AND d.actor_id=NEW.signatory_user_id AND d.content_hash=r.content_hash)
     OR encode(sha256(NEW.content),'hex')<>NEW.content_hash OR substring(NEW.content from 1 for 5)<>convert_to('%PDF-','UTF8')
    THEN RAISE EXCEPTION 'Sealed letter artifact requires the authorised final decision and exact PDF bytes';END IF;
   END IF;
  ELSE
   SELECT * INTO a FROM public.letter_artifact WHERE id=NEW.artifact_id;
   IF l.state<>'issued' OR a.id IS NULL OR a.letter_id<>l.id OR a.tenant_id<>NEW.tenant_id OR a.revision_id IS DISTINCT FROM l.current_revision_id OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NEW.content_hash<>a.content_hash
    OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=l.employment_id AND e.tenant_id=l.tenant_id AND app.is_self_person(e.person_id))
   THEN RAISE EXCEPTION 'Employee action must name their exact current issued artifact';END IF;
   IF NEW.kind='acknowledged' AND p.policy->>'acknowledgement'<>'acknowledge' OR NEW.kind='signed' AND p.policy->>'acknowledgement'<>'signature' OR NEW.kind IN ('acknowledged','signed') AND length(trim(NEW.intent))=0 THEN RAISE EXCEPTION 'Employee action does not match the configured intent';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='letter_access_token' THEN
  SELECT * INTO a FROM public.letter_artifact WHERE id=NEW.artifact_id;
  SELECT * INTO l FROM public.letter_record WHERE id=a.letter_id;
  SELECT * INTO b FROM public.letter_generation_batch WHERE id=l.batch_id;
  SELECT * INTO p FROM public.letter_policy_version WHERE id=b.policy_version_id;
  IF a.id IS NULL OR a.tenant_id<>NEW.tenant_id OR NEW.audience_user_id IS DISTINCT FROM app.current_user_id() OR l.state<>'issued' OR a.revision_id IS DISTINCT FROM l.current_revision_id
   OR NEW.expires_at<=now() OR NEW.expires_at>now()+make_interval(mins=>(p.policy->>'sensitiveLinkMinutes')::integer)
  THEN RAISE EXCEPTION 'Letter access link identity or expiry is invalid';END IF;
 ELSIF TG_TABLE_NAME='letter_job' THEN
  IF NEW.letter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.letter_record x WHERE x.id=NEW.letter_id AND x.tenant_id=NEW.tenant_id AND x.company_id=NEW.company_id) THEN RAISE EXCEPTION 'Letter job identity mismatch';END IF;
  IF NEW.recipient_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.recipient_user_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL) THEN RAISE EXCEPTION 'Letter job recipient unavailable';END IF;
  IF NEW.source_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=NEW.source_event_id AND e.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Letter job source event mismatch';END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['letter_capability_grant','letter_asset','letter_policy_version','letter_merge_field_version','letter_template','letter_template_version','letter_template_field','letter_generation_batch','letter_record','letter_revision','letter_approval_decision','letter_artifact','letter_recipient_event','letter_access_token','letter_job','letter_counter'] LOOP
  EXECUTE format('CREATE TRIGGER letter_insert_binding BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.letter_bind_insert()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.letter_template_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','approved_by','approved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','approved_by','approved_at']) THEN RAISE EXCEPTION 'Template content is immutable; create a new version';END IF;
 IF NOT app.letter_permission(OLD.company_id,'template') OR NOT ((OLD.status='draft' AND NEW.status='submitted') OR (OLD.status='submitted' AND NEW.status IN ('approved','rejected'))) THEN RAISE EXCEPTION 'Template approval transition refused';END IF;
 IF NEW.status IN ('approved','rejected') AND OLD.created_by=app.current_user_id() THEN RAISE EXCEPTION 'A template author cannot approve or reject their own version';END IF;
 IF NEW.status='approved' THEN NEW.approved_by:=app.current_user_id();NEW.approved_at:=now();
 ELSE NEW.approved_by:=NULL;NEW.approved_at:=NULL;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER letter_template_version_transition BEFORE UPDATE ON letter_template_version FOR EACH ROW EXECUTE FUNCTION app.letter_template_transition();
CREATE FUNCTION app.letter_record_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE b public.letter_generation_batch;p public.letter_policy_version;d public.letter_approval_decision;
BEGIN
 IF app.letter_automation_transition_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF NEW.state IN ('submitted','approved','issued') AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.stage_index<>OLD.stage_index) AND NOT app.letter_automation_source_current(OLD.id) THEN RAISE EXCEPTION 'The employee event that created this letter changed' USING ERRCODE='check_violation';END IF;
 IF NOT (app.letter_permission(OLD.company_id,'generate') OR app.letter_permission(OLD.company_id,'approve') OR app.letter_permission(OLD.company_id,'issue') OR app.letter_permission(OLD.company_id,'settings')) THEN RAISE EXCEPTION 'Letter write permission unavailable';END IF;
 NEW.submitted_at:=OLD.submitted_at;NEW.approved_at:=OLD.approved_at;NEW.issued_at:=OLD.issued_at;NEW.voided_at:=OLD.voided_at;
 IF (to_jsonb(NEW)-ARRAY['current_revision_id','state','stage_index','lock_version','legal_hold','retain_until','submitted_at','approved_at','issued_at','voided_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['current_revision_id','state','stage_index','lock_version','legal_hold','retain_until','submitted_at','approved_at','issued_at','voided_at']) OR NEW.lock_version<>OLD.lock_version+1 OR NEW.retain_until<OLD.retain_until THEN RAISE EXCEPTION 'Letter identity changed or stale workflow revision';END IF;
 IF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold OR NEW.retain_until<>OLD.retain_until THEN
  IF NOT app.letter_permission(OLD.company_id,'settings') THEN RAISE EXCEPTION 'Retention changes require letter settings permission';END IF;
 END IF;
 IF (NEW.legal_hold IS DISTINCT FROM OLD.legal_hold OR NEW.retain_until<>OLD.retain_until) AND (to_jsonb(NEW)-ARRAY['legal_hold','retain_until','lock_version']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['legal_hold','retain_until','lock_version']) THEN RETURN NEW;END IF;
 IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
  IF NOT app.letter_permission(OLD.company_id,'generate') OR OLD.state NOT IN ('draft','returned','rejected') OR NEW.state<>'draft' OR NEW.stage_index<>0 OR NOT EXISTS(SELECT 1 FROM public.letter_revision r WHERE r.id=NEW.current_revision_id AND r.letter_id=OLD.id AND r.tenant_id=OLD.tenant_id) THEN RAISE EXCEPTION 'Refresh requires a new editable revision and restarted approval';END IF;
  NEW.submitted_at:=NULL;NEW.approved_at:=NULL;
 ELSIF OLD.state IN ('draft','returned','rejected') AND NEW.state IN ('submitted','withdrawn') THEN
  IF NOT app.letter_permission(OLD.company_id,'generate') OR NEW.state='submitted' AND OLD.current_revision_id IS NULL OR NEW.stage_index<>0 THEN RAISE EXCEPTION 'Letter submission unavailable';END IF;
  IF NEW.state='submitted' THEN IF OLD.state<>'draft' THEN RAISE EXCEPTION 'Returned or rejected letters require a new revision before resubmission';END IF;NEW.submitted_at:=now();END IF;
 ELSIF OLD.state='submitted' AND (NEW.state IN ('submitted','approved','returned','rejected','withdrawn')) THEN
  IF NEW.state='withdrawn' THEN
   IF NOT app.letter_permission(OLD.company_id,'generate') THEN RAISE EXCEPTION 'Letter withdrawal unavailable';END IF;
  ELSE
   IF NOT app.letter_permission(OLD.company_id,'approve') THEN RAISE EXCEPTION 'Letter approval unavailable';END IF;
   SELECT * INTO d FROM public.letter_approval_decision WHERE letter_id=OLD.id AND revision_id=OLD.current_revision_id AND stage_index=OLD.stage_index ORDER BY created_at DESC,id DESC LIMIT 1;
   IF d.id IS NULL OR d.actor_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'A current stage decision is required';END IF;
   SELECT * INTO b FROM public.letter_generation_batch WHERE id=OLD.batch_id;SELECT * INTO p FROM public.letter_policy_version WHERE id=b.policy_version_id;
   IF d.action='approve' THEN
    IF OLD.stage_index=jsonb_array_length(p.policy->'stages')-1 THEN
     IF NEW.state<>'approved' OR NEW.stage_index<>OLD.stage_index OR NOT EXISTS(SELECT 1 FROM public.letter_artifact a WHERE a.revision_id=OLD.current_revision_id AND a.letter_id=OLD.id) THEN RAISE EXCEPTION 'Final approval requires the sealed artifact';END IF;
     NEW.approved_at:=now();
    ELSIF NEW.state<>'submitted' OR NEW.stage_index<>OLD.stage_index+1 THEN RAISE EXCEPTION 'Approval stages must advance in order';END IF;
   ELSIF d.action='delegate' THEN IF NEW.state<>'submitted' OR NEW.stage_index<>OLD.stage_index THEN RAISE EXCEPTION 'Delegation cannot skip a stage';END IF;
   ELSIF (d.action='return' AND NEW.state<>'returned') OR (d.action='reject' AND NEW.state<>'rejected') OR NEW.stage_index<>OLD.stage_index THEN RAISE EXCEPTION 'Decision does not match letter state';END IF;
  END IF;
 ELSIF OLD.state='approved' AND NEW.state='withdrawn' THEN
  IF NOT app.letter_permission(OLD.company_id,'generate') THEN RAISE EXCEPTION 'Letter withdrawal unavailable';END IF;
 ELSIF OLD.state='approved' AND NEW.state='issued' THEN
  IF NOT app.letter_permission(OLD.company_id,'issue') OR NOT EXISTS(SELECT 1 FROM public.letter_artifact a JOIN public.employee_document doc ON doc.letter_artifact_id=a.id WHERE a.letter_id=OLD.id AND a.revision_id=OLD.current_revision_id AND doc.tenant_id=OLD.tenant_id AND doc.employment_id=OLD.employment_id) THEN RAISE EXCEPTION 'Issuance requires the sealed artifact in the employee folder';END IF;
  NEW.issued_at:=now();
 ELSIF OLD.state='issued' AND NEW.state='void' THEN
  IF NOT app.letter_permission(OLD.company_id,'issue') THEN RAISE EXCEPTION 'Revocation unavailable';END IF;NEW.voided_at:=now();
 ELSIF NEW.state<>OLD.state OR NEW.stage_index<>OLD.stage_index OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN RAISE EXCEPTION 'Letter transition refused';
 END IF;
 IF NEW.state IN ('issued','void','approved') AND NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN RAISE EXCEPTION 'Sealed letter content cannot change';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER letter_record_transition BEFORE UPDATE ON letter_record FOR EACH ROW EXECUTE FUNCTION app.letter_record_transition();
--> statement-breakpoint
CREATE FUNCTION app.letter_folder_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND OLD.letter_artifact_id IS NOT NULL THEN RAISE EXCEPTION 'Issued letter folder entries are immutable; use the letter register' USING ERRCODE='check_violation';END IF;
 IF TG_OP<>'DELETE' AND NEW.letter_artifact_id IS NOT NULL THEN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.letter_artifact a JOIN public.letter_record l ON l.id=a.letter_id WHERE a.id=NEW.letter_artifact_id AND a.tenant_id=NEW.tenant_id AND l.employment_id=NEW.employment_id AND app.letter_permission(l.company_id,'issue') AND l.state='approved' AND a.revision_id=l.current_revision_id AND octet_length(NEW.content)=0 AND NEW.mime_type='application/pdf' AND NEW.size_bytes=octet_length(a.content)) THEN RAISE EXCEPTION 'Employee folder must link the exact authorised sealed artifact';END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER letter_folder_protection BEFORE INSERT OR UPDATE OR DELETE ON employee_document FOR EACH ROW EXECUTE FUNCTION app.letter_folder_binding();
--> statement-breakpoint
-- Non-admin workflow participants see their own or explicitly assigned letters, not the company's
-- whole register merely because their role may approve. Employee self-service stays independently own-only.
CREATE FUNCTION app.letter_staff_scope(co uuid,creator uuid,batch uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.is_admin_for(co) OR creator=app.current_user_id() OR
 (app.letter_permission(co,'approve') AND (
  EXISTS(SELECT 1 FROM public.letter_generation_batch b JOIN public.letter_policy_version p ON p.id=b.policy_version_id,
   LATERAL jsonb_array_elements(p.policy->'stages') stage
   WHERE b.id=batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=co AND p.tenant_id=b.tenant_id AND (stage->'userIds' ? app.current_user_id()::text OR p.policy->>'escalationUserId'=app.current_user_id()::text))
  OR EXISTS(SELECT 1 FROM public.letter_approval_decision d WHERE d.letter_id=subject AND d.tenant_id=app.current_tenant_id() AND d.action='delegate' AND d.delegated_to=app.current_user_id())))
$$;
REVOKE ALL ON FUNCTION app.letter_staff_scope(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_staff_scope(uuid,uuid,uuid,uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.letter_can_read(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.letter_record l
  JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id
  WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND
   ((l.state IN ('issued','void') AND app.is_self_person(e.person_id)) OR
    (app.letter_permission(l.company_id,'read') AND app.letter_staff_scope(l.company_id,l.created_by,l.batch_id,l.id) AND (NOT l.confidential OR app.can_admin_payroll_for(l.company_id)))))
$$;
DROP POLICY letter_record_read ON letter_record;
CREATE POLICY letter_record_read ON letter_record FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
 ((app.letter_permission(company_id,'read') AND app.letter_staff_scope(company_id,created_by,batch_id,id) AND (NOT confidential OR app.can_admin_payroll_for(company_id))) OR
  (state IN ('issued','void') AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=letter_record.tenant_id AND app.is_self_person(e.person_id)))));
CREATE FUNCTION app.letter_template_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['deactivated','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['deactivated','revision']) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Template identity is immutable or stale';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER letter_template_identity BEFORE UPDATE ON letter_template FOR EACH ROW EXECUTE FUNCTION app.letter_template_identity();
CREATE FUNCTION app.letter_grant_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF (to_jsonb(NEW)-'allowed') IS DISTINCT FROM (to_jsonb(OLD)-'allowed') THEN RAISE EXCEPTION 'Letter permission identity is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER letter_grant_identity BEFORE UPDATE ON letter_capability_grant FOR EACH ROW EXECUTE FUNCTION app.letter_grant_identity();
--> statement-breakpoint
CREATE FUNCTION app.letter_asset_reference(co uuid,subject uuid,asset_kind text,asset_owner uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.letter_permission(co,'settings') AND EXISTS(SELECT 1 FROM public.letter_asset a WHERE a.id=subject AND a.tenant_id=app.current_tenant_id() AND a.company_id=co AND a.kind=asset_kind AND (asset_owner IS NULL OR a.owner_user_id=asset_owner))
$$;
CREATE FUNCTION app.letter_asset_choices(co uuid) RETURNS TABLE(id uuid,name text,owner_user_id uuid,kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT a.id,a.name,a.owner_user_id,a.kind FROM public.letter_asset a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=co AND app.letter_permission(co,'settings') ORDER BY a.kind,a.name,a.id LIMIT 501
$$;
REVOKE ALL ON FUNCTION app.letter_asset_reference(uuid,uuid,text,uuid),app.letter_asset_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_asset_reference(uuid,uuid,text,uuid),app.letter_asset_choices(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_counter_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.tenant_id<>OLD.tenant_id OR NEW.year<>OLD.year OR NEW.next_value<=OLD.next_value THEN RAISE EXCEPTION 'Letter reference counters only advance';END IF;RETURN NEW;END $$;
CREATE TRIGGER letter_counter_advance BEFORE UPDATE ON letter_counter FOR EACH ROW EXECUTE FUNCTION app.letter_counter_advance();
CREATE FUNCTION app.letter_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','due_at','attempts','last_error','lease_token','lease_until']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','due_at','attempts','last_error','lease_token','lease_until']) OR NEW.attempts<OLD.attempts OR OLD.status IN ('completed','cancelled') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Letter job identity or completed outcome is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER letter_job_identity BEFORE UPDATE ON letter_job FOR EACH ROW EXECUTE FUNCTION app.letter_job_identity();
--> statement-breakpoint
CREATE FUNCTION app.verify_letter_status(token_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE current_bucket bigint:=floor(extract(epoch FROM clock_timestamp())/60)::bigint;counted integer;
BEGIN
 -- A shared ceiling bounds both enumeration attempts and the number of anonymous counters retained.
 PERFORM pg_advisory_xact_lock(hashtextextended('letter-public-verification',0));
 DELETE FROM public.letter_verification_rate WHERE bucket<current_bucket-2;
 INSERT INTO public.letter_verification_rate(scope,bucket,hits) VALUES('global',current_bucket,1)
 ON CONFLICT(scope,bucket) DO UPDATE SET hits=least(public.letter_verification_rate.hits+1,121) RETURNING hits INTO counted;
 IF counted>120 THEN RETURN 'limited';END IF;
 IF token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid';END IF;
 INSERT INTO public.letter_verification_rate(scope,bucket,hits) VALUES(token_hash,current_bucket,1)
 ON CONFLICT(scope,bucket) DO UPDATE SET hits=least(public.letter_verification_rate.hits+1,21) RETURNING hits INTO counted;
 IF counted>20 THEN RETURN 'limited';END IF;
 IF EXISTS(SELECT 1 FROM public.letter_artifact a JOIN public.letter_record l ON l.id=a.letter_id AND l.tenant_id=a.tenant_id
  WHERE a.authenticity_token_hash=token_hash AND l.state='issued' AND a.revision_id=l.current_revision_id) THEN RETURN 'valid';END IF;
 RETURN 'invalid';
END $$;
REVOKE ALL ON FUNCTION app.verify_letter_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.verify_letter_status(text) TO ai_hr_app;
--> statement-breakpoint
-- General DomainEvent reads remain admin-scoped. Letter staff receive only their authorised letter's history.
CREATE FUNCTION app.letter_audit(subject uuid,before_event uuid,page_size integer)
RETURNS TABLE(id uuid,event_type text,actor_type text,actor_id uuid,payload jsonb,occurred_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF page_size IS NULL OR page_size<1 OR page_size>101 OR NOT app.letter_can_read(subject) OR NOT EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND app.letter_permission(l.company_id,'read')) THEN RAISE EXCEPTION 'Letter audit access unavailable' USING ERRCODE='insufficient_privilege';END IF;
 RETURN QUERY SELECT e.id,e.event_type,e.actor_type::text,e.actor_id,e.payload,e.occurred_at FROM public.domain_event e
 WHERE e.tenant_id=app.current_tenant_id() AND e.aggregate_type='letter' AND e.aggregate_id=subject
 AND (before_event IS NULL OR e.sequence<(SELECT c.sequence FROM public.domain_event c WHERE c.id=before_event AND c.tenant_id=app.current_tenant_id() AND c.aggregate_type='letter' AND c.aggregate_id=subject))
 ORDER BY e.sequence DESC LIMIT page_size;
END $$;
REVOKE ALL ON FUNCTION app.letter_audit(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_audit(uuid,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
-- Resolve latest before applying sensitivity: hidden current mappings never resurrect an older visible version.
CREATE FUNCTION app.letter_field_latest_version(co uuid,field_key text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT latest.id FROM (SELECT f.id,f.definition FROM public.letter_merge_field_version f
  WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=co AND f.key=field_key ORDER BY f.ordinal DESC LIMIT 1) latest
 WHERE app.principal_snapshot_current() AND (app.letter_permission(co,'read') OR app.letter_permission(co,'template'))
  AND (NOT coalesce((latest.definition->>'sensitive')::boolean,true) OR app.can_admin_payroll_for(co))
$$;
REVOKE ALL ON FUNCTION app.letter_field_latest_version(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_field_latest_version(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_field_in_use(co uuid,field_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.letter_field_latest_version(co,field_key) IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.letter_merge_field_version f JOIN public.letter_template_field binding ON binding.field_version_id=f.id AND binding.tenant_id=f.tenant_id
  JOIN public.letter_template_version v ON v.id=binding.template_version_id AND v.tenant_id=f.tenant_id
  JOIN public.letter_template t ON t.id=v.template_id AND t.tenant_id=f.tenant_id
  WHERE f.company_id=co AND f.tenant_id=app.current_tenant_id() AND f.key=field_key AND NOT t.deactivated)
$$;
REVOKE ALL ON FUNCTION app.letter_field_in_use(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_field_in_use(uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- Purpose-limited picker: names of eligible signers, never login subjects or signature bytes.
CREATE FUNCTION app.letter_signatory_choices(co uuid,after_id uuid,wanted_search text,row_limit integer)
RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT u.id,p.full_name FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND (app.letter_permission(co,'template') OR app.letter_permission(co,'read') OR app.letter_permission(co,'settings'))
 AND app.letter_permission_for_user(u.id,co,'read') AND app.letter_permission_for_user(u.id,co,'approve')
 AND (after_id IS NULL OR u.id>after_id) AND (wanted_search IS NULL OR p.full_name ILIKE wanted_search)
 ORDER BY u.id LIMIT greatest(1,least(coalesce(row_limit,101),101))
$$;
REVOKE ALL ON FUNCTION app.letter_signatory_choices(uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_signatory_choices(uuid,uuid,text,integer) TO ai_hr_app;

--> statement-breakpoint
-- Only identities already bound to an authorized template version may be labelled here.
CREATE FUNCTION app.letter_template_appearance(subject uuid) RETURNS TABLE(letterhead_name text,signatory_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT a.name,p.full_name FROM public.letter_template_version v
 LEFT JOIN public.letter_asset a ON a.id=(v.presentation->>'letterheadAssetId')::uuid AND a.tenant_id=v.tenant_id AND a.company_id=v.company_id AND a.kind='letterhead'
 LEFT JOIN public.app_user u ON u.id=(v.presentation->>'signatoryUserId')::uuid AND u.tenant_id=v.tenant_id
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=v.tenant_id
 WHERE v.id=subject AND v.tenant_id=app.current_tenant_id() AND (app.letter_permission(v.company_id,'read') OR app.letter_permission(v.company_id,'template'))
$$;
REVOKE ALL ON FUNCTION app.letter_template_appearance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_template_appearance(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE INDEX letter_batch_author_created_idx ON letter_generation_batch(tenant_id,company_id,created_by,created_at DESC,id DESC);

--> statement-breakpoint
-- Filter the existing Workforce projection; Branch remains the employee master's org_branch value.
CREATE FUNCTION app.access_workforce_picker_rows(wanted_branch text,hired_from date,hired_to date) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT r.value FROM app.access_workforce_list_rows() r(value)
 JOIN public.employment e ON e.id=(r.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.company_id=(r.value->>'companyId')::uuid
 WHERE (wanted_branch IS NULL OR e.org_branch=wanted_branch) AND (hired_from IS NULL OR e.hired_on>=hired_from) AND (hired_to IS NULL OR e.hired_on<=hired_to)
$$;
REVOKE ALL ON FUNCTION app.access_workforce_picker_rows(text,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_picker_rows(text,date,date) TO ai_hr_app;

--> statement-breakpoint
-- One grant policy serves current principals and read-only evaluation of an actual prospective
-- approver's grants. These pure predicates never install a principal or change session authority.
CREATE FUNCTION app.grants_have_role_for(grants jsonb,wanted_role text,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(grants,'[]'::jsonb)) g
 WHERE g->>'role'=wanted_role AND (g->>'companyId' IS NULL OR (g->>'companyId')::uuid=wanted_company OR app.is_company_descendant(wanted_company,(g->>'companyId')::uuid)))
$$;
CREATE FUNCTION app.grants_admin_for(grants jsonb,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.grants_have_role_for(grants,'hr_admin',wanted_company) OR app.grants_have_role_for(grants,'super_admin',wanted_company) $$;
CREATE FUNCTION app.grants_payroll_admin_for(grants jsonb,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.grants_admin_for(grants,wanted_company) OR app.grants_have_role_for(grants,'payroll_partner',wanted_company) $$;
--> statement-breakpoint
-- Preserve the public wrappers' volatility/security attributes and their existing grant semantics.
CREATE OR REPLACE FUNCTION app.has_role_for(p_role text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.grants_have_role_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_role,p_company)
$$;
CREATE OR REPLACE FUNCTION app.is_admin_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT app.grants_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company)
$$;
CREATE OR REPLACE FUNCTION app.can_admin_payroll_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company)
$$;
--> statement-breakpoint
CREATE FUNCTION app.letter_approver_eligible_at(wanted_tenant uuid,subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.letter_permission_for_user_at(wanted_tenant,subject,co,'read') AND app.letter_permission_for_user_at(wanted_tenant,subject,co,'approve')
 AND (NOT confidential OR app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=wanted_tenant AND r.app_user_id=subject),co))
$$;
REVOKE ALL ON FUNCTION app.letter_approver_eligible_at(uuid,uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_approver_eligible(subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current()
 AND (app.letter_permission(co,'generate') OR app.letter_permission(co,'approve') OR app.letter_permission(co,'settings') OR app.letter_permission(co,'template'))
 AND app.letter_approver_eligible_at(app.current_tenant_id(),subject,co,confidential)
$$;
REVOKE ALL ON FUNCTION app.letter_approver_eligible(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_approver_eligible(uuid,uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_creator_eligible_at(wanted_tenant uuid,subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.letter_permission_for_user_at(wanted_tenant,subject,co,'read') AND app.letter_permission_for_user_at(wanted_tenant,subject,co,'generate')
 AND (NOT confidential OR app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=wanted_tenant AND r.app_user_id=subject),co))
$$;
REVOKE ALL ON FUNCTION app.letter_creator_eligible_at(uuid,uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.letter_creator_eligible(subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND (app.letter_permission(co,'generate') OR app.letter_permission(co,'approve') OR app.letter_permission(co,'issue'))
 AND app.letter_creator_eligible_at(app.current_tenant_id(),subject,co,confidential)
$$;
REVOKE ALL ON FUNCTION app.letter_creator_eligible(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_creator_eligible(uuid,uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- A letter reviewer can see the subject's label without receiving directory access or contact data.
CREATE FUNCTION app.letter_staff_identity(subject uuid) RETURNS TABLE(employee_name text,employee_code text,company_name text,title text,category text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT p.full_name,e.employee_code,c.legal_name,v.name,v.category FROM public.letter_record l
 JOIN public.company c ON c.id=l.company_id AND c.tenant_id=l.tenant_id
 JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
 JOIN public.letter_template_version v ON v.id=b.template_version_id AND v.tenant_id=l.tenant_id
 JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id AND e.company_id=l.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=l.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND app.letter_permission(l.company_id,'read') AND app.letter_can_read(l.id)
$$;
REVOKE ALL ON FUNCTION app.letter_staff_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_staff_identity(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_delegate_choices(subject uuid,after_id uuid,wanted_search text,row_limit integer)
RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT u.id,p.full_name FROM public.letter_record l
 JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
 JOIN public.letter_policy_version policy ON policy.id=b.policy_version_id AND policy.tenant_id=l.tenant_id
 JOIN public.app_user u ON u.tenant_id=l.tenant_id JOIN public.person p ON p.id=u.person_id AND p.tenant_id=l.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND app.letter_can_read(l.id)
 AND app.letter_approver_eligible(app.current_user_id(),l.company_id,l.confidential)
 AND l.state='submitted' AND l.created_by<>app.current_user_id() AND l.stage_index<jsonb_array_length(policy.policy->'stages')-1
 AND coalesce((policy.policy->'stages'->l.stage_index->>'allowDelegation')::boolean,false)
 AND coalesce((SELECT decision.delegated_to=app.current_user_id() FROM public.letter_approval_decision decision WHERE decision.revision_id=l.current_revision_id AND decision.stage_index=l.stage_index AND decision.action='delegate' ORDER BY decision.created_at DESC,decision.id DESC LIMIT 1),(policy.policy->'stages'->l.stage_index->'userIds') ? app.current_user_id()::text)
 AND u.id<>l.created_by AND u.id<>app.current_user_id() AND app.letter_approver_eligible(u.id,l.company_id,l.confidential)
 AND (after_id IS NULL OR u.id>after_id) AND (wanted_search IS NULL OR p.full_name ILIKE wanted_search)
 ORDER BY u.id LIMIT greatest(1,least(coalesce(row_limit,101),101))
$$;
REVOKE ALL ON FUNCTION app.letter_delegate_choices(uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_delegate_choices(uuid,uuid,text,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_approval_actor_label(subject uuid,actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT p.full_name FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=actor AND u.tenant_id=app.current_tenant_id() AND app.letter_can_read(subject)
 AND EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=u.tenant_id AND app.letter_permission(l.company_id,'read'))
 AND EXISTS(SELECT 1 FROM public.letter_approval_decision d WHERE d.letter_id=subject AND d.tenant_id=u.tenant_id AND d.actor_id=actor)
$$;
REVOKE ALL ON FUNCTION app.letter_approval_actor_label(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_approval_actor_label(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_audit_actor_label(subject uuid,actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT p.full_name FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=actor AND u.tenant_id=app.current_tenant_id() AND app.letter_can_read(subject)
 AND EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=u.tenant_id AND app.letter_permission(l.company_id,'read'))
 AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=u.tenant_id AND e.aggregate_type='letter' AND e.aggregate_id=subject AND e.actor_type='user' AND e.actor_id=actor)
$$;
REVOKE ALL ON FUNCTION app.letter_audit_actor_label(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_audit_actor_label(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Generation inputs belong to the full cohort. A delegated reviewer receives only the metadata
-- needed for the one letter they can read, never the other employees' custom merge values.
CREATE FUNCTION app.letter_batch_financial_access(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND NOT EXISTS(SELECT 1 FROM public.letter_record l WHERE l.batch_id=subject AND l.tenant_id=app.current_tenant_id() AND l.confidential AND NOT app.can_admin_payroll_for(l.company_id))
$$;
REVOKE ALL ON FUNCTION app.letter_batch_financial_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_batch_financial_access(uuid) TO ai_hr_app;
CREATE FUNCTION app.letter_batch_can_read(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.letter_generation_batch b
 WHERE b.id=subject AND b.tenant_id=app.current_tenant_id() AND app.letter_permission(b.company_id,'read')
 AND app.letter_batch_financial_access(b.id)
 AND (b.created_by=app.current_user_id() OR
  (EXISTS(SELECT 1 FROM public.letter_record l WHERE l.batch_id=b.id)
   AND (SELECT count(*) FROM public.letter_record l WHERE l.batch_id=b.id)=jsonb_array_length(b.selection->'employmentIds')
   AND NOT EXISTS(SELECT 1 FROM public.letter_record l WHERE l.batch_id=b.id AND NOT app.letter_can_read(l.id)))))
$$;
REVOKE ALL ON FUNCTION app.letter_batch_can_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_batch_can_read(uuid) TO ai_hr_app;
DROP POLICY letter_generation_batch_read ON letter_generation_batch;
-- Keep the creator test on NEW's row: a STABLE table-reading helper cannot see an INSERT's
-- own RETURNING row. The financial predicate reads children independently and still applies
-- after creation, including when financial grants are later revoked.
CREATE POLICY letter_generation_batch_read ON letter_generation_batch FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.letter_permission(company_id,'read') AND ((created_by=app.current_user_id() AND app.letter_batch_financial_access(id)) OR app.letter_batch_can_read(id)));
CREATE FUNCTION app.letter_staff_batch_metadata(subject uuid)
RETURNS TABLE(id uuid,tenant_id uuid,company_id uuid,template_version_id uuid,policy_version_id uuid,source_as_of_date text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT b.id,b.tenant_id,b.company_id,b.template_version_id,b.policy_version_id,b.selection->>'sourceAsOfDate'
 FROM public.letter_record l JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND app.letter_permission(l.company_id,'read') AND app.letter_can_read(l.id)
$$;
REVOKE ALL ON FUNCTION app.letter_staff_batch_metadata(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_staff_batch_metadata(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.letter_setting_asset_page(co uuid,asset_kind text,asset_owner uuid,after_id uuid,wanted_search text,row_limit integer)
RETURNS TABLE(id uuid,name text,owner_user_id uuid,kind text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT a.id,a.name,a.owner_user_id,a.kind,a.created_at FROM public.letter_asset a
 WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=co AND a.kind=asset_kind
 AND asset_kind IN ('letterhead','signature') AND app.principal_snapshot_current()
 AND (app.letter_permission(co,'settings') OR asset_kind='signature' AND asset_owner=app.current_user_id() AND app.letter_permission(co,'approve'))
 AND (asset_owner IS NULL OR a.owner_user_id=asset_owner)
 AND (after_id IS NULL OR a.id>after_id) AND (wanted_search IS NULL OR a.name ILIKE wanted_search)
 ORDER BY a.id LIMIT greatest(1,least(coalesce(row_limit,101),101))
$$;
REVOKE ALL ON FUNCTION app.letter_setting_asset_page(uuid,text,uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_setting_asset_page(uuid,text,uuid,uuid,text,integer) TO ai_hr_app;
DROP POLICY letter_asset_read ON letter_asset;
CREATE POLICY letter_asset_read ON letter_asset FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (kind='letterhead' AND (app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template') OR app.letter_permission(company_id,'settings')) OR owner_user_id=app.current_user_id()));

--> statement-breakpoint
CREATE FUNCTION app.letter_policy_people(subject uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT u.id,p.full_name FROM public.letter_policy_version v
 JOIN public.app_user u ON u.tenant_id=v.tenant_id JOIN public.person p ON p.id=u.person_id AND p.tenant_id=v.tenant_id
 WHERE v.id=subject AND v.tenant_id=app.current_tenant_id() AND app.letter_permission(v.company_id,'settings')
 AND (u.id=(v.policy->>'escalationUserId')::uuid OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.policy->'stages') stage WHERE stage->'userIds' ? u.id::text)) ORDER BY u.id
$$;
CREATE FUNCTION app.letter_policy_appearance(subject uuid) RETURNS TABLE(letterhead_name text,signature_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT head.name,signature.name FROM public.letter_policy_version v
 LEFT JOIN public.letter_asset head ON head.id=(v.policy->>'letterheadAssetId')::uuid AND head.tenant_id=v.tenant_id AND head.company_id=v.company_id AND head.kind='letterhead'
 LEFT JOIN public.letter_asset signature ON signature.id=(v.policy->>'signatureAssetId')::uuid AND signature.tenant_id=v.tenant_id AND signature.company_id=v.company_id AND signature.kind='signature' AND signature.owner_user_id=(v.policy->>'signatoryUserId')::uuid
 WHERE v.id=subject AND v.tenant_id=app.current_tenant_id() AND app.letter_permission(v.company_id,'settings')
$$;
REVOKE ALL ON FUNCTION app.letter_policy_people(uuid),app.letter_policy_appearance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_policy_people(uuid),app.letter_policy_appearance(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Letters can address an approver account without inventing an employment record.
-- These are purpose-bound rows in the canonical bell, not a second notification store.
ALTER TABLE notification ALTER COLUMN recipient_employment_id DROP NOT NULL;
ALTER TABLE notification ADD COLUMN recipient_user_id uuid REFERENCES app_user(id);
ALTER TABLE notification ADD COLUMN letter_job_id uuid REFERENCES letter_job(id);
ALTER TABLE notification ADD COLUMN company_id uuid REFERENCES company(id);
ALTER TABLE notification ADD COLUMN portal_visible boolean NOT NULL DEFAULT true;
ALTER TABLE notification ADD CONSTRAINT notification_audience_xor CHECK (
 (recipient_employment_id IS NOT NULL AND recipient_user_id IS NULL AND letter_job_id IS NULL AND company_id IS NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NOT NULL AND company_id IS NOT NULL));
CREATE UNIQUE INDEX notification_letter_job_uq ON notification(letter_job_id) WHERE letter_job_id IS NOT NULL;
CREATE INDEX notification_user_recipient_idx ON notification(tenant_id,recipient_user_id,created_at);
CREATE FUNCTION app.letter_notification_storage_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actor AS (SELECT session_user::text AS login,
  coalesce(nullif(nullif(current_setting('role',true),'none'),''),session_user::text) AS effective)
 SELECT a.login<>'ai_hr_app' AND a.effective<>'ai_hr_app' AND coalesce((
  SELECT count(*)=4 AND bool_and(
   (p.rolsuper OR p.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.effective::name,c.relowner,'USAGE')))
   AND (s.rolsuper OR s.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.login::name,c.relowner,'USAGE'))))
  FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles s CROSS JOIN pg_catalog.pg_class c
  WHERE p.rolname=a.effective::name AND s.rolname=a.login::name
   AND c.oid IN ('public.letter_record'::regclass,'public.letter_job'::regclass,'public.notification'::regclass,'public.domain_event'::regclass)
 ),false) FROM actor a
$$;
REVOKE ALL ON FUNCTION app.letter_notification_storage_owner() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.guard_letter_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE j public.letter_job%ROWTYPE;e public.domain_event%ROWTYPE;target_path text;expected_kind text;portal boolean;batch uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.recipient_user_id IS NOT NULL THEN RAISE EXCEPTION 'Letter notification history is immutable' USING ERRCODE='42501';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.recipient_user_id IS NOT NULL OR NEW.recipient_user_id IS NOT NULL THEN
   IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'Letter notification is immutable' USING ERRCODE='42501';END IF;
  END IF;RETURN NEW;
 END IF;
 IF NEW.recipient_user_id IS NULL THEN RETURN NEW;END IF;
 IF NOT app.letter_notification_storage_owner() THEN RAISE EXCEPTION 'Letter projection requires its maintenance connection' USING ERRCODE='42501';END IF;
 SELECT * INTO j FROM public.letter_job WHERE id=NEW.letter_job_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO e FROM public.domain_event WHERE id=j.source_event_id AND tenant_id=j.tenant_id AND aggregate_type='letter' AND aggregate_id=j.letter_id;
 SELECT coalesce((p.policy->>'portalNotifications')::boolean,false),l.batch_id INTO portal,batch FROM public.letter_record l JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id JOIN public.letter_policy_version p ON p.id=b.policy_version_id AND p.tenant_id=b.tenant_id WHERE l.id=j.letter_id AND l.tenant_id=j.tenant_id;
 expected_kind:='letter.'||CASE j.kind WHEN 'notification' THEN CASE WHEN j.payload->>'purpose'='draftCreated' THEN 'created' WHEN j.payload->>'purpose'='recipientAcknowledgement' THEN CASE j.payload->>'outcome' WHEN 'acknowledged' THEN 'acknowledged' WHEN 'signed' THEN 'signed' ELSE NULL END WHEN j.payload->>'purpose'='creatorDecision' THEN CASE j.payload->>'outcome' WHEN 'returned' THEN 'returned' WHEN 'rejected' THEN 'rejected' WHEN 'approved' THEN 'approved' ELSE NULL END WHEN j.payload ? 'artifactId' THEN 'issued' ELSE 'approval' END WHEN 'approvalReminder' THEN 'approvalReminder' WHEN 'escalation' THEN 'escalation' WHEN 'acknowledgementReminder' THEN 'acknowledgementReminder' ELSE NULL END;
 target_path:=CASE WHEN j.payload->>'purpose'='draftCreated' THEN '/letters/generate/'||batch::text WHEN j.payload->>'purpose'='recipientAcknowledgement' THEN '/letters/register/'||j.letter_id::text WHEN j.payload->>'purpose'='creatorDecision' THEN '/letters/generate/'||batch::text ELSE (CASE WHEN j.payload ? 'artifactId' THEN '/me/letters/' ELSE '/letters/approval/' END)||j.letter_id::text END;
 IF j.id IS NULL OR e.id IS NULL OR j.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
  OR NEW.portal_visible IS DISTINCT FROM portal OR NEW.company_id IS DISTINCT FROM j.company_id OR NEW.source_event_id IS DISTINCT FROM e.id OR NEW.link_path IS DISTINCT FROM target_path
  OR expected_kind IS NULL OR NEW.kind IS DISTINCT FROM expected_kind
  OR NEW.severity::text IS DISTINCT FROM (CASE WHEN expected_kind IN ('letter.issued','letter.approved','letter.acknowledged','letter.signed','letter.created') THEN 'info' ELSE 'action' END)
  OR NEW.title IS DISTINCT FROM 'letters.notifications.'||substring(NEW.kind FROM 8)
  OR NEW.body IS DISTINCT FROM 'letters.notifications.body' OR NEW.read_at IS NOT NULL
 THEN RAISE EXCEPTION 'Letter notification identity is invalid' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_letter_notification() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER letter_notification_guard BEFORE INSERT OR UPDATE OR DELETE ON notification
 FOR EACH ROW EXECUTE FUNCTION app.guard_letter_notification();
CREATE POLICY notification_letter_user_read ON notification FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND portal_visible AND app.principal_snapshot_current());
CREATE POLICY notification_letter_user_update ON notification FOR UPDATE USING
 (tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND portal_visible AND app.principal_snapshot_current())
 WITH CHECK (tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND portal_visible AND app.principal_snapshot_current());
--> statement-breakpoint
ALTER TABLE notification_email_policy DROP CONSTRAINT notification_email_policy_category_check;
ALTER TABLE notification_email_policy ADD CONSTRAINT notification_email_policy_category_check CHECK(category IN
 ('attendance','claims','delegation','leave','letters','notice','offboarding','onboarding','payroll','performance','profile','readiness','review','rewards','toil','employee_master_reports'));
ALTER TABLE notification_pref ALTER COLUMN recipient_employment_id DROP NOT NULL;
ALTER TABLE notification_pref ADD COLUMN recipient_user_id uuid REFERENCES app_user(id),
 ADD COLUMN email_consent_issuer text,ADD COLUMN email_consent_subject text,
 ADD COLUMN email_consent_address_hash text,ADD COLUMN email_consent_verified_at timestamptz;
ALTER TABLE notification_pref ADD CONSTRAINT notification_pref_audience_xor CHECK(
 (recipient_employment_id IS NOT NULL AND recipient_user_id IS NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND category='letters' AND channel='email'));
CREATE UNIQUE INDEX notification_pref_user_uq ON notification_pref(tenant_id,recipient_user_id,category,channel);
CREATE FUNCTION app.letter_email_consent_identity(issuer text,subject text,address_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
  JOIN public.app_external_identity i ON i.app_user_id=u.id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  AND i.issuer=$1 AND i.subject=$2 AND i.revoked_at IS NULL
  AND encode(sha256(convert_to(lower(p.primary_email),'UTF8')),'hex')=$3)
$$;
REVOKE ALL ON FUNCTION app.letter_email_consent_identity(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_email_consent_identity(text,text,text) TO ai_hr_app;
CREATE POLICY notification_pref_letter_account ON notification_pref FOR ALL USING
 (tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND category='letters' AND channel='email' AND app.principal_snapshot_current())
 WITH CHECK (tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND recipient_employment_id IS NULL AND category='letters' AND channel='email' AND app.principal_snapshot_current());
CREATE FUNCTION app.guard_letter_email_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE changed boolean;
BEGIN
 IF TG_OP='UPDATE' AND OLD.recipient_user_id IS NOT NULL THEN
  IF (NEW.tenant_id,NEW.recipient_user_id,NEW.recipient_employment_id,NEW.category,NEW.channel) IS DISTINCT FROM
     (OLD.tenant_id,OLD.recipient_user_id,OLD.recipient_employment_id,OLD.category,OLD.channel) THEN
   RAISE EXCEPTION 'Account email preference identity is immutable' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.recipient_user_id IS NULL THEN RETURN NEW;END IF;
 IF NEW.recipient_user_id IS DISTINCT FROM app.current_user_id() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Account email preference unavailable' USING ERRCODE='42501';END IF;
 IF NEW.email_locale NOT IN ('en','ms','zh','ta','th','vi') THEN RAISE EXCEPTION 'Invalid email language';END IF;
 IF NEW.enabled THEN
  IF NOT app.letter_email_consent_identity(NEW.email_consent_issuer,NEW.email_consent_subject,NEW.email_consent_address_hash) THEN
   RAISE EXCEPTION 'Account email identity unavailable' USING ERRCODE='42501';END IF;
  changed:=TG_OP='INSERT';
  IF TG_OP='UPDATE' THEN changed:=NOT OLD.enabled OR (NEW.email_consent_issuer,NEW.email_consent_subject,NEW.email_consent_address_hash) IS DISTINCT FROM (OLD.email_consent_issuer,OLD.email_consent_subject,OLD.email_consent_address_hash);END IF;
  NEW.email_consent_user_id:=app.current_user_id();
  IF changed THEN NEW.email_after_sequence:=app.notification_email_watermark();NEW.email_consent_verified_at:=now();
  ELSE NEW.email_after_sequence:=OLD.email_after_sequence;NEW.email_consent_verified_at:=OLD.email_consent_verified_at;END IF;
 ELSE
  NEW.email_consent_user_id:=NULL;NEW.email_after_sequence:=NULL;NEW.email_consent_issuer:=NULL;NEW.email_consent_subject:=NULL;NEW.email_consent_address_hash:=NULL;NEW.email_consent_verified_at:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_letter_email_consent() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER letter_email_consent_guard BEFORE INSERT OR UPDATE ON notification_pref FOR EACH ROW EXECUTE FUNCTION app.guard_letter_email_consent();
--> statement-breakpoint
ALTER TABLE notification_delivery ADD COLUMN letter_prepared_stamp text,ADD COLUMN letter_prepared_until timestamptz;
-- A short-lived commercial witness is produced by the canonical TypeScript entitlement resolver.
-- Configuration changes invalidate it immediately; time-based expiry bounds the lease separately.
CREATE FUNCTION identity_email.letter_commercial_stamp(wanted_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'tenant',(SELECT jsonb_build_array(t.id,t.status) FROM public.tenant t WHERE t.id=wanted_tenant),
  'modules',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.tenant_module m WHERE m.tenant_id=wanted_tenant),
  'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM public.tenant_setting s WHERE s.tenant_id=wanted_tenant),
  'catalog',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.code),'[]'::jsonb) FROM public.module m),
  'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM public.setting_definition s)
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION identity_email.letter_commercial_stamp(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION identity_email.letter_job_current(wanted_tenant uuid,wanted_job uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET TimeZone='Asia/Kuala_Lumpur' AS $$
DECLARE j public.letter_job%ROWTYPE;l public.letter_record%ROWTYPE;p jsonb;delegation public.letter_approval_decision%ROWTYPE;suffix text;expected_key text;stage_time timestamptz;
BEGIN
 SELECT * INTO j FROM public.letter_job WHERE id=wanted_job AND tenant_id=wanted_tenant AND kind<>'eventDraft' AND status<>'cancelled';IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO l FROM public.letter_record WHERE id=j.letter_id AND tenant_id=j.tenant_id AND company_id=j.company_id;IF NOT FOUND THEN RETURN false;END IF;
 IF l.state NOT IN ('issued','void') AND NOT app.letter_automation_source_current_at(wanted_tenant,l.id) THEN RETURN false;END IF;
 SELECT config.policy INTO p FROM public.letter_generation_batch b JOIN public.letter_policy_version config ON config.id=b.policy_version_id AND config.tenant_id=b.tenant_id WHERE b.id=l.batch_id AND b.tenant_id=l.tenant_id;
 IF p IS NULL OR (p->>'emailNotifications')::boolean IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=j.recipient_user_id AND u.tenant_id=j.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN false;END IF;
 IF j.payload->>'purpose'='draftCreated' THEN RETURN app.letter_draft_created_job_current(wanted_tenant,wanted_job);END IF;
 IF j.payload->>'purpose'='recipientAcknowledgement' THEN RETURN app.letter_acknowledgement_job_current(wanted_tenant,wanted_job);END IF;
 IF j.payload->>'purpose'='creatorDecision' THEN
  IF j.kind<>'notification' OR j.recipient_user_id<>l.created_by OR l.state NOT IN ('returned','rejected','approved') OR j.payload->>'outcome' IS DISTINCT FROM l.state OR j.payload->>'revisionId' IS DISTINCT FROM l.current_revision_id::text THEN RETURN false;END IF;
  IF j.dedupe_key<>l.id::text||':'||l.current_revision_id::text||':creator:'||(j.payload->>'decisionId') OR NOT EXISTS(
   SELECT 1 FROM public.letter_approval_decision d JOIN public.domain_event e ON e.id=j.source_event_id AND e.tenant_id=d.tenant_id AND e.aggregate_type='letter' AND e.aggregate_id=d.letter_id
   WHERE d.id::text=j.payload->>'decisionId' AND d.tenant_id=l.tenant_id AND d.letter_id=l.id AND d.revision_id=l.current_revision_id
   AND d.action=(CASE l.state WHEN 'returned' THEN 'return' WHEN 'rejected' THEN 'reject' ELSE 'approve' END)
   AND e.event_type='letter.approval.'||d.action AND e.payload->>'decisionId'=d.id::text AND e.payload->>'revisionId'=d.revision_id::text) THEN RETURN false;END IF;
  RETURN app.letter_creator_eligible_at(wanted_tenant,j.recipient_user_id,l.company_id,l.confidential);
 END IF;
 IF j.payload ? 'artifactId' THEN
  IF l.state<>'issued' OR j.kind NOT IN ('notification','acknowledgementReminder') OR NOT EXISTS(
   SELECT 1 FROM public.letter_artifact a JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE a.id::text=j.payload->>'artifactId' AND a.letter_id=l.id AND a.tenant_id=l.tenant_id AND a.revision_id=l.current_revision_id AND u.id=j.recipient_user_id) THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||(j.payload->>'artifactId')||':issued:'||j.recipient_user_id::text||CASE WHEN j.kind='acknowledgementReminder' THEN ':acknowledgement' ELSE '' END;
  IF j.dedupe_key<>expected_key THEN RETURN false;END IF;
  IF j.kind='acknowledgementReminder' THEN
   IF p->>'acknowledgement'='none' OR l.issued_at+(p->>'acknowledgementDueDays')::integer*interval '1 day'>now() OR EXISTS(
    SELECT 1 FROM public.letter_recipient_event e WHERE e.tenant_id=l.tenant_id AND e.letter_id=l.id AND e.artifact_id::text=j.payload->>'artifactId'
     AND e.kind=(CASE WHEN p->>'acknowledgement'='signature' THEN 'signed' ELSE 'acknowledged' END)) THEN RETURN false;END IF;
  END IF;RETURN true;
 END IF;
 IF l.state<>'submitted' OR j.payload->>'revisionId' IS DISTINCT FROM l.current_revision_id::text OR j.payload->>'stageIndex' IS DISTINCT FROM l.stage_index::text OR j.kind NOT IN ('notification','approvalReminder','escalation') THEN RETURN false;END IF;
 IF NOT app.letter_permission_for_user_at(wanted_tenant,j.recipient_user_id,l.company_id,'read') OR NOT app.letter_permission_for_user_at(wanted_tenant,j.recipient_user_id,l.company_id,'approve') OR
  (l.confidential AND NOT app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=l.tenant_id AND r.app_user_id=j.recipient_user_id),l.company_id)) THEN RETURN false;END IF;
 SELECT * INTO delegation FROM public.letter_approval_decision d WHERE d.letter_id=l.id AND d.tenant_id=l.tenant_id AND d.revision_id=l.current_revision_id AND d.stage_index=l.stage_index AND d.action='delegate' ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
 suffix:=CASE WHEN delegation.id IS NOT NULL THEN ':delegation:'||delegation.id::text ELSE '' END;
 IF j.kind='escalation' THEN
  IF p->>'escalationUserId' IS DISTINCT FROM j.recipient_user_id::text THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||l.current_revision_id::text||':'||l.stage_index::text||':escalation'||suffix;
 ELSE
  IF j.recipient_user_id=l.created_by OR (delegation.id IS NOT NULL AND delegation.delegated_to<>j.recipient_user_id) OR
   (delegation.id IS NULL AND coalesce(p->'stages'->l.stage_index->'userIds' ? j.recipient_user_id::text,false) IS NOT TRUE) THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||l.current_revision_id::text||':stage:'||l.stage_index::text||':'||j.recipient_user_id::text||suffix||CASE WHEN j.kind='approvalReminder' THEN ':reminder' ELSE '' END;
 END IF;
 IF j.dedupe_key<>expected_key THEN RETURN false;END IF;
 IF j.kind<>'notification' THEN
  IF l.stage_index=0 THEN stage_time:=l.submitted_at;ELSE SELECT d.created_at INTO stage_time FROM public.letter_approval_decision d WHERE d.letter_id=l.id AND d.tenant_id=l.tenant_id AND d.revision_id=l.current_revision_id AND d.stage_index=l.stage_index-1 AND d.action='approve';END IF;
  IF stage_time IS NULL OR stage_time+(CASE WHEN j.kind='escalation' THEN (p->>'approvalDueHours')::integer ELSE (p->>'reminderHours')::integer END)*interval '1 hour'>now() THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
REVOKE ALL ON FUNCTION identity_email.letter_job_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.letter_email_enqueue(wanted_notification uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE added integer;
BEGIN
 IF NOT app.letter_notification_storage_owner() THEN RAISE EXCEPTION 'Letter email enqueue requires its maintenance connection' USING ERRCODE='42501';END IF;
 INSERT INTO public.notification_delivery(tenant_id,notification_id,channel,recipient_user_id,source_event_id,kind,category)
 SELECT n.tenant_id,n.id,'email',n.recipient_user_id,n.source_event_id,n.kind,'letters'
 FROM public.notification n JOIN public.domain_event e ON e.id=n.source_event_id AND e.tenant_id=n.tenant_id
 JOIN public.app_user u ON u.id=n.recipient_user_id AND u.tenant_id=n.tenant_id AND u.archived_at IS NULL
 JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 JOIN public.notification_pref pref ON pref.tenant_id=n.tenant_id AND pref.recipient_user_id=u.id AND pref.recipient_employment_id IS NULL AND pref.category='letters' AND pref.channel='email' AND pref.enabled AND pref.email_consent_user_id=u.id
 JOIN public.notification_email_policy policy ON policy.tenant_id=n.tenant_id AND policy.category='letters' AND policy.enabled
 WHERE n.id=wanted_notification AND n.tenant_id=app.current_tenant_id() AND n.letter_job_id IS NOT NULL
 AND pref.email_consent_verified_at IS NOT NULL AND e.sequence>pref.email_after_sequence AND e.sequence>policy.after_sequence
 AND encode(sha256(convert_to(lower(p.primary_email),'UTF8')),'hex')=pref.email_consent_address_hash
 AND EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.app_user_id=u.id AND i.issuer=pref.email_consent_issuer AND i.subject=pref.email_consent_subject AND i.revoked_at IS NULL)
 AND identity_email.letter_job_current(n.tenant_id,n.letter_job_id) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;RETURN added=1;
END $$;
REVOKE ALL ON FUNCTION app.letter_email_enqueue(uuid) FROM PUBLIC,ai_hr_app;
-- Web administrators may review/retry metadata but cannot mint a private send lease or a commercial witness.
CREATE FUNCTION app.guard_letter_email_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.category='letters' AND NOT app.letter_notification_storage_owner() THEN RAISE EXCEPTION 'Letter email projection requires its maintenance connection' USING ERRCODE='42501';END IF;RETURN NEW;
 END IF;
 IF OLD.category='letters' OR NEW.category='letters' THEN
  IF (NEW.tenant_id,NEW.notification_id,NEW.channel,NEW.recipient_user_id,NEW.source_event_id,NEW.kind,NEW.category) IS DISTINCT FROM
     (OLD.tenant_id,OLD.notification_id,OLD.channel,OLD.recipient_user_id,OLD.source_event_id,OLD.kind,OLD.category) THEN RAISE EXCEPTION 'Letter email routing is immutable' USING ERRCODE='42501';END IF;
  IF ((NEW.letter_prepared_stamp,NEW.letter_prepared_until) IS DISTINCT FROM (OLD.letter_prepared_stamp,OLD.letter_prepared_until) OR (NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token)) AND NOT app.letter_notification_storage_owner() THEN
   RAISE EXCEPTION 'Letter email lease requires its maintenance connection' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_letter_email_delivery() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER letter_email_delivery_guard BEFORE INSERT OR UPDATE ON notification_delivery FOR EACH ROW EXECUTE FUNCTION app.guard_letter_email_delivery();
CREATE OR REPLACE FUNCTION app.notification_email_delivery_authorized(p_notification uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM public.notification n WHERE n.id=p_notification AND n.tenant_id=app.current_tenant_id() AND
  (n.recipient_user_id IS NULL AND app.is_admin() AND app.can_admin_employment(n.recipient_employment_id) OR
   n.recipient_user_id IS NOT NULL AND n.letter_job_id IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin_for(n.company_id)))
$$;
--> statement-breakpoint
CREATE FUNCTION identity_email.letter_delivery_target(p_id uuid,p_token uuid,p_issuer text)
RETURNS TABLE(user_id uuid,subject text,email text,category text,link_path text,severity text,locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='Asia/Kuala_Lumpur' AS $$
 SELECT u.id,i.subject,p.primary_email,d.category,n.link_path,n.severity::text,pref.email_locale
 FROM public.notification_delivery d JOIN public.notification n ON n.id=d.notification_id AND n.tenant_id=d.tenant_id AND n.recipient_user_id=d.recipient_user_id AND n.source_event_id=d.source_event_id AND n.kind=d.kind
 JOIN public.domain_event e ON e.id=d.source_event_id AND e.tenant_id=d.tenant_id
 JOIN public.app_user u ON u.id=d.recipient_user_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL
 JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 JOIN public.tenant t ON t.id=d.tenant_id AND t.status IN ('active','trial')
 JOIN public.notification_pref pref ON pref.tenant_id=d.tenant_id AND pref.recipient_user_id=u.id AND pref.recipient_employment_id IS NULL AND pref.category='letters' AND pref.channel='email' AND pref.enabled AND pref.email_consent_user_id=u.id
 JOIN public.notification_email_policy policy ON policy.tenant_id=d.tenant_id AND policy.category='letters' AND policy.enabled
 JOIN public.app_external_identity i ON i.app_user_id=u.id AND i.issuer=p_issuer AND i.issuer=pref.email_consent_issuer AND i.subject=pref.email_consent_subject AND i.revoked_at IS NULL
 WHERE d.id=p_id AND d.lease_token=p_token AND d.category='letters' AND d.channel='email' AND d.status='pending'
 AND d.started_at IS NULL AND d.attempts<5 AND d.lease_until>now() AND d.letter_prepared_until>now()
 AND d.letter_prepared_stamp=identity_email.letter_commercial_stamp(d.tenant_id)
 AND pref.email_consent_verified_at IS NOT NULL AND e.sequence>pref.email_after_sequence AND e.sequence>policy.after_sequence
 AND encode(sha256(convert_to(lower(p.primary_email),'UTF8')),'hex')=pref.email_consent_address_hash
 AND identity_email.letter_job_current(d.tenant_id,n.letter_job_id)
$$;
REVOKE ALL ON FUNCTION identity_email.letter_delivery_target(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
-- Preserve the current employment transport verbatim behind the same public nonce-bound entry point.
DO $$ DECLARE definition text;copied text;BEGIN
 SELECT pg_get_functiondef('identity_email.delivery_target(uuid,uuid,text)'::regprocedure) INTO definition;
 copied:=replace(definition,'FUNCTION identity_email.delivery_target(','FUNCTION identity_email.delivery_target_employment(');
 IF copied=definition THEN RAISE EXCEPTION 'Workflow target definition could not be preserved';END IF;EXECUTE copied;
END $$;
REVOKE ALL ON FUNCTION identity_email.delivery_target_employment(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION identity_email.delivery_target(p_id uuid,p_token uuid,p_issuer text)
RETURNS TABLE(user_id uuid,subject text,email text,category text,link_path text,severity text,locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='Asia/Kuala_Lumpur' AS $$
 SELECT * FROM identity_email.delivery_target_employment(p_id,p_token,p_issuer)
 UNION ALL SELECT * FROM identity_email.letter_delivery_target(p_id,p_token,p_issuer)
$$;
REVOKE ALL ON FUNCTION identity_email.delivery_target(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_letter_mail_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT to_regprocedure('identity_email.letter_delivery_target(uuid,uuid,text)') IS NOT NULL
  AND to_regprocedure('app.internal_auth_notification_target(uuid,uuid,text)') IS NOT NULL
  AND to_regprocedure('app.internal_auth_notification_start(uuid,uuid,text,jsonb)') IS NOT NULL
  AND has_function_privilege('ai_hr_app','app.internal_auth_notification_target(uuid,uuid,text)','EXECUTE')
  AND has_function_privilege('ai_hr_app','app.internal_auth_notification_summary(uuid,uuid,text)','EXECUTE')
  AND has_function_privilege('ai_hr_app','app.internal_auth_notification_start(uuid,uuid,text,jsonb)','EXECUTE')
  AND has_function_privilege('ai_hr_app','app.internal_auth_notification_finish(uuid,uuid,text,text)','EXECUTE')
$$;
REVOKE ALL ON FUNCTION app.internal_auth_letter_mail_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.internal_auth_letter_mail_ready() TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE letter_automation_rule_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),template_id uuid NOT NULL REFERENCES letter_template(id),
 trigger text NOT NULL CHECK(trigger IN ('probation_due','confirmation_applied','promotion_applied')),ordinal integer NOT NULL CHECK(ordinal>0),enabled boolean NOT NULL,start_on date NOT NULL,after_sequence bigint NOT NULL DEFAULT 0 CHECK(after_sequence>=0),
 custom_values jsonb NOT NULL CHECK(jsonb_typeof(custom_values)='object' AND octet_length(custom_values::text)<=262144),confidential boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_automation_rule_version_uq UNIQUE(tenant_id,company_id,template_id,trigger,ordinal)
);
ALTER TABLE letter_automation_rule_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_automation_rule_read ON letter_automation_rule_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.letter_permission(company_id,'read') AND app.letter_permission(company_id,'settings') AND (NOT confidential OR app.can_admin_payroll_for(company_id)));
CREATE POLICY letter_automation_rule_insert ON letter_automation_rule_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.letter_permission(company_id,'read') AND app.letter_permission(company_id,'settings') AND (NOT enabled OR app.letter_permission(company_id,'generate') AND app.access_workforce_company(company_id,'workforce.view')) AND (NOT confidential OR app.can_admin_payroll_for(company_id)));
GRANT SELECT,INSERT ON letter_automation_rule_version TO ai_hr_app;
CREATE TRIGGER letter_automation_rule_immutable BEFORE UPDATE OR DELETE ON letter_automation_rule_version FOR EACH ROW EXECUTE FUNCTION app.letter_immutable();
--> statement-breakpoint
CREATE FUNCTION app.letter_automation_rule_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE next_ordinal integer;current_version uuid;previous_rule public.letter_automation_rule_version%ROWTYPE;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current()
  OR NOT app.letter_permission(NEW.company_id,'settings') OR NOT app.letter_permission(NEW.company_id,'read')
  OR (NEW.enabled AND (NOT app.letter_permission(NEW.company_id,'generate') OR NOT app.access_workforce_company(NEW.company_id,'workforce.view')))
 THEN RAISE EXCEPTION 'Letter automation configuration permission unavailable' USING ERRCODE='insufficient_privilege';END IF;
 PERFORM 1 FROM public.letter_template t JOIN public.company co ON co.id=t.company_id AND co.tenant_id=t.tenant_id
  WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.company_id=NEW.company_id AND co.archived_at IS NULL FOR UPDATE OF t;
 IF NOT FOUND THEN RAISE EXCEPTION 'Letter automation template scope mismatch' USING ERRCODE='check_violation';END IF;
 SELECT r.* INTO previous_rule FROM public.letter_automation_rule_version r WHERE r.tenant_id=NEW.tenant_id AND r.company_id=NEW.company_id AND r.template_id=NEW.template_id AND r.trigger=NEW.trigger ORDER BY r.ordinal DESC LIMIT 1;
 next_ordinal:=coalesce(previous_rule.ordinal,0)+1;
 IF NEW.ordinal<>next_ordinal THEN RAISE EXCEPTION 'Create the next letter automation version' USING ERRCODE='check_violation';END IF;
 IF NEW.enabled AND NEW.start_on<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Letter automation activation cannot backfill past dates' USING ERRCODE='check_violation';END IF;
 IF NEW.enabled THEN
 SELECT v.id INTO current_version FROM public.letter_template_version v JOIN public.letter_template t ON t.id=v.template_id AND t.tenant_id=v.tenant_id
  WHERE v.template_id=NEW.template_id AND v.tenant_id=NEW.tenant_id AND v.company_id=NEW.company_id AND v.status='approved'
   AND (NOT NEW.enabled OR NOT t.deactivated AND v.effective_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY v.ordinal DESC LIMIT 1;
 IF current_version IS NULL THEN RAISE EXCEPTION 'Letter automation requires an approved template' USING ERRCODE='check_violation';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(NEW.custom_values))>200 OR EXISTS(
  SELECT 1 FROM jsonb_each(NEW.custom_values) input WHERE NOT EXISTS(
   SELECT 1 FROM public.letter_template_field binding JOIN public.letter_merge_field_version field ON field.id=binding.field_version_id AND field.tenant_id=binding.tenant_id
    WHERE binding.tenant_id=NEW.tenant_id AND binding.template_version_id=current_version AND field.key=input.key AND field.definition->>'source' LIKE 'custom.%')
 ) THEN RAISE EXCEPTION 'Letter automation values must bind custom template fields' USING ERRCODE='check_violation';END IF;
 SELECT EXISTS(SELECT 1 FROM public.letter_template_field binding JOIN public.letter_merge_field_version field ON field.id=binding.field_version_id AND field.tenant_id=binding.tenant_id
  WHERE binding.tenant_id=NEW.tenant_id AND binding.template_version_id=current_version AND coalesce((field.definition->>'sensitive')::boolean,true)) INTO NEW.confidential;
 ELSE
  IF previous_rule.id IS NULL THEN RAISE EXCEPTION 'No configured letter automation to disable' USING ERRCODE='check_violation';END IF;
  NEW.custom_values:=previous_rule.custom_values;NEW.confidential:=previous_rule.confidential;
 END IF;
 IF NEW.confidential AND NOT app.can_admin_payroll_for(NEW.company_id) THEN RAISE EXCEPTION 'Confidential letter automation permission unavailable' USING ERRCODE='insufficient_privilege';END IF;
 -- The database stamps the tenant's committed event watermark; a client cannot request history replay.
 SELECT coalesce(max(sequence),0) INTO NEW.after_sequence FROM public.domain_event WHERE tenant_id=NEW.tenant_id;
 NEW.created_at:=now();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.letter_automation_rule_bind() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER letter_automation_rule_bind BEFORE INSERT ON letter_automation_rule_version FOR EACH ROW EXECUTE FUNCTION app.letter_automation_rule_bind();
--> statement-breakpoint
-- Resolve latest identity before confidential row filtering; hidden versions never revive an older rule.
CREATE FUNCTION app.letter_automation_latest_version(co uuid,root uuid,kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.id FROM public.letter_automation_rule_version r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=co AND r.template_id=root AND r.trigger=kind
  AND app.letter_permission(co,'read') AND app.letter_permission(co,'settings') ORDER BY r.ordinal DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.letter_automation_latest_version(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_automation_latest_version(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Prospective automation authority is derived from persisted grants. This private predicate
-- does not adopt the rule author's identity or widen a deliberately narrowed web session.
CREATE FUNCTION app.letter_automation_owner_eligible_at(wanted_tenant uuid,subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.letter_creator_eligible_at(wanted_tenant,subject,co,confidential) AND EXISTS(
  SELECT 1 FROM public.role_assignment r JOIN public.access_capability c ON c.id='workforce.view'
   WHERE r.tenant_id=wanted_tenant AND r.app_user_id=subject AND r.role::text IN ('hr_admin','super_admin') AND app.access_scope_covers(r.company_id,co,wanted_tenant)
    AND (NOT c.supported OR app.access_allowed_for_tenant(wanted_tenant,subject,c.id,co)))
$$;
REVOKE ALL ON FUNCTION app.letter_automation_owner_eligible_at(uuid,uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only the real storage owner with NO human principal can consume an explicitly
-- configured and registered draft intent. Ordinary web roles cannot mint these jobs.
CREATE FUNCTION app.letter_automation_insert_allowed(table_name text,row_data jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.letter_job;rule public.letter_automation_rule_version;b public.letter_generation_batch;l public.letter_record;v public.letter_template_version;p public.letter_policy_version;subject uuid;
BEGIN
 IF app.current_user_id() IS NOT NULL OR NOT app.letter_notification_storage_owner() OR row_data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RETURN false;END IF;
 IF table_name='letter_job' THEN
  IF row_data->>'kind'='notification' AND row_data->'payload'->>'purpose'='draftCreated' THEN
   RETURN row_data->>'status'='queued' AND (row_data->>'attempts')::integer=0 AND row_data->>'lease_token' IS NULL AND row_data->>'lease_until' IS NULL AND app.letter_draft_created_notice_valid(app.current_tenant_id(),row_data);
  END IF;
  IF row_data->>'kind'<>'eventDraft' OR row_data->>'letter_id' IS NOT NULL OR row_data->>'status'<>'queued' OR (row_data->>'attempts')::integer<>0 OR row_data->>'lease_token' IS NOT NULL OR row_data->>'lease_until' IS NOT NULL THEN RETURN false;END IF;
  SELECT * INTO rule FROM public.letter_automation_rule_version WHERE id=(row_data->'payload'->>'ruleVersionId')::uuid AND tenant_id=app.current_tenant_id();
  subject:=(row_data->'payload'->>'employmentId')::uuid;
  IF rule.id IS NULL OR row_data->>'company_id'<>rule.company_id::text OR row_data->>'recipient_user_id' IS DISTINCT FROM rule.created_by::text
   OR row_data->'payload'->>'sourceFingerprint' !~ '^[0-9a-f]{64}$' OR row_data->'payload'->>'sourceAsOfDate' IS NULL OR row_data->'payload'->>'batchId' IS NULL
   OR row_data->>'dedupe_key' IS DISTINCT FROM 'automation:'||rule.template_id::text||':'||rule.trigger||':'||subject::text||':'||(row_data->'payload'->>'sourceFingerprint')||':'||rule.id::text
   OR row_data->>'source_event_id' IS DISTINCT FROM row_data->'payload'->>'sourceEventId'
   OR (row_data->>'source_event_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=(row_data->>'source_event_id')::uuid AND event.tenant_id=rule.tenant_id AND event.subject_employment_id=subject AND event.sequence=(row_data->'payload'->>'sourceSequence')::bigint))
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=rule.tenant_id AND e.company_id=rule.company_id)
  THEN RETURN false;END IF;
 ELSE
  IF table_name='letter_generation_batch' THEN SELECT * INTO j FROM public.letter_job WHERE id=(row_data->>'operation_key')::uuid;
  ELSIF table_name='letter_record' THEN SELECT * INTO b FROM public.letter_generation_batch WHERE id=(row_data->>'batch_id')::uuid;SELECT * INTO j FROM public.letter_job WHERE id=b.operation_key;
  ELSIF table_name='letter_revision' THEN SELECT * INTO l FROM public.letter_record WHERE id=(row_data->>'letter_id')::uuid;SELECT * INTO b FROM public.letter_generation_batch WHERE id=l.batch_id;SELECT * INTO j FROM public.letter_job WHERE id=b.operation_key;
  ELSIF table_name='letter_counter' THEN
   IF row_data->>'year'<>to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY') OR (row_data->>'next_value')::bigint<>1 THEN RETURN false;END IF;
   SELECT * INTO j FROM public.letter_job WHERE tenant_id=app.current_tenant_id() AND kind='eventDraft' AND status IN ('queued','failed') AND lease_token IS NOT NULL AND lease_until>now() ORDER BY created_at,id LIMIT 1;
  ELSE RETURN false;END IF;
  IF j.id IS NULL OR j.tenant_id<>app.current_tenant_id() OR j.kind<>'eventDraft' OR j.status NOT IN ('queued','failed') OR j.lease_token IS NULL OR j.lease_until<=now() THEN RETURN false;END IF;
  SELECT * INTO rule FROM public.letter_automation_rule_version WHERE id=(j.payload->>'ruleVersionId')::uuid AND tenant_id=j.tenant_id AND company_id=j.company_id;subject:=(j.payload->>'employmentId')::uuid;
  IF table_name='letter_generation_batch' THEN
   SELECT * INTO v FROM public.letter_template_version WHERE id=(row_data->>'template_version_id')::uuid;SELECT * INTO p FROM public.letter_policy_version WHERE id=(row_data->>'policy_version_id')::uuid;
   IF row_data->>'id' IS DISTINCT FROM j.payload->>'batchId' OR row_data->>'company_id' IS DISTINCT FROM rule.company_id::text OR row_data->>'created_by' IS DISTINCT FROM rule.created_by::text OR row_data->>'source_event_id' IS DISTINCT FROM j.source_event_id::text
    OR row_data->'selection' IS DISTINCT FROM jsonb_build_object('employmentIds',jsonb_build_array(subject::text),'customValues',jsonb_build_object(subject::text,rule.custom_values),'sourceAsOfDate',j.payload->>'sourceAsOfDate')
    OR v.template_id IS DISTINCT FROM rule.template_id OR p.id IS NULL OR EXISTS(SELECT 1 FROM public.letter_policy_version newer WHERE newer.tenant_id=p.tenant_id AND newer.company_id=p.company_id AND newer.category=p.category AND newer.ordinal>p.ordinal)
   THEN RETURN false;END IF;
  ELSIF table_name='letter_record' THEN
   IF b.id::text IS DISTINCT FROM j.payload->>'batchId' OR row_data->>'company_id' IS DISTINCT FROM rule.company_id::text OR row_data->>'employment_id' IS DISTINCT FROM subject::text OR row_data->>'created_by' IS DISTINCT FROM rule.created_by::text OR row_data->>'original_letter_id' IS NOT NULL
    OR (row_data->>'legal_hold')::boolean OR (row_data->>'retain_until')::date IS DISTINCT FROM (j.payload->>'sourceAsOfDate')::date+(SELECT (policy->>'retentionDays')::integer FROM public.letter_policy_version WHERE id=b.policy_version_id)
    OR (row_data->>'confidential')::boolean IS DISTINCT FROM EXISTS(SELECT 1 FROM public.letter_template_field binding JOIN public.letter_merge_field_version field ON field.id=binding.field_version_id AND field.tenant_id=binding.tenant_id WHERE binding.template_version_id=b.template_version_id AND binding.tenant_id=b.tenant_id AND coalesce((field.definition->>'sensitive')::boolean,true))
   THEN RETURN false;END IF;
  ELSIF table_name='letter_revision' THEN
   IF b.id::text IS DISTINCT FROM j.payload->>'batchId' OR l.employment_id IS DISTINCT FROM subject OR l.created_by IS DISTINCT FROM rule.created_by OR l.current_revision_id IS NOT NULL OR l.state<>'draft' OR (row_data->>'ordinal')::integer<>1 OR row_data->>'created_by' IS DISTINCT FROM rule.created_by::text THEN RETURN false;END IF;
  END IF;
 END IF;
 RETURN coalesce(rule.enabled AND rule.tenant_id=app.current_tenant_id() AND app.letter_automation_owner_eligible_at(rule.tenant_id,rule.created_by,rule.company_id,rule.confidential)
  AND NOT EXISTS(SELECT 1 FROM public.letter_automation_rule_version newer WHERE newer.tenant_id=rule.tenant_id AND newer.company_id=rule.company_id AND newer.template_id=rule.template_id AND newer.trigger=rule.trigger AND newer.ordinal>rule.ordinal),false);
END $$;
REVOKE ALL ON FUNCTION app.letter_automation_insert_allowed(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_automation_transition_allowed(old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.letter_generation_batch;j public.letter_job;r public.letter_revision;
BEGIN
 IF app.current_user_id() IS NOT NULL OR NOT app.letter_notification_storage_owner() OR old_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR (new_row->>'lock_version')::integer<>(old_row->>'lock_version')::integer+1 THEN RETURN false;END IF;
 SELECT * INTO b FROM public.letter_generation_batch WHERE id=(old_row->>'batch_id')::uuid AND tenant_id=app.current_tenant_id();SELECT * INTO j FROM public.letter_job WHERE id=b.operation_key AND tenant_id=b.tenant_id AND kind='eventDraft';
 IF j.id IS NULL OR b.id::text IS DISTINCT FROM j.payload->>'batchId' OR old_row->>'employment_id' IS DISTINCT FROM j.payload->>'employmentId' OR j.lease_token IS NULL OR j.lease_until<=now() THEN RETURN false;END IF;
 IF j.status='completed' AND j.last_error='sourceChanged' AND old_row->>'state' IN ('draft','submitted','approved','returned','rejected') AND new_row->>'state'='withdrawn' AND new_row->>'stage_index'='0'
  AND new_row-ARRAY['state','stage_index','lock_version'] IS NOT DISTINCT FROM old_row-ARRAY['state','stage_index','lock_version'] THEN RETURN true;END IF;
 IF old_row->>'state'<>'draft' OR old_row->>'current_revision_id' IS NOT NULL OR new_row->>'current_revision_id' IS NULL OR new_row-ARRAY['current_revision_id','lock_version'] IS DISTINCT FROM old_row-ARRAY['current_revision_id','lock_version'] THEN RETURN false;END IF;
 SELECT * INTO r FROM public.letter_revision WHERE id=(new_row->>'current_revision_id')::uuid AND tenant_id=b.tenant_id AND letter_id=(old_row->>'id')::uuid AND ordinal=1 AND created_by=b.created_by;
 RETURN r.id IS NOT NULL AND app.letter_automation_insert_allowed('letter_revision',to_jsonb(r));
END $$;
REVOKE ALL ON FUNCTION app.letter_automation_transition_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Cancelled, never-created intents may be replaced after configuration changes.
-- A queued, failed or completed generation reserves its source across rule versions.
CREATE UNIQUE INDEX letter_automation_source_once_uq ON letter_job(tenant_id,(regexp_replace(dedupe_key,':[0-9a-f-]{36}$','')))
 WHERE kind='eventDraft' AND status IN ('queued','failed','completed');
--> statement-breakpoint
CREATE FUNCTION app.letter_automation_rule_metadata(subject uuid) RETURNS TABLE(owner_name text,eligible boolean,template_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.full_name,app.letter_automation_owner_eligible_at(r.tenant_id,r.created_by,r.company_id,r.confidential),t.code
 FROM public.letter_automation_rule_version r JOIN public.letter_template t ON t.id=r.template_id AND t.tenant_id=r.tenant_id JOIN public.app_user u ON u.id=r.created_by AND u.tenant_id=r.tenant_id LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=r.tenant_id
 WHERE r.id=subject AND r.tenant_id=app.current_tenant_id() AND app.letter_permission(r.company_id,'read') AND app.letter_permission(r.company_id,'settings') AND (NOT r.confidential OR app.can_admin_payroll_for(r.company_id))
$$;
REVOKE ALL ON FUNCTION app.letter_automation_rule_metadata(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_automation_rule_metadata(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Canonical SQL confirmation-date owner, shared by status/criteria readers and source guards.
-- Pure arguments only: granting execution exposes no personnel rows.
CREATE FUNCTION app.employment_confirmation_date(final_date date,normal_date date,probation_end date,provisional_end date) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(final_date,normal_date,probation_end,provisional_end) $$;
REVOKE ALL ON FUNCTION app.employment_confirmation_date(date,date,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_confirmation_date(date,date,date,date) TO ai_hr_app;
--> statement-breakpoint
-- Movement owns this narrow validation of an IMMUTABLE, already-applied fact. The
-- canonical projection classified it when the intent was registered. Applied facts
-- never become pending/superseded. Reversal or a changed configured behavior
-- invalidates the registered promotion/confirmation classification.
CREATE FUNCTION app.movement_applied_source_current(wanted_tenant uuid,subject uuid,movement uuid,source uuid,source_sequence bigint,expected_behavior text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.domain_event original JOIN public.domain_event applied ON applied.id=source AND applied.tenant_id=original.tenant_id AND applied.subject_employment_id=subject AND applied.sequence=source_sequence
  WHERE original.id=movement AND original.tenant_id=wanted_tenant AND original.subject_employment_id=subject
   AND (source=movement AND original.event_type<>'employment.movement.scheduled' OR original.event_type='employment.movement.scheduled' AND applied.event_type='employment.movement.applied' AND applied.payload->>'scheduledId'=original.id::text)
   AND expected_behavior IN ('promotion','confirmation')
   AND coalesce((SELECT kind.behaviour_kind FROM public.movement_event_type kind WHERE kind.tenant_id=wanted_tenant AND kind.code=coalesce(original.payload->'movement'->>'type',original.payload->>'type')),coalesce(original.payload->'movement'->>'type',original.payload->>'type'))=expected_behavior
   AND (expected_behavior='promotion' OR coalesce(original.payload->'movement'->>'type',original.payload->>'type')='confirmation')
   AND NOT EXISTS(SELECT 1 FROM public.domain_event reversal WHERE reversal.tenant_id=wanted_tenant AND reversal.subject_employment_id=subject AND reversal.event_type='employment.movement.reversed' AND reversal.payload->>'movementId'=original.id::text))
$$;
REVOKE ALL ON FUNCTION app.movement_applied_source_current(uuid,uuid,uuid,uuid,bigint,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A Letter party learns a boolean for this exact artifact workflow, never raw
-- personnel dates, movement payloads, compensation or another employee's data.
CREATE FUNCTION app.letter_automation_source_current_at(wanted_tenant uuid,subject uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.letter_record;b public.letter_generation_batch;j public.letter_job;r public.letter_automation_rule_version;e public.employment;
BEGIN
 SELECT * INTO l FROM public.letter_record WHERE id=subject AND tenant_id=wanted_tenant;
 IF l.id IS NULL THEN RETURN false;END IF;
 SELECT * INTO b FROM public.letter_generation_batch WHERE id=l.batch_id AND tenant_id=l.tenant_id;SELECT * INTO j FROM public.letter_job WHERE id=b.operation_key AND tenant_id=l.tenant_id AND kind='eventDraft';
 IF j.id IS NULL THEN RETURN true;END IF;
 SELECT * INTO r FROM public.letter_automation_rule_version WHERE id=(j.payload->>'ruleVersionId')::uuid AND tenant_id=l.tenant_id AND company_id=l.company_id;
 SELECT * INTO e FROM public.employment WHERE id=l.employment_id AND tenant_id=l.tenant_id AND company_id=l.company_id;
 IF r.id IS NULL OR e.id IS NULL OR j.company_id<>l.company_id OR b.id::text IS DISTINCT FROM j.payload->>'batchId' OR l.employment_id::text IS DISTINCT FROM j.payload->>'employmentId' OR j.status<>'completed' OR (j.payload->>'sourceAsOfDate')::date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RETURN false;END IF;
 IF r.trigger='probation_due' THEN
  RETURN j.source_event_id IS NULL AND j.payload->>'sourceKey'='probation:'||e.id::text||':'||(j.payload->>'sourceAsOfDate') AND app.employment_confirmation_date(e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on) IS NOT DISTINCT FROM (j.payload->>'sourceAsOfDate')::date;
 END IF;
 RETURN coalesce(j.payload->>'sourceKey' LIKE 'movement:%' AND j.source_event_id::text IS NOT DISTINCT FROM j.payload->>'sourceEventId'
  AND app.movement_applied_source_current(l.tenant_id,l.employment_id,substring(j.payload->>'sourceKey' from 10)::uuid,j.source_event_id,(j.payload->>'sourceSequence')::bigint,CASE r.trigger WHEN 'promotion_applied' THEN 'promotion' WHEN 'confirmation_applied' THEN 'confirmation' ELSE NULL END),false);
END $$;
REVOKE ALL ON FUNCTION app.letter_automation_source_current_at(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_automation_source_current(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=app.current_tenant_id()
  AND (app.letter_can_read(l.id) OR app.current_user_id() IS NULL AND app.letter_notification_storage_owner())
  AND app.letter_automation_source_current_at(l.tenant_id,l.id))
$$;
REVOKE ALL ON FUNCTION app.letter_automation_source_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_automation_source_current(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Explicit issuance authority covers ready/sealed letters, not unrelated drafts or
-- generic Personnel records. Confidential access remains enforced by letter_can_read.
CREATE OR REPLACE FUNCTION app.letter_staff_scope(co uuid,creator uuid,batch uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.is_admin_for(co) OR creator=app.current_user_id()
 OR (app.letter_permission(co,'issue') AND EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND l.company_id=co AND l.state IN ('approved','issued','void')))
 OR (app.letter_permission(co,'approve') AND (
  EXISTS(SELECT 1 FROM public.letter_generation_batch b JOIN public.letter_policy_version p ON p.id=b.policy_version_id,
   LATERAL jsonb_array_elements(p.policy->'stages') stage
   WHERE b.id=batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=co AND p.tenant_id=b.tenant_id AND (stage->'userIds' ? app.current_user_id()::text OR p.policy->>'escalationUserId'=app.current_user_id()::text))
  OR EXISTS(SELECT 1 FROM public.letter_approval_decision d WHERE d.letter_id=subject AND d.tenant_id=app.current_tenant_id() AND d.action='delegate' AND d.delegated_to=app.current_user_id())))
$$;
--> statement-breakpoint
-- Employee Document owner port: immutable artifact metadata only; no Personnel
-- record, document bytes, email address or arbitrary upload authority is returned.
CREATE FUNCTION app.letter_document_filing_target(subject uuid,sealed uuid)
RETURNS TABLE(employment_id uuid,title text,category text,description text,file_name text,size_bytes integer,document_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT l.employment_id,t.name,t.category,l.reference,regexp_replace(l.reference,'[^A-Za-z0-9._-]','_','g')||'.pdf',octet_length(a.content),
  (SELECT d.id FROM public.employee_document d WHERE d.letter_artifact_id=a.id AND d.tenant_id=l.tenant_id AND d.employment_id=l.employment_id)
 FROM public.letter_record l JOIN public.letter_artifact a ON a.letter_id=l.id AND a.tenant_id=l.tenant_id AND a.revision_id=l.current_revision_id
 JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id JOIN public.letter_template_version t ON t.id=b.template_version_id AND t.tenant_id=l.tenant_id
 JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id AND e.company_id=l.company_id
 WHERE l.id=subject AND a.id=sealed AND l.tenant_id=app.current_tenant_id() AND l.state='approved' AND app.principal_snapshot_current()
  AND app.letter_permission(l.company_id,'read') AND app.letter_permission(l.company_id,'issue') AND app.letter_can_read(l.id) AND app.letter_automation_source_current(l.id)
$$;
REVOKE ALL ON FUNCTION app.letter_document_filing_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_document_filing_target(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_document_pointer_allowed(row_data jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT row_data->>'tenant_id'=app.current_tenant_id()::text AND row_data->>'uploaded_by_user_id'=app.current_user_id()::text AND row_data->>'updated_by_user_id'=app.current_user_id()::text
  AND row_data->>'mime_type'='application/pdf' AND octet_length((row_data->>'content')::bytea)=0
  AND (row_data->>'created_at')::timestamptz=now() AND (row_data->>'updated_at')::timestamptz=now()
  AND EXISTS(SELECT 1 FROM public.letter_artifact a CROSS JOIN LATERAL app.letter_document_filing_target(a.letter_id,a.id) target
   WHERE a.id=(row_data->>'letter_artifact_id')::uuid AND a.tenant_id=app.current_tenant_id() AND target.employment_id::text=row_data->>'employment_id'
    AND target.title=row_data->>'title' AND target.category=row_data->>'category' AND target.description=row_data->>'description' AND target.file_name=row_data->>'file_name' AND target.size_bytes=(row_data->>'size_bytes')::integer)
$$;
REVOKE ALL ON FUNCTION app.letter_document_pointer_allowed(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_document_pointer_allowed(jsonb) TO ai_hr_app;
--> statement-breakpoint
DROP POLICY access_workforce_document_insert ON employee_document;
CREATE POLICY access_workforce_document_insert ON employee_document AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.access_workforce_employment(employment_id,'workforce.maintain') OR letter_artifact_id IS NOT NULL AND app.letter_document_pointer_allowed(to_jsonb(employee_document)));
CREATE OR REPLACE FUNCTION app.access_workforce_document_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.letter_artifact_id IS NOT NULL AND app.letter_document_pointer_allowed(to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF NOT app.access_workforce_storage_owner() THEN
  IF TG_OP='UPDATE' THEN
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.employment_id IS DISTINCT FROM OLD.employment_id THEN RAISE EXCEPTION 'Document subject cannot be reassigned' USING ERRCODE='42501';END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
   IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.access_workforce_employment(OLD.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.access_workforce_employment(NEW.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.letter_employee_accounts(subject uuid) RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id FROM public.letter_record l JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id AND e.company_id=l.company_id JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND l.state='issued' AND app.principal_snapshot_current() AND app.letter_permission(l.company_id,'read') AND app.letter_permission(l.company_id,'issue') AND app.letter_can_read(l.id) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;
REVOKE ALL ON FUNCTION app.letter_employee_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_employee_accounts(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_acknowledgement_target_eligible_at(wanted_tenant uuid,target uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=wanted_tenant AND l.state='issued'
  AND app.letter_permission_for_user_at(wanted_tenant,target,l.company_id,'read')
  AND (NOT l.confidential OR app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=wanted_tenant AND r.app_user_id=target),l.company_id))
  AND (l.created_by=target AND app.letter_permission_for_user_at(wanted_tenant,target,l.company_id,'generate') OR
   target=(SELECT e.actor_id FROM public.domain_event e JOIN public.letter_artifact a ON a.id::text=e.payload->>'artifactId' AND a.tenant_id=e.tenant_id AND a.letter_id=l.id AND a.revision_id=l.current_revision_id
    WHERE e.tenant_id=wanted_tenant AND e.aggregate_type='letter' AND e.aggregate_id=l.id AND e.event_type='letter.issued' AND e.actor_type='user' ORDER BY e.sequence LIMIT 1)
   AND app.letter_permission_for_user_at(wanted_tenant,target,l.company_id,'issue')))
$$;
REVOKE ALL ON FUNCTION app.letter_acknowledgement_target_eligible_at(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_acknowledgement_job_current(wanted_tenant uuid,wanted_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.letter_job j JOIN public.letter_record l ON l.id=j.letter_id AND l.tenant_id=j.tenant_id AND l.company_id=j.company_id
  JOIN public.letter_artifact a ON a.id::text=j.payload->>'artifactId' AND a.letter_id=l.id AND a.tenant_id=l.tenant_id AND a.revision_id=l.current_revision_id
  JOIN public.letter_recipient_event action ON action.id::text=j.payload->>'recipientEventId' AND action.letter_id=l.id AND action.tenant_id=l.tenant_id AND action.artifact_id=a.id AND action.content_hash=a.content_hash
  JOIN public.domain_event source ON source.id=j.source_event_id AND source.tenant_id=l.tenant_id AND source.aggregate_type='letter' AND source.aggregate_id=l.id AND source.event_type='letter.recipient.'||action.kind AND source.actor_id=action.actor_id AND source.actor_type='user'
  JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id JOIN public.letter_policy_version p ON p.id=b.policy_version_id AND p.tenant_id=l.tenant_id
  WHERE j.id=wanted_job AND j.tenant_id=wanted_tenant AND j.kind='notification' AND j.payload->>'purpose'='recipientAcknowledgement' AND j.status<>'cancelled' AND l.state='issued'
   AND action.kind IN ('acknowledged','signed') AND j.payload->>'outcome'=action.kind AND j.payload->>'revisionId'=l.current_revision_id::text
   AND action.kind=(CASE p.policy->>'acknowledgement' WHEN 'acknowledge' THEN 'acknowledged' WHEN 'signature' THEN 'signed' ELSE NULL END)
   AND source.payload->>'artifactId'=a.id::text AND source.payload->>'artifactHash'=a.content_hash AND source.payload->>'actorId'=action.actor_id::text AND source.payload->>'intent'=action.intent
   AND j.dedupe_key=l.id::text||':'||a.id::text||':ack:'||action.id::text||':'||j.recipient_user_id::text
   AND app.letter_acknowledgement_target_eligible_at(wanted_tenant,j.recipient_user_id,l.id))
$$;
REVOKE ALL ON FUNCTION app.letter_acknowledgement_job_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.queue_letter_acknowledgement_notices(action_id uuid,source_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE action public.letter_recipient_event;l public.letter_record;a public.letter_artifact;source public.domain_event;p jsonb;target uuid;issuer uuid;
BEGIN
 SELECT * INTO action FROM public.letter_recipient_event WHERE id=action_id AND tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND kind IN ('acknowledged','signed');
 SELECT * INTO l FROM public.letter_record WHERE id=action.letter_id AND tenant_id=app.current_tenant_id() AND state='issued';SELECT * INTO a FROM public.letter_artifact WHERE id=action.artifact_id AND letter_id=l.id AND tenant_id=l.tenant_id AND revision_id=l.current_revision_id;
 SELECT * INTO source FROM public.domain_event WHERE id=source_id AND tenant_id=l.tenant_id AND aggregate_type='letter' AND aggregate_id=l.id AND event_type='letter.recipient.'||action.kind AND actor_id=action.actor_id AND actor_type='user';
 IF action.id IS NULL OR a.id IS NULL OR source.id IS NULL OR NOT app.principal_snapshot_current() OR action.content_hash<>a.content_hash
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=l.employment_id AND e.tenant_id=l.tenant_id AND app.is_self_person(e.person_id))
  OR source.payload->>'artifactId' IS DISTINCT FROM a.id::text OR source.payload->>'artifactHash' IS DISTINCT FROM a.content_hash OR source.payload->>'actorId' IS DISTINCT FROM action.actor_id::text OR source.payload->>'intent' IS DISTINCT FROM action.intent
 THEN RAISE EXCEPTION 'Acknowledgement notification must bind the employee exact issued evidence' USING ERRCODE='42501';END IF;
 SELECT config.policy INTO p FROM public.letter_generation_batch b JOIN public.letter_policy_version config ON config.id=b.policy_version_id AND config.tenant_id=b.tenant_id WHERE b.id=l.batch_id AND b.tenant_id=l.tenant_id;
 IF NOT ((p->>'portalNotifications')::boolean OR (p->>'emailNotifications')::boolean) THEN RETURN;END IF;
 SELECT e.actor_id INTO issuer FROM public.domain_event e WHERE e.tenant_id=l.tenant_id AND e.aggregate_type='letter' AND e.aggregate_id=l.id AND e.event_type='letter.issued' AND e.payload->>'artifactId'=a.id::text AND e.actor_type='user' ORDER BY e.sequence LIMIT 1;
 FOR target IN SELECT DISTINCT id FROM unnest(ARRAY[l.created_by,issuer]) id WHERE id IS NOT NULL LOOP
  IF app.letter_acknowledgement_target_eligible_at(l.tenant_id,target,l.id) THEN
   INSERT INTO public.letter_job(tenant_id,company_id,letter_id,kind,recipient_user_id,source_event_id,dedupe_key,payload,due_at)
   VALUES(l.tenant_id,l.company_id,l.id,'notification',target,source_id,l.id::text||':'||a.id::text||':ack:'||action.id::text||':'||target::text,
    jsonb_build_object('purpose','recipientAcknowledgement','artifactId',a.id,'revisionId',l.current_revision_id,'recipientEventId',action.id,'outcome',action.kind,'portal',(p->>'portalNotifications')::boolean,'email',(p->>'emailNotifications')::boolean),now()) ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.queue_letter_acknowledgement_notices(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_letter_acknowledgement_notices(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_draft_created_notice_valid(wanted_tenant uuid,row_data jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.letter_record l JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
  JOIN public.domain_event source ON source.id=(row_data->>'source_event_id')::uuid AND source.tenant_id=l.tenant_id AND source.aggregate_type='letter' AND source.aggregate_id=l.id
  WHERE l.id=(row_data->>'letter_id')::uuid AND l.tenant_id=wanted_tenant AND row_data->>'tenant_id'=wanted_tenant::text AND row_data->>'company_id'=l.company_id::text
   AND row_data->>'kind'='notification' AND row_data->>'status'<>'cancelled' AND row_data->'payload'->>'purpose'='draftCreated'
   AND row_data->>'recipient_user_id'=l.created_by::text AND row_data->'payload'->>'batchId'=b.id::text AND source.payload->>'batchId'=b.id::text
   AND row_data->>'dedupe_key'=b.id::text||':created:'||l.created_by::text
   AND (source.event_type='letter.draft.batch-created' AND source.actor_type='user' AND source.actor_id=l.created_by OR
    source.event_type='letter.automation.source-bound' AND source.actor_type='system' AND source.actor_id IS NULL AND source.payload->>'responsibleUserId'=l.created_by::text
     AND source.payload->>'jobId'=b.operation_key::text AND EXISTS(SELECT 1 FROM public.letter_job parent WHERE parent.id=b.operation_key AND parent.tenant_id=b.tenant_id AND parent.kind='eventDraft' AND parent.status='completed' AND parent.payload->>'batchId'=b.id::text))
   AND app.letter_automation_owner_eligible_at(wanted_tenant,l.created_by,l.company_id,l.confidential))
$$;
REVOKE ALL ON FUNCTION app.letter_draft_created_notice_valid(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.letter_draft_created_job_current(wanted_tenant uuid,wanted_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT app.letter_draft_created_notice_valid(wanted_tenant,to_jsonb(j)) FROM public.letter_job j WHERE j.id=wanted_job AND j.tenant_id=wanted_tenant),false)
$$;
REVOKE ALL ON FUNCTION app.letter_draft_created_job_current(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Company deletion sees a retention boolean even when the HR actor cannot inspect individual letters.
CREATE FUNCTION app.letter_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company c
 WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id) AND (
 EXISTS(SELECT 1 FROM public.letter_asset r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_automation_rule_version r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_capability_grant r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_generation_batch r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_job r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_merge_field_version r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_policy_version r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_record r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_template r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.letter_template_version r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)
 OR  EXISTS(SELECT 1 FROM public.notification r WHERE r.company_id=c.id AND r.tenant_id=c.tenant_id)))
$$;
REVOKE ALL ON FUNCTION app.letter_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_company_in_use(uuid) TO ai_hr_app;
