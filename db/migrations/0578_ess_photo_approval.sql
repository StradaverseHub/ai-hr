-- ESS photo proposals use the existing profile request/routing owner. No own master-photo write.
DROP POLICY person_photo_own_insert ON person_photo;
--> statement-breakpoint
DROP POLICY person_photo_own_update ON person_photo;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_set_own_profile_photo(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT false $$;
--> statement-breakpoint
CREATE UNIQUE INDEX profile_change_request_pending_photo_person_uq ON profile_change_request(tenant_id,person_id) WHERE status='pending' AND proposed->>'kind'='photo';
--> statement-breakpoint
CREATE TABLE profile_photo_proposal (
 request_id uuid PRIMARY KEY REFERENCES profile_change_request(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 content bytea NOT NULL,
 mime_type text NOT NULL,
 size_bytes integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT profile_photo_proposal_bytes CHECK(size_bytes=octet_length(content) AND size_bytes BETWEEN 1 AND 2097152 AND
 ((mime_type='image/png' AND encode(substring(content from 1 for 8),'hex')='89504e470d0a1a0a') OR (mime_type='image/jpeg' AND encode(substring(content from 1 for 3),'hex')='ffd8ff')))
);
--> statement-breakpoint
ALTER TABLE profile_photo_proposal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE profile_photo_proposal FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON profile_photo_proposal FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON profile_photo_proposal TO ai_hr_app;
--> statement-breakpoint
-- The owning retention trigger can purge decided bytes under FORCE RLS; runtime gets no DELETE.
CREATE POLICY profile_photo_proposal_retention_read ON profile_photo_proposal FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY profile_photo_proposal_retention_delete ON profile_photo_proposal FOR DELETE TO ai_hr_owner USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- Exact photo disclosure/submission limits, including the v4 tab/section upper bound.
CREATE FUNCTION app.profile_photo_proposal_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM tenant_setting s WHERE s.tenant_id=app.current_tenant_id() AND s.key='ess.profile_photo_edit' AND s.value='true'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM tenant_setting s WHERE s.tenant_id=app.current_tenant_id() AND s.key='ess.profile_change_fields' AND
  CASE WHEN s.value IS NULL OR s.value='null'::jsonb OR s.value='"all"'::jsonb OR jsonb_typeof(s.value)='array' THEN false
   WHEN s.value->>'version'='2' THEN false
   WHEN s.value->>'version' IN ('3','4') THEN
    COALESCE(s.value->'fields'->>'profile.personal_details.photo','hide')='hide'
    OR (s.value->>'version'='4' AND (COALESCE(s.value->'groups'->>'tab:Profile','editable')<>'editable' OR COALESCE(s.value->'groups'->>'section:Profile/Personal details','editable')<>'editable'))
   ELSE true END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_photo_proposal_allowed() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_photo_proposal_allowed() TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY profile_photo_proposal_read ON profile_photo_proposal FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.profile_photo_proposal_allowed() AND EXISTS(SELECT 1 FROM profile_change_request r WHERE r.id=request_id AND r.tenant_id=profile_photo_proposal.tenant_id AND r.status='pending' AND r.proposed->'v'='3'::jsonb AND r.proposed->>'kind'='photo'
  AND ((app.is_self_person(r.person_id) AND app.profile_photo_proposal_allowed() AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.person_id=r.person_id AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))) OR (r.route_approver_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM app.profile_route_principal(r.route_approver_employment_id,r.employment_id) p WHERE p.user_id=app.current_user_id())))));
--> statement-breakpoint
CREATE POLICY profile_photo_proposal_insert ON profile_photo_proposal FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_photo_proposal_allowed() AND EXISTS(SELECT 1 FROM profile_change_request r WHERE r.id=request_id AND r.tenant_id=profile_photo_proposal.tenant_id AND r.status='pending' AND r.proposed->'v'='3'::jsonb AND r.proposed->>'kind'='photo' AND r.proposed->>'fieldId'='profile.personal_details.photo' AND r.route_approver_user_id IS NOT NULL AND app.is_self_person(r.person_id)));
--> statement-breakpoint
-- Retain decision metadata/history; remove bytes on approval, rejection, withdrawal or PDPA redaction.
CREATE FUNCTION app.purge_decided_profile_photo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status<>'pending' OR NEW.proposed->>'kind' IS DISTINCT FROM 'photo' THEN
  DELETE FROM profile_photo_proposal WHERE request_id=NEW.id AND tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_decided_profile_photo() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER profile_photo_proposal_retention AFTER UPDATE ON profile_change_request FOR EACH ROW EXECUTE FUNCTION app.purge_decided_profile_photo();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_route_reader(p_subject uuid,p_assigned_user uuid,p_assigned_employment uuid,p_status text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.can_admin_employment(p_subject) AND (
  (p_assigned_user IS NOT NULL AND p_assigned_user=app.current_user_id() AND NOT app.login_blocked(p_assigned_user)
    AND EXISTS(SELECT 1 FROM app.profile_route_principal(p_assigned_employment,p_subject) p WHERE p.user_id=p_assigned_user))
  OR (p_assigned_user IS NULL AND (p_status<>'pending' OR NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing') OR EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing' AND t.value->>'version' IN ('1','2') AND t.value->'enabled'='false'::jsonb)))
  OR (app.is_group_admin() AND current_setting('app.profile_route_maintenance',true)='on')
 );
$$;

