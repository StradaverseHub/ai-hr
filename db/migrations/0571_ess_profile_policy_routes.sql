-- The canonical catalogs load after migrations on a fresh installation. Declare only the
-- global ESS module here before its setting FKs; do not grant any tenant entitlement.
-- seedCatalogs reconciles this declaration with packs/catalog.ts after migration.
INSERT INTO module(code,name,category,description,depends_on,billable,is_core,parent_module,pack_backed,sort_order)
 VALUES('ess','Employee Self-Service','core','The employee-facing workspace.','["employees"]'::jsonb,false,true,NULL,false,40)
 ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
INSERT INTO setting_definition (key,module_code,scope,value_type,default_value,default_on_install,customer_visible,description,sort_order)
VALUES ('ess.profile_photo_edit','ess','tenant','boolean','false'::jsonb,NULL,true,'Allow active employees to upload or replace their own profile photo; no deletion or other Personnel authority.',155)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Narrow own INSERT/UPDATE course. Existing administrator ownership and read/delete policies remain.
CREATE FUNCTION app.can_set_own_profile_photo(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('app.profile_own_photo_write',true)='on'
  AND app.is_self_person(p_person)
  AND EXISTS(SELECT 1 FROM tenant_setting s WHERE s.tenant_id=app.current_tenant_id() AND s.key='ess.profile_photo_edit' AND s.value='true'::jsonb)
  AND EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=p_person AND u.id=app.current_user_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.blacklisted_at IS NULL
    AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.can_set_own_profile_photo(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_set_own_profile_photo(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY person_photo_own_insert ON person_photo FOR INSERT
 WITH CHECK (tenant_id=app.current_tenant_id() AND uploaded_by_user_id=app.current_user_id() AND app.can_set_own_profile_photo(person_id) AND size_bytes=octet_length(content) AND size_bytes BETWEEN 1 AND 2097152 AND ((mime_type='image/png' AND encode(substring(content from 1 for 8),'hex')='89504e470d0a1a0a') OR (mime_type='image/jpeg' AND encode(substring(content from 1 for 3),'hex')='ffd8ff')));
--> statement-breakpoint
CREATE POLICY person_photo_own_update ON person_photo FOR UPDATE
 USING (tenant_id=app.current_tenant_id() AND app.can_set_own_profile_photo(person_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND uploaded_by_user_id=app.current_user_id() AND app.can_set_own_profile_photo(person_id) AND size_bytes=octet_length(content) AND size_bytes BETWEEN 1 AND 2097152 AND ((mime_type='image/png' AND encode(substring(content from 1 for 8),'hex')='89504e470d0a1a0a') OR (mime_type='image/jpeg' AND encode(substring(content from 1 for 3),'hex')='ffd8ff')));
--> statement-breakpoint
INSERT INTO setting_definition (key,module_code,scope,value_type,default_value,default_on_install,customer_visible,description,sort_order)
VALUES ('ess.profile_change_routing','ess','tenant','json','{"version":1,"enabled":false,"revision":"00000000-0000-0000-0000-000000000000","rules":[]}'::jsonb,NULL,true,'Named HR approval routing; designation never grants Personnel authority.',165)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE profile_change_request ADD COLUMN route_id uuid;
--> statement-breakpoint
ALTER TABLE profile_change_request ADD COLUMN route_revision uuid;
--> statement-breakpoint
ALTER TABLE profile_change_request ADD COLUMN route_approver_user_id uuid REFERENCES app_user(id);
--> statement-breakpoint
ALTER TABLE profile_change_request ADD COLUMN route_approver_employment_id uuid REFERENCES employment(id);
--> statement-breakpoint
ALTER TABLE profile_change_request ADD COLUMN route_context jsonb;
--> statement-breakpoint
-- Deliberate narrow cross-principal lookup. An employee may resolve only a route for their own subject;
-- HR may resolve only within their existing authority. No grant is minted by this function.
CREATE FUNCTION app.profile_route_principal(p_approver uuid,p_subject uuid)
RETURNS TABLE(user_id uuid,employment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.id,a.id FROM employment a JOIN app_user u ON u.person_id=a.person_id AND u.tenant_id=a.tenant_id
 JOIN employment s ON s.id=p_subject AND s.tenant_id=a.tenant_id
 WHERE a.id=p_approver AND a.tenant_id=app.current_tenant_id() AND a.person_id<>s.person_id
 AND (app.is_self_person(s.person_id) OR app.can_admin_employment(s.id))
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND a.blacklisted_at IS NULL
 AND a.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(a.resignation_date,a.last_working_date,a.terminated_on) IS NULL OR LEAST(a.resignation_date,a.last_working_date,a.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=a.tenant_id AND r.app_user_id=u.id AND r.role IN ('hr_admin','super_admin')
  AND (r.company_id IS NULL OR r.company_id=s.company_id OR app.is_company_descendant(s.company_id,r.company_id)))
 AND (NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=a.tenant_id AND t.key='ess.profile_change_approver' AND t.value='"group_admin"'::jsonb) OR EXISTS(SELECT 1 FROM role_assignment g WHERE g.tenant_id=a.tenant_id AND g.app_user_id=u.id AND (g.role='super_admin' OR g.role='hr_admin' AND g.company_id IS NULL)))
 AND (SELECT count(*) FROM app_user other WHERE other.tenant_id=a.tenant_id AND other.person_id=a.person_id AND other.archived_at IS NULL AND NOT app.login_blocked(other.id))=1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_route_principal(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_route_principal(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_route_reader(p_subject uuid,p_assigned_user uuid,p_assigned_employment uuid,p_status text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.can_admin_employment(p_subject) AND (
  (p_assigned_user IS NOT NULL AND p_assigned_user=app.current_user_id() AND NOT app.login_blocked(p_assigned_user)
    AND EXISTS(SELECT 1 FROM app.profile_route_principal(p_assigned_employment,p_subject) p WHERE p.user_id=p_assigned_user))
  OR (p_assigned_user IS NULL AND (p_status<>'pending' OR NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing') OR EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing' AND t.value->'version'='1'::jsonb AND t.value->'enabled'='false'::jsonb)))
  OR (app.is_group_admin() AND current_setting('app.profile_route_maintenance',true)='on')
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_route_reader(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_route_reader(uuid,uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
DROP POLICY profile_change_request_read ON profile_change_request;
--> statement-breakpoint
CREATE POLICY profile_change_request_read ON profile_change_request FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.tenant_id=profile_change_request.tenant_id AND e.person_id=profile_change_request.person_id
  AND (app.is_self_person(e.person_id) OR app.profile_route_reader(e.id,profile_change_request.route_approver_user_id,profile_change_request.route_approver_employment_id,profile_change_request.status::text))));
--> statement-breakpoint
DROP POLICY profile_change_request_update ON profile_change_request;
--> statement-breakpoint
CREATE POLICY profile_change_request_update ON profile_change_request FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND app.profile_route_reader(employment_id,route_approver_user_id,route_approver_employment_id,status::text))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_route_reader(employment_id,route_approver_user_id,route_approver_employment_id,status::text));
--> statement-breakpoint
-- Private reasoned route history remains under request RLS, without values/reasons in public events.
ALTER TABLE profile_change_request ADD COLUMN route_history jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE FUNCTION app.profile_route_candidates() RETURNS TABLE(employment_id uuid,user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.id,u.id FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE app.is_admin() AND app.can_admin_employment(e.id) AND e.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=e.tenant_id AND r.app_user_id=u.id AND r.role IN ('hr_admin','super_admin'))
 AND (SELECT count(*) FROM app_user other WHERE other.tenant_id=e.tenant_id AND other.person_id=e.person_id AND other.archived_at IS NULL AND NOT app.login_blocked(other.id))=1
 ORDER BY e.id,u.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_route_candidates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_route_candidates() TO ai_hr_app;
--> statement-breakpoint
-- Privacy erasure remains a scoped, write-only course, without granting proposal reads/decisions.
CREATE FUNCTION app.redact_profile_request_pii(p_person uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE profile_change_request r SET proposed='{"redacted":true}'::jsonb,decision_reason=NULL,route_history='[]'::jsonb,route_context=NULL
 WHERE r.tenant_id=app.current_tenant_id() AND r.person_id=p_person AND app.can_admin_employment(r.employment_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.redact_profile_request_pii(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.redact_profile_request_pii(uuid) TO ai_hr_app;
