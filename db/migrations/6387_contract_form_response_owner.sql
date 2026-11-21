-- Canonical Form answer history, actual actor-bound intents and immutable receipts. No Personnel writes.
CREATE TABLE public.document_form_response(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),document_id uuid NOT NULL,subject_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(answers)='object' AND octet_length(answers::text)<=1048576),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id),UNIQUE(tenant_id,subject_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.document_signing_document(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,subject_id) REFERENCES public.contract_shared_letter(tenant_id,id)
);
ALTER TABLE public.document_form_response ADD COLUMN source_person_id uuid NOT NULL, ADD COLUMN locked_values jsonb;
CREATE TABLE public.document_form_response_revision(
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,revision integer NOT NULL,answers jsonb NOT NULL,
 actor_user_id uuid,actor_person_id uuid,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id,revision),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.document_form_response(tenant_id,document_id)
);
CREATE TABLE public.document_form_action_intent(
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,action_id text NOT NULL CHECK(length(action_id) BETWEEN 1 AND 200),step_id text NOT NULL,
 actor_user_id uuid NOT NULL,actor_person_id uuid NOT NULL,action_kind text NOT NULL CHECK(action_kind IN('signed','reviewed','approved')),
 base_revision integer NOT NULL,base_hash text NOT NULL,response_revision integer NOT NULL,response_hash text NOT NULL,
 signature_hash text NOT NULL,scope text NOT NULL CHECK(scope IN('employee','hr')),field_ids jsonb NOT NULL,values_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id,action_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.document_form_response(tenant_id,document_id)
);
CREATE TABLE public.document_form_action_receipt(
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,action_id text NOT NULL,data jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id,action_id),
 FOREIGN KEY(tenant_id,document_id,action_id) REFERENCES public.document_form_action_intent(tenant_id,document_id,action_id)
);
CREATE TABLE public.document_form_release(
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,fingerprint text NOT NULL,data jsonb NOT NULL,
 released_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.document_form_response(tenant_id,document_id)
);
--> statement-breakpoint
ALTER TABLE public.document_form_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_response FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_response_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_response_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_action_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_action_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_action_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_action_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_form_release FORCE ROW LEVEL SECURITY;
CREATE POLICY document_form_response_owner ON public.document_form_response FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY document_form_response_revision_owner ON public.document_form_response_revision FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY document_form_action_intent_owner ON public.document_form_action_intent FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY document_form_action_receipt_owner ON public.document_form_action_receipt FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY document_form_release_owner ON public.document_form_release FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.document_form_response,public.document_form_response_revision,public.document_form_action_intent,public.document_form_action_receipt,public.document_form_release FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON public.document_form_response TO ai_hr_owner;
GRANT SELECT,INSERT ON public.document_form_response_revision,public.document_form_action_intent,public.document_form_action_receipt,public.document_form_release TO ai_hr_owner;
--> statement-breakpoint
CREATE FUNCTION app.document_form_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Document Form history and receipts are immutable' USING ERRCODE='23514';END $$;
REVOKE ALL ON FUNCTION app.document_form_receipt_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER document_form_revision_immutable BEFORE UPDATE OR DELETE ON public.document_form_response_revision FOR EACH ROW EXECUTE FUNCTION app.document_form_receipt_immutable();
CREATE TRIGGER document_form_intent_immutable BEFORE UPDATE OR DELETE ON public.document_form_action_intent FOR EACH ROW EXECUTE FUNCTION app.document_form_receipt_immutable();
CREATE TRIGGER document_form_action_receipt_immutable BEFORE UPDATE OR DELETE ON public.document_form_action_receipt FOR EACH ROW EXECUTE FUNCTION app.document_form_receipt_immutable();
CREATE TRIGGER document_form_release_immutable BEFORE UPDATE OR DELETE ON public.document_form_release FOR EACH ROW EXECUTE FUNCTION app.document_form_receipt_immutable();
--> statement-breakpoint
-- The approved HTML derives kind from real blocks/routing, rather than a user-selected template label.
CREATE FUNCTION app.contract_shared_document_kind(p_letter uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN 'Form'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type'='signature')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type'='signature' AND coalesce(block->>'role','hr')<>'employee')
 THEN 'Acknowledgement' ELSE 'Letter' END FROM public.contract_shared_letter l WHERE tenant_id=app.current_tenant_id() AND id=p_letter
$$;
REVOKE ALL ON FUNCTION app.contract_shared_document_kind(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Forms never use a released/Case-View visibility shortcut. Identity means the current actual UID AND PID.
CREATE FUNCTION app.contract_shared_form_body_visible(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_letter l
 JOIN public.document_signing_document document ON document.tenant_id=l.tenant_id AND document.id=l.signing_document_id
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id AND e.person_id::text=l.data->>'subjectPersonId'
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND app.contract_shared_document_kind(l.id)='Form' AND (
  EXISTS(SELECT 1 FROM jsonb_array_elements(document.data->'route'->'steps') step WHERE step->'owner'='true'::jsonb AND step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text)
  OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document.data) step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(document.data->'actions') action WHERE action->>'actorId'=app.current_user_id()::text AND action->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_body_visible(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.document_form_field_validate(p_field jsonb,p_value text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row jsonb;table_rows jsonb;
BEGIN
 IF p_value IS NULL OR length(p_value)>20000 THEN RAISE EXCEPTION 'A Form field exceeds the allowed length' USING ERRCODE='22023';END IF;
 IF p_value='' THEN RETURN;END IF;
 IF p_field->>'type'='select' AND NOT(p_field->'options' ? p_value) THEN RAISE EXCEPTION 'Choose a valid option for %',p_field->>'label' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='date' AND (p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char(p_value::date,'YYYY-MM-DD')<>p_value) THEN RAISE EXCEPTION 'Enter a valid date for %',p_field->>'label' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='checkbox' AND p_value NOT IN('true','false') THEN RAISE EXCEPTION 'Choose a valid checkbox value' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='number' AND (p_value !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' OR lower(p_value) IN('nan','infinity','-infinity')) THEN RAISE EXCEPTION 'Enter a valid number' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='email' AND p_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='table' THEN
  BEGIN table_rows:=p_value::jsonb;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Enter valid table rows' USING ERRCODE='22023';END;
  IF jsonb_typeof(table_rows)<>'array' OR jsonb_array_length(table_rows)>50 THEN RAISE EXCEPTION 'Enter valid table rows' USING ERRCODE='22023';END IF;
  FOR row IN SELECT * FROM jsonb_array_elements(table_rows) LOOP
   IF jsonb_typeof(row)<>'array' OR jsonb_array_length(row)<>jsonb_array_length(coalesce(p_field->'columns','[]'::jsonb)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(row) cell WHERE jsonb_typeof(cell)<>'string' OR length(cell#>>'{}')>1000) THEN RAISE EXCEPTION 'Enter valid table cells' USING ERRCODE='22023';END IF;
  END LOOP;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.document_form_field_validate(jsonb,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
