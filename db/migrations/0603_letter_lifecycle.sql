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
 dedupe_key text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','cancelled')),due_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error text,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT letter_job_dedupe_uq UNIQUE(tenant_id,dedupe_key)
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
CREATE FUNCTION app.letter_permission_for_user(subject uuid,co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT cap IN ('read','template','generate','approve','issue','report','settings') AND EXISTS(SELECT 1 FROM public.company c JOIN public.app_user u ON u.tenant_id=c.tenant_id AND u.id=subject AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  WHERE c.id=co AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL
  AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=c.tenant_id AND r.app_user_id=u.id AND app.access_scope_covers(r.company_id,c.id,c.tenant_id)
    AND coalesce((SELECT g.allowed FROM public.letter_capability_grant g WHERE g.tenant_id=c.tenant_id AND g.company_id=c.id AND g.capability=cap AND g.role=r.role::text),r.role::text IN ('super_admin','hr_admin'))))
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
CREATE POLICY letter_job_read ON letter_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'read')));
CREATE POLICY letter_job_insert ON letter_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue')));
GRANT SELECT,INSERT ON letter_job TO ai_hr_app;
CREATE POLICY letter_job_update ON letter_job FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue'))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.letter_permission(company_id,'generate') OR app.letter_permission(company_id,'approve') OR app.letter_permission(company_id,'issue')));
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
 a public.letter_artifact;stage jsonb;delegate uuid;next_ordinal integer;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Letter principal is unavailable' USING ERRCODE='insufficient_privilege'; END IF;
 IF row_data ? 'company_id' THEN
  co:=(row_data->>'company_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=NEW.tenant_id AND c.archived_at IS NULL) THEN RAISE EXCEPTION 'Letter company identity mismatch';END IF;
 END IF;
 IF row_data ? 'created_by' AND (row_data->>'created_by')::uuid IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Letter actor identity mismatch';END IF;
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
   WHERE b.id=batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=co AND p.tenant_id=b.tenant_id AND stage->'userIds' ? app.current_user_id()::text)
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
 IF (to_jsonb(NEW)-ARRAY['status','due_at','attempts','last_error','lease_token','lease_until']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','due_at','attempts','last_error','lease_token','lease_until']) OR NEW.attempts<OLD.attempts OR OLD.status IN ('sent','cancelled') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Letter job identity or completed outcome is immutable';END IF;
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
 AND (app.letter_permission(co,'template') OR app.letter_permission(co,'read'))
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
CREATE FUNCTION app.letter_approver_eligible(subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current()
 AND (app.letter_permission(co,'generate') OR app.letter_permission(co,'approve') OR app.letter_permission(co,'settings') OR app.letter_permission(co,'template'))
 AND app.letter_permission_for_user(subject,co,'read') AND app.letter_permission_for_user(subject,co,'approve')
 AND (NOT confidential OR app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=subject),co))
$$;
REVOKE ALL ON FUNCTION app.letter_approver_eligible(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_approver_eligible(uuid,uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- A letter reviewer can see the subject's label without receiving directory access or contact data.
CREATE FUNCTION app.letter_staff_identity(subject uuid) RETURNS TABLE(employee_name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT p.full_name,e.employee_code FROM public.letter_record l
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
