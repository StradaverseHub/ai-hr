-- Kingdee onboarding V3.1. Additive: no legacy case, approval, asset or history is rewritten.
CREATE TABLE lc_onboarding_config (
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id), revision integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE lc_onboarding_case (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), source_draft_id uuid,
 employment_id uuid REFERENCES employment(id), revision integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,source_draft_id), CHECK(data->>'version'='1')
);
CREATE INDEX lc_onboarding_case_tenant_company ON lc_onboarding_case(tenant_id,company_id);
--> statement-breakpoint
CREATE TABLE lc_onboarding_private (
 case_id uuid PRIMARY KEY REFERENCES lc_onboarding_case(id), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), data jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE lc_onboarding_note (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 case_id uuid NOT NULL REFERENCES lc_onboarding_case(id), data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lc_onboarding_note_case ON lc_onboarding_note(tenant_id,case_id,created_at,id);
--> statement-breakpoint
CREATE TABLE lc_onboarding_seen (
 tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
 case_id uuid NOT NULL REFERENCES lc_onboarding_case(id), seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,case_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_page_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lc_onboarding_config c WHERE c.tenant_id=app.current_tenant_id()
 AND (c.data->'access'->'onboarding') ? app.current_user_id()::text)
$$;
REVOKE ALL ON FUNCTION app.onboarding_page_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_page_access() TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_group_member(p_group text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lc_onboarding_config c,
 jsonb_array_elements(c.data->'groups') g WHERE c.tenant_id=app.current_tenant_id()
 AND g->>'id'=p_group AND (g->'members') ? app.current_user_id()::text)
$$;
REVOKE ALL ON FUNCTION app.onboarding_group_member(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_group_member(text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_requisition_group_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lc_onboarding_config cfg WHERE cfg.tenant_id=app.current_tenant_id() AND (
 app.onboarding_group_member(cfg.data->>'techGroup') OR
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(cfg.data->'exceptions'->'groups') g WHERE app.onboarding_group_member(g)) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'catalogue') i WHERE app.onboarding_group_member(i->>'team')) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'workflows') w,jsonb_array_elements(w->'steps') s WHERE s->>'type'='group' AND app.onboarding_group_member(s->>'target')) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'routings') r,jsonb_array_elements(r->'rows') row WHERE app.onboarding_group_member(row->>'group'))))
$$;
REVOKE ALL ON FUNCTION app.onboarding_requisition_group_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_requisition_group_access() TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_participant(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lc_onboarding_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_id AND (
 app.onboarding_page_access() OR
 (jsonb_array_length(c.data->'requisitions')>0 AND app.onboarding_requisition_group_access()) OR
 EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.person_id::text=c.data->>'personId') OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks') t WHERE t->>'assignee'=app.current_user_id()::text) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'requisitions') r,
 jsonb_array_elements(r->'items') i WHERE app.onboarding_group_member(i->>'team') OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(i->'steps') s WHERE s->>'user'=app.current_user_id()::text OR app.onboarding_group_member(s->>'group'))) OR
 EXISTS(SELECT 1 FROM lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=c.tenant_id AND (n.data->'mentions') ? app.current_user_id()::text)))
$$;
REVOKE ALL ON FUNCTION app.onboarding_participant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_participant(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE lc_onboarding_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_config_read ON lc_onboarding_config FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE POLICY onb_config_insert ON lc_onboarding_config FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY onb_config_update ON lc_onboarding_config FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.onboarding_page_access() OR app.is_group_admin())) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON lc_onboarding_config TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE lc_onboarding_case ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_case_read ON lc_onboarding_case FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onboarding_participant(id) OR app.is_admin_for(company_id)));
CREATE POLICY onb_case_insert ON lc_onboarding_case FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY onb_case_update ON lc_onboarding_case FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.onboarding_participant(id) OR app.is_admin_for(company_id))) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON lc_onboarding_case TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE lc_onboarding_private ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_private_hr ON lc_onboarding_private FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
GRANT SELECT,INSERT,UPDATE ON lc_onboarding_private TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE lc_onboarding_note ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_note_read ON lc_onboarding_note FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.onboarding_participant(case_id));
CREATE POLICY onb_note_insert ON lc_onboarding_note FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_participant(case_id) AND data->>'by'=app.current_user_id()::text);
CREATE POLICY onb_note_update ON lc_onboarding_note FOR UPDATE USING(tenant_id=app.current_tenant_id() AND data->>'by'=app.current_user_id()::text AND app.onboarding_participant(case_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND data->>'by'=app.current_user_id()::text);
GRANT SELECT,INSERT,UPDATE ON lc_onboarding_note TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE lc_onboarding_seen ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_seen_own ON lc_onboarding_seen FOR ALL USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.onboarding_participant(case_id));
GRANT SELECT,INSERT,UPDATE ON lc_onboarding_seen TO ai_hr_app;
--> statement-breakpoint
-- A bounded public directory projection. Historical actor names remain in the case log.
CREATE OR REPLACE FUNCTION app.onboarding_directory() RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.id,coalesce(p.full_name,'User '||left(u.id::text,8)) FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id)
 AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id())
 ORDER BY coalesce(p.full_name,'User '||left(u.id::text,8)),u.id
$$;
REVOKE ALL ON FUNCTION app.onboarding_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_directory() TO ai_hr_app;
--> statement-breakpoint
-- Returns availability only, never medical details. Mirrors the Leave owner's date/whole-span semantics.
CREATE OR REPLACE FUNCTION app.onboarding_unavailable(p_dates date[]) RETURNS TABLE(user_id uuid,on_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH members AS (
 SELECT DISTINCT (jsonb_array_elements_text(g->'members'))::uuid AS id
 FROM lc_onboarding_config c,jsonb_array_elements(c.data->'groups') g
 WHERE c.tenant_id=app.current_tenant_id() AND (app.onboarding_page_access() OR app.is_group_admin() OR app.onboarding_group_member(g->>'id'))
 ), dates AS (SELECT DISTINCT unnest(p_dates) d LIMIT 400)
 SELECT DISTINCT u.id,dates.d FROM members m JOIN app_user u ON u.id=m.id AND u.tenant_id=app.current_tenant_id()
 JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN leave_request lr ON lr.employment_id=e.id AND lr.tenant_id=e.tenant_id
 CROSS JOIN dates
 WHERE (
 EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id AND ld.leave_date=dates.d AND ld.status='approved')
 OR (lr.status='approved' AND dates.d BETWEEN lr.start_date AND lr.end_date
 AND NOT EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id)))
$$;
REVOKE ALL ON FUNCTION app.onboarding_unavailable(date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_unavailable(date[]) TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE lc_onboarding_config_history (
 tenant_id uuid NOT NULL REFERENCES tenant(id),revision integer NOT NULL,data jsonb NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE lc_onboarding_config_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_config_history_read ON lc_onboarding_config_history FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onboarding_page_access() OR app.is_group_admin()));
CREATE POLICY onb_config_history_insert ON lc_onboarding_config_history FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND (app.onboarding_page_access() OR app.is_group_admin()) AND actor_user_id=app.current_user_id());
GRANT SELECT,INSERT ON lc_onboarding_config_history TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_note_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.data->>'by' IS DISTINCT FROM app.current_user_id()::text THEN
   IF (NEW.data-'resolved') IS DISTINCT FROM (OLD.data-'resolved')
      OR NOT ((OLD.data->'mentions') ? app.current_user_id()::text)
      OR NOT ((NEW.data->'resolved') @> (OLD.data->'resolved'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.data->'resolved') v
        WHERE v<>app.current_user_id()::text AND NOT ((OLD.data->'resolved') ? v))
   THEN RAISE EXCEPTION 'Only the note author may change its content'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onb_note_guard BEFORE UPDATE ON lc_onboarding_note FOR EACH ROW EXECUTE FUNCTION app.onboarding_note_guard();
DROP POLICY onb_note_update ON lc_onboarding_note;
CREATE POLICY onb_note_update ON lc_onboarding_note FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onboarding_participant(case_id) AND
 (data->>'by'=app.current_user_id()::text OR (data->'mentions') ? app.current_user_id()::text))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_participant(case_id));

--> statement-breakpoint
CREATE TABLE lc_onboarding_notice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 user_id uuid NOT NULL REFERENCES app_user(id),case_id uuid NOT NULL REFERENCES lc_onboarding_case(id),
 kind text NOT NULL, occurrence text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,
 UNIQUE(tenant_id,user_id,case_id,kind,occurrence)
);
CREATE UNIQUE INDEX lc_onboarding_digest_day_uq ON lc_onboarding_notice(tenant_id,user_id,occurrence) WHERE kind='digest';
ALTER TABLE lc_onboarding_notice ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_notice_read ON lc_onboarding_notice FOR SELECT USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.onboarding_participant(case_id));
CREATE POLICY onb_notice_insert ON lc_onboarding_notice FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY onb_notice_update ON lc_onboarding_notice FOR UPDATE USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
GRANT SELECT,INSERT ON lc_onboarding_notice TO ai_hr_app;
GRANT UPDATE(read_at) ON lc_onboarding_notice TO ai_hr_app;
--> statement-breakpoint
DROP POLICY onb_config_read ON lc_onboarding_config;
CREATE POLICY onb_config_read ON lc_onboarding_config FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.current_user_id() IS NOT NULL OR app.is_group_admin()));

--> statement-breakpoint
ALTER TABLE notification_email_policy DROP CONSTRAINT notification_email_policy_category_check;
ALTER TABLE notification_email_policy ADD CONSTRAINT notification_email_policy_category_check CHECK(category IN ('attendance','claims','delegation','leave','notice','offboarding','onboarding','payroll','performance','profile','readiness','review','rewards','toil','employee_master_reports'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.notification_email_enqueue(p_notification uuid,p_category text,p_sequence bigint)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_admin() THEN RAISE EXCEPTION 'notification dispatcher required' USING ERRCODE='insufficient_privilege'; END IF;
 INSERT INTO notification_delivery(tenant_id,notification_id,channel,recipient_user_id,source_event_id,kind,category)
 SELECT n.tenant_id,n.id,'email',u.id,n.source_event_id,n.kind,p_category
 FROM notification n JOIN domain_event ev ON ev.id=n.source_event_id AND ev.tenant_id=n.tenant_id
 JOIN employment e ON e.id=n.recipient_employment_id AND e.tenant_id=n.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=n.tenant_id
 JOIN notification_pref pref ON pref.tenant_id=n.tenant_id AND pref.recipient_employment_id=e.id
   AND pref.category=p_category AND pref.channel='email' AND pref.enabled
   AND pref.email_consent_user_id=u.id AND pref.email_after_sequence IS NOT NULL AND ev.sequence>pref.email_after_sequence
 JOIN notification_email_policy policy ON policy.tenant_id=n.tenant_id AND policy.category=p_category
   AND policy.enabled AND ev.sequence>policy.after_sequence
 WHERE n.id=p_notification AND n.tenant_id=app.current_tenant_id() AND ev.sequence=p_sequence
 AND app.can_admin_employment(e.id)
 AND p_category IN ('attendance','claims','delegation','leave','notice','offboarding','onboarding','payroll','performance','profile','readiness','review','rewards','toil') AND NOT app.login_blocked(u.id)
 AND EXISTS(SELECT 1 FROM app_external_identity i WHERE i.app_user_id=u.id AND i.revoked_at IS NULL)
 ON CONFLICT DO NOTHING;
END; $$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_user_participant(p_id uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lc_onboarding_case c JOIN lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id
 JOIN app_user u ON u.tenant_id=c.tenant_id AND u.id=p_user
 WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_id AND NOT app.login_blocked(u.id)
 AND c.data->>'state' IN ('pending','submitted') AND (
 (cfg.data->'access'->'onboarding') ? p_user::text OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks') t WHERE t->>'assignee'=p_user::text AND t->>'status'<>'done') OR
 EXISTS(SELECT 1 FROM lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=c.tenant_id AND n.data->>'deleted'='false' AND (n.data->'mentions') ? p_user::text AND NOT (n.data->'resolved') ? p_user::text) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i
 WHERE r->>'cancelledAt' IS NULL AND r->>'handedAt' IS NULL AND i->>'removed'='false' AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups') g WHERE g->>'id'=i->>'team' AND (g->'members') ? p_user::text) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(i->'steps') s WHERE s->>'status'='pending' AND (s->>'user'=p_user::text OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups') g WHERE g->>'id'=s->>'group' AND (g->'members') ? p_user::text)))))))
$$;
REVOKE ALL ON FUNCTION app.onboarding_user_participant(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_mail_recipient(p_case uuid,p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH candidates AS (
 SELECT e.id FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 WHERE u.id=p_user AND u.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id)
 AND app.is_group_admin() AND app.onboarding_user_participant(p_case,p_user)
 )
 SELECT id FROM candidates WHERE (SELECT count(*) FROM candidates)=1 AND EXISTS(
 SELECT 1 FROM lc_onboarding_notice n WHERE n.tenant_id=app.current_tenant_id() AND n.case_id=p_case AND n.user_id=p_user AND n.kind='digest' AND n.occurrence=to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD'))
$$;

REVOKE ALL ON FUNCTION app.onboarding_mail_recipient(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_mail_recipient(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_task_actors(p_person uuid,p_supervisor uuid)
RETURNS TABLE(kind text,user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH candidates AS (
 SELECT 'joiner'::text kind,u.id FROM app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.person_id=p_person AND NOT app.login_blocked(u.id)
 UNION ALL
 SELECT 'manager'::text,u.id FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=p_supervisor AND e.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id)
 )
 SELECT kind,min(id::text)::uuid FROM candidates WHERE app.onboarding_page_access() OR app.is_group_admin() GROUP BY kind HAVING count(*)=1
$$;
REVOKE ALL ON FUNCTION app.onboarding_task_actors(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_task_actors(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Workload totals are tenant-wide even for staff using only My tasks. Exposes counts, never cases.
CREATE OR REPLACE FUNCTION app.onboarding_assignment_loads()
RETURNS TABLE(user_id uuid,task_load bigint,last_auto text,pending_approvals bigint,lifetime_approvals bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH permitted AS (
 SELECT app.onboarding_page_access() OR app.is_group_admin() OR EXISTS(
 SELECT 1 FROM lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups') g
 WHERE cfg.tenant_id=app.current_tenant_id() AND (g->'members') ? app.current_user_id()::text) AS ok
 ), cs AS (SELECT c.data FROM lc_onboarding_case c,permitted WHERE c.tenant_id=app.current_tenant_id() AND permitted.ok),
 tasks AS (SELECT c.data->>'state' AS case_state,t FROM cs c,jsonb_array_elements(c.data->'tasks') t),
 past_tasks AS (SELECT t FROM cs c,jsonb_array_elements(coalesce(c.data->'taskHistory','[]'::jsonb)) h,jsonb_array_elements(h) t),
 auto_history AS (SELECT a FROM (SELECT t FROM tasks UNION ALL SELECT t FROM past_tasks) x,jsonb_array_elements(coalesce(t->'autoAssignments','[]'::jsonb)) a),
 steps AS (SELECT c.data->>'state' AS case_state,r,i,s FROM cs c,jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i,jsonb_array_elements(i->'steps') s WHERE s->>'type' IN ('group','routing')),
 assigned AS (SELECT a FROM steps,jsonb_array_elements(coalesce(s->'assignments','[]'::jsonb)) a)
 SELECT u.id,
 (SELECT count(*) FROM tasks WHERE case_state='submitted' AND t->>'by'='group' AND t->>'assignee'=u.id::text AND t->>'status'<>'done'),
 (SELECT max(a->>'at') FROM auto_history WHERE a->>'user'=u.id::text),
 (SELECT count(*) FROM steps WHERE case_state='submitted' AND r->>'cancelledAt' IS NULL AND i->>'removed'='false' AND i->>'approval'='pending' AND s->>'status'='pending' AND s->>'user'=u.id::text),
 (SELECT count(*) FROM assigned WHERE a->>'user'=u.id::text)
 FROM app_user u,permitted WHERE u.tenant_id=app.current_tenant_id() AND permitted.ok AND NOT app.login_blocked(u.id)
$$;
REVOKE ALL ON FUNCTION app.onboarding_assignment_loads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assignment_loads() TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE lc_onboarding_case_revision (
 case_id uuid NOT NULL REFERENCES lc_onboarding_case(id),revision integer NOT NULL,
 tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(case_id,revision)
);
ALTER TABLE lc_onboarding_case_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_revision_read ON lc_onboarding_case_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onboarding_participant(case_id) OR app.is_admin_for(company_id)));
CREATE POLICY onb_revision_insert ON lc_onboarding_case_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND (app.onboarding_participant(case_id) OR app.is_admin_for(company_id)));
GRANT SELECT,INSERT ON lc_onboarding_case_revision TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE lc_onboarding_private_revision (
 case_id uuid NOT NULL REFERENCES lc_onboarding_case(id),revision integer NOT NULL,
 tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(case_id,revision)
);
ALTER TABLE lc_onboarding_private_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY onb_private_revision_read ON lc_onboarding_private_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY onb_private_revision_insert ON lc_onboarding_private_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
GRANT SELECT,INSERT ON lc_onboarding_private_revision TO ai_hr_app;

--> statement-breakpoint
-- Names for the already-authorized case, without widening Personnel or master-data browsing rights.
CREATE OR REPLACE FUNCTION app.onboarding_case_labels(p_case uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH c AS (SELECT (data->'local')||(data->'source') AS f FROM lc_onboarding_case
 WHERE id=p_case AND tenant_id=app.current_tenant_id() AND (app.onboarding_participant(id) OR app.is_admin_for(company_id)))
 SELECT jsonb_strip_nulls(jsonb_build_object(
 'company',(SELECT legal_name FROM company,c WHERE company.tenant_id=app.current_tenant_id() AND company.id::text=c.f->>'company'),
 'businessGroup',(SELECT name FROM business_unit,c WHERE business_unit.tenant_id=app.current_tenant_id() AND business_unit.id::text=c.f->>'businessGroup'),
 'department',(SELECT name FROM department,c WHERE department.tenant_id=app.current_tenant_id() AND department.id::text=c.f->>'department'),
 'title',(SELECT title FROM position,c WHERE position.tenant_id=app.current_tenant_id() AND position.id::text=c.f->>'title'),
 'grade',(SELECT name FROM job_grade,c WHERE job_grade.tenant_id=app.current_tenant_id() AND job_grade.id::text=c.f->>'grade'),
 'supervisor',(SELECT p.full_name FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id,c WHERE e.tenant_id=app.current_tenant_id() AND e.id::text=c.f->>'supervisor')
 )) WHERE EXISTS(SELECT 1 FROM c)
$$;
REVOKE ALL ON FUNCTION app.onboarding_case_labels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_case_labels(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onboarding_supervisors() RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.id,coalesce(e.employee_code||' – ','')||p.full_name||' · '||co.legal_name
 FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.terminated_on IS NULL
 AND (app.onboarding_page_access() OR app.is_group_admin()) ORDER BY p.full_name,e.employee_code,e.id
$$;
REVOKE ALL ON FUNCTION app.onboarding_supervisors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_supervisors() TO ai_hr_app;

--> statement-breakpoint
-- The scheduled Personnel refresh has tenant/role scope but deliberately has no fabricated login.
-- Retain the same authoritative lifecycle counter and leave the legacy login-only allocator intact.
CREATE OR REPLACE FUNCTION app.onboarding_next_case_number(p_year text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v integer;
BEGIN
 IF app.current_tenant_id() IS NULL OR
    (app.current_user_id() IS NULL AND NOT app.is_group_admin()) THEN
   RAISE EXCEPTION 'onboarding_next_case_number: no authorized session';
 END IF;
 IF p_year IS NULL OR p_year !~ '^[0-9]{4}$' THEN
   RAISE EXCEPTION 'onboarding_next_case_number: invalid year';
 END IF;
 INSERT INTO lc_counter(tenant_id,prefix,last_value)
 VALUES(app.current_tenant_id(),'OB-'||p_year,1)
 ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=lc_counter.last_value+1
 RETURNING last_value INTO v;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_next_case_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_next_case_number(text) TO ai_hr_app;
