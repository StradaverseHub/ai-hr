-- Managed resignation journey, additive to legacy resignation requests. No historical request is replayed.
-- Allocation: idx5167 / when1793330100101; root owns journal admission.
-- person.id is already globally unique; this additive alternate key enables tenant-bound foreign keys.
ALTER TABLE public.person ADD CONSTRAINT person_id_tenant_uq UNIQUE(id,tenant_id);
--> statement-breakpoint
ALTER TABLE public.resignation_request ADD CONSTRAINT resignation_request_tenant_id_key UNIQUE(tenant_id,id);
--> statement-breakpoint
CREATE TABLE public.resignation_journey (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), id uuid NOT NULL,
 employment_id uuid NOT NULL, company_id uuid NOT NULL, person_id uuid NOT NULL,
 number bigint GENERATED ALWAYS AS IDENTITY, stage text NOT NULL CHECK(stage IN('decision','retention','offer','accepted','leaving','retained','withdrawn')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND pg_column_size(data)<=2097152),
 participant_ids uuid[] NOT NULL DEFAULT '{}', offboarding_case_id uuid, submitted_on date NOT NULL, closed_on date,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,number),
 FOREIGN KEY(employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
 CONSTRAINT resignation_journey_company_tenant_fk FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(person_id,tenant_id) REFERENCES public.person(id,tenant_id),
 FOREIGN KEY(tenant_id,id) REFERENCES public.resignation_request(tenant_id,id),
 FOREIGN KEY(tenant_id,offboarding_case_id) REFERENCES public.lc_v9_case(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX resignation_journey_one_open ON public.resignation_journey(tenant_id,employment_id) WHERE stage NOT IN('retained','withdrawn');
--> statement-breakpoint
CREATE INDEX resignation_journey_employee ON public.resignation_journey(tenant_id,employment_id,number DESC);
--> statement-breakpoint
CREATE INDEX resignation_journey_participants ON public.resignation_journey USING gin(participant_ids);
--> statement-breakpoint
CREATE INDEX resignation_journey_due ON public.resignation_journey(tenant_id,((data->>'offerReplyBy')::text),id) WHERE stage='offer';
--> statement-breakpoint
ALTER TABLE public.resignation_journey ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resignation_journey FORCE ROW LEVEL SECURITY;
CREATE POLICY resignation_journey_owner ON public.resignation_journey FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.resignation_journey FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.resignation_journey TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_access(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND EXISTS(
 SELECT 1 FROM resignation_journey j JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=j.tenant_id AND u.archived_at IS NULL
 WHERE j.tenant_id=app.current_tenant_id() AND j.id=p_id AND (
 u.person_id=j.person_id OR u.id=ANY(j.participant_ids) OR (app.automation_can_configure('off') AND app.is_admin_for(j.company_id))
 )),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_can_act(p_id uuid,p_action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.resignation_journey_access(p_id) AND EXISTS(SELECT 1 FROM resignation_journey j JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=j.tenant_id WHERE j.id=p_id AND j.tenant_id=app.current_tenant_id() AND CASE p_action
 WHEN 'own' THEN u.person_id=j.person_id
 WHEN 'decision' THEN j.stage='decision' AND j.data->'decision'->'to' ? u.id::text AND u.person_id<>j.person_id
 WHEN 'comment' THEN j.stage='decision' AND coalesce((j.data->'decision'->>'canComment')::boolean,false) AND j.data->'decision'->'watch' ? u.id::text
 WHEN 'runner' THEN false
 WHEN 'retry' THEN app.automation_can_configure('off') AND app.is_admin_for(j.company_id)
 WHEN 'letter' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'document'->'route'->'steps','[]')) s WHERE s->>'holderId'=u.id::text)
 ELSE false END),false)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resignation_journey_access(uuid),app.resignation_journey_can_act(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_journey_access(uuid),app.resignation_journey_can_act(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- A purpose-separated server attestation authenticates derived runtime state. It grants no actor authority.
-- Only the schema owner provisions this key. A database application principal cannot mint custody proof.
CREATE TABLE app.resignation_runtime_verifier(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),secret bytea NOT NULL CHECK(octet_length(secret)=32));
CREATE TABLE app.resignation_runtime_state(tenant_id uuid NOT NULL REFERENCES public.tenant(id),actor text NOT NULL,kind text NOT NULL,transaction_id bigint NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,actor,kind));
ALTER TABLE app.resignation_runtime_verifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.resignation_runtime_verifier FORCE ROW LEVEL SECURITY;
ALTER TABLE app.resignation_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.resignation_runtime_state FORCE ROW LEVEL SECURITY;
CREATE POLICY resignation_runtime_owner ON app.resignation_runtime_verifier FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY resignation_runtime_owner ON app.resignation_runtime_state FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.resignation_runtime_verifier,app.resignation_runtime_state FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_runtime_intent(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND kind='intent:'||p_id::text AND transaction_id=txid_current());
$$;
-- Effective pending signing stage, after the latest resend. Review/Approve receipts are content bound too.
CREATE FUNCTION app.resignation_pending_steps(p_letter jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actions AS(SELECT a,n FROM jsonb_array_elements(coalesce(p_letter->'document'->'actions','[]')) WITH ORDINALITY x(a,n) WHERE a->>'contentRevision'=p_letter->'document'->>'contentRevision' AND a->>'contentHash'=p_letter->'document'->>'contentHash'), round AS(SELECT coalesce(max(n) FILTER(WHERE a->>'action'='resent'),0) n FROM actions), todo AS(SELECT s FROM jsonb_array_elements(coalesce(p_letter->'document'->'route'->'steps','[]')) s WHERE coalesce((s->>'required')::boolean,false) AND NOT EXISTS(SELECT 1 FROM actions a,round r WHERE a.n>r.n AND a.a->>'stepId'=s->>'id' AND a.a->>'action' IN('signed','reviewed','approved')) AND NOT EXISTS(SELECT 1 FROM actions a,round r WHERE a.n>r.n AND a.a->>'action'='returned')) SELECT s FROM todo WHERE s->>'stage'=(SELECT min((s->>'stage')::integer)::text FROM todo);
$$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_command_allowed(p_id uuid,p_command jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;u app_user;l jsonb;s jsonb;owner_id text;mine boolean;holding boolean;opened boolean;k text:=p_command->>'type';w jsonb;layer jsonb;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND THEN RETURN false;END IF;
 IF k='sweep' THEN RETURN app.current_user_id() IS NULL AND app.acting_as_owner();END IF;
 IF k='postingOutcome' THEN RETURN EXISTS(SELECT 1 FROM personnel_posting p WHERE p.tenant_id=j.tenant_id AND p.id=(p_command->>'postingId')::uuid AND p.source IN('off','offboarding') AND p.source_ref=j.id AND p.employment_id=j.employment_id AND p.company_id=j.company_id AND p.status=p_command->>'outcome' AND p.status IN('approved','rejected') AND (p.status='approved' AND p.approved_by=app.current_user_id() OR p.status='rejected' AND to_jsonb(p)->>'rejected_by'=app.current_user_id()::text OR app.current_user_id() IS NULL AND app.acting_as_owner()));END IF;
 SELECT * INTO u FROM app_user WHERE id=app.current_user_id() AND tenant_id=j.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF u.id IS NULL OR NOT app.resignation_journey_access(p_id) THEN RETURN false;END IF;
 IF k='withdraw' THEN RETURN u.person_id=j.person_id AND j.stage IN('decision','retention');
 ELSIF k IN('accept','offer') THEN RETURN j.stage='decision' AND u.person_id<>j.person_id AND j.data->'decision'->'to' ? u.id::text AND (k='accept' OR j.data->'decision'->>'choices'='both' AND NOT coalesce((j.data->>'offerLocked')::boolean,false));
 ELSIF k='comment' THEN RETURN app.resignation_journey_can_act(p_id,'comment');
 ELSIF k='retry' THEN RETURN app.resignation_journey_can_act(p_id,'retry');
 ELSIF k='completeReplacement' THEN RETURN j.data->'replacementRequest'->>'status'='requested' AND j.data->'replacementRequest'->>'id'=p_command->>'taskId' AND j.data->'replacementRequest'->'to' ? u.id::text;
 ELSIF k='taskProgress' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'tasks','[]')) t WHERE t->>'id'=p_command->>'taskId' AND t->'userIds' ? u.id::text);
 ELSIF k='uploadFile' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) w WHERE w->>'id'=p_command->>'taskId' AND w->>'kind'='file' AND w->'to' ? u.id::text);
 ELSIF k='approvalTask' THEN
  FOR w IN SELECT x FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) x WHERE x->>'kind'='approval' LOOP
   SELECT x INTO layer FROM jsonb_array_elements(coalesce(w->'layers','[]')) x WHERE NOT coalesce((x->>'done')::boolean,false) LIMIT 1;
   IF layer->>'id'=p_command->>'taskId' AND layer->'to' ? u.id::text AND (layer->>'action'=p_command->>'action' OR p_command->>'action'='reject' AND length(btrim(coalesce(p_command->>'comment',''))) BETWEEN 1 AND 4000) THEN RETURN true;END IF;
  END LOOP;RETURN false;
 END IF;
 IF k='updateEmail' THEN
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) l CROSS JOIN LATERAL jsonb_array_elements(l->'document'->'route'->'steps') s WHERE s->>'owner'='true' AND s->>'holderId'=u.id::text AND l->>'state' IN('review','owner') AND (l->>'state'='owner' OR EXISTS(SELECT 1 FROM app.resignation_pending_steps(l) z WHERE z->>'id'=s->>'id')) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'actions') a WHERE a->>'action'='signed' AND a->>'contentRevision'=l->>'revision'));
 END IF;
 SELECT x INTO l FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) x WHERE x->>'id'=p_command->>'documentId';
 IF l IS NULL OR l->>'revision' IS DISTINCT FROM p_command->>'documentRevision' THEN RETURN false;END IF;
 SELECT x->>'holderId' INTO owner_id FROM jsonb_array_elements(l->'document'->'route'->'steps') x WHERE x->>'owner'='true' LIMIT 1;
 SELECT x INTO s FROM app.resignation_pending_steps(l) x WHERE x->>'holderId'=u.id::text LIMIT 1;mine:=s IS NOT NULL;holding:=owner_id=u.id::text AND (l->>'state'='owner' OR mine);opened:=l->'openedBy'->>u.id::text=l->>'revision';
 IF k='openLetter' THEN RETURN l->>'state' IN('review','owner','released') AND (owner_id=u.id::text OR mine OR l->>'state'='released' AND (l->>'employeeUserId'=u.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'route'->'steps') x WHERE x->>'holderId'=u.id::text)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(l->'history') a WHERE a->>'actorId'=u.id::text));END IF;
 IF l->>'state' NOT IN('review','owner') THEN RETURN false;END IF;
 IF k='letterAction' THEN RETURN mine AND l->>'state'='review' AND s->>'kind'=p_command->>'action' AND (l->>'employeeUserId'<>u.id::text OR opened) AND (p_command->>'action'<>'sign' OR p_command->>'consent'='true' AND length(coalesce(p_command->>'signature','')) BETWEEN 1 AND 100000);
 ELSIF k='sendBack' THEN RETURN mine AND owner_id<>u.id::text AND (l->>'employeeUserId'<>u.id::text OR opened) AND length(btrim(coalesce(p_command->>'reason',''))) BETWEEN 1 AND 4000;
 ELSIF k='recall' THEN RETURN owner_id=u.id::text AND NOT holding AND EXISTS(SELECT 1 FROM app.resignation_pending_steps(l));
 ELSIF k='updateLetter' THEN RETURN (NOT(p_command ?| ARRAY['lastWorkingDay','reason']) OR holding) AND (NOT(p_command ? 'blocks') OR (l->>'state'='owner' AND owner_id=u.id::text OR mine AND s->>'kind'='review') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'actions') a WHERE a->>'action'='signed' AND a->>'contentRevision'=l->>'revision'));
 ELSIF k='resendLetter' THEN RETURN l->>'state'='owner' AND owner_id=u.id::text;
 ELSIF k='withdrawOffer' THEN RETURN l->>'state'='owner' AND l->>'kind'='retention' AND owner_id=u.id::text AND length(btrim(coalesce(p_command->>'reason',''))) BETWEEN 1 AND 4000;
 ELSIF k='declineOffer' THEN RETURN l->>'kind'='retention' AND l->>'employeeUserId'=u.id::text AND mine AND opened;
 END IF;RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_admit(p_payload text,p_signature text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k bytea;p jsonb;expected bytea;received bytea;difference integer:=0;i integer;n numeric:=extract(epoch FROM clock_timestamp())*1000;j resignation_journey;op text;
BEGIN
 IF p_payload IS NULL OR octet_length(p_payload)>4194304 OR p_signature IS NULL OR p_signature!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 SELECT secret INTO k FROM app.resignation_runtime_verifier WHERE singleton;
 IF k IS NULL THEN RAISE EXCEPTION 'Resignation runtime verifier is not provisioned' USING ERRCODE='42501';END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to(p_payload,'UTF8'),k);received:=decode(p_signature,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 p:=p_payload::jsonb;op:=p->>'operation';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['v','purpose','runner','tenantId','userId','personId','transactionId','operation','issuedAt','expiresAt']) OR p->>'purpose' IS DISTINCT FROM 'aihr-resignation-runtime-v1' OR p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'runner' IS DISTINCT FROM 'resignation-journey' OR p->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR p->>'userId' IS DISTINCT FROM app.current_user_id()::text OR p->>'transactionId' IS DISTINCT FROM txid_current()::text OR jsonb_typeof(p->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'expiresAt') IS DISTINCT FROM 'number' OR (p->>'issuedAt')!~'^[0-9]{1,16}$' OR (p->>'expiresAt')!~'^[0-9]{1,16}$' OR (p->>'issuedAt')::numeric>n OR (p->>'expiresAt')::numeric<=n OR (p->>'expiresAt')::numeric-(p->>'issuedAt')::numeric NOT BETWEEN 1 AND 60000 OR op NOT IN('begin','create','save','read','context','notify','retrySave','postingRejected','email') THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 IF app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.person_id::text IS NOT DISTINCT FROM p->>'personId' AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR app.current_user_id() IS NULL AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Runtime actor unavailable' USING ERRCODE='42501';END IF;
 IF p ? 'caseId' THEN
  SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=(p->>'caseId')::uuid;
  IF j.id IS NOT NULL AND p ? 'companyId' AND p->>'companyId'<>j.company_id::text THEN RAISE EXCEPTION 'Runtime company mismatch' USING ERRCODE='42501';END IF;
 END IF;
 IF op='begin' THEN
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=(p->>'caseId')::uuid FOR UPDATE;
  IF j.id IS NULL OR NOT app.resignation_command_allowed(j.id,p->'command') THEN RAISE EXCEPTION 'This action is not currently assigned to you' USING ERRCODE='42501';END IF;
  IF j.revision IS DISTINCT FROM (p->>'revision')::integer THEN RAISE EXCEPTION 'This resignation changed; reload before acting' USING ERRCODE='40001';END IF;
  p:=p||jsonb_build_object('initialStage',j.stage,'initialData',j.data,'companyId',j.company_id);
  INSERT INTO app.resignation_runtime_state VALUES(app.current_tenant_id(),coalesce(app.current_user_id()::text,'worker'),'intent:'||j.id::text,txid_current(),p,now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
 ELSIF op NOT IN('read','context','create') AND NOT app.resignation_runtime_intent((p->>'caseId')::uuid) THEN RAISE EXCEPTION 'A current authorized command is required' USING ERRCODE='42501';END IF;
 DELETE FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND transaction_id<>txid_current();
 INSERT INTO app.resignation_runtime_state VALUES(app.current_tenant_id(),coalesce(app.current_user_id()::text,'worker'),'proof:'||op,txid_current(),p,now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_runtime_consume(p_operation text,p_id uuid,p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p jsonb;
BEGIN
 DELETE FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND kind='proof:'||p_operation AND transaction_id=txid_current() RETURNING payload INTO p;
 IF p IS NULL OR p->'args' IS DISTINCT FROM p_args OR (p ? 'caseId' AND p->>'caseId' IS DISTINCT FROM p_id::text) OR p_operation NOT IN('context','create') AND NOT app.resignation_runtime_intent(p_id) THEN RAISE EXCEPTION 'Exact runtime custody proof is required' USING ERRCODE='42501';END IF;RETURN p;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_runtime_readable(p_id uuid,p_employment uuid,p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.resignation_runtime_state r WHERE r.tenant_id=app.current_tenant_id() AND r.actor=coalesce(app.current_user_id()::text,'worker') AND r.kind='proof:read' AND r.transaction_id=txid_current() AND CASE r.payload->'args'->>'mode'
 WHEN 'case' THEN r.payload->'args'->>'caseId'=p_id::text AND app.resignation_journey_access(p_id)
 WHEN 'posting' THEN r.payload->'args'->>'caseId'=p_id::text AND EXISTS(SELECT 1 FROM personnel_posting p WHERE p.tenant_id=app.current_tenant_id() AND p.id::text=r.payload->'args'->>'postingId' AND p.source='offboarding' AND p.source_ref=p_id AND p.company_id=p_company AND p.employment_id=p_employment AND (p.status='approved' AND p.approved_by=app.current_user_id() OR p.status='rejected' AND to_jsonb(p)->>'rejected_by'=app.current_user_id()::text))
 WHEN 'own' THEN r.payload->'args'->>'employmentId'=p_employment::text AND EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 WHEN 'inbox' THEN app.resignation_journey_access(p_id) AND (jsonb_array_length(coalesce(r.payload->'args'->'companyIds','[]'))=0 OR r.payload->'args'->'companyIds' ? p_company::text)
 WHEN 'configuration' THEN app.automation_can_configure('off') AND app.is_admin_for(p_company) AND (jsonb_array_length(coalesce(r.payload->'args'->'companyIds','[]'))=0 OR r.payload->'args'->'companyIds' ? p_company::text)
 ELSE false END) OR app.resignation_runtime_intent(p_id);
$$;
REVOKE ALL ON FUNCTION app.resignation_runtime_intent(uuid),app.resignation_pending_steps(jsonb),app.resignation_command_allowed(uuid,jsonb),app.resignation_runtime_consume(text,uuid,jsonb),app.resignation_runtime_readable(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.resignation_journey_admit(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_journey_admit(text,text),app.resignation_runtime_readable(uuid,uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE POLICY resignation_journey_read ON public.resignation_journey FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.resignation_runtime_readable(id,employment_id,company_id));
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_create(p_id uuid,p_data jsonb,p_participants uuid[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r resignation_request;u app_user;n bigint;proof jsonb;
BEGIN
 proof:=app.resignation_runtime_consume('create',p_id,jsonb_build_object('id',p_id,'data',p_data,'participants',to_jsonb(p_participants)));
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO u FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id);
 SELECT * INTO r FROM resignation_request WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF u.person_id IS NULL OR r.person_id IS DISTINCT FROM u.person_id OR r.status<>'pending' OR jsonb_typeof(p_data)<>'object' THEN RAISE EXCEPTION 'Only the employee can start their resignation journey' USING ERRCODE='42501';END IF;
 IF NOT(p_data ?& ARRAY['decision','offer','letters','releasedDocuments','waits','tasks','decidedBy','lastWorkingDay','reason','facts']) OR p_data->'decision' IS DISTINCT FROM 'null'::jsonb OR p_data->'offer' IS DISTINCT FROM 'null'::jsonb OR p_data->'letters' IS DISTINCT FROM '[]'::jsonb OR p_data->'releasedDocuments' IS DISTINCT FROM '[]'::jsonb OR p_data->'waits' IS DISTINCT FROM '[]'::jsonb OR p_data->'tasks' IS DISTINCT FROM '[]'::jsonb OR p_data->'decidedBy' IS DISTINCT FROM 'null'::jsonb OR p_data->>'lastWorkingDay'<>r.last_working_day::text OR coalesce(p_data->>'reason','')<>coalesce(r.reason,'') OR p_data->'facts'->>'employmentId'<>r.employment_id::text OR p_data->'facts'->>'personId'<>r.person_id::text THEN RAISE EXCEPTION 'Only an unassigned source-derived seed can start a journey' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM resignation_journey WHERE tenant_id=r.tenant_id AND employment_id=r.employment_id AND stage NOT IN('retained','withdrawn')) THEN RAISE EXCEPTION 'A resignation is already open' USING ERRCODE='40001';END IF;
 INSERT INTO resignation_journey(tenant_id,id,employment_id,company_id,person_id,stage,data,participant_ids,submitted_on)
 SELECT r.tenant_id,r.id,r.employment_id,e.company_id,r.person_id,'decision',p_data,p_participants,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND e.person_id=r.person_id RETURNING number INTO n;
 IF n IS NULL THEN RAISE EXCEPTION 'The employment subject does not match the request' USING ERRCODE='42501';END IF;
 INSERT INTO app.resignation_runtime_state VALUES(r.tenant_id,u.id::text,'intent:'||p_id::text,txid_current(),jsonb_build_object('command',jsonb_build_object('type','submit'),'companyId',(SELECT company_id FROM employment WHERE id=r.employment_id AND tenant_id=r.tenant_id),'initialStage','decision','initialData',p_data),now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
 RETURN n;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_save(p_id uuid,p_revision integer,p_action text,p_stage text,p_data jsonb,p_participants uuid[],p_offboarding uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;proof jsonb;intent jsonb;k text;
BEGIN
 proof:=app.resignation_runtime_consume('save',p_id,jsonb_build_object('id',p_id,'revision',p_revision,'action',p_action,'stage',p_stage,'data',p_data,'participants',to_jsonb(p_participants),'offboarding',p_offboarding));
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND kind='intent:'||p_id::text AND transaction_id=txid_current();k:=intent->'command'->>'type';
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO j FROM resignation_journey WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR intent IS NULL THEN RAISE EXCEPTION 'This resignation action is not assigned to you' USING ERRCODE='42501';END IF;
 IF j.revision<>p_revision THEN RAISE EXCEPTION 'This resignation changed; reload before acting' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_data)<>'object' OR NOT (p_data->>'lastWorkingDay' ~ '^\d{4}-\d{2}-\d{2}$') OR length(coalesce(p_data->>'reason',''))>4000 OR cardinality(p_participants)>1000 THEN RAISE EXCEPTION 'Invalid resignation details' USING ERRCODE='22023';END IF;
 -- HMAC authenticates derivation; native invariants retain identity, scope, history and command authority.
 IF p_data->'facts' IS DISTINCT FROM j.data->'facts' THEN RAISE EXCEPTION 'Frozen subject facts cannot change' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_participants) uid WHERE NOT(uid=ANY(j.participant_ids)) AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.id=uid AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Invalid case participant' USING ERRCODE='42501';END IF;
 IF p_offboarding IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=p_offboarding AND c.company_id=j.company_id AND c.employment_id=j.employment_id AND c.module='off' AND c.data->>'resignationSourceCaseId'=j.id::text) THEN RAISE EXCEPTION 'Invalid clearance case' USING ERRCODE='42501';END IF;
 IF j.offboarding_case_id IS NOT NULL AND p_offboarding IS DISTINCT FROM j.offboarding_case_id THEN RAISE EXCEPTION 'Clearance link cannot be replaced' USING ERRCODE='42501';END IF;
 IF k='withdraw' AND p_stage<>'withdrawn' OR k='accept' AND p_stage NOT IN('accepted','leaving') OR k='offer' AND p_stage NOT IN('retention','offer') OR k IN('comment','taskProgress','updateEmail','openLetter','completeReplacement') AND p_stage<>j.stage THEN RAISE EXCEPTION 'Command cannot make this transition' USING ERRCODE='42501';END IF;
 IF k='accept' AND (p_data->>'lastWorkingDay' IS DISTINCT FROM intent->'command'->>'lastWorkingDay' OR p_data->'replacementNeeded' IS DISTINCT FROM intent->'command'->'replacementNeeded') THEN RAISE EXCEPTION 'Decision values differ from the admitted command' USING ERRCODE='42501';END IF;
 IF k='offer' AND p_data->'offer' IS DISTINCT FROM (intent->'command'->'offer'||jsonb_build_object('position',btrim(intent->'command'->'offer'->>'position'))) THEN RAISE EXCEPTION 'Offer differs from the admitted command' USING ERRCODE='42501';END IF;
 IF k NOT IN('accept','updateLetter') AND (p_data->>'lastWorkingDay' IS DISTINCT FROM j.data->>'lastWorkingDay' OR p_data->>'reason' IS DISTINCT FROM j.data->>'reason') THEN RAISE EXCEPTION 'Only the holding owner can correct case details' USING ERRCODE='42501';END IF;
 IF k='updateLetter' AND ((intent->'command' ? 'lastWorkingDay' AND p_data->>'lastWorkingDay' IS DISTINCT FROM intent->'command'->>'lastWorkingDay') OR (intent->'command' ? 'reason' AND p_data->>'reason' IS DISTINCT FROM intent->'command'->>'reason')) THEN RAISE EXCEPTION 'Corrections differ from the admitted command' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(coalesce(p_data->'offerSnapshots','[]'))<jsonb_array_length(coalesce(j.data->'offerSnapshots','[]')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'offerSnapshots','[]')) WITH ORDINALITY old(snapshot,n) WHERE p_data->'offerSnapshots'->((old.n-1)::integer) IS DISTINCT FROM old.snapshot) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'offerSnapshots','[]')) WITH ORDINALITY new(snapshot,n) WHERE new.n>jsonb_array_length(coalesce(j.data->'offerSnapshots','[]')) AND (k<>'offer' OR snapshot->'offer' IS DISTINCT FROM (intent->'command'->'offer'||jsonb_build_object('position',btrim(intent->'command'->'offer'->>'position'))) OR snapshot->'by'->>'id' IS DISTINCT FROM app.current_user_id()::text)) THEN RAISE EXCEPTION 'Retention offer snapshots are immutable command evidence' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) new WHERE new->>'id'=old->>'id')) THEN RAISE EXCEPTION 'Letter evidence cannot be removed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l WHERE l->'document'->>'tenantId'<>j.tenant_id::text OR l->'document'->>'companyId'<>j.company_id::text OR l->'document'->>'subjectId'<>j.id::text OR l->'document'->>'subjectType'<>'resignation' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'route'->'steps') s WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=j.tenant_id AND u.person_id IS NOT NULL AND (NOT(s ? 'holderPersonId') OR u.person_id::text=s->>'holderPersonId') AND u.archived_at IS NULL))) THEN RAISE EXCEPTION 'Letter scope or recipient identity mismatch' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l LEFT JOIN LATERAL (SELECT prior FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') old ON true CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'history','[]')) WITH ORDINALITY a(receipt,n) WHERE a.n>coalesce(jsonb_array_length(old.prior->'history'),0) AND (receipt->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.id=app.current_user_id() AND u.person_id::text=receipt->>'actorPersonId' AND u.archived_at IS NULL))) THEN RAISE EXCEPTION 'New signing evidence must name the current verified actor' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'document'->'actions','[]')) a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'history','[]')) h WHERE (a-'contentRevision'-'contentHash')=(h-'contentRevision'-'contentHash'))) THEN RAISE EXCEPTION 'Effective signing receipts must retain immutable action evidence' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l LEFT JOIN LATERAL (SELECT prior FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') old ON true CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'history','[]')) WITH ORDINALITY a(receipt,n) WHERE a.n>coalesce(jsonb_array_length(old.prior->'history'),0) AND receipt->>'action'='signed' AND (k<>'letterAction' OR intent->'command'->>'action'<>'sign' OR l->>'id' IS DISTINCT FROM intent->'command'->>'documentId' OR receipt->'signature'->>'consent' IS DISTINCT FROM 'true' OR receipt->'signature'->>'value' IS DISTINCT FROM intent->'command'->>'signature' OR NOT EXISTS(SELECT 1 FROM app.resignation_pending_steps(old.prior) step WHERE step->>'id'=receipt->>'stepId' AND step->>'holderId'=app.current_user_id()::text AND step->>'kind'='sign'))) THEN RAISE EXCEPTION 'Signature evidence must match the admitted current pending signature' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE new->'document'->'route' IS DISTINCT FROM old->'document'->'route' OR new->'templateId' IS DISTINCT FROM old->'templateId' OR new->'templateVersion' IS DISTINCT FROM old->'templateVersion' OR new->'generatedOn' IS DISTINCT FROM old->'generatedOn' OR jsonb_array_length(new->'history')<jsonb_array_length(old->'history') OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'history') WITH ORDINALITY h(a,n) WHERE new->'history'->((h.n-1)::integer) IS DISTINCT FROM h.a)) THEN RAISE EXCEPTION 'Pinned letter identity and action history cannot change' USING ERRCODE='42501';END IF;
 UPDATE resignation_journey SET stage=p_stage,data=p_data,participant_ids=p_participants,offboarding_case_id=coalesce(p_offboarding,offboarding_case_id),revision=revision+1,closed_on=CASE WHEN p_stage IN('retained','withdrawn','leaving') THEN coalesce(closed_on,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ELSE NULL END,updated_at=now() WHERE id=p_id AND tenant_id=j.tenant_id;
 -- Managed accepted journeys retain the pending legacy request until clearance records termination atomically.
 UPDATE resignation_request SET last_working_day=(p_data->>'lastWorkingDay')::date,reason=p_data->>'reason',status=CASE WHEN p_stage IN('retained','withdrawn') THEN 'withdrawn'::resignation_status ELSE status END WHERE id=p_id AND tenant_id=j.tenant_id;
 RETURN p_revision+1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_journey_create(uuid,jsonb,uuid[]),app.resignation_journey_save(uuid,integer,text,text,jsonb,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_journey_create(uuid,jsonb,uuid[]),app.resignation_journey_save(uuid,integer,text,text,jsonb,uuid[],uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_context(p_employment uuid,p_case uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();r jsonb;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.resignation_runtime_consume('context',p_case,jsonb_build_object('employmentId',p_employment,'caseId',p_case));
 IF NOT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE e.id=p_employment AND e.tenant_id=t AND (u.person_id=e.person_id OR (p_case IS NOT NULL AND (app.resignation_runtime_intent(p_case) OR app.resignation_journey_access(p_case)) AND EXISTS(SELECT 1 FROM resignation_journey j WHERE j.id=p_case AND j.tenant_id=t AND j.employment_id=e.id)) OR app.automation_can_configure('off') AND app.is_admin_for(e.company_id))) AND NOT(app.current_user_id() IS NULL AND app.acting_as_owner()) THEN RAISE EXCEPTION 'Resignation context unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'employeeName',p.full_name,'employeeCode',coalesce(e.employee_code,''),'companyName',co.legal_name,
 'businessGroupId',a.business_unit_id,'businessGroup',coalesce(bu.name,''),'departmentId',a.department_id,'department',coalesce(dep.name,''),'positionId',a.position_id,'jobGradeId',e.grade_id,'position',coalesce(pos.title,''),'jobGrade',coalesce(g.code,''),'employmentType',coalesce(a.employment_type::text,'permanent'),'confirmed',e.final_confirmation_date IS NULL OR e.final_confirmation_date<=day,'finalConfirmationDate',e.final_confirmation_date::text,'noticeBefore',CASE WHEN e.notice_before_confirmation_value IS NOT NULL THEN jsonb_build_object('value',e.notice_before_confirmation_value,'unit',e.notice_before_confirmation_unit) ELSE NULL END,'noticeAfter',CASE WHEN e.notice_after_confirmation_value IS NOT NULL THEN jsonb_build_object('value',e.notice_after_confirmation_value,'unit',e.notice_after_confirmation_unit) ELSE NULL END,
 'basicSalary',(SELECT c.basic_salary::text FROM compensation c WHERE c.tenant_id=t AND c.employment_id=e.id AND c.superseded_at IS NULL AND c.valid_from<=day AND (c.valid_to IS NULL OR c.valid_to>day) ORDER BY c.valid_from DESC,c.id LIMIT 1),
 'employeeUserId',(SELECT (array_agg(u.id))[1] FROM app_user u WHERE u.tenant_id=t AND u.person_id=e.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) HAVING count(*)=1),
 'supervisorUserId',(SELECT (array_agg(DISTINCT u.id))[1] FROM reporting_line rl JOIN employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id JOIN app_user u ON u.person_id=me.person_id AND u.tenant_id=me.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE rl.tenant_id=t AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=day AND (rl.valid_to IS NULL OR rl.valid_to>day) HAVING count(DISTINCT u.id)=1),
 'config',(SELECT data FROM lc_v9_config WHERE tenant_id=t),
 'workflows',coalesce((SELECT jsonb_agg(v.definition||jsonb_build_object('id',v.workflow_id,'status',v.status,'required',v.required)) FROM(SELECT DISTINCT ON(workflow_id) workflow_id,status,required,definition FROM automation_workflow_version WHERE tenant_id=t AND module='off' ORDER BY workflow_id,revision DESC LIMIT 200) v WHERE v.status='live' AND v.definition->'trigger'->>'event'='submitted'),'[]'),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (SELECT DISTINCT ON(routing_id) routing_id,name,routing_rows,retired FROM automation_routing_version WHERE tenant_id=t ORDER BY routing_id,revision DESC LIMIT 500) r WHERE NOT retired),'[]'),
 'users',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'personId',u.person_id,'name',up.full_name)) FROM app_user u JOIN person up ON up.id=u.person_id AND up.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (
 u.id=app.current_user_id() OR u.person_id=e.person_id OR EXISTS(SELECT 1 FROM reporting_line rl JOIN employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id WHERE rl.tenant_id=t AND rl.subordinate_employment_id=e.id AND me.person_id=u.person_id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=day AND (rl.valid_to IS NULL OR rl.valid_to>day)) OR
 u.id=ANY(coalesce((SELECT j.participant_ids FROM resignation_journey j WHERE j.tenant_id=t AND j.id=p_case),'{}'::uuid[])) OR u.id::text IN(SELECT v #>> '{}' FROM lc_v9_config cfg CROSS JOIN LATERAL jsonb_path_query(cfg.data,'$.**.members[*]') v WHERE cfg.tenant_id=t UNION SELECT v #>> '{}' FROM lc_v9_config cfg CROSS JOIN LATERAL jsonb_path_query(cfg.data,'$.**.userId') v WHERE cfg.tenant_id=t UNION SELECT v #>> '{}' FROM automation_routing_version ar CROSS JOIN LATERAL jsonb_path_query(ar.routing_rows,'$.**.userIds[*]') v WHERE ar.tenant_id=t UNION SELECT v #>> '{}' FROM automation_workflow_version aw CROSS JOIN LATERAL jsonb_path_query(aw.definition,'$.**.userId') v WHERE aw.tenant_id=t AND aw.module='off')
 )),'[]')) INTO r
 FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM assignment WHERE employment_id=e.id AND tenant_id=t AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1)a ON true
 LEFT JOIN business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=t LEFT JOIN department dep ON dep.id=a.department_id AND dep.tenant_id=t LEFT JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=t LEFT JOIN job_grade g ON g.id=e.grade_id AND g.tenant_id=t WHERE e.id=p_employment AND e.tenant_id=t;
 -- Availability is the canonical approved leave-day/range projection; no leave reason or other absence data exits.
 r:=r||jsonb_build_object('unavailableUserIds',coalesce((SELECT jsonb_agg(DISTINCT u->>'id') FROM jsonb_array_elements(r->'users') u JOIN app_user au ON au.tenant_id=t AND au.id::text=u->>'id' JOIN employment e ON e.tenant_id=t AND e.person_id=au.person_id JOIN leave_request lr ON lr.tenant_id=t AND lr.employment_id=e.id WHERE EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id AND ld.leave_date=day AND ld.status='approved') OR lr.status='approved' AND day BETWEEN lr.start_date AND lr.end_date AND NOT EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id)),'[]'::jsonb),
 'assignmentLoads',coalesce((WITH candidates AS(SELECT u->>'id' id FROM jsonb_array_elements(r->'users') u), shared AS(SELECT * FROM app.onboarding_assignment_loads()), tasks AS(SELECT a #>> '{}' id,task FROM resignation_journey j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.data->'tasks','[]')) task CROSS JOIN LATERAL jsonb_array_elements(coalesce(task->'userIds','[]')) a WHERE j.tenant_id=app.current_tenant_id() AND j.stage NOT IN('retained','withdrawn') AND task->>'status' IN('todo','progress')) SELECT jsonb_agg(jsonb_build_object('userId',c.id,'taskLoad',coalesce(s.task_load,0)+(SELECT count(*) FROM tasks x WHERE x.id=c.id),'lastAuto',s.last_auto)) FROM candidates c LEFT JOIN shared s ON s.user_id::text=c.id),'[]'::jsonb));
 RETURN r;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_journey_context(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_journey_context(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.resignation_journey_file(tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),case_id uuid NOT NULL,task_id text,slot text NOT NULL DEFAULT '',document_id uuid,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),mime_type text NOT NULL,size integer NOT NULL CHECK(size BETWEEN 1 AND 10485760),content bytea NOT NULL,uploaded_by uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES resignation_journey(tenant_id,id),FOREIGN KEY(uploaded_by,tenant_id) REFERENCES public.app_user(id,tenant_id),CHECK(octet_length(content)=size));
ALTER TABLE public.resignation_journey_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resignation_journey_file FORCE ROW LEVEL SECURITY;
CREATE POLICY resignation_journey_file_owner ON resignation_journey_file FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY resignation_journey_file_read ON resignation_journey_file FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.resignation_journey_access(case_id) AND document_id IS NULL);
GRANT SELECT,INSERT ON resignation_journey_file TO ai_hr_app;
CREATE POLICY resignation_journey_file_insert ON resignation_journey_file FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND uploaded_by=app.current_user_id() AND document_id IS NULL AND EXISTS(SELECT 1 FROM resignation_journey j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.data->'waits','[]'::jsonb)) w WHERE j.tenant_id=resignation_journey_file.tenant_id AND j.id=resignation_journey_file.case_id AND w->>'kind'='file' AND w->>'id'=resignation_journey_file.task_id AND w->>'slot'=resignation_journey_file.slot AND w->'to' ? app.current_user_id()::text));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_run_subject_access(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject) WHEN 'off' THEN app.resignation_journey_access(p_subject) ELSE false END,false)
$$;
CREATE OR REPLACE FUNCTION app.automation_can_run(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject) WHEN 'off' THEN app.resignation_runtime_intent(p_subject) ELSE false END,false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_offboarding_intent(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR j.stage NOT IN('accepted','leaving') OR NOT app.resignation_runtime_intent(p_id) THEN RAISE EXCEPTION 'Resignation handoff unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('employmentId',j.employment_id,'type','Resignation','noticeDate',j.submitted_on::text,'lastDay',j.data->>'lastWorkingDay','manualHandoff',false,'offboardingCaseId',j.offboarding_case_id);
END $$;
CREATE FUNCTION app.resignation_offboarding_admit(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN PERFORM app.resignation_offboarding_intent(p_id);PERFORM set_config('app.resignation_handoff',p_id::text,true);END $$;
CREATE FUNCTION app.resignation_handoff_active() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE id uuid;
BEGIN id:=nullif(current_setting('app.resignation_handoff',true),'')::uuid;IF id IS NULL THEN RETURN false;END IF;PERFORM app.resignation_offboarding_intent(id);RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION app.resignation_offboarding_sequence(p_id uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n bigint;
BEGIN PERFORM app.resignation_offboarding_intent(p_id);PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':OFB9',0));SELECT coalesce(max(substring(number from '[0-9]+$')::bigint),0)+1 INTO n FROM lc_v9_case WHERE tenant_id=app.current_tenant_id() AND number ~ '^OFB9-[0-9]+$';RETURN n;END $$;
REVOKE ALL ON FUNCTION app.resignation_offboarding_intent(uuid),app.resignation_offboarding_admit(uuid),app.resignation_handoff_active(),app.resignation_offboarding_sequence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_offboarding_intent(uuid),app.resignation_offboarding_admit(uuid),app.resignation_handoff_active(),app.resignation_offboarding_sequence(uuid) TO ai_hr_app;
-- Case construction uses the canonical V9 reader inside the protected, authenticated handoff only.
CREATE POLICY resignation_handoff_config_read ON lc_v9_config FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.resignation_handoff_active());
CREATE POLICY resignation_handoff_case_read ON lc_v9_case FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.resignation_handoff_active() AND data->>'resignationSourceCaseId'=current_setting('app.resignation_handoff',true));
CREATE POLICY resignation_handoff_case_insert ON lc_v9_case FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND app.resignation_handoff_active() AND module='off' AND data->>'resignationSourceCaseId'=current_setting('app.resignation_handoff',true) AND EXISTS(SELECT 1 FROM resignation_journey j WHERE j.id::text=current_setting('app.resignation_handoff',true) AND j.tenant_id=lc_v9_case.tenant_id AND j.employment_id=lc_v9_case.employment_id AND j.company_id=lc_v9_case.company_id AND j.offboarding_case_id IS NULL));
--> statement-breakpoint
CREATE TABLE app.resignation_notification_receipt(tenant_id uuid NOT NULL,case_id uuid NOT NULL,key text NOT NULL CHECK(length(key) BETWEEN 1 AND 500),recipient_user_id uuid NOT NULL,notification_id uuid NOT NULL DEFAULT gen_random_uuid(),title text NOT NULL,body text NOT NULL,PRIMARY KEY(tenant_id,case_id,key,recipient_user_id),UNIQUE(notification_id),FOREIGN KEY(tenant_id,case_id) REFERENCES public.resignation_journey(tenant_id,id),FOREIGN KEY(recipient_user_id,tenant_id) REFERENCES public.app_user(id,tenant_id));
ALTER TABLE app.resignation_notification_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.resignation_notification_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY resignation_notification_owner ON app.resignation_notification_receipt FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.resignation_notification_receipt FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.resignation_journey_notify(p_id uuid,p_key text,p_to uuid[],p_subject text,p_body text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.resignation_runtime_consume('notify',p_id,jsonb_build_object('id',p_id,'key',p_key,'to',to_jsonb(p_to),'subject',p_subject,'body',p_body));
 IF cardinality(p_to) NOT BETWEEN 1 AND 1000 OR length(p_subject) NOT BETWEEN 1 AND 500 OR length(p_body)>100000 THEN RAISE EXCEPTION 'Invalid notification' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_to) id WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=id AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Notification recipient is unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.resignation_notification_receipt(tenant_id,case_id,key,recipient_user_id,title,body) SELECT app.current_tenant_id(),p_id,p_key,uid,p_subject,p_body FROM unnest(p_to) uid ON CONFLICT DO NOTHING;
 INSERT INTO public.notification(id,tenant_id,company_id,recipient_user_id,kind,title,body,link_path,severity)
 SELECT i.notification_id,app.current_tenant_id(),j.company_id,i.recipient_user_id,'resignation_journey',i.title,i.body,'/profile/resignation?case='||p_id::text,'info'::notification_severity FROM app.resignation_notification_receipt i JOIN resignation_journey j ON j.tenant_id=i.tenant_id AND j.id=i.case_id WHERE i.tenant_id=app.current_tenant_id() AND i.case_id=p_id AND i.key=p_key AND i.recipient_user_id=ANY(p_to) AND NOT EXISTS(SELECT 1 FROM notification n WHERE n.id=i.notification_id) ON CONFLICT(id) DO NOTHING;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_run_retry_save(p_run uuid,p_result jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r automation_run;w jsonb;retry_remaining jsonb;new_remaining jsonb;
BEGIN
 SELECT * INTO r FROM automation_run WHERE tenant_id=app.current_tenant_id() AND id=p_run AND module='off' FOR UPDATE;
 PERFORM app.resignation_runtime_consume('retrySave',r.subject_id,jsonb_build_object('runId',p_run,'result',p_result));
 IF r.id IS NULL OR r.status<>'failed' OR NOT app.resignation_journey_can_act(r.subject_id,'retry') THEN RAISE EXCEPTION 'Only an assigned configuration owner can retry a failed run' USING ERRCODE='42501';END IF;
 SELECT definition INTO w FROM automation_workflow_version WHERE tenant_id=r.tenant_id AND workflow_id=r.workflow_id AND revision=r.workflow_revision;
 IF r.step_cursor<1 OR w->'steps'->(r.step_cursor-1) IS NULL THEN RAISE EXCEPTION 'Pinned failed step unavailable' USING ERRCODE='22023';END IF;
 retry_remaining:=jsonb_build_array(jsonb_build_object('index',r.step_cursor-1,'step',w->'steps'->(r.step_cursor-1)))||r.remaining_steps;new_remaining:=p_result->'remaining';
 IF p_result->>'id'<>r.id::text OR p_result->>'subjectId'<>r.subject_id::text OR p_result->>'workflowId'<>r.workflow_id::text OR (p_result->>'workflowRevision')::integer<>r.workflow_revision OR (p_result->>'cursor')::integer<r.step_cursor-1 OR NOT app.automation_run_log_valid(p_result->'log') OR jsonb_typeof(new_remaining)<>'array' OR jsonb_array_length(new_remaining)>jsonb_array_length(retry_remaining) OR new_remaining IS DISTINCT FROM (SELECT coalesce(jsonb_agg(e ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(retry_remaining) WITH ORDINALITY x(e,n) WHERE n>jsonb_array_length(retry_remaining)-jsonb_array_length(new_remaining)) THEN RAISE EXCEPTION 'Retry changed its pinned workflow' USING ERRCODE='22023';END IF;
 UPDATE automation_run SET status=p_result->>'status',step_cursor=(p_result->>'cursor')::integer,waiting_for=(p_result->>'waitingFor')::uuid,remaining_steps=new_remaining,log=p_result->'log',failure=p_result->>'failure',updated_at=now() WHERE tenant_id=r.tenant_id AND id=r.id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_posting_run_rejected(p_run uuid,p_posting uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r automation_run;
BEGIN
 SELECT * INTO r FROM automation_run WHERE tenant_id=app.current_tenant_id() AND id=p_run AND module='off' FOR UPDATE;
 PERFORM app.resignation_runtime_consume('postingRejected',r.subject_id,jsonb_build_object('runId',p_run,'postingId',p_posting,'reason',p_reason));
 IF r.id IS NULL OR r.status<>'waiting' OR r.waiting_for<>p_posting OR NOT EXISTS(SELECT 1 FROM personnel_posting p WHERE p.tenant_id=r.tenant_id AND p.id=p_posting AND p.source IN('off','offboarding') AND p.source_ref=r.subject_id AND p.status='rejected') THEN RAISE EXCEPTION 'Recorded rejected posting required' USING ERRCODE='42501';END IF;
 UPDATE automation_run SET status='failed',waiting_for=NULL,failure=left(coalesce(nullif(p_reason,''),'The Personnel posting was rejected.'),1000),updated_at=now() WHERE tenant_id=r.tenant_id AND id=r.id;
END $$;
REVOKE ALL ON FUNCTION app.resignation_journey_notify(uuid,text,uuid[],text,text),app.resignation_run_retry_save(uuid,jsonb),app.resignation_posting_run_rejected(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_journey_notify(uuid,text,uuid[],text,text),app.resignation_run_retry_save(uuid,jsonb),app.resignation_posting_run_rejected(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Legacy APIs cannot accept a managed resignation before its completed-clearance posting is approved.
CREATE FUNCTION app.resignation_managed_request_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;intent jsonb;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=OLD.tenant_id AND id=OLD.id;
 IF j.id IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Managed resignation evidence cannot be deleted' USING ERRCODE='42501';END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.employment_id IS DISTINCT FROM OLD.employment_id THEN RAISE EXCEPTION 'Managed resignation identity cannot change' USING ERRCODE='42501';END IF;
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=OLD.tenant_id AND actor=coalesce(app.current_user_id()::text,'worker') AND kind='intent:'||OLD.id::text AND transaction_id=txid_current();
 IF NEW.last_working_day IS DISTINCT FROM OLD.last_working_day OR NEW.reason IS DISTINCT FROM OLD.reason THEN
  IF intent IS NULL OR NEW.last_working_day::text IS DISTINCT FROM j.data->>'lastWorkingDay' OR coalesce(NEW.reason,'') IS DISTINCT FROM coalesce(j.data->>'reason','') THEN RAISE EXCEPTION 'Case corrections must use the current authorized journey command' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  IF NEW.status='accepted' THEN
   IF NOT EXISTS(SELECT 1 FROM personnel_posting p JOIN lc_v9_case c ON c.tenant_id=p.tenant_id AND c.id=j.offboarding_case_id AND c.company_id=p.company_id AND c.employment_id=p.employment_id WHERE p.tenant_id=j.tenant_id AND p.source='offboarding' AND p.source_ref=j.id AND p.event_type='termination' AND p.status='approved' AND p.company_id=j.company_id AND p.employment_id=j.employment_id AND p.applied->>'effectiveDate'=NEW.last_working_day::text AND c.data->>'state'='cleared') THEN RAISE EXCEPTION 'Termination is recorded only after approved completed clearance' USING ERRCODE='42501';END IF;
  ELSIF NEW.status='withdrawn' THEN
   IF intent IS NULL OR j.stage NOT IN('withdrawn','retained') THEN RAISE EXCEPTION 'Withdrawal requires the authorized employee or signed retention journey' USING ERRCODE='42501';END IF;
  ELSE RAISE EXCEPTION 'Managed request status belongs to the journey' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.resignation_managed_request_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER resignation_managed_request_guard BEFORE UPDATE OR DELETE ON public.resignation_request FOR EACH ROW EXECUTE FUNCTION app.resignation_managed_request_guard();
--> statement-breakpoint
CREATE POLICY resignation_journey_supporting_read ON public.resignation_request_attachment FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.resignation_journey_access(resignation_request_id));
--> statement-breakpoint
CREATE FUNCTION app.resignation_request_is_managed(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_id); $$;
CREATE FUNCTION app.resignation_managed_clearance_ready(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM resignation_journey j JOIN lc_v9_case c ON c.tenant_id=j.tenant_id AND c.id=j.offboarding_case_id AND c.company_id=j.company_id AND c.employment_id=j.employment_id JOIN personnel_posting p ON p.tenant_id=j.tenant_id AND p.source='offboarding' AND p.source_ref=j.id AND p.company_id=j.company_id AND p.employment_id=j.employment_id AND p.event_type='termination' AND p.status='approved' WHERE j.tenant_id=app.current_tenant_id() AND j.id=p_id AND c.data->>'state'='cleared' AND p.applied->>'effectiveDate'=j.data->>'lastWorkingDay');
$$;
REVOKE ALL ON FUNCTION app.resignation_request_is_managed(uuid),app.resignation_managed_clearance_ready(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_request_is_managed(uuid),app.resignation_managed_clearance_ready(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_journey_subject_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM resignation_request r JOIN employment e ON e.tenant_id=r.tenant_id AND e.id=r.employment_id AND e.person_id=r.person_id WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.id AND r.employment_id=NEW.employment_id AND r.person_id=NEW.person_id AND e.company_id=NEW.company_id) THEN RAISE EXCEPTION 'Resignation request and employment subject must match' USING ERRCODE='23503';END IF;
 IF NEW.offboarding_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.offboarding_case_id AND c.company_id=NEW.company_id AND c.employment_id=NEW.employment_id AND c.module='off' AND c.data->>'resignationSourceCaseId'=NEW.id::text) THEN RAISE EXCEPTION 'Clearance case must match resignation subject' USING ERRCODE='23503';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.resignation_journey_subject_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER resignation_journey_subject_guard BEFORE INSERT OR UPDATE OF tenant_id,id,employment_id,company_id,person_id,offboarding_case_id ON public.resignation_journey FOR EACH ROW EXECUTE FUNCTION app.resignation_journey_subject_guard();
--> statement-breakpoint
-- A typed native projection into the canonical account bell, matching the existing Rewards capability.
ALTER TABLE public.notification DROP CONSTRAINT notification_audience_xor;
ALTER TABLE public.notification ADD CONSTRAINT notification_audience_xor CHECK(
 (recipient_employment_id IS NOT NULL AND recipient_user_id IS NULL AND letter_job_id IS NULL AND company_id IS NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NOT NULL AND company_id IS NOT NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NULL AND company_id IS NOT NULL AND kind IN('rewards.access-suspended','resignation_journey')));
CREATE FUNCTION app.resignation_notification_valid(p public.notification) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.resignation_notification_receipt r JOIN resignation_journey j ON j.tenant_id=r.tenant_id AND j.id=r.case_id WHERE r.notification_id=(p).id AND r.tenant_id=(p).tenant_id AND r.tenant_id=app.current_tenant_id() AND r.recipient_user_id=(p).recipient_user_id AND (p).company_id=j.company_id AND (p).title=r.title AND (p).body=r.body AND (p).link_path='/profile/resignation?case='||j.id::text AND (p).kind='resignation_journey' AND (p).recipient_employment_id IS NULL AND (p).letter_job_id IS NULL AND (p).source_event_id IS NULL AND (p).read_at IS NULL AND (p).severity='info' AND (p).portal_visible);
$$;
CREATE FUNCTION app.resignation_notification_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NEW.kind='resignation_journey' AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Native resignation notification owner required' USING ERRCODE='42501';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.resignation_notification_valid(public.notification),app.resignation_notification_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER resignation_notification_owner BEFORE INSERT ON public.notification FOR EACH ROW EXECUTE FUNCTION app.resignation_notification_owner();
-- Preserve the installed Letter/Rewards guard byte-for-byte except the one typed native capability branch.
DO $migration$
DECLARE definition text;needle text:=' IF NEW.recipient_user_id IS NULL THEN RETURN NEW;END IF;';
BEGIN
 SELECT pg_get_functiondef('app.guard_letter_notification()'::regprocedure) INTO definition;
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Canonical notification guard shape changed; review resignation projection';END IF;
 definition:=replace(definition,needle,needle||E'\n IF NEW.kind=''resignation_journey'' AND NEW.letter_job_id IS NULL THEN\n  IF NOT app.resignation_notification_valid(NEW) THEN RAISE EXCEPTION ''Native resignation notification identity is invalid'' USING ERRCODE=''42501'';END IF;RETURN NEW;\n END IF;');
 EXECUTE definition;
END $migration$;
