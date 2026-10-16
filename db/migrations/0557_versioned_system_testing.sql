-- ADR0128 /9689f5d3. Existing TC identities and run outcomes remain intact.
-- Entitlement authority remains canonical service assertModuleEnabled; policies below add assignment/actor integrity.
ALTER TABLE public.test_case ADD COLUMN semantic_id text, ADD COLUMN origin text NOT NULL DEFAULT 'legacy',
 ADD COLUMN current_version_id uuid, ADD COLUMN draft_definition jsonb, ADD COLUMN draft_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN accepted_catalogue_definition_hash text;
ALTER TABLE public.test_case ADD CONSTRAINT test_case_origin_ck CHECK(origin IN ('legacy','local','catalogue')),
 ADD CONSTRAINT test_case_draft_revision_ck CHECK(draft_revision >= 0), ADD CONSTRAINT test_case_id_tenant_uq UNIQUE(id,tenant_id);
CREATE UNIQUE INDEX test_case_semantic_uq ON public.test_case(tenant_id,semantic_id) WHERE semantic_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.test_case_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 test_case_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0), definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), provenance text NOT NULL CHECK(provenance IN ('upgrade_baseline','local','catalogue')),
 source_ref text, catalogue_hash text, source_content_hash text, guide_source_hash text, published_by_user_id uuid REFERENCES public.app_user(id), published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(test_case_id,ordinal), UNIQUE(id,tenant_id,test_case_id),
 FOREIGN KEY(test_case_id,tenant_id) REFERENCES public.test_case(id,tenant_id) ON DELETE CASCADE,
 CHECK((provenance='catalogue')=(source_ref IS NOT NULL AND catalogue_hash IS NOT NULL AND source_content_hash IS NOT NULL AND guide_source_hash IS NOT NULL))
);
-- Honest upgrade baseline ONLY. No old test_run is backfilled to this new version.
INSERT INTO public.test_case_version(tenant_id,test_case_id,ordinal,definition,content_hash,provenance)
 SELECT tenant_id,id,1,jsonb_build_object('format',0,'history','upgrade_baseline','title',title,'moduleCode',module_code,
 'precondition',precondition,'steps',steps,'testType',test_type,'priority',priority,'expectedBehavior',expected_behavior,'expectedFunction',expected_function),
 encode(digest(convert_to(jsonb_build_object('title',title,'module',module_code,'steps',steps,'expectedBehavior',expected_behavior,'expectedFunction',expected_function)::text,'UTF8'),'sha256'),'hex'),'upgrade_baseline'
 FROM public.test_case;
UPDATE public.test_case c SET current_version_id=v.id FROM public.test_case_version v WHERE v.test_case_id=c.id AND v.ordinal=1;
ALTER TABLE public.test_case ADD CONSTRAINT test_case_current_version_fk FOREIGN KEY(current_version_id,tenant_id,id) REFERENCES public.test_case_version(id,tenant_id,test_case_id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE public.test_assignment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id), test_case_id uuid NOT NULL,
 tester_user_id uuid NOT NULL REFERENCES public.app_user(id), target_version_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true, retest_required boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 assigned_by_user_id uuid NOT NULL REFERENCES public.app_user(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(test_case_id,tester_user_id), UNIQUE(id,tenant_id),
 FOREIGN KEY(test_case_id,tenant_id) REFERENCES public.test_case(id,tenant_id) ON DELETE CASCADE,
 FOREIGN KEY(target_version_id,tenant_id,test_case_id) REFERENCES public.test_case_version(id,tenant_id,test_case_id)
);
CREATE INDEX test_assignment_user_idx ON public.test_assignment(tenant_id,tester_user_id,active);
CREATE TABLE public.test_execution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id), assignment_id uuid NOT NULL,
 version_id uuid NOT NULL REFERENCES public.test_case_version(id), attempt_no integer NOT NULL CHECK(attempt_no>0), tester_user_id uuid NOT NULL REFERENCES public.app_user(id),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), current_run_id uuid,
 defect_feedback_id uuid REFERENCES public.feedback_request(id), improvement_feedback_id uuid REFERENCES public.feedback_request(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(assignment_id,version_id,attempt_no), UNIQUE(id,tenant_id),
 FOREIGN KEY(assignment_id,tenant_id) REFERENCES public.test_assignment(id,tenant_id) ON DELETE CASCADE
);
ALTER TABLE public.test_run ADD COLUMN version_id uuid REFERENCES public.test_case_version(id), ADD COLUMN execution_id uuid,
 ADD COLUMN execution_revision integer, ADD COLUMN execution_status text, ADD COLUMN comments text, ADD COLUMN defect_notes text, ADD COLUMN improvement_notes text;
ALTER TABLE public.test_run ADD CONSTRAINT test_run_execution_fk FOREIGN KEY(execution_id,tenant_id) REFERENCES public.test_execution(id,tenant_id) ON DELETE CASCADE,
 ADD CONSTRAINT test_run_version_execution_ck CHECK((execution_id IS NULL AND execution_revision IS NULL AND execution_status IS NULL) OR
 (execution_id IS NOT NULL AND version_id IS NOT NULL AND execution_revision>0 AND execution_status IN ('not_started','in_progress','passed','failed','blocked','retest_required','not_applicable','partial'))),
 ADD CONSTRAINT test_run_id_tenant_uq UNIQUE(id,tenant_id);
CREATE UNIQUE INDEX test_run_execution_revision_uq ON public.test_run(execution_id,execution_revision) WHERE execution_id IS NOT NULL;
ALTER TABLE public.test_execution ADD CONSTRAINT test_execution_current_run_fk FOREIGN KEY(current_run_id,tenant_id) REFERENCES public.test_run(id,tenant_id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE public.test_execution_attachment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id), execution_id uuid NOT NULL,
 run_id uuid NOT NULL, file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 240), mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 10485760), uploaded_by_user_id uuid NOT NULL REFERENCES public.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(execution_id,tenant_id) REFERENCES public.test_execution(id,tenant_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,tenant_id) REFERENCES public.test_run(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX test_execution_attachment_execution_idx ON public.test_execution_attachment(tenant_id,execution_id);
CREATE TABLE public.test_catalogue_update (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id), update_hash text NOT NULL CHECK(update_hash ~ '^[a-f0-9]{64}$'),
 preview_hash text NOT NULL, catalogue_hash text NOT NULL, source_ref text NOT NULL, source_content_hash text NOT NULL,
 selected_semantic_ids jsonb NOT NULL CHECK(jsonb_typeof(selected_semantic_ids)='array'), result jsonb NOT NULL CHECK(jsonb_typeof(result)='array'),
 confirmed_by_user_id uuid NOT NULL REFERENCES public.app_user(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,update_hash)
);
--> statement-breakpoint
-- Fixed tenant/login probes avoid recursive policies. No Personnel/salary projection or impersonation.
CREATE FUNCTION app.testing_live_principal() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
CREATE FUNCTION app.testing_assigned(case_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app.testing_live_principal() AND EXISTS(SELECT 1 FROM public.test_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.test_case_id=case_id AND a.tester_user_id=app.current_user_id())
$$;
CREATE FUNCTION app.testing_owns_execution(execution_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app.testing_live_principal() AND EXISTS(SELECT 1 FROM public.test_execution e JOIN public.test_assignment a ON a.id=e.assignment_id AND a.tenant_id=e.tenant_id
 WHERE e.id=execution_id AND e.tenant_id=app.current_tenant_id() AND e.tester_user_id=app.current_user_id() AND a.tester_user_id=app.current_user_id())
$$;
REVOKE ALL ON FUNCTION app.testing_live_principal(),app.testing_assigned(uuid),app.testing_owns_execution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.testing_live_principal(),app.testing_assigned(uuid),app.testing_owns_execution(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.test_case_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_execution_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_catalogue_update ENABLE ROW LEVEL SECURITY;
DROP POLICY test_case_rls ON public.test_case;
CREATE POLICY test_case_read ON public.test_case FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_assigned(id)));
CREATE POLICY test_case_insert ON public.test_case FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal());
CREATE POLICY test_case_update ON public.test_case FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal());
CREATE POLICY test_version_read ON public.test_case_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_assigned(test_case_id)));
CREATE POLICY test_version_insert ON public.test_case_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal() AND published_by_user_id=app.current_user_id() AND provenance<>'upgrade_baseline');
CREATE POLICY test_assignment_read ON public.test_assignment FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR tester_user_id=app.current_user_id()));
CREATE POLICY test_assignment_write ON public.test_assignment FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal());
CREATE POLICY test_execution_read ON public.test_execution FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_owns_execution(id)));
CREATE POLICY test_execution_insert ON public.test_execution FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND tester_user_id=app.current_user_id() AND app.testing_live_principal() AND EXISTS(SELECT 1 FROM public.test_assignment a WHERE a.id=assignment_id AND a.tenant_id=test_execution.tenant_id AND a.tester_user_id=app.current_user_id() AND a.active AND a.target_version_id=version_id));
-- Updates only link canonical own Feedback; head changes are made by the private run trigger below.
CREATE POLICY test_execution_update ON public.test_execution FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.testing_owns_execution(id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.testing_owns_execution(id));
DROP POLICY test_run_rls ON public.test_run;
CREATE POLICY test_run_read ON public.test_run FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_owns_execution(execution_id)));
CREATE POLICY test_run_insert ON public.test_run FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND run_by_user_id=app.current_user_id() AND app.testing_live_principal() AND ((execution_id IS NULL AND app.is_admin()) OR app.testing_owns_execution(execution_id)));
CREATE POLICY test_run_update ON public.test_run FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_owns_execution(execution_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_owns_execution(execution_id)));
CREATE POLICY test_attachment_read ON public.test_execution_attachment FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.testing_live_principal() AND (app.is_admin() OR app.testing_owns_execution(execution_id)));
CREATE POLICY test_attachment_insert ON public.test_execution_attachment FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND uploaded_by_user_id=app.current_user_id() AND app.testing_owns_execution(execution_id));
CREATE POLICY test_catalogue_update_read ON public.test_catalogue_update FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal());
CREATE POLICY test_catalogue_update_insert ON public.test_catalogue_update FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.testing_live_principal() AND confirmed_by_user_id=app.current_user_id());
-- Explicit ACLs override broad inherited defaults; no ordinary DELETE of historical records.
REVOKE ALL ON public.test_case_version,public.test_assignment,public.test_execution,public.test_execution_attachment,public.test_catalogue_update FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.test_case_version,public.test_execution_attachment,public.test_catalogue_update TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON public.test_assignment,public.test_execution TO ai_hr_app;
REVOKE ALL ON public.test_case,public.test_run FROM PUBLIC,ai_hr_app;
-- Table revocation does not remove independently granted column privileges.
DO $$ DECLARE relation text; columns text; BEGIN
 FOREACH relation IN ARRAY ARRAY['test_case','test_run'] LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_catalog.pg_attribute
   WHERE attrelid=('public.'||relation)::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC,ai_hr_app',columns,relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON public.test_case,public.test_run TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.testing_version_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Published testing instruction versions are immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.testing_version_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_version_immutable BEFORE UPDATE ON public.test_case_version FOR EACH ROW EXECUTE FUNCTION app.testing_version_immutable();
CREATE TRIGGER testing_catalogue_update_immutable BEFORE UPDATE ON public.test_catalogue_update FOR EACH ROW EXECUTE FUNCTION app.testing_version_immutable();
--> statement-breakpoint
CREATE FUNCTION app.testing_assignment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.testing_live_principal() OR NOT app.is_admin() THEN RAISE EXCEPTION 'Testing assignment authority is unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Testing assignment revision must advance' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.test_case_id,NEW.tester_user_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.test_case_id,OLD.tester_user_id,OLD.created_at) THEN RAISE EXCEPTION 'Testing assignment identity is immutable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.test_case c WHERE c.id=NEW.test_case_id AND c.tenant_id=NEW.tenant_id AND c.current_version_id=NEW.target_version_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Testing assignment version is unavailable' USING ERRCODE='23514'; END IF;
 IF (TG_OP='INSERT' OR (NOT OLD.active AND NEW.active)) AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.tester_user_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Testing assignment tester is unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.testing_assignment_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_assignment_guard BEFORE INSERT OR UPDATE ON public.test_assignment FOR EACH ROW EXECUTE FUNCTION app.testing_assignment_guard();
--> statement-breakpoint
CREATE FUNCTION app.testing_run_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e public.test_execution; a public.test_assignment; c public.test_case; expected_outcome text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.testing_live_principal() OR NOT (NEW.execution_id IS NULL AND app.is_admin() OR NEW.execution_id IS NOT NULL AND app.testing_owns_execution(NEW.execution_id)) THEN RAISE EXCEPTION 'Testing observation authority is unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'feedback_request_id') IS DISTINCT FROM (to_jsonb(OLD)-'feedback_request_id') THEN RAISE EXCEPTION 'Testing observations are append-only' USING ERRCODE='23514'; END IF;
  IF OLD.execution_id IS NOT NULL AND NEW.feedback_request_id IS DISTINCT FROM OLD.feedback_request_id THEN RAISE EXCEPTION 'Personal execution feedback belongs on its canonical execution link' USING ERRCODE='23514'; END IF;
  IF OLD.feedback_request_id IS NOT NULL AND NEW.feedback_request_id IS DISTINCT FROM OLD.feedback_request_id THEN RAISE EXCEPTION 'Testing feedback link is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.execution_id IS NULL THEN
  IF NEW.version_id IS NOT NULL THEN RAISE EXCEPTION 'Versioned observations require a personal execution' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO c FROM public.test_case WHERE id=NEW.test_case_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 SELECT x.* INTO a FROM public.test_assignment x JOIN public.test_execution y ON y.assignment_id=x.id WHERE y.id=NEW.execution_id AND y.tenant_id=NEW.tenant_id FOR UPDATE OF x;
 SELECT * INTO e FROM public.test_execution WHERE id=NEW.execution_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF c.id IS NULL OR a.id IS NULL OR e.id IS NULL OR e.tester_user_id IS DISTINCT FROM app.current_user_id() OR NEW.run_by_user_id IS DISTINCT FROM e.tester_user_id OR a.tester_user_id IS DISTINCT FROM e.tester_user_id OR a.test_case_id IS DISTINCT FROM c.id OR NOT a.active OR NEW.version_id IS DISTINCT FROM e.version_id OR a.target_version_id IS DISTINCT FROM e.version_id OR c.current_version_id IS DISTINCT FROM e.version_id OR NEW.execution_revision IS DISTINCT FROM e.revision+1 THEN
  RAISE EXCEPTION 'Testing execution or instructions changed; reload before saving' USING ERRCODE='40001';
 END IF;
 expected_outcome := CASE NEW.execution_status WHEN 'passed' THEN 'pass' WHEN 'failed' THEN 'fail' WHEN 'blocked' THEN 'blocked' WHEN 'partial' THEN 'partial' ELSE 'not_tested' END;
 IF NEW.run_no IS DISTINCT FROM app.testing_next_run_no(NEW.test_case_id) THEN RAISE EXCEPTION 'Testing run ordinal must be the next case observation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.test_case_version v WHERE v.id=e.version_id AND v.definition->>'format'='1' AND v.definition->>'active'='false') THEN RAISE EXCEPTION 'Testing instructions are inactive' USING ERRCODE='23514'; END IF;
 IF NEW.outcome::text IS DISTINCT FROM expected_outcome THEN RAISE EXCEPTION 'Testing outcome does not match personal status' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.testing_run_advance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.execution_id IS NOT NULL THEN UPDATE public.test_execution SET current_run_id=NEW.id,revision=NEW.execution_revision WHERE id=NEW.execution_id AND tenant_id=NEW.tenant_id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.testing_run_guard(),app.testing_run_advance() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_run_guard BEFORE INSERT OR UPDATE ON public.test_run FOR EACH ROW EXECUTE FUNCTION app.testing_run_guard();
CREATE TRIGGER testing_run_advance AFTER INSERT ON public.test_run FOR EACH ROW EXECUTE FUNCTION app.testing_run_advance();
--> statement-breakpoint
CREATE FUNCTION app.testing_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.test_assignment; c public.test_case;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.testing_live_principal() OR NEW.tester_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.test_assignment x WHERE x.id=NEW.assignment_id AND x.tenant_id=NEW.tenant_id AND x.tester_user_id=app.current_user_id()) THEN RAISE EXCEPTION 'Testing execution authority is unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO a FROM public.test_assignment WHERE id=NEW.assignment_id AND tenant_id=NEW.tenant_id;
  SELECT * INTO c FROM public.test_case WHERE id=a.test_case_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  SELECT * INTO a FROM public.test_assignment WHERE id=NEW.assignment_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.test_case_version v WHERE v.id=NEW.version_id AND v.definition->>'format'='1' AND v.definition->>'active'='false') THEN RAISE EXCEPTION 'Testing instructions are inactive' USING ERRCODE='23514'; END IF;
  IF NEW.attempt_no IS DISTINCT FROM (SELECT coalesce(max(x.attempt_no),0)+1 FROM public.test_execution x WHERE x.assignment_id=NEW.assignment_id AND x.version_id=NEW.version_id) THEN RAISE EXCEPTION 'Testing attempt must advance consecutively' USING ERRCODE='23514'; END IF;
  IF a.id IS NULL OR c.id IS NULL OR NOT a.active OR a.tester_user_id IS DISTINCT FROM NEW.tester_user_id OR NEW.tester_user_id IS DISTINCT FROM app.current_user_id() OR NEW.version_id IS DISTINCT FROM a.target_version_id OR NEW.version_id IS DISTINCT FROM c.current_version_id OR NEW.revision<>0 OR NEW.current_run_id IS NOT NULL OR NEW.defect_feedback_id IS NOT NULL OR NEW.improvement_feedback_id IS NOT NULL THEN RAISE EXCEPTION 'Testing execution assignment is unavailable' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.id,NEW.tenant_id,NEW.assignment_id,NEW.version_id,NEW.attempt_no,NEW.tester_user_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.assignment_id,OLD.version_id,OLD.attempt_no,OLD.tester_user_id,OLD.created_at) THEN RAISE EXCEPTION 'Testing execution identity is immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.current_run_id,NEW.revision) IS DISTINCT FROM (OLD.current_run_id,OLD.revision) AND NOT EXISTS(SELECT 1 FROM public.test_run r WHERE r.id=NEW.current_run_id AND r.execution_id=NEW.id AND r.tenant_id=NEW.tenant_id AND r.execution_revision=NEW.revision AND r.run_by_user_id=NEW.tester_user_id AND NEW.revision=OLD.revision+1) THEN RAISE EXCEPTION 'Testing head must advance to its next actual observation' USING ERRCODE='23514'; END IF;
  IF (OLD.defect_feedback_id IS NOT NULL AND NEW.defect_feedback_id IS DISTINCT FROM OLD.defect_feedback_id) OR (OLD.improvement_feedback_id IS NOT NULL AND NEW.improvement_feedback_id IS DISTINCT FROM OLD.improvement_feedback_id) THEN RAISE EXCEPTION 'Testing feedback links are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.defect_feedback_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.feedback_request f WHERE f.id=NEW.defect_feedback_id AND f.tenant_id=NEW.tenant_id AND f.reporter_user_id=NEW.tester_user_id AND f.category='issue') THEN RAISE EXCEPTION 'Testing defect must be this tester canonical feedback' USING ERRCODE='23514'; END IF;
 IF NEW.improvement_feedback_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.feedback_request f WHERE f.id=NEW.improvement_feedback_id AND f.tenant_id=NEW.tenant_id AND f.reporter_user_id=NEW.tester_user_id AND f.category='enhancement') THEN RAISE EXCEPTION 'Testing improvement must be this tester canonical feedback' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.testing_execution_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_execution_guard BEFORE INSERT OR UPDATE ON public.test_execution FOR EACH ROW EXECUTE FUNCTION app.testing_execution_guard();
--> statement-breakpoint
CREATE FUNCTION app.testing_attachment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.uploaded_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT app.testing_owns_execution(NEW.execution_id) THEN RAISE EXCEPTION 'Testing screenshot authority is unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.test_execution WHERE id=NEW.execution_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.test_run r WHERE r.id=NEW.run_id AND r.execution_id=NEW.execution_id AND r.tenant_id=NEW.tenant_id AND r.run_by_user_id=NEW.uploaded_by_user_id) OR (SELECT count(*) FROM public.test_execution_attachment WHERE execution_id=NEW.execution_id)>=10 THEN RAISE EXCEPTION 'Testing screenshot execution or limit is invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.testing_attachment_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_attachment_guard BEFORE INSERT ON public.test_execution_attachment FOR EACH ROW EXECUTE FUNCTION app.testing_attachment_guard();

--> statement-breakpoint
CREATE FUNCTION app.testing_case_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_ordinal integer; new_ordinal integer;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.testing_live_principal() OR NOT app.is_admin() THEN RAISE EXCEPTION 'Testing case authority is unavailable' USING ERRCODE='42501'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.case_no,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.case_no,OLD.created_at) OR (OLD.semantic_id IS NOT NULL AND NEW.semantic_id IS DISTINCT FROM OLD.semantic_id) THEN RAISE EXCEPTION 'Testing case identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
  SELECT ordinal INTO old_ordinal FROM public.test_case_version WHERE id=OLD.current_version_id AND tenant_id=OLD.tenant_id AND test_case_id=OLD.id;
  SELECT ordinal INTO new_ordinal FROM public.test_case_version WHERE id=NEW.current_version_id AND tenant_id=NEW.tenant_id AND test_case_id=NEW.id;
  IF new_ordinal IS NULL OR new_ordinal<=coalesce(old_ordinal,0) THEN RAISE EXCEPTION 'Published testing versions advance monotonically' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.testing_case_retest() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
  UPDATE public.test_assignment a SET target_version_id=NEW.current_version_id,revision=revision+1,updated_at=now(),
   retest_required=EXISTS(SELECT 1 FROM public.test_execution e WHERE e.assignment_id=a.id AND e.revision>0)
   WHERE a.tenant_id=NEW.tenant_id AND a.test_case_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.testing_case_guard(),app.testing_case_retest() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER testing_case_guard BEFORE UPDATE ON public.test_case FOR EACH ROW EXECUTE FUNCTION app.testing_case_guard();
CREATE TRIGGER testing_case_retest AFTER UPDATE ON public.test_case FOR EACH ROW EXECUTE FUNCTION app.testing_case_retest();
--> statement-breakpoint
-- RLS hides other testers' runs. Only this gated ordinal allocator sees the case-global counter.
CREATE FUNCTION app.testing_next_run_no(case_id uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result integer;
BEGIN
 IF NOT app.testing_live_principal() OR NOT EXISTS(SELECT 1 FROM public.test_case c WHERE c.id=case_id AND c.tenant_id=app.current_tenant_id()) OR NOT (app.is_admin() OR EXISTS(SELECT 1 FROM public.test_assignment a JOIN public.test_case c ON c.id=a.test_case_id AND c.tenant_id=a.tenant_id WHERE a.test_case_id=case_id AND a.tenant_id=app.current_tenant_id() AND a.tester_user_id=app.current_user_id() AND a.active AND a.target_version_id=c.current_version_id)) THEN RAISE EXCEPTION 'Testing case is not assigned' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('test-run:'||case_id::text,0));
 SELECT coalesce(max(run_no),0)+1 INTO result FROM public.test_run WHERE test_case_id=case_id AND tenant_id=app.current_tenant_id();
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.testing_next_run_no(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.testing_next_run_no(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Canonical Feedback extension: a login is a reporter even when it has no employment.
-- Existing employment-backed scope/history is retained. No synthetic/borrowed employment or company.
ALTER TABLE public.feedback_request ALTER COLUMN reporter_employment_id DROP NOT NULL;
ALTER TABLE public.feedback_attachment ALTER COLUMN employment_id DROP NOT NULL;
ALTER TABLE public.feedback_request ADD CONSTRAINT feedback_reporter_identity_ck CHECK(reporter_employment_id IS NOT NULL OR reporter_user_id IS NOT NULL);
CREATE FUNCTION app.feedback_live_principal() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
CREATE FUNCTION app.can_access_feedback(feedback_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.feedback_request f WHERE f.id=feedback_id AND f.tenant_id=app.current_tenant_id() AND
  CASE WHEN f.reporter_employment_id IS NOT NULL THEN f.reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
   ELSE (SELECT app.feedback_live_principal()) AND (f.reporter_user_id=app.current_user_id() OR app.is_group_admin()) END)
$$;
REVOKE ALL ON FUNCTION app.feedback_live_principal(),app.can_access_feedback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.feedback_live_principal(),app.can_access_feedback(uuid) TO ai_hr_app;
--> statement-breakpoint
DROP POLICY feedback_request_rls ON public.feedback_request;
CREATE POLICY feedback_request_read ON public.feedback_request FOR SELECT USING(tenant_id=app.current_tenant_id() AND
 CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
 ELSE (SELECT app.feedback_live_principal()) AND (reporter_user_id=app.current_user_id() OR app.is_group_admin()) END);
CREATE POLICY feedback_request_insert ON public.feedback_request FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND
 CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
 ELSE reporter_user_id=app.current_user_id() AND (SELECT app.feedback_live_principal()) END);
CREATE POLICY feedback_request_update ON public.feedback_request FOR UPDATE USING(app.can_access_feedback(id)) WITH CHECK(tenant_id=app.current_tenant_id() AND
 CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
 ELSE (SELECT app.feedback_live_principal()) AND (reporter_user_id=app.current_user_id() OR app.is_group_admin()) END);
-- Withdraw remains a status transition. User-only records gain no new ordinary destructive policy.
CREATE POLICY feedback_request_delete ON public.feedback_request FOR DELETE USING(tenant_id=app.current_tenant_id() AND reporter_employment_id IS NOT NULL AND reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
DROP POLICY feedback_attachment_rls ON public.feedback_attachment;
CREATE POLICY feedback_attachment_read ON public.feedback_attachment FOR SELECT USING(tenant_id=app.current_tenant_id() AND CASE WHEN employment_id IS NOT NULL THEN employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE app.can_access_feedback(feedback_request_id) END);
CREATE POLICY feedback_attachment_insert ON public.feedback_attachment FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND CASE WHEN employment_id IS NOT NULL THEN employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE app.can_access_feedback(feedback_request_id) AND uploaded_by_user_id=app.current_user_id() AND (SELECT app.feedback_live_principal()) END);
CREATE POLICY feedback_attachment_update ON public.feedback_attachment FOR UPDATE USING(tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])) WITH CHECK(tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
CREATE POLICY feedback_attachment_delete ON public.feedback_attachment FOR DELETE USING(tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
ALTER POLICY feedback_plan_revision_read ON public.feedback_plan_revision USING(tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id));
ALTER POLICY feedback_plan_revision_append ON public.feedback_plan_revision WITH CHECK(tenant_id=app.current_tenant_id() AND outcome IS NULL AND app.can_access_feedback(feedback_request_id));
ALTER POLICY feedback_plan_revision_close ON public.feedback_plan_revision USING(tenant_id=app.current_tenant_id() AND outcome IS NULL AND app.can_access_feedback(feedback_request_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id));
ALTER POLICY feedback_block_read ON public.feedback_block USING(tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id));
ALTER POLICY feedback_block_append ON public.feedback_block WITH CHECK(tenant_id=app.current_tenant_id() AND resolved_at IS NULL AND answer IS NULL AND app.can_access_feedback(feedback_request_id));
ALTER POLICY feedback_block_resolve ON public.feedback_block USING(tenant_id=app.current_tenant_id() AND resolved_at IS NULL AND app.can_access_feedback(feedback_request_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND resolved_at IS NOT NULL AND app.can_access_feedback(feedback_request_id));
--> statement-breakpoint
CREATE FUNCTION app.feedback_user_reporter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' AND NEW.reporter_employment_id IS NULL THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.reporter_user_id IS DISTINCT FROM app.current_user_id() OR NOT app.feedback_live_principal() THEN RAISE EXCEPTION 'User-only feedback requires the actual live reporter' USING ERRCODE='42501'; END IF;
 ELSIF TG_OP='UPDATE' AND (OLD.reporter_employment_id IS NULL OR NEW.reporter_employment_id IS NULL) THEN
  IF (NEW.id,NEW.tenant_id,NEW.reporter_employment_id,NEW.reporter_user_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.reporter_employment_id,OLD.reporter_user_id) THEN RAISE EXCEPTION 'Feedback reporter identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.feedback_attachment_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE f public.feedback_request;
BEGIN
 SELECT * INTO f FROM public.feedback_request WHERE id=NEW.feedback_request_id AND tenant_id=NEW.tenant_id;
 IF f.id IS NULL OR NEW.employment_id IS DISTINCT FROM f.reporter_employment_id THEN RAISE EXCEPTION 'Feedback attachment parent is unavailable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.employment_id IS NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'User-only feedback evidence is append-only' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.feedback_user_reporter_guard(),app.feedback_attachment_binding_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER feedback_user_reporter_guard BEFORE INSERT OR UPDATE ON public.feedback_request FOR EACH ROW EXECUTE FUNCTION app.feedback_user_reporter_guard();
CREATE TRIGGER feedback_attachment_binding_guard BEFORE INSERT OR UPDATE ON public.feedback_attachment FOR EACH ROW EXECUTE FUNCTION app.feedback_attachment_binding_guard();

--> statement-breakpoint
-- Reassert only the existing canonical Feedback operations; inherited TRUNCATE/TRIGGER/REFERENCES
-- grants bypass or undermine ownership, and must not survive on the extended retained tables.
REVOKE ALL ON public.feedback_request,public.feedback_attachment,public.feedback_plan_revision,public.feedback_block FROM PUBLIC,ai_hr_app;
DO $$ DECLARE relation text; columns text; BEGIN
 FOREACH relation IN ARRAY ARRAY['feedback_request','feedback_attachment','feedback_plan_revision','feedback_block'] LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_catalog.pg_attribute WHERE attrelid=('public.'||relation)::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC,ai_hr_app',columns,relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.feedback_request,public.feedback_attachment TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON public.feedback_plan_revision,public.feedback_block TO ai_hr_app;
--> statement-breakpoint
-- Existing generic audit read admits scoped administrators. Private account Feedback must not leak
-- through that independent consumer. This restriction never grants a new raw audit reader.
CREATE FUNCTION app.feedback_event_readable(feedback_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT CASE WHEN f.reporter_employment_id IS NULL THEN app.can_access_feedback(f.id) ELSE true END
 FROM public.feedback_request f WHERE f.id=feedback_id AND f.tenant_id=app.current_tenant_id()),true)
$$;
REVOKE ALL ON FUNCTION app.feedback_event_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.feedback_event_readable(uuid) TO ai_hr_app;
CREATE POLICY feedback_user_only_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND (aggregate_type<>'feedback' OR app.feedback_event_readable(aggregate_id))
);
