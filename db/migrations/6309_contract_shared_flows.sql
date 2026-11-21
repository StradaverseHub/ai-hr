-- Explicit cutover adapter over the existing Contract case identity. No legacy case is migrated by this migration.
CREATE TABLE public.contract_shared_case (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), case_id uuid NOT NULL REFERENCES public.contract_case(id),
 revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND data->>'version'='2' AND (data->>'revision')::integer=revision),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,case_id), CHECK(octet_length(data::text)<=262144)
);
--> statement-breakpoint
CREATE TABLE public.contract_shared_letter (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), id uuid NOT NULL, case_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id), CHECK(octet_length(data::text)<=2097152)
);
--> statement-breakpoint
CREATE INDEX contract_shared_letter_case ON public.contract_shared_letter(tenant_id,case_id,id);
--> statement-breakpoint
ALTER TABLE public.contract_shared_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_case FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_letter FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_shared_case_owner ON public.contract_shared_case FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_shared_letter_owner ON public.contract_shared_letter FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_assigned(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_letter d
 WHERE d.tenant_id=app.current_tenant_id() AND d.case_id=p_case AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'document'->'route'->'steps') s
 WHERE s->>'holderId'=app.current_user_id()::text))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_letter_assigned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_assigned(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY contract_shared_case_read ON public.contract_shared_case FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_case_permitted(case_id,'view'));
CREATE POLICY contract_shared_letter_read ON public.contract_shared_letter FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.contract_shared_case_permitted(case_id,'view') OR app.contract_shared_letter_assigned(case_id)));
--> statement-breakpoint
REVOKE ALL ON public.contract_shared_case,public.contract_shared_letter FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.contract_shared_case,public.contract_shared_letter TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_adopt(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;f jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case FOR UPDATE;
 IF c.id IS NULL OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT data INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 IF f IS NOT NULL THEN RETURN f;END IF;
 IF c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb
 OR coalesce(c.data->'decisionDraft','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
 OR EXISTS(SELECT 1 FROM public.contract_document d WHERE d.tenant_id=c.tenant_id AND d.case_id=c.id)
 OR EXISTS(SELECT 1 FROM public.contract_effect e WHERE e.tenant_id=c.tenant_id AND e.case_id=c.id)
 OR EXISTS(SELECT 1 FROM public.contract_date_amendment a WHERE a.tenant_id=c.tenant_id AND a.case_id=c.id AND a.status IN('pending','failed'))
 OR EXISTS(SELECT 1 FROM public.contract_generation_request g WHERE g.tenant_id=c.tenant_id AND g.case_id=c.id AND g.status IN('pending','failed'))
 THEN RAISE EXCEPTION 'This legacy case has work in progress; finish its pinned flow before cutover' USING ERRCODE='40001';END IF;
 f:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',c.term_id,'startOn',c.data->'term'->>'startOn','endOn',c.data->'term'->>'endOn','number',c.number,'sourceRevision',c.data->'term'->>'sourceRevision'),
 'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(c.tenant_id,c.id,1,f);
 PERFORM app.contract_audit(c.id,'shared.adopted',jsonb_build_object('version',2));
 RETURN f;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_adopt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_adopt(uuid) TO ai_hr_app;
--> statement-breakpoint
-- A versioned module cannot fall through to legacy commands/effects. The old function bytes remain unchanged under
-- a private compatibility name; new adapters must expose their own adjudicated commands.
ALTER FUNCTION app.contract_case_command(uuid,integer,text,jsonb) RENAME TO contract_case_command_before_shared;
--> statement-breakpoint
CREATE FUNCTION app.contract_case_command(p_case uuid,p_revision integer,p_command text,p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case) THEN
  RAISE EXCEPTION 'This case uses shared Contract workflows; reload the case' USING ERRCODE='40001';
 END IF;
 RETURN app.contract_case_command_before_shared(p_case,p_revision,p_command,p_args);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_case_command_before_shared(uuid,integer,text,jsonb),app.contract_case_command(uuid,integer,text,jsonb) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_case_command(uuid,integer,text,jsonb) TO ai_hr_app;
