-- Immutable per-person files for rich Probation emails. HR writes through one checked, audited command.
CREATE TABLE automation_email_case_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),template_id uuid NOT NULL,slot_id uuid NOT NULL,
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 180),mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 10485760),content_hash text GENERATED ALWAYS AS (encode(sha256(content),'hex')) STORED,
 uploaded_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX automation_email_case_file_slot ON automation_email_case_file(tenant_id,case_id,template_id,slot_id,created_at DESC,id);
--> statement-breakpoint
ALTER TABLE automation_email_case_file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_email_case_file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.probation_email_case_files_admin(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case AND app.probation_case_access(c.id) AND (app.probation_config_admin(c.company_id) OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_case_files_admin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_case_files_admin(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY automation_email_case_file_owner ON automation_email_case_file FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY automation_email_case_file_read ON automation_email_case_file FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_email_case_files_admin(case_id));
--> statement-breakpoint
REVOKE ALL ON automation_email_case_file FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON automation_email_case_file TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_email_case_file_write(p_case uuid,p_template uuid,p_slot uuid,p_revision integer,p_filename text,p_mime text,p_content bytea) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;definition jsonb;v_id uuid;
BEGIN
 IF app.current_user_id() IS NULL OR app.probation_email_case_files_admin(p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Email files unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Case changed; reload before uploading' USING ERRCODE='40001';END IF;
 IF octet_length(p_content) NOT BETWEEN 1 AND 10485760 OR length(p_filename) NOT BETWEEN 1 AND 180 OR (p_filename~'[[:cntrl:]/]' OR strpos(p_filename,chr(92))>0) THEN RAISE EXCEPTION 'Invalid email file' USING ERRCODE='22023';END IF;
 SELECT v.definition INTO definition FROM automation_email_template_version v WHERE v.tenant_id=c.tenant_id AND v.template_id=p_template AND v.module='probation' ORDER BY v.revision DESC LIMIT 1;
 IF definition IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'slots') slot WHERE slot->>'id'=p_slot::text) THEN RAISE EXCEPTION 'Email file slot unavailable' USING ERRCODE='22023';END IF;
 INSERT INTO automation_email_case_file(tenant_id,case_id,template_id,slot_id,filename,mime_type,content,uploaded_by) VALUES(c.tenant_id,c.id,p_template,p_slot,p_filename,p_mime,p_content,app.current_user_id()) RETURNING id INTO v_id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-case',c.id,'probation.email-file-uploaded','user',app.current_user_id(),c.employment_id,jsonb_build_object('templateId',p_template,'slotId',p_slot,'fileId',v_id,'bytes',octet_length(p_content)));
 UPDATE automation_email_hold_context SET needs_check=true WHERE tenant_id=c.tenant_id AND case_id=c.id AND template_id=p_template;
 RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_case_file_write(uuid,uuid,uuid,integer,text,text,bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_case_file_write(uuid,uuid,uuid,integer,text,text,bytea) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_email_case_file_refs(p_case uuid,p_template uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'slotId',f.slot_id,'name',f.filename,'contentHash',f.content_hash) ORDER BY f.slot_id),'[]'::jsonb) INTO result FROM (SELECT DISTINCT ON(slot_id) * FROM automation_email_case_file WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND template_id=p_template ORDER BY slot_id,created_at DESC,id DESC LIMIT 50) f;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_case_file_refs(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_case_file_refs(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_email_file_choices(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.probation_email_case_files_admin(p_case) IS NOT TRUE THEN RETURN '[]'::jsonb;END IF;
 WITH templates AS (SELECT DISTINCT ON(template_id) template_id,name,definition,retired FROM automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='probation' ORDER BY template_id,revision DESC LIMIT 500), latest_files AS (SELECT DISTINCT ON(template_id,slot_id) template_id,slot_id,id,filename,content_hash FROM automation_email_case_file WHERE tenant_id=app.current_tenant_id() AND case_id=p_case ORDER BY template_id,slot_id,created_at DESC,id DESC), file_lists AS (SELECT template_id,jsonb_agg(jsonb_build_object('id',id,'slotId',slot_id,'name',filename,'contentHash',content_hash) ORDER BY slot_id) AS files FROM latest_files GROUP BY template_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('templateId',t.template_id,'name',t.name,'slots',t.definition->'slots','files',coalesce(f.files,'[]'::jsonb)) ORDER BY t.name,t.template_id),'[]'::jsonb) INTO result FROM templates t LEFT JOIN file_lists f ON f.template_id=t.template_id WHERE NOT t.retired AND jsonb_array_length(coalesce(t.definition->'slots','[]'::jsonb))>0;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_file_choices(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_file_choices(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_case_files(p_id uuid,p_token uuid,p_origin text) RETURNS TABLE(id uuid,filename text,mime_type text,bytes text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);IF target IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT f.id,f.filename,f.mime_type,encode(f.content,'base64') FROM automation_email_case_file f JOIN jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'caseFiles','[]'::jsonb)) r ON r->>'id'=f.id::text AND r->>'contentHash'=f.content_hash WHERE f.tenant_id=(target->>'tenantId')::uuid AND f.case_id=(target->>'subjectId')::uuid AND f.template_id::text=target->'payload'->'mail'->'delivery'->>'templateId' ORDER BY f.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_case_files(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_email_case_files(uuid,uuid,text) TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE automation_email_hold_context(run_id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),template_id uuid NOT NULL,facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object' AND pg_column_size(facts)<=50000),needs_check boolean NOT NULL DEFAULT false,checked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES automation_run(tenant_id,id));
--> statement-breakpoint
ALTER TABLE automation_email_hold_context ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_email_hold_context FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_email_hold_owner ON automation_email_hold_context FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON automation_email_hold_context FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_email_hold_context(p_case uuid,p_template uuid,p_run uuid,p_facts jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM automation_run r WHERE r.id=p_run AND r.tenant_id=app.current_tenant_id() AND r.subject_id=p_case AND r.module='probation' AND r.status IN ('running','waiting')) THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 IF p_facts IS NOT NULL THEN INSERT INTO automation_email_hold_context(run_id,tenant_id,case_id,template_id,facts) VALUES(p_run,app.current_tenant_id(),p_case,p_template,p_facts) ON CONFLICT(tenant_id,run_id) DO UPDATE SET case_id=excluded.case_id,template_id=excluded.template_id,facts=excluded.facts,needs_check=false,checked_at=NULL;END IF;
 SELECT facts INTO result FROM automation_email_hold_context WHERE run_id=p_run AND case_id=p_case AND template_id=p_template AND tenant_id=app.current_tenant_id();RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_hold_context(uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_hold_context(uuid,uuid,uuid,jsonb) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.probation_email_hold_recheck() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='automation_email_template_version' THEN UPDATE automation_email_hold_context SET needs_check=true WHERE tenant_id=NEW.tenant_id AND template_id=NEW.template_id;
 ELSIF NEW.kind='letter_released' THEN UPDATE automation_email_hold_context SET needs_check=true WHERE tenant_id=NEW.tenant_id AND case_id=NEW.case_id;END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_hold_recheck() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER probation_email_definition_recheck AFTER INSERT ON automation_email_template_version FOR EACH ROW EXECUTE FUNCTION app.probation_email_hold_recheck();
--> statement-breakpoint
CREATE TRIGGER probation_email_document_recheck AFTER INSERT ON probation_file FOR EACH ROW EXECUTE FUNCTION app.probation_email_hold_recheck();

--> statement-breakpoint
-- Only attachment metadata crosses into the workflow planner. Bytes remain behind the leased private capability.
CREATE FUNCTION app.probation_email_file_budget(p_case uuid,p_documents uuid[],p_files uuid[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 IF coalesce(cardinality(p_documents),0)>100 OR coalesce(cardinality(p_files),0)>50 THEN RAISE EXCEPTION 'Too many email files' USING ERRCODE='22023';END IF;
 SELECT jsonb_build_object('count',count(*),'bytes',coalesce(sum(size),0)) INTO result FROM (
  SELECT octet_length(f.content) AS size FROM unnest(p_documents) r(id) JOIN probation_file f ON f.id=r.id AND f.tenant_id=app.current_tenant_id() AND f.case_id=p_case AND f.kind='letter_released'
  UNION ALL SELECT octet_length(f.content) FROM unnest(p_files) r(id) JOIN automation_email_case_file f ON f.id=r.id AND f.tenant_id=app.current_tenant_id() AND f.case_id=p_case
 ) sizes;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_file_budget(uuid,uuid[],uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_file_budget(uuid,uuid[],uuid[]) TO ai_hr_app;
