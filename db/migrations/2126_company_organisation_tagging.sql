-- Reviewed dated organisation mappings. Installation creates no mappings, classifications or data run.
-- Composite keys prevent private owner code from accidentally crossing tenant boundaries.
CREATE UNIQUE INDEX IF NOT EXISTS company_org_business_unit_tenant_uq ON business_unit(id,tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS company_org_employment_tenant_uq ON employment(id,tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS company_org_user_tenant_uq ON app_user(id,tenant_id);
CREATE TABLE public.company_organisation_run(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(kind IN('mapping','restructure','retag')),
 effective_on date NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','approved','staging','published','stale','rejected')),
 company_ids uuid[] NOT NULL,authority_company_ids uuid[] NOT NULL,mapping jsonb NOT NULL,structure jsonb NOT NULL DEFAULT '[]',source_epoch bigint NOT NULL,digest text NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_user(id),checked_by uuid REFERENCES app_user(id),checked_at timestamptz,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,failure text,
 CHECK(checked_by IS NULL OR checked_by<>requested_by),UNIQUE(id,tenant_id),FOREIGN KEY(requested_by,tenant_id) REFERENCES app_user(id,tenant_id),FOREIGN KEY(checked_by,tenant_id) REFERENCES app_user(id,tenant_id)
);
CREATE TABLE public.company_organisation_mapping(
 run_id uuid NOT NULL,tenant_id uuid NOT NULL,company_id uuid NOT NULL,business_unit_id uuid,parent_company_id uuid,business_group_id uuid,
 PRIMARY KEY(run_id,company_id),FOREIGN KEY(run_id,tenant_id) REFERENCES company_organisation_run(id,tenant_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id),FOREIGN KEY(parent_company_id,tenant_id) REFERENCES company(id,tenant_id),
 FOREIGN KEY(business_group_id,tenant_id) REFERENCES company(id,tenant_id),FOREIGN KEY(business_unit_id,tenant_id) REFERENCES business_unit(id,tenant_id)
);
CREATE TABLE public.company_organisation_run_row(
 run_id uuid NOT NULL,tenant_id uuid NOT NULL,employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL,
 employee_name text NOT NULL,employee_code text,company_name text NOT NULL,before_labels jsonb NOT NULL,after_labels jsonb NOT NULL,status text NOT NULL,active_on boolean NOT NULL,projection_on date,before_tags jsonb NOT NULL,after_tags jsonb NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('changed','unchanged','skipped','failed')),reason text,staged boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id,employment_id),FOREIGN KEY(employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(run_id,tenant_id) REFERENCES company_organisation_run(id,tenant_id),FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id)
);
CREATE TABLE public.employment_organisation_classification(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL,
 effective_on date NOT NULL,mapping_version_id uuid NOT NULL REFERENCES company_organisation_run(id),tags jsonb NOT NULL,trigger text NOT NULL,actor_id uuid NOT NULL REFERENCES app_user(id),
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,idempotency_key),FOREIGN KEY(employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(actor_id,tenant_id) REFERENCES app_user(id,tenant_id),FOREIGN KEY(mapping_version_id,tenant_id) REFERENCES company_organisation_run(id,tenant_id),FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id)
);
CREATE TABLE public.company_organisation_source_epoch(tenant_id uuid PRIMARY KEY REFERENCES tenant(id),revision bigint NOT NULL DEFAULT 0);
ALTER TABLE company_organisation_run ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_run FORCE ROW LEVEL SECURITY;
ALTER TABLE company_organisation_mapping ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE company_organisation_run_row ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_run_row FORCE ROW LEVEL SECURITY;
ALTER TABLE employment_organisation_classification ENABLE ROW LEVEL SECURITY;ALTER TABLE employment_organisation_classification FORCE ROW LEVEL SECURITY;
ALTER TABLE company_organisation_source_epoch ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_source_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY company_org_run_owner ON company_organisation_run FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY company_org_mapping_owner ON company_organisation_mapping FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY company_org_rows_owner ON company_organisation_run_row FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY company_org_classification_owner ON employment_organisation_classification FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY company_org_epoch_owner ON company_organisation_source_epoch FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON company_organisation_run,company_organisation_mapping,company_organisation_run_row,employment_organisation_classification,company_organisation_source_epoch FROM PUBLIC,ai_hr_app;
CREATE TABLE public.company_organisation_publish_lease(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,run_id uuid NOT NULL,actor_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id),FOREIGN KEY(actor_id,tenant_id) REFERENCES app_user(id,tenant_id),FOREIGN KEY(run_id,tenant_id) REFERENCES company_organisation_run(id,tenant_id));
ALTER TABLE company_organisation_publish_lease ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_publish_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY company_org_publish_owner ON company_organisation_publish_lease FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON company_organisation_publish_lease FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.company_org_lock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||t::text,0)) THEN RAISE EXCEPTION 'Organisation dependencies are busy; retry.' USING ERRCODE='40001';END IF;
 PERFORM app.lock_system_label_criteria(t,'business_unit');
 PERFORM pg_advisory_xact_lock(hashtextextended('company-organisation:'||t::text,0));
 INSERT INTO company_organisation_source_epoch(tenant_id) VALUES(t) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM company_organisation_source_epoch WHERE tenant_id=t FOR UPDATE;
END $$;
CREATE FUNCTION app.company_org_source_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id;ELSE t:=NEW.tenant_id;END IF;
 INSERT INTO company_organisation_source_epoch(tenant_id,revision) VALUES(t,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=company_organisation_source_epoch.revision+1;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER company_org_company_epoch AFTER INSERT OR UPDATE OR DELETE ON company FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_employment_epoch AFTER INSERT OR UPDATE OR DELETE ON employment FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_assignment_epoch AFTER INSERT OR UPDATE OR DELETE ON assignment FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_person_epoch AFTER INSERT OR UPDATE OR DELETE ON person FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_bu_epoch AFTER INSERT OR UPDATE OR DELETE ON business_unit FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_criteria_epoch AFTER INSERT OR UPDATE OR DELETE ON label_company_assignment FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_user_epoch AFTER INSERT OR UPDATE OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE TRIGGER company_org_grant_epoch AFTER INSERT OR UPDATE OR DELETE ON role_assignment FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE FUNCTION app.company_org_identity_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;u uuid;BEGIN IF TG_OP='DELETE' THEN u:=OLD.app_user_id;ELSE u:=NEW.app_user_id;END IF;SELECT tenant_id INTO t FROM app_user WHERE id=u;IF t IS NOT NULL THEN INSERT INTO company_organisation_source_epoch(tenant_id,revision) VALUES(t,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=company_organisation_source_epoch.revision+1;END IF;IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE TRIGGER company_org_identity_epoch AFTER INSERT OR UPDATE OR DELETE ON app_external_identity FOR EACH ROW EXECUTE FUNCTION app.company_org_identity_changed();
--> statement-breakpoint
-- Replaced by the separately owned canonical encrypted-account admission bridge before this feature can execute.
-- Fail closed: arbitrary runtime SQL cannot manufacture account availability.
CREATE FUNCTION app.organisation_actor_account_available(p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT false; $$;
REVOKE ALL ON FUNCTION app.organisation_actor_account_available(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.company_org_hr(p_actor uuid,p_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_actor IS NOT NULL AND app.organisation_actor_account_available(p_actor) AND cardinality(p_companies)>0 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=p_actor AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND NOT EXISTS(SELECT 1 FROM unnest(p_companies) co WHERE NOT EXISTS(SELECT 1 FROM company c WHERE c.id=co AND c.tenant_id=app.current_tenant_id()) OR NOT EXISTS(
  SELECT 1 FROM role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=p_actor AND r.role IN('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=co OR app.is_company_descendant(co,r.company_id)) AND EXISTS(SELECT 1 FROM access_capability cap WHERE cap.id='workforce.maintain' AND (NOT cap.supported OR app.access_allowed_for_tenant(app.current_tenant_id(),p_actor,cap.id,co)))));
$$;
CREATE FUNCTION app.company_org_checker(p_actor uuid,p_doer uuid,p_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_actor IS NOT NULL AND p_actor<>p_doer AND EXISTS(SELECT 1 FROM app_user a JOIN app_user d ON d.tenant_id=a.tenant_id WHERE a.id=p_actor AND d.id=p_doer AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.organisation_actor_account_available(a.id) AND (a.person_id IS NULL OR d.person_id IS NULL OR a.person_id<>d.person_id)) AND (
 app.company_org_hr(p_actor,p_companies) OR NOT EXISTS(SELECT 1 FROM unnest(p_companies) co WHERE NOT EXISTS(
  SELECT 1 FROM reward_unit u JOIN reward_member m ON m.unit_id=u.id AND m.tenant_id=u.tenant_id WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=co AND u.deleted_at IS NULL AND m.user_id=p_actor AND m.role='gr' AND app.reward_member_eligible_internal(m.id))));
$$;
CREATE FUNCTION app.company_org_run_access(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM company_organisation_run r WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id() AND (app.company_org_hr(app.current_user_id(),r.authority_company_ids) OR app.company_org_checker(app.current_user_id(),r.requested_by,r.company_ids)));
$$;
CREATE POLICY company_org_run_read ON company_organisation_run FOR SELECT TO ai_hr_app USING(app.company_org_run_access(id));
GRANT SELECT ON company_organisation_run TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.company_org_bu_usable(p_bu uuid,p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM business_unit b WHERE b.id=p_bu AND b.tenant_id=app.current_tenant_id() AND b.archived_at IS NULL AND (b.is_global OR EXISTS(SELECT 1 FROM label_company_assignment a WHERE a.tenant_id=b.tenant_id AND a.label_kind='business_unit' AND a.label_id=b.id AND a.company_id=p_company)));
$$;
CREATE FUNCTION app.company_org_mapping_at(p_day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(c.id::text,jsonb_build_object('companyId',c.id,'businessUnitId',m.business_unit_id,'parentCompanyId',CASE WHEN m.company_id IS NOT NULL THEN m.parent_company_id ELSE c.parent_company_id END,'mappingVersionId',m.run_id)),'{}') FROM company c LEFT JOIN LATERAL(
  SELECT m.* FROM company_organisation_mapping m JOIN company_organisation_run r ON r.id=m.run_id AND r.tenant_id=m.tenant_id WHERE m.company_id=c.id AND m.tenant_id=c.tenant_id AND (r.state='published' OR EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.effective_on<=p_day ORDER BY r.effective_on DESC,r.published_at DESC,r.id DESC LIMIT 1
 ) m ON true WHERE c.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.company_org_current_parent(p_company uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN latest.company_id IS NOT NULL THEN latest.parent_company_id ELSE c.parent_company_id END FROM company c LEFT JOIN LATERAL(
 SELECT m.company_id,m.parent_company_id FROM company_organisation_mapping m JOIN company_organisation_run r ON r.id=m.run_id AND r.tenant_id=m.tenant_id WHERE m.tenant_id=c.tenant_id AND m.company_id=c.id AND r.state='published' AND r.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date ORDER BY r.effective_on DESC,r.published_at DESC,r.id DESC LIMIT 1
 ) latest ON true WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_company;
$$;
CREATE OR REPLACE FUNCTION app.is_company_descendant(child uuid,ancestor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE up(id,path) AS(SELECT c.id,ARRAY[c.id] FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.id=child UNION ALL SELECT p.id,up.path||p.id FROM up JOIN public.company p ON p.id=app.company_org_current_parent(up.id) AND p.tenant_id=app.current_tenant_id() WHERE NOT(p.id=ANY(up.path))) SELECT EXISTS(SELECT 1 FROM up WHERE id=ancestor);
$$;
CREATE OR REPLACE FUNCTION app.company_subtree(root uuid) RETURNS TABLE(id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE down(id,path) AS(SELECT c.id,ARRAY[c.id] FROM public.company c WHERE c.id=root AND c.tenant_id=app.current_tenant_id() UNION ALL SELECT c.id,down.path||c.id FROM down JOIN public.company c ON app.company_org_current_parent(c.id)=down.id AND c.tenant_id=app.current_tenant_id() WHERE NOT(c.id=ANY(down.path))) SELECT down.id FROM down;
$$;
REVOKE ALL ON FUNCTION app.company_subtree(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.company_org_resolve(p_company uuid,p_mapping jsonb,p_activated boolean) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry jsonb:=p_mapping->p_company::text;cursor_id uuid:=p_company;visited uuid[]:='{}';parent uuid;root uuid;reason text;BEGIN
 IF entry IS NULL THEN RETURN NULL;END IF;
 LOOP
  IF cursor_id=ANY(visited) THEN reason:='Group structure contains a cycle';EXIT;END IF;visited:=array_append(visited,cursor_id);
  IF NOT(p_mapping?cursor_id::text) THEN reason:='Parent company is unavailable';EXIT;END IF;
  root:=cursor_id;parent:=nullif(p_mapping->cursor_id::text->>'parentCompanyId','')::uuid;IF parent IS NULL THEN EXIT;END IF;cursor_id:=parent;
 END LOOP;
 IF p_activated AND entry->>'businessUnitId' IS NULL THEN reason:='Company not in Group structure';END IF;
 RETURN entry||jsonb_build_object('businessGroupId',CASE WHEN reason IN('Group structure contains a cycle','Parent company is unavailable') THEN NULL ELSE root END,'status',CASE WHEN NOT p_activated THEN 'legacy' WHEN reason IS NULL THEN 'ready' ELSE 'pending' END,'reason',reason);
END $$;
CREATE FUNCTION app.company_org_tags_unchecked(p_company uuid,p_day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.company_org_resolve(p_company,app.company_org_mapping_at(p_day),EXISTS(SELECT 1 FROM company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND (r.state='published' OR EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.kind<>'retag' AND r.effective_on<=p_day))||jsonb_build_object('mappingVersionId',coalesce(nullif(app.company_org_mapping_at(p_day)->p_company::text->'mappingVersionId','null'::jsonb),(SELECT to_jsonb(r.id) FROM company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND (r.state='published' OR EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.kind<>'retag' AND r.effective_on<=p_day ORDER BY r.effective_on DESC,r.published_at DESC NULLS FIRST,r.id DESC LIMIT 1)));
$$;
CREATE FUNCTION app.company_org_company_read(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()) AND (
 app.access_workforce_company(p_company,'workforce.view') OR app.access_workforce_company(p_company,'workforce.maintain') OR app.can_admin_payroll_for(p_company) OR EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=p_company AND app.reward_access(u.id)));
$$;
CREATE FUNCTION app.company_organisation_tags(p_company uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF p_day IS NULL OR NOT app.company_org_company_read(p_company) THEN RAISE EXCEPTION 'Company organisation is unavailable' USING ERRCODE='42501';END IF;RETURN app.company_org_tags_unchecked(p_company,p_day);END $$;
-- Existing company catalogues expose parent identities under tenant company-row access. No employee or labels are exposed.
CREATE FUNCTION app.company_organisation_current_parent(p_company uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Current tenant identity required' USING ERRCODE='42501';END IF;RETURN app.company_org_current_parent(p_company);END $$;
CREATE FUNCTION app.company_organisation_next_change(p_company uuid,p_day date) RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result date;BEGIN IF NOT app.company_org_company_read(p_company) THEN RAISE EXCEPTION 'Company organisation is unavailable' USING ERRCODE='42501';END IF;
 SELECT min(r.effective_on) INTO result FROM company_organisation_mapping m JOIN company_organisation_run r ON r.id=m.run_id AND r.tenant_id=m.tenant_id WHERE m.tenant_id=app.current_tenant_id() AND m.company_id=p_company AND r.state='published' AND r.effective_on>p_day;RETURN result;END $$;
--> statement-breakpoint
CREATE FUNCTION app.company_org_employment_company(p_employment uuid,p_day date) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT nullif(ev.payload->'before'->>'companyId','')::uuid FROM domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_day::text ORDER BY ev.sequence LIMIT 1),
 (SELECT a.company_id FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=p_day AND (a.valid_to IS NULL OR a.valid_to>p_day) ORDER BY a.valid_from DESC,a.id LIMIT 1),e.company_id)
 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.company_org_employment_unchecked(p_employment uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE co uuid;tags jsonb;bu uuid;recorded jsonb;BEGIN
 co:=app.company_org_employment_company(p_employment,p_day);IF co IS NULL THEN RETURN NULL;END IF;tags:=app.company_org_tags_unchecked(co,p_day);
 IF tags->>'status'='legacy' THEN
  SELECT a.business_unit_id INTO bu FROM assignment a WHERE a.employment_id=p_employment AND a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=p_day AND (a.valid_to IS NULL OR a.valid_to>p_day) ORDER BY a.valid_from DESC,a.id LIMIT 1;
  RETURN tags||jsonb_build_object('businessUnitId',bu);
 END IF;
 -- Classification is a retained fact. Later published dated mappings supersede it only from their own date.
 SELECT c.tags INTO recorded FROM employment_organisation_classification c JOIN company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment AND c.company_id=co AND c.effective_on<=p_day AND r.state='published' AND NOT EXISTS(
  SELECT 1 FROM company_organisation_mapping m JOIN company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id WHERE m.tenant_id=c.tenant_id AND m.company_id=co AND newer.state='published' AND newer.effective_on>c.effective_on AND newer.effective_on<=p_day
 ) ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1;
 RETURN coalesce(recorded,tags);
END $$;
CREATE FUNCTION app.employment_organisation_tags(p_employment uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE co uuid;BEGIN
 co:=app.company_org_employment_company(p_employment,p_day);
 IF co IS NULL OR NOT app.principal_snapshot_current() OR NOT(
 app.access_workforce_employment(p_employment,'workforce.view') OR app.access_workforce_employment(p_employment,'workforce.maintain') OR app.access_workforce_projection_company(co) OR app.can_admin_payroll_for(co) OR EXISTS(SELECT 1 FROM reward_entry e JOIN reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id WHERE e.tenant_id=app.current_tenant_id() AND e.employment_id=p_employment AND app.reward_access(u.id))) THEN RAISE EXCEPTION 'Employee organisation is unavailable' USING ERRCODE='42501';END IF;
 RETURN app.company_org_employment_unchecked(p_employment,p_day);
END $$;
-- Generic auth event appenders execute as owner too. Only this private exact-event permit can emit organisation audit evidence.
CREATE TABLE public.company_organisation_audit_permit(xact_id xid8 NOT NULL,token text NOT NULL,PRIMARY KEY(xact_id,token));
ALTER TABLE company_organisation_audit_permit ENABLE ROW LEVEL SECURITY;ALTER TABLE company_organisation_audit_permit FORCE ROW LEVEL SECURITY;
CREATE POLICY company_org_audit_permit_owner ON company_organisation_audit_permit FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON company_organisation_audit_permit FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.company_org_append_event(t uuid,aggregate text,identifier uuid,event text,actor_kind text,actor uuid,subject uuid,detail jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE token text:=encode(sha256(convert_to(jsonb_build_array(t,aggregate,identifier,event,actor_kind,actor,subject,detail)::text,'UTF8')),'hex');BEGIN
 INSERT INTO company_organisation_audit_permit VALUES(pg_current_xact_id(),token);
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(t,aggregate,identifier,event,actor_kind::actor_type,actor,subject,detail);
END $$;
CREATE FUNCTION app.company_org_append_event(t uuid,aggregate text,identifier uuid,event text,actor_kind text,actor uuid,detail jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$SELECT app.company_org_append_event(t,aggregate,identifier,event,actor_kind,actor,NULL,detail);$$;
CREATE FUNCTION app.record_employment_organisation_tags(p_employment uuid,p_company uuid,p_day date,p_trigger text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tags jsonb;previous jsonb;k text;new_id uuid;BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() OR NOT app.access_workforce_employment(p_employment,'workforce.maintain') OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()) OR p_company IS DISTINCT FROM app.company_org_employment_company(p_employment,p_day) OR p_trigger NOT IN('hire','correction','transfer','restructure','import','retag','assignment','movement') THEN RAISE EXCEPTION 'Organisation write scope is unavailable' USING ERRCODE='42501';END IF;
 tags:=app.company_org_tags_unchecked(p_company,p_day);IF tags->>'status'='legacy' THEN RETURN tags;END IF;
 SELECT c.tags INTO previous FROM employment_organisation_classification c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment AND c.effective_on<=p_day ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM employment_organisation_classification c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment AND c.company_id=p_company AND c.effective_on=p_day AND c.tags=tags) THEN RETURN tags;END IF;
 k:=encode(sha256(convert_to(jsonb_build_array(p_employment,p_company,p_day,p_trigger,tags)::text,'UTF8')),'hex');
 INSERT INTO employment_organisation_classification(tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,trigger,actor_id,idempotency_key) VALUES(app.current_tenant_id(),p_employment,p_company,p_day,(tags->>'mappingVersionId')::uuid,tags,p_trigger,app.current_user_id(),k) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id INTO new_id;
 IF new_id IS NOT NULL THEN PERFORM app.company_org_append_event(app.current_tenant_id(),'employment',p_employment,'employment.organisation-tagged','user',app.current_user_id(),p_employment,jsonb_build_object('companyId',p_company,'before',previous,'after',tags,'effectiveOn',p_day,'trigger',p_trigger,'mappingVersionId',tags->'mappingVersionId'));END IF;
 RETURN tags;
END $$;
--> statement-breakpoint
ALTER TABLE company_organisation_run_row ADD COLUMN source_digest text NOT NULL;
CREATE FUNCTION app.company_org_employment_fingerprint(p_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('employment',to_jsonb(e),'person',jsonb_build_array(p.id,p.full_name),'assignments',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id),'[]'),'classifications',coalesce((SELECT jsonb_agg(jsonb_build_array(c.id,c.tags,c.effective_on) ORDER BY c.id) FROM employment_organisation_classification c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id),'[]'))::text,'UTF8')),'hex') FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_id;
$$;
CREATE TRIGGER company_org_classification_epoch AFTER INSERT OR UPDATE OR DELETE ON employment_organisation_classification FOR EACH ROW EXECUTE FUNCTION app.company_org_source_changed();
CREATE FUNCTION app.company_org_active(p_employment uuid,p_day date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.hired_on<=p_day AND (e.blacklisted_at IS NULL OR (e.blacklisted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>p_day) AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR least(e.resignation_date,e.last_working_date,e.terminated_on)>p_day));
$$;
-- Reprove the proposed tree without changing the caller's identity or using the candidate for authorization.
CREATE FUNCTION app.company_org_hr_proposed(p_actor uuid,p_companies uuid[],p_mapping jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM unnest(p_companies) co WHERE NOT EXISTS(
 SELECT 1 FROM role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=p_actor AND r.role IN('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=co OR EXISTS(
 WITH RECURSIVE ancestors(id,path) AS(SELECT co,ARRAY[co] UNION ALL SELECT nullif(p_mapping->a.id::text->>'parentCompanyId','')::uuid,a.path||nullif(p_mapping->a.id::text->>'parentCompanyId','')::uuid FROM ancestors a WHERE p_mapping->a.id::text->>'parentCompanyId' IS NOT NULL AND NOT(nullif(p_mapping->a.id::text->>'parentCompanyId','')::uuid=ANY(a.path))) SELECT 1 FROM ancestors WHERE id=r.company_id))));
$$;
CREATE FUNCTION app.company_org_tag_labels(p_tags jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('businessUnit', (SELECT name FROM business_unit WHERE id=nullif(p_tags->>'businessUnitId','')::uuid AND tenant_id=app.current_tenant_id()),'parentCompany',(SELECT legal_name FROM company WHERE id=nullif(p_tags->>'parentCompanyId','')::uuid AND tenant_id=app.current_tenant_id()),'businessGroup',(SELECT legal_name FROM company WHERE id=nullif(p_tags->>'businessGroupId','')::uuid AND tenant_id=app.current_tenant_id()));
$$;
CREATE FUNCTION app.prepare_company_organisation_run(p_input jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();r uuid:=gen_random_uuid();kind text:=p_input->>'kind';day date:=(p_input->>'effectiveOn')::date;scope uuid[];authority uuid[];mapping jsonb;old_mapping jsonb;change jsonb;co uuid;parent uuid;bu uuid;tags jsonb;before_tags jsonb;emp record;active boolean;outcome text;status text;reason text;epoch bigint;token text;first_mapping boolean;projection_day date;next_day date;
BEGIN
 PERFORM app.company_org_lock();
 IF actor IS NULL OR NOT app.principal_snapshot_current() OR kind NOT IN('mapping','restructure','retag') OR day IS NULL OR NOT isfinite(day) OR jsonb_typeof(p_input->'companyIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'companyIds') NOT BETWEEN 1 AND 500 OR jsonb_typeof(coalesce(p_input->'changes','[]')) IS DISTINCT FROM 'array' OR jsonb_array_length(coalesce(p_input->'changes','[]'))>500 THEN RAISE EXCEPTION 'Choose a valid organisation run and scope';END IF;
 IF kind='retag' AND day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Re-tag is effective on the confirmed run date';END IF;
 SELECT array_agg(DISTINCT x::uuid ORDER BY x::uuid) INTO scope FROM jsonb_array_elements_text(p_input->'companyIds') x;
 old_mapping:=app.company_org_mapping_at(day);mapping:=old_mapping;authority:=scope;
 first_mapping:=NOT EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=t AND state='published' AND kind<>'retag');
 IF kind='retag' AND NOT EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=t AND state='published' AND kind<>'retag' AND effective_on<=day) THEN RAISE EXCEPTION 'Publish a reviewed mapping before preparing a re-tag';END IF;
 IF kind<>'retag' AND jsonb_array_length(coalesce(p_input->'changes','[]'))=0 THEN RAISE EXCEPTION 'Choose explicit company mappings';END IF;
 IF kind='retag' AND jsonb_array_length(coalesce(p_input->'changes','[]'))<>0 THEN RAISE EXCEPTION 'A re-tag cannot change the structure';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) c)<>(SELECT count(DISTINCT c->>'companyId') FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) c) THEN RAISE EXCEPTION 'Choose each mapping once';END IF;
 FOR change IN SELECT value FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) LOOP
  co:=(change->>'companyId')::uuid;parent:=nullif(change->>'parentCompanyId','')::uuid;bu:=nullif(change->>'businessUnitId','')::uuid;
  IF co IS NULL OR NOT(co=ANY(scope)) OR NOT(mapping?co::text) OR co=parent OR NOT(change?'businessUnitId' AND change?'parentCompanyId') THEN RAISE EXCEPTION 'Choose explicit company, parent and Business Unit identities';END IF;
  IF parent IS NOT NULL AND NOT(mapping?parent::text) THEN RAISE EXCEPTION 'Parent company must belong to the same tenant';END IF;
  IF bu IS NOT NULL AND NOT app.company_org_bu_usable(bu,co) THEN RAISE EXCEPTION 'Business Unit is unavailable to this company through Criteria';END IF;
  IF parent IS NOT NULL AND NOT(parent=ANY(authority)) THEN authority:=array_append(authority,parent);END IF;
  mapping:=jsonb_set(mapping,ARRAY[co::text],jsonb_build_object('companyId',co,'businessUnitId',bu,'parentCompanyId',parent,'mappingVersionId',r));
 END LOOP;
 -- A changed ancestor changes descendant lineage too. Never accept a caller-supplied truncated cohort.
 IF first_mapping AND kind<>'retag' THEN SELECT array_agg(id ORDER BY id) INTO scope FROM company WHERE tenant_id=t;
 ELSIF kind<>'retag' THEN
  WITH RECURSIVE affected(id) AS(SELECT unnest(scope) UNION SELECT (value->>'companyId')::uuid FROM jsonb_each(mapping) entry JOIN affected a ON entry.value->>'parentCompanyId'=a.id::text)
  SELECT array_agg(DISTINCT id ORDER BY id) INTO scope FROM affected;
 END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO authority FROM unnest(scope||authority) x;
 IF NOT app.company_org_hr(actor,authority) OR NOT app.company_org_hr_proposed(actor,authority,mapping) OR EXISTS(SELECT 1 FROM unnest(authority) c WHERE NOT app.access_workforce_company(c,'workforce.maintain')) THEN RAISE EXCEPTION 'HR administration of the entire affected scope is required' USING ERRCODE='42501';END IF;
 FOR co IN SELECT id FROM company WHERE tenant_id=t ORDER BY id LOOP
  tags:=app.company_org_resolve(co,mapping,true);IF tags->>'reason' IN('Group structure contains a cycle','Parent company is unavailable') THEN RAISE EXCEPTION 'Resolve the complete company hierarchy before previewing';END IF;
 END LOOP;
 SELECT revision INTO epoch FROM company_organisation_source_epoch WHERE tenant_id=t;
 INSERT INTO company_organisation_run(id,tenant_id,kind,effective_on,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by) VALUES(r,t,kind,day,scope,authority,mapping,epoch,'preparing',actor);
 FOR emp IN SELECT e.*,p.full_name FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=t AND (app.company_org_employment_company(e.id,day)=ANY(scope) OR e.company_id=ANY(scope) OR EXISTS(SELECT 1 FROM assignment future WHERE future.tenant_id=t AND future.employment_id=e.id AND future.superseded_at IS NULL AND future.valid_from>day AND future.company_id=ANY(scope))) ORDER BY e.id LOOP
  active:=app.company_org_active(emp.id,day);projection_day:=NULL;
  IF active THEN SELECT day INTO projection_day WHERE EXISTS(SELECT 1 FROM assignment a WHERE a.tenant_id=t AND a.employment_id=emp.id AND a.superseded_at IS NULL AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day));
  ELSIF emp.voided_at IS NULL AND emp.hired_on>day THEN
   -- Only an already-entered future interval is eligible. Never create an interval for an inactive record.
   SELECT a.valid_from INTO projection_day FROM assignment a WHERE a.tenant_id=t AND a.employment_id=emp.id AND a.superseded_at IS NULL AND a.valid_from>=greatest(day,emp.hired_on) AND (a.valid_to IS NULL OR a.valid_to>a.valid_from) AND coalesce(a.company_id,emp.company_id)=ANY(scope) AND app.company_org_active(emp.id,a.valid_from) ORDER BY a.valid_from,a.id LIMIT 1;
  END IF;
  IF kind<>'retag' AND NOT active AND projection_day IS NULL THEN CONTINUE;END IF;
  co:=app.company_org_employment_company(emp.id,coalesce(projection_day,day));
  IF projection_day>day THEN
   SELECT min(rn.effective_on) INTO next_day FROM company_organisation_mapping m JOIN company_organisation_run rn ON rn.id=m.run_id AND rn.tenant_id=m.tenant_id WHERE m.tenant_id=t AND m.company_id=co AND rn.state='published' AND rn.effective_on>day;
   IF next_day IS NOT NULL AND projection_day>=next_day THEN IF kind<>'retag' THEN CONTINUE;ELSE projection_day:=NULL;END IF;END IF;
  END IF;
  before_tags:=app.company_org_employment_unchecked(emp.id,coalesce(projection_day,day));
  IF kind='retag' THEN
   SELECT c.tags INTO before_tags FROM employment_organisation_classification c WHERE c.tenant_id=t AND c.employment_id=emp.id AND c.company_id=co AND c.effective_on<=day ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1;
   IF before_tags IS NULL THEN
    before_tags:=app.company_org_employment_unchecked(emp.id,day)||jsonb_build_object('status','legacy','reason',NULL,'mappingVersionId',NULL,'businessUnitId',(SELECT a.business_unit_id FROM assignment a WHERE a.tenant_id=t AND a.employment_id=emp.id AND a.superseded_at IS NULL AND a.valid_from<=day ORDER BY a.valid_from DESC,a.id LIMIT 1));
   END IF;
  END IF;
  tags:=app.company_org_resolve(co,mapping,true);
  tags:=tags||jsonb_build_object('mappingVersionId',CASE WHEN kind='retag' THEN app.company_org_tags_unchecked(co,day)->'mappingVersionId' ELSE to_jsonb(r) END);
  status:=CASE WHEN emp.voided_at IS NOT NULL THEN 'voided' WHEN emp.hired_on>day THEN 'future' WHEN emp.blacklisted_at IS NOT NULL AND (emp.blacklisted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=day THEN 'blacklisted' WHEN NOT active THEN 'inactive' ELSE 'active' END;
  reason:=CASE WHEN emp.voided_at IS NOT NULL THEN 'Voided import record retained without a new interval' ELSE tags->>'reason' END;
  IF active AND projection_day IS NULL THEN reason:='No existing assignment covers the effective date; repair the source before publication';END IF;
  outcome:=CASE WHEN active AND projection_day IS NULL THEN 'failed' WHEN emp.voided_at IS NOT NULL THEN 'skipped' WHEN (before_tags-'mappingVersionId') IS NOT DISTINCT FROM (tags-'mappingVersionId') THEN 'unchanged' ELSE 'changed' END;
  INSERT INTO company_organisation_run_row(run_id,tenant_id,employment_id,company_id,employee_name,employee_code,company_name,before_labels,after_labels,status,active_on,projection_on,before_tags,after_tags,outcome,reason,source_digest)
   VALUES(r,t,emp.id,co,emp.full_name,emp.employee_code,(SELECT legal_name FROM company WHERE id=co AND tenant_id=t),app.company_org_tag_labels(before_tags),app.company_org_tag_labels(tags),status,active,projection_day,before_tags,tags,outcome,reason,app.company_org_employment_fingerprint(emp.id));
 END LOOP;
 IF (SELECT count(*) FROM company_organisation_run_row WHERE run_id=r)>250000 THEN RAISE EXCEPTION 'Split the authorised population into reviewed runs of at most 250000 records';END IF;
 SELECT encode(sha256(convert_to(jsonb_build_object('tenantId',t,'kind',kind,'effectiveOn',day,'requestedBy',actor,'scope',scope,'authority',authority,'mapping',mapping,'epoch',epoch,'rows',coalesce(jsonb_agg(jsonb_build_array(employment_id,company_id,status,projection_on,before_tags,after_tags,outcome,source_digest) ORDER BY employment_id),'[]'))::text,'UTF8')),'hex') INTO token FROM company_organisation_run_row WHERE run_id=r;
 UPDATE company_organisation_run SET digest=token,structure=(SELECT jsonb_agg(jsonb_build_object('companyId',c.id,'company',c.legal_name,'before',app.company_org_resolve(c.id,old_mapping,NOT first_mapping),'after',app.company_org_resolve(c.id,mapping,true),'beforeDisplay',app.company_org_tag_labels(app.company_org_resolve(c.id,old_mapping,NOT first_mapping)),'afterDisplay',app.company_org_tag_labels(app.company_org_resolve(c.id,mapping,true))) ORDER BY c.legal_name,c.id) FROM company c WHERE c.tenant_id=t AND c.id=ANY(scope)) WHERE id=r;
 PERFORM app.company_org_append_event(t,'organisation-tag-run',r,'organisation-tag-run.prepared','user',actor,jsonb_build_object('kind',kind,'effectiveOn',day,'digest',token,'companies',scope,'population',(SELECT count(*) FROM company_organisation_run_row WHERE run_id=r)));
 RETURN r;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.company_org_run_checker(p_actor uuid,p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM company_organisation_run r JOIN app_user a ON a.id=p_actor AND a.tenant_id=r.tenant_id JOIN app_user d ON d.id=r.requested_by AND d.tenant_id=r.tenant_id WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id() AND a.id<>d.id AND (a.person_id IS NULL OR d.person_id IS NULL OR a.person_id<>d.person_id) AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.organisation_actor_account_available(a.id) AND (
 (app.company_org_hr(a.id,r.authority_company_ids) AND app.company_org_hr_proposed(a.id,r.authority_company_ids,r.mapping)) OR (
 EXISTS(SELECT 1 FROM company_organisation_run_row x WHERE x.run_id=r.id) AND NOT EXISTS(SELECT 1 FROM unnest(r.company_ids) co WHERE NOT EXISTS(SELECT 1 FROM company_organisation_run_row x WHERE x.run_id=r.id AND x.company_id=co)) AND NOT EXISTS(
 SELECT 1 FROM company_organisation_run_row x CROSS JOIN LATERAL(VALUES(x.before_tags->>'businessUnitId'),(x.after_tags->>'businessUnitId')) needed(bu) WHERE x.run_id=r.id AND (needed.bu IS NULL OR NOT EXISTS(
 SELECT 1 FROM reward_unit u JOIN reward_member m ON m.unit_id=u.id AND m.tenant_id=u.tenant_id WHERE u.tenant_id=r.tenant_id AND u.company_id=x.company_id AND u.business_unit_id::text=needed.bu AND u.deleted_at IS NULL AND m.user_id=a.id AND m.role='gr' AND app.reward_member_eligible_internal(m.id)))))));
$$;
CREATE OR REPLACE FUNCTION app.company_org_run_access(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM company_organisation_run r WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id() AND (app.company_org_hr(app.current_user_id(),r.authority_company_ids) OR app.company_org_run_checker(app.current_user_id(),r.id)));
$$;
CREATE FUNCTION app.company_org_run_fresh(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM company_organisation_run r JOIN company_organisation_source_epoch e ON e.tenant_id=r.tenant_id WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id() AND r.source_epoch=e.revision AND NOT EXISTS(SELECT 1 FROM company_organisation_run_row x WHERE x.run_id=r.id AND x.source_digest IS DISTINCT FROM app.company_org_employment_fingerprint(x.employment_id)) AND (r.kind<>'retag' OR r.effective_on=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date));
$$;
CREATE FUNCTION app.company_organisation_run_view(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r company_organisation_run;counts jsonb;BEGIN
 IF NOT app.company_org_run_access(p_id) THEN RAISE EXCEPTION 'Organisation run is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM company_organisation_run WHERE id=p_id AND tenant_id=app.current_tenant_id();
 SELECT jsonb_build_object('total',count(*),'changed',count(*) FILTER(WHERE outcome='changed'),'unchanged',count(*) FILTER(WHERE outcome='unchanged'),'skipped',count(*) FILTER(WHERE outcome='skipped'),'failed',count(*) FILTER(WHERE outcome='failed'),'staged',count(*) FILTER(WHERE staged)) INTO counts FROM company_organisation_run_row WHERE run_id=r.id;
 RETURN jsonb_build_object('id',r.id,'kind',r.kind,'effectiveOn',r.effective_on,'state',r.state,'digest',r.digest,'requestedBy',r.requested_by,'checkedBy',r.checked_by,'counts',counts,'companyIds',r.company_ids,'structure',coalesce(r.structure,'[]'),'failure',r.failure,'canApprove',r.state='prepared' AND app.company_org_run_checker(app.current_user_id(),r.id),'canProcess',r.state IN('approved','staging') AND r.requested_by=app.current_user_id() AND app.company_org_hr(app.current_user_id(),r.authority_company_ids));
END $$;
CREATE FUNCTION app.decide_company_organisation_run(p_id uuid,p_digest text,p_approve boolean,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r company_organisation_run;BEGIN
 PERFORM app.company_org_lock();SELECT * INTO r FROM company_organisation_run WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR NOT app.principal_snapshot_current() OR NOT app.company_org_run_checker(app.current_user_id(),r.id) OR p_approve IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 2000 OR r.digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'An independent scoped checker must approve this exact preview' USING ERRCODE='42501';END IF;
 IF p_approve AND EXISTS(SELECT 1 FROM company_organisation_run_row WHERE run_id=r.id AND outcome='failed') THEN RAISE EXCEPTION 'Resolve failed source rows and prepare a fresh preview';END IF;
 IF r.state<>'prepared' THEN RAISE EXCEPTION 'This preview has already been decided';END IF;
 IF NOT app.company_org_run_fresh(r.id) OR NOT app.company_org_hr(r.requested_by,r.authority_company_ids) OR NOT app.company_org_hr_proposed(r.requested_by,r.authority_company_ids,r.mapping) THEN
  UPDATE company_organisation_run SET state='stale',failure='The population, mapping or source changed. Prepare a fresh preview.' WHERE id=r.id;PERFORM app.company_org_append_event(r.tenant_id,'organisation-tag-run',r.id,'organisation-tag-run.stale','user',app.current_user_id(),jsonb_build_object('digest',r.digest,'phase','review'));RETURN;
 END IF;
 UPDATE company_organisation_run SET state=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,checked_by=app.current_user_id(),checked_at=now(),reason=btrim(p_reason) WHERE id=r.id;
 PERFORM app.company_org_append_event(r.tenant_id,'organisation-tag-run',r.id,CASE WHEN p_approve THEN 'organisation-tag-run.approved' ELSE 'organisation-tag-run.rejected' END,'user',app.current_user_id(),jsonb_build_object('digest',r.digest,'requestedBy',r.requested_by,'reason',btrim(p_reason)));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.process_company_organisation_run(p_id uuid,p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r company_organisation_run;BEGIN
 PERFORM app.company_org_lock();SELECT * INTO r FROM company_organisation_run WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR NOT app.principal_snapshot_current() OR r.requested_by IS DISTINCT FROM app.current_user_id() OR NOT app.company_org_hr(app.current_user_id(),r.authority_company_ids) OR NOT app.company_org_hr_proposed(app.current_user_id(),r.authority_company_ids,r.mapping) OR EXISTS(SELECT 1 FROM unnest(r.company_ids) c WHERE NOT app.access_workforce_company(c,'workforce.maintain')) THEN RAISE EXCEPTION 'The current scoped HR doer must execute this run' USING ERRCODE='42501';END IF;
 IF r.state='published' THEN RETURN app.company_organisation_run_view(r.id);END IF;
 IF r.state NOT IN('approved','staging') OR r.checked_by IS NULL THEN RAISE EXCEPTION 'Independent approval is required before staging';END IF;
 IF NOT app.company_org_run_fresh(r.id) OR NOT app.company_org_run_checker(r.checked_by,r.id) THEN
  UPDATE company_organisation_run SET state='stale',failure='Source or actor eligibility changed. Prepare and approve a fresh preview.' WHERE id=r.id;
  UPDATE company_organisation_run_row SET outcome='failed',reason='The approved source changed; no version was published.' WHERE run_id=r.id AND outcome<>'skipped';
  PERFORM app.company_org_append_event(r.tenant_id,'organisation-tag-run',r.id,'organisation-tag-run.stale','user',app.current_user_id(),jsonb_build_object('digest',r.digest));
  RETURN app.company_organisation_run_view(r.id);
 END IF;
 UPDATE company_organisation_run_row SET staged=true WHERE run_id=r.id AND employment_id IN(SELECT employment_id FROM company_organisation_run_row WHERE run_id=r.id AND NOT staged ORDER BY employment_id LIMIT greatest(1,least(coalesce(p_limit,200),500)));
 UPDATE company_organisation_run SET state='staging' WHERE id=r.id;
 RETURN app.company_organisation_run_view(r.id);
END $$;
CREATE FUNCTION app.begin_company_organisation_publication(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r company_organisation_run;entry record;BEGIN
 PERFORM app.company_org_lock();SELECT * INTO r FROM company_organisation_run WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR NOT app.principal_snapshot_current() OR r.requested_by IS DISTINCT FROM app.current_user_id() OR NOT app.company_org_hr(r.requested_by,r.authority_company_ids) OR NOT app.company_org_hr_proposed(r.requested_by,r.authority_company_ids,r.mapping) OR NOT app.company_org_run_checker(r.checked_by,r.id) OR r.state<>'staging' OR EXISTS(SELECT 1 FROM company_organisation_run_row WHERE run_id=r.id AND NOT staged) OR NOT app.company_org_run_fresh(r.id) THEN RAISE EXCEPTION 'The exact current approved population must be staged before publication' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM company WHERE tenant_id=r.tenant_id AND id=ANY(r.company_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM employment WHERE tenant_id=r.tenant_id AND id IN(SELECT employment_id FROM company_organisation_run_row WHERE run_id=r.id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM assignment WHERE tenant_id=r.tenant_id AND employment_id IN(SELECT employment_id FROM company_organisation_run_row WHERE run_id=r.id) ORDER BY id FOR UPDATE;
 INSERT INTO company_organisation_publish_lease(xact_id,tenant_id,run_id,actor_id) VALUES(pg_current_xact_id(),r.tenant_id,r.id,app.current_user_id());
 IF r.kind<>'retag' THEN
  FOR entry IN SELECT key,value FROM jsonb_each(r.mapping) WHERE key::uuid=ANY(r.company_ids) LOOP
   INSERT INTO company_organisation_mapping(run_id,tenant_id,company_id,business_unit_id,parent_company_id,business_group_id)
   VALUES(r.id,r.tenant_id,entry.key::uuid,nullif(entry.value->>'businessUnitId','')::uuid,nullif(entry.value->>'parentCompanyId','')::uuid,(app.company_org_resolve(entry.key::uuid,r.mapping,true)->>'businessGroupId')::uuid);
  END LOOP;
 END IF;
END $$;
CREATE FUNCTION app.company_organisation_projection_rows(p_id uuid) RETURNS TABLE(employment_id uuid,effective_on date) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.xact_id=pg_current_xact_id() AND l.tenant_id=app.current_tenant_id() AND l.run_id=p_id AND l.actor_id=app.current_user_id()) THEN RAISE EXCEPTION 'Native publication lease is required' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT x.employment_id,x.projection_on FROM company_organisation_run_row x JOIN company_organisation_run r ON r.id=x.run_id AND r.tenant_id=x.tenant_id WHERE x.run_id=p_id AND x.projection_on IS NOT NULL AND x.outcome='changed' ORDER BY x.employment_id;
END $$;
CREATE FUNCTION app.finish_company_organisation_publication(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r company_organisation_run;x record;before_view jsonb;k text;new_id uuid;BEGIN
 SELECT * INTO r FROM company_organisation_run WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.xact_id=pg_current_xact_id() AND l.tenant_id=r.tenant_id AND l.run_id=r.id AND l.actor_id=app.current_user_id()) THEN RAISE EXCEPTION 'Native publication lease is required' USING ERRCODE='42501';END IF;
 -- The lease validated both actors and froze every source under canonical locks before native writes.
 -- A raw application caller cannot publish while omitting the required canonical projection.
 IF EXISTS(SELECT 1 FROM company_organisation_run_row x WHERE x.run_id=r.id AND x.projection_on IS NOT NULL AND x.outcome='changed' AND NOT EXISTS(
  SELECT 1 FROM assignment a WHERE a.tenant_id=r.tenant_id AND a.employment_id=x.employment_id AND a.superseded_at IS NULL AND a.valid_from<=x.projection_on AND (a.valid_to IS NULL OR a.valid_to>x.projection_on) AND coalesce(a.company_id,(SELECT company_id FROM employment WHERE id=a.employment_id AND tenant_id=a.tenant_id))=x.company_id AND a.business_unit_id IS NOT DISTINCT FROM nullif(x.after_tags->>'businessUnitId','')::uuid)) THEN RAISE EXCEPTION 'Canonical assignment projection is incomplete';END IF;
 before_view:=app.company_organisation_run_view(r.id);
 FOR x IN SELECT * FROM company_organisation_run_row WHERE run_id=r.id AND outcome='changed' ORDER BY employment_id LOOP
  IF NOT EXISTS(SELECT 1 FROM employment_organisation_classification c WHERE c.tenant_id=r.tenant_id AND c.employment_id=x.employment_id AND c.company_id=x.company_id AND c.effective_on=r.effective_on AND c.tags=x.after_tags) THEN
   k:='organisation-run:'||r.id::text||':'||x.employment_id::text;
   INSERT INTO employment_organisation_classification(tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,trigger,actor_id,idempotency_key)
    VALUES(r.tenant_id,x.employment_id,x.company_id,r.effective_on,(x.after_tags->>'mappingVersionId')::uuid,x.after_tags,CASE WHEN r.kind='retag' THEN 'retag' ELSE 'restructure' END,r.requested_by,k) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id INTO new_id;
   IF new_id IS NOT NULL THEN PERFORM app.company_org_append_event(r.tenant_id,'employment',x.employment_id,'employment.organisation-tagged','user',r.requested_by,x.employment_id,jsonb_build_object('companyId',x.company_id,'before',x.before_tags,'after',x.after_tags,'effectiveOn',r.effective_on,'trigger',CASE WHEN r.kind='retag' THEN 'retag' ELSE 'restructure' END,'runId',r.id,'checkedBy',r.checked_by));END IF;
  END IF;
 END LOOP;
 UPDATE company_organisation_run SET state='published',published_at=now() WHERE id=r.id;
 UPDATE company_organisation_source_epoch SET revision=revision+1 WHERE tenant_id=r.tenant_id;
 DELETE FROM company_organisation_publish_lease WHERE xact_id=pg_current_xact_id() AND tenant_id=r.tenant_id;
 PERFORM app.company_org_append_event(r.tenant_id,'organisation-tag-run',r.id,'organisation-tag-run.published','user',app.current_user_id(),jsonb_build_object('digest',r.digest,'effectiveOn',r.effective_on,'checkedBy',r.checked_by,'counts',before_view->'counts'));
 RETURN before_view||jsonb_build_object('state','published','canProcess',false,'canApprove',false);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.company_organisation_run_report(p_id uuid,p_offset integer,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 IF NOT app.company_org_run_access(p_id) THEN RAISE EXCEPTION 'Organisation report is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('run',app.company_organisation_run_view(p_id),'rows',coalesce(jsonb_agg(x.row ORDER BY x.employment_id),'[]'),'hasMore',(SELECT count(*)>greatest(0,p_offset)+greatest(1,least(p_limit,500)) FROM company_organisation_run_row WHERE run_id=p_id)) INTO result FROM(
 SELECT employment_id,jsonb_build_object('employmentId',employment_id,'employee',employee_name,'employeeCode',employee_code,'companyId',company_id,'company',company_name,'beforeDisplay',before_labels,'afterDisplay',after_labels,'status',status,'projectionOn',projection_on,'before',before_tags,'after',after_tags,'outcome',outcome,'reason',reason) row FROM company_organisation_run_row WHERE run_id=p_id ORDER BY employment_id LIMIT greatest(1,least(p_limit,500)) OFFSET greatest(0,p_offset)
 )x;RETURN result;
END $$;
CREATE FUNCTION app.company_organisation_managed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=app.current_tenant_id() AND state='published' AND kind<>'retag');
$$;
-- Company SELECT stays tenant-readable. New rows still prove their submitted physical parent;
-- current UPDATE/DELETE authority follows the same published HR-today parent as native ancestry.
ALTER POLICY tenant_isolation ON company USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY company_org_insert_parent ON company AS RESTRICTIVE FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(coalesce(parent_company_id,id)));
CREATE POLICY company_org_update_parent ON company AS RESTRICTIVE FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND (NOT app.company_organisation_managed() OR app.is_admin_for(coalesce(app.company_organisation_current_parent(id),id))))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(coalesce(CASE WHEN app.company_organisation_managed() THEN app.company_organisation_current_parent(id) ELSE parent_company_id END,id)));
ALTER POLICY company_delete_admin ON company USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(coalesce(app.company_organisation_current_parent(id),id)));
CREATE FUNCTION app.company_org_assignment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE co uuid;old_co uuid;tags jsonb;managed boolean;retained_bu uuid;BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper)) AND NOT EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=NEW.tenant_id AND state='published' AND kind<>'retag') THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Tenant-bound organisation write required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND NEW.tenant_id=OLD.tenant_id AND NEW.employment_id=OLD.employment_id AND NEW.business_unit_id IS NOT DISTINCT FROM OLD.business_unit_id AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id AND NEW.valid_from=OLD.valid_from THEN RETURN NEW;END IF;
 co:=NEW.company_id;IF co IS NULL THEN SELECT company_id INTO co FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id;END IF;
 tags:=app.company_org_tags_unchecked(co,NEW.valid_from);
 IF tags->>'status'<>'legacy' THEN NEW.business_unit_id:=nullif(tags->>'businessUnitId','')::uuid;
 ELSE
  -- Activation is tenant-wide even for a new backdated row. A pre-activation date is not
  -- permission to author a new BU. The private first-publication lease also activates this
  -- rule, while keeping actual historical prefix/reversal source values intact.
  managed:=app.company_organisation_managed() OR EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.tenant_id=NEW.tenant_id AND l.xact_id=pg_current_xact_id() AND l.actor_id=app.current_user_id());
  IF managed THEN
   IF TG_OP='UPDATE' THEN
    old_co:=OLD.company_id;IF old_co IS NULL THEN SELECT company_id INTO old_co FROM employment WHERE id=OLD.employment_id AND tenant_id=OLD.tenant_id;END IF;
    IF OLD.tenant_id=NEW.tenant_id AND OLD.employment_id=NEW.employment_id AND old_co IS NOT DISTINCT FROM co THEN
     NEW.business_unit_id:=OLD.business_unit_id;RETURN NEW;
    END IF;
   END IF;
   -- Native corrections supersede their source before inserting its replacement; normal
   -- dated assignments close it exactly at the replacement's start. Both are recorded
   -- provenance, not a caller-supplied BU. Never search another employment or Company.
   SELECT a.business_unit_id INTO retained_bu FROM assignment a JOIN employment e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
   WHERE a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id AND a.id<>NEW.id AND coalesce(a.company_id,e.company_id) IS NOT DISTINCT FROM co
    AND a.valid_from<=NEW.valid_from AND (a.valid_to IS NULL OR (a.valid_to>a.valid_from AND a.valid_to>=NEW.valid_from))
   ORDER BY a.valid_from DESC,(a.superseded_at IS NULL) DESC,a.superseded_at DESC NULLS LAST,a.id DESC LIMIT 1;
   NEW.business_unit_id:=retained_bu;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organisation_assignment_guard BEFORE INSERT OR UPDATE OF tenant_id,employment_id,business_unit_id,company_id,valid_from,valid_to,superseded_at ON assignment FOR EACH ROW EXECUTE FUNCTION app.company_org_assignment_guard();
CREATE FUNCTION app.company_org_assignment_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND NEW.superseded_at IS NULL AND (NEW.valid_to IS NULL OR NEW.valid_to>NEW.valid_from) AND EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=NEW.tenant_id AND state='published' AND kind<>'retag' AND effective_on<=NEW.valid_from) THEN
  PERFORM app.record_employment_organisation_tags(NEW.employment_id,coalesce(NEW.company_id,(SELECT company_id FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id)),NEW.valid_from,'assignment');
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER organisation_assignment_record AFTER INSERT OR UPDATE OF business_unit_id,company_id,valid_from ON assignment FOR EACH ROW EXECUTE FUNCTION app.company_org_assignment_record();
-- Private table mutation and audit evidence cannot be manufactured via the generic event appender.
CREATE FUNCTION app.company_org_audit_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event_token text;BEGIN
 IF NEW.aggregate_type='organisation-tag-run' OR NEW.event_type='employment.organisation-tagged' THEN
  event_token:=encode(sha256(convert_to(jsonb_build_array(NEW.tenant_id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload)::text,'UTF8')),'hex');
  DELETE FROM company_organisation_audit_permit p WHERE p.xact_id=pg_current_xact_id() AND p.token=event_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organisation audit requires its native exact-event permit' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER company_org_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.company_org_audit_owner();
CREATE FUNCTION app.company_organisation_options() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Current HR identity required' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('managed',app.company_organisation_managed(),'companies',coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.legal_name,'parentCompanyId',app.company_org_current_parent(c.id),'businessUnitId',app.company_org_tags_unchecked(c.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->'businessUnitId','units',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) ORDER BY b.name,b.id) FROM business_unit b WHERE b.tenant_id=c.tenant_id AND app.company_org_bu_usable(b.id,c.id)),'[]')) ORDER BY c.legal_name,c.id),'[]')) INTO result FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.company_org_hr(app.current_user_id(),ARRAY[c.id]) AND app.access_workforce_company(c.id,'workforce.maintain');RETURN result;
END $$;
-- Raw parent writes cannot bypass the reviewed owner once a mapping has been explicitly published.
CREATE FUNCTION app.company_org_parent_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NEW.parent_company_id IS DISTINCT FROM OLD.parent_company_id AND NOT app.acting_as_owner() AND app.company_organisation_managed() THEN RAISE EXCEPTION 'Prepare an independently reviewed dated Group structure proposal' USING ERRCODE='42501';END IF;RETURN NEW;END $$;
CREATE TRIGGER organisation_company_parent_guard BEFORE UPDATE OF parent_company_id ON company FOR EACH ROW EXECUTE FUNCTION app.company_org_parent_guard();
-- Default-deny all implementation helpers. Only the declared fixed-command/read contracts are public to runtime.
DO $$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname IN(
 'company_org_append_event','company_org_identity_changed','company_org_tag_labels','company_org_parent_guard','company_organisation_options','company_org_current_parent','company_organisation_current_parent','company_org_hr_proposed','company_org_lock','company_org_source_changed','company_org_hr','company_org_checker','company_org_run_access','company_org_bu_usable','company_org_mapping_at','company_org_resolve','company_org_tags_unchecked','company_org_company_read','company_organisation_tags','company_organisation_next_change','company_org_employment_company','company_org_employment_unchecked','employment_organisation_tags','record_employment_organisation_tags','company_org_employment_fingerprint','company_org_active','prepare_company_organisation_run','company_org_run_checker','company_org_run_fresh','company_organisation_run_view','decide_company_organisation_run','process_company_organisation_run','begin_company_organisation_publication','company_organisation_projection_rows','finish_company_organisation_publication','company_organisation_run_report','company_organisation_managed','company_org_assignment_guard','company_org_assignment_record','company_org_audit_owner') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,ai_hr_app',f.signature);
 IF f.proname IN('company_organisation_options','company_organisation_current_parent','company_org_run_access','company_organisation_tags','company_organisation_next_change','employment_organisation_tags','record_employment_organisation_tags','prepare_company_organisation_run','company_organisation_run_view','decide_company_organisation_run','process_company_organisation_run','begin_company_organisation_publication','company_organisation_projection_rows','finish_company_organisation_publication','company_organisation_run_report','company_organisation_managed') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ai_hr_app',f.signature);END IF;
 END LOOP;END $$;
