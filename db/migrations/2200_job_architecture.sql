-- Approved Job Architecture: explicit seats, immutable approved versions and independently checked proposals.
CREATE TABLE job_architecture_seat (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 user_id uuid NOT NULL REFERENCES app_user(id),company_id uuid REFERENCES company(id),
 role text NOT NULL CHECK(role IN('group_rewards','org_design','pbp')),
 valid_from date NOT NULL,valid_to date,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_to IS NULL OR valid_to>=valid_from),UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX job_architecture_seat_active ON job_architecture_seat(tenant_id,user_id,role,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid),valid_from);
ALTER TABLE job_architecture_seat ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_architecture_seat FORCE ROW LEVEL SECURITY;
CREATE POLICY job_architecture_seat_read ON job_architecture_seat FOR SELECT USING(tenant_id=app.current_tenant_id() AND (user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY job_architecture_seat_insert ON job_architecture_seat FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin() AND created_by=app.current_user_id());
CREATE POLICY job_architecture_seat_update ON job_architecture_seat FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_group_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
GRANT SELECT,INSERT,UPDATE ON job_architecture_seat TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.job_architecture_can(wanted_company uuid,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_operation IN('view','propose','check')
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (wanted_company IS NULL OR EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()))
 AND (
  EXISTS(SELECT 1 FROM job_architecture_seat s WHERE s.tenant_id=app.current_tenant_id() AND s.user_id=app.current_user_id()
   AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
   AND (s.company_id IS NULL OR s.company_id=wanted_company OR wanted_operation='view' AND wanted_company IS NULL) AND (wanted_operation<>'check' OR s.role IN('group_rewards','org_design')))
  OR wanted_operation<>'check' AND (
   wanted_company IS NOT NULL AND app.access_workforce_company(wanted_company,CASE WHEN wanted_operation='view' THEN 'workforce.view' ELSE 'workforce.maintain' END)
   OR wanted_company IS NULL AND (wanted_operation='view' AND EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_company(c.id,'workforce.view')) OR wanted_operation='propose' AND app.is_group_admin())
  )
 )
$$;
REVOKE ALL ON FUNCTION app.job_architecture_can(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.job_architecture_can(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE job_architecture_proposal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid REFERENCES company(id),
 kind text NOT NULL CHECK(kind IN('catalogue','positions','outlier_resolution')),affected_company_ids uuid[] NOT NULL DEFAULT '{}',base_revision integer NOT NULL CHECK(base_revision>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 4000),
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),checked_by uuid REFERENCES app_user(id),checked_at timestamptz,
 CHECK(checked_by IS NULL OR checked_by<>created_by),CHECK((status='pending')=(checked_by IS NULL)),UNIQUE(tenant_id,id)
);
CREATE TABLE job_architecture_catalogue_revision (
 tenant_id uuid NOT NULL REFERENCES tenant(id),revision integer NOT NULL CHECK(revision>0),catalogue jsonb NOT NULL CHECK(jsonb_typeof(catalogue)='object'),
 proposal_id uuid NOT NULL,proposed_by uuid NOT NULL REFERENCES app_user(id),checked_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,revision),FOREIGN KEY(tenant_id,proposal_id) REFERENCES job_architecture_proposal(tenant_id,id),CHECK(proposed_by<>checked_by)
);
CREATE TABLE job_architecture_position_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),position_id uuid NOT NULL REFERENCES position(id),
 revision integer NOT NULL CHECK(revision>0),catalogue_revision integer NOT NULL,mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),proposal_id uuid NOT NULL,
 proposed_by uuid NOT NULL REFERENCES app_user(id),checked_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,company_id,position_id,revision),FOREIGN KEY(tenant_id,catalogue_revision) REFERENCES job_architecture_catalogue_revision(tenant_id,revision),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES job_architecture_proposal(tenant_id,id),CHECK(proposed_by<>checked_by)
);
CREATE TABLE job_architecture_outlier (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),fingerprint text NOT NULL,company_ids uuid[] NOT NULL,
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),state text NOT NULL DEFAULT 'new' CHECK(state IN('new','open','partial','resolved')),
 owner_id uuid REFERENCES app_user(id),due_on date,resolution text,revision integer NOT NULL DEFAULT 1,
 detected_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),resolved_by uuid REFERENCES app_user(id),checked_by uuid REFERENCES app_user(id),
 UNIQUE(tenant_id,fingerprint),UNIQUE(tenant_id,id),CHECK(checked_by IS NULL OR resolved_by IS NOT NULL AND checked_by<>resolved_by)
);
--> statement-breakpoint
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['job_architecture_proposal','job_architecture_catalogue_revision','job_architecture_position_revision','job_architecture_outlier'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
 END LOOP;
END $$;
CREATE POLICY job_architecture_proposal_read ON job_architecture_proposal FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'view') AND NOT EXISTS(SELECT 1 FROM unnest(affected_company_ids) c WHERE NOT app.job_architecture_can(c,'view')));
CREATE POLICY job_architecture_proposal_insert ON job_architecture_proposal FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND status='pending' AND app.job_architecture_can(company_id,'propose'));
CREATE POLICY job_architecture_proposal_check ON job_architecture_proposal FOR UPDATE USING(tenant_id=app.current_tenant_id() AND status='pending' AND created_by<>app.current_user_id() AND app.job_architecture_can(company_id,'check')) WITH CHECK(tenant_id=app.current_tenant_id() AND status IN('approved','rejected') AND checked_by=app.current_user_id() AND created_by<>checked_by AND app.job_architecture_can(company_id,'check'));
CREATE POLICY job_architecture_catalogue_read ON job_architecture_catalogue_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(NULL,'view'));
CREATE POLICY job_architecture_catalogue_insert ON job_architecture_catalogue_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND checked_by=app.current_user_id() AND app.job_architecture_can(NULL,'check') AND EXISTS(SELECT 1 FROM job_architecture_proposal p WHERE p.id=proposal_id AND p.tenant_id=job_architecture_catalogue_revision.tenant_id AND p.kind='catalogue' AND p.status='approved' AND p.created_by=proposed_by AND p.checked_by=job_architecture_catalogue_revision.checked_by));
CREATE POLICY job_architecture_position_read ON job_architecture_position_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'view'));
CREATE POLICY job_architecture_position_insert ON job_architecture_position_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND checked_by=app.current_user_id() AND app.job_architecture_can(company_id,'check') AND EXISTS(SELECT 1 FROM job_architecture_proposal p WHERE p.id=proposal_id AND p.tenant_id=job_architecture_position_revision.tenant_id AND p.kind='positions' AND p.company_id=job_architecture_position_revision.company_id AND p.status='approved' AND p.created_by=proposed_by AND p.checked_by=job_architecture_position_revision.checked_by));
CREATE POLICY job_architecture_outlier_read ON job_architecture_outlier FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(NULL,'view') AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.job_architecture_can(c,'view')));
CREATE POLICY job_architecture_outlier_write ON job_architecture_outlier FOR ALL USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(NULL,'propose') AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.job_architecture_can(c,'propose'))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.job_architecture_can(NULL,'propose') AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.job_architecture_can(c,'propose')));
GRANT SELECT,INSERT,UPDATE ON job_architecture_proposal,job_architecture_outlier TO ai_hr_app;
GRANT SELECT,INSERT ON job_architecture_catalogue_revision,job_architecture_position_revision TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.job_architecture_links() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='job_architecture_seat' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.user_id AND tenant_id=NEW.tenant_id) OR NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Architecture seat must remain in its tenant'; END IF;
 ELSIF TG_TABLE_NAME='job_architecture_position_revision' THEN
  IF NOT EXISTS(SELECT 1 FROM position p WHERE p.id=NEW.position_id AND p.tenant_id=NEW.tenant_id AND p.archived_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   OR NEW.mapping->>'positionId'<>NEW.position_id::text OR NEW.mapping->>'companyId'<>NEW.company_id::text THEN RAISE EXCEPTION 'Invalid architecture position binding'; END IF;
 ELSIF TG_TABLE_NAME='job_architecture_proposal' AND TG_OP='UPDATE' THEN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.kind<>OLD.kind OR NEW.base_revision<>OLD.base_revision OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.created_by<>OLD.created_by OR NEW.reason<>OLD.reason OR NEW.affected_company_ids IS DISTINCT FROM OLD.affected_company_ids OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'Only the independent decision may change a proposal'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER job_architecture_seat_links BEFORE INSERT OR UPDATE ON job_architecture_seat FOR EACH ROW EXECUTE FUNCTION app.job_architecture_links();
CREATE TRIGGER job_architecture_position_links BEFORE INSERT ON job_architecture_position_revision FOR EACH ROW EXECUTE FUNCTION app.job_architecture_links();
CREATE TRIGGER job_architecture_proposal_links BEFORE UPDATE ON job_architecture_proposal FOR EACH ROW EXECUTE FUNCTION app.job_architecture_links();
REVOKE ALL ON FUNCTION app.job_architecture_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.job_architecture_links() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.job_architecture_ladder_continuity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE previous jsonb;last_revision integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,2200));
 SELECT revision,catalogue INTO last_revision,previous FROM job_architecture_catalogue_revision WHERE tenant_id=NEW.tenant_id ORDER BY revision DESC LIMIT 1;
 IF NEW.revision<>coalesce(last_revision,0)+1 THEN RAISE EXCEPTION 'Catalogue revision is stale'; END IF;
 IF jsonb_array_length(coalesce(previous->'ladder','[]'::jsonb))=13 AND
 (jsonb_array_length(coalesce(NEW.catalogue->'ladder','[]'::jsonb))<>13 OR EXISTS(SELECT 1 FROM jsonb_array_elements(previous->'ladder') p WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.catalogue->'ladder') n WHERE n->>'code'=p->>'code' AND n->>'gradeId'=p->>'gradeId'))) THEN RAISE EXCEPTION 'Official ladder identities require a separate reviewed grade migration'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER job_architecture_ladder_continuity BEFORE INSERT ON job_architecture_catalogue_revision FOR EACH ROW EXECUTE FUNCTION app.job_architecture_ladder_continuity();
REVOKE ALL ON FUNCTION app.job_architecture_ladder_continuity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.job_architecture_ladder_continuity() TO ai_hr_app;
