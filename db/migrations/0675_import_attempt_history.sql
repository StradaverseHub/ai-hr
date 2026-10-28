-- Shared personnel import history and revert (ADR-0152). One append-only record per uploaded file for the
-- Cost Center Allocation (c4055300), Bank & Statutory (0db97f14), "Everything" (524303d9) and movement
-- (ac6645ec) imports. Attempts, items and events are immutable; a revert appends an event and writes its
-- compensation through each kind's own owner (never by editing these rows).
CREATE TABLE import_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 kind text NOT NULL CHECK(kind IN ('cost_allocations','bank_statutory','employee_full','movement')),
 created_by uuid NOT NULL REFERENCES app_user(id),operation_key uuid NOT NULL,
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 255),mime_type text NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),source_content bytea NOT NULL CHECK(octet_length(source_content)<=10485760),
 company_ids uuid[] NOT NULL CHECK(array_position(company_ids,NULL) IS NULL),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_hash=encode(sha256(source_content),'hex')),
 UNIQUE(tenant_id,created_by,operation_key)
);
CREATE INDEX import_attempt_kind_created_idx ON import_attempt(tenant_id,kind,created_at DESC,id DESC);
CREATE INDEX import_attempt_created_idx ON import_attempt(tenant_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE import_attempt_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 attempt_id uuid NOT NULL REFERENCES import_attempt(id),company_id uuid NOT NULL REFERENCES company(id),
 employment_id uuid REFERENCES employment(id),item_key text NOT NULL CHECK(length(item_key) BETWEEN 1 AND 500),
 label text NOT NULL DEFAULT '' CHECK(length(label)<=500),ordinal integer NOT NULL CHECK(ordinal>=0),
 status text NOT NULL CHECK(status IN ('applied','failed')),
 before jsonb,after jsonb,errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(errors)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,item_key)
);
CREATE INDEX import_attempt_item_attempt_idx ON import_attempt_item(tenant_id,attempt_id,ordinal);
CREATE INDEX import_attempt_item_employment_idx ON import_attempt_item(tenant_id,employment_id) WHERE employment_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE import_attempt_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 attempt_id uuid NOT NULL REFERENCES import_attempt(id),
 kind text NOT NULL CHECK(kind IN ('previewed','confirmed','failed','reverted','revert_failed')),
 actor_id uuid NOT NULL REFERENCES app_user(id),reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind<>'reverted' OR reason IS NOT NULL)
);
CREATE INDEX import_attempt_event_attempt_idx ON import_attempt_event(tenant_id,attempt_id,created_at);
CREATE UNIQUE INDEX import_attempt_confirm_once_uq ON import_attempt_event(attempt_id) WHERE kind='confirmed';
CREATE UNIQUE INDEX import_attempt_revert_once_uq ON import_attempt_event(attempt_id) WHERE kind='reverted';
--> statement-breakpoint
-- Permission per import kind. Every kind currently maps to the Workforce purpose capability of the company
-- (view to read, maintain to import or revert). A later kind owner replaces this one function, never the policies.
CREATE FUNCTION app.import_company_access(p_kind text,p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_company IS NOT NULL AND p_operation IN ('view','maintain')
  AND p_kind IN ('cost_allocations','bank_statutory','employee_full','movement')
  AND app.access_workforce_company(p_company,'workforce.'||p_operation);
$$;
REVOKE ALL ON FUNCTION app.import_company_access(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_company_access(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- p_all=false: the actor holds the operation for at least one listed company (list/detail visibility).
-- p_all=true: for every listed company (source download, revert). An attempt naming no company (an
-- unreadable file) is visible to its creator only.
CREATE FUNCTION app.import_attempt_access(p_attempt uuid,p_operation text,p_all boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.import_attempt a
  WHERE a.id=p_attempt AND a.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND CASE WHEN cardinality(a.company_ids)=0 THEN a.created_by=app.current_user_id()
   WHEN p_all THEN NOT EXISTS(SELECT 1 FROM unnest(a.company_ids) c WHERE NOT app.import_company_access(a.kind,c,p_operation))
   ELSE EXISTS(SELECT 1 FROM unnest(a.company_ids) c WHERE app.import_company_access(a.kind,c,p_operation)) END);
$$;
REVOKE ALL ON FUNCTION app.import_attempt_access(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_access(uuid,text,boolean) TO ai_hr_app;
--> statement-breakpoint
-- An item is readable only by an actor with the operation for that item's own company, which must be one of
-- the attempt's listed companies. A multi-company file therefore shows each administrator only their rows.
CREATE FUNCTION app.import_item_access(p_attempt uuid,p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.import_attempt a
  WHERE a.id=p_attempt AND a.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND p_company=ANY(a.company_ids) AND app.import_company_access(a.kind,p_company,p_operation));
$$;
REVOKE ALL ON FUNCTION app.import_item_access(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_item_access(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Only names of actors already recorded on an accessible attempt; no personnel directory access.
CREATE FUNCTION app.import_attempt_actor_label(p_attempt uuid,p_actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT nullif(btrim(p.full_name),'') FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=p_actor AND u.tenant_id=app.current_tenant_id() AND app.import_attempt_access(p_attempt,'view',false)
 AND (EXISTS(SELECT 1 FROM public.import_attempt a WHERE a.id=p_attempt AND a.tenant_id=u.tenant_id AND a.created_by=u.id)
  OR EXISTS(SELECT 1 FROM public.import_attempt_event e WHERE e.attempt_id=p_attempt AND e.tenant_id=u.tenant_id AND e.actor_id=u.id));
$$;
REVOKE ALL ON FUNCTION app.import_attempt_actor_label(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_actor_label(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE import_attempt ENABLE ROW LEVEL SECURITY;
-- Inlined for INSERT RETURNING: a STABLE helper reading this table cannot observe its own command's row.
CREATE POLICY import_attempt_read ON import_attempt FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND CASE WHEN cardinality(company_ids)=0 THEN created_by=app.current_user_id()
  ELSE EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE app.import_company_access(kind,c,'view')) END);
CREATE POLICY import_attempt_insert ON import_attempt FOR INSERT WITH CHECK(
 tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current()
 AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.import_company_access(kind,c,'maintain')));
-- SELECT FOR UPDATE serializes confirm and revert; the immutability trigger still refuses any change.
CREATE POLICY import_attempt_lock ON import_attempt FOR UPDATE USING(app.import_attempt_access(id,'view',false)) WITH CHECK(false);
ALTER TABLE import_attempt_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_attempt_item_read ON import_attempt_item FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.import_item_access(attempt_id,company_id,'view'));
CREATE POLICY import_attempt_item_insert ON import_attempt_item FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.import_item_access(attempt_id,company_id,'maintain'));
ALTER TABLE import_attempt_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_attempt_event_read ON import_attempt_event FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.import_attempt_access(attempt_id,'view',false));
CREATE POLICY import_attempt_event_insert ON import_attempt_event FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.import_attempt_access(attempt_id,'maintain',false));
-- Production bootstrap grants arwd on new public tables by default. State the exact privileges.
REVOKE ALL ON import_attempt,import_attempt_item,import_attempt_event FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON import_attempt,import_attempt_item,import_attempt_event TO ai_hr_app;
GRANT UPDATE(id) ON import_attempt TO ai_hr_app;
--> statement-breakpoint
-- Company retention (core/company-refs.ts): import history keeps its companies; items may be invisible to
-- a company-scoped administrator, so this fixed boolean answers for them.
CREATE FUNCTION app.import_history_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM public.import_attempt_item i WHERE i.tenant_id=app.current_tenant_id() AND i.company_id=wanted_company)
  OR EXISTS(SELECT 1 FROM public.import_attempt a WHERE a.tenant_id=app.current_tenant_id() AND wanted_company=ANY(a.company_ids)));
$$;
REVOKE ALL ON FUNCTION app.import_history_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_history_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.import_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Import history is append-only; record a new event instead'; END $$;
CREATE TRIGGER import_attempt_immutable BEFORE UPDATE OR DELETE ON import_attempt FOR EACH ROW EXECUTE FUNCTION app.import_attempt_immutable();
CREATE TRIGGER import_attempt_item_immutable BEFORE UPDATE OR DELETE ON import_attempt_item FOR EACH ROW EXECUTE FUNCTION app.import_attempt_immutable();
CREATE TRIGGER import_attempt_event_immutable BEFORE UPDATE OR DELETE ON import_attempt_event FOR EACH ROW EXECUTE FUNCTION app.import_attempt_immutable();
--> statement-breakpoint
-- c4055300: an import revert re-commits the earlier allocation through the single allocation writer and
-- is labelled as such in allocation history. The writer below is the only producer of this column.
ALTER TABLE employment_cost_allocation_set DROP CONSTRAINT employment_cost_allocation_set_source_check;
ALTER TABLE employment_cost_allocation_set ADD CONSTRAINT employment_cost_allocation_set_source_check CHECK(source IN ('manual','employee-import','allocation-import','import-revert'));
--> statement-breakpoint
-- Unchanged from 0597 except that 'import-revert' is an accepted source.
CREATE OR REPLACE FUNCTION app.employment_cost_allocation_commit(p_employment uuid,p_company uuid,p_date date,p_revision integer,p_operation text,p_rows jsonb,p_source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;v_revision integer;v_company uuid;v_count integer;v_total integer;v_id uuid:=gen_random_uuid();v_next date;v_kind text;v_before jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 FOREACH v_kind IN ARRAY ARRAY['department','position','cost_center','business_unit'] LOOP PERFORM app.lock_system_label_criteria(app.current_tenant_id(),v_kind);END LOOP;
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF e.id IS NULL OR NOT app.access_workforce_employment(e.id,'workforce.maintain') OR NOT app.access_workforce_company(p_company,'workforce.maintain') OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_company AND tenant_id=e.tenant_id AND archived_at IS NULL)
  THEN RAISE EXCEPTION 'Allocation access denied' USING ERRCODE='42501';END IF;
 SELECT count(*),(array_agg(a.company_id))[1] INTO v_count,v_company FROM public.assignment a
  WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=p_date AND(a.valid_to IS NULL OR a.valid_to>p_date);
 IF p_date<e.hired_on OR(e.terminated_on IS NOT NULL AND p_date>e.terminated_on) OR v_count<>1 OR v_company IS DISTINCT FROM p_company
  THEN RAISE EXCEPTION 'Allocation company history is unavailable' USING ERRCODE='23514';END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_date IS NULL OR p_operation IS NULL OR p_source IS NULL
  OR p_operation NOT IN ('replace','clear') OR p_source NOT IN ('manual','employee-import','allocation-import','import-revert') OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>100
  OR(p_operation='clear' AND jsonb_array_length(p_rows)<>0) OR(p_operation='replace' AND jsonb_array_length(p_rows)=0)
  THEN RAISE EXCEPTION 'Invalid allocation operation' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) x WHERE jsonb_typeof(x->'hundredths') IS DISTINCT FROM 'number' OR coalesce(x->>'hundredths','') !~ '^[0-9]+$') THEN RAISE EXCEPTION 'Allocation percentages must be exact integer hundredths' USING ERRCODE='23514';END IF;
 SELECT count(*),coalesce(sum(x.hundredths),0) INTO v_count,v_total FROM jsonb_to_recordset(p_rows) x("costCenterId" uuid,hundredths integer);
 IF v_total>10000 OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_rows) x("costCenterId" uuid,hundredths integer) WHERE x."costCenterId" IS NULL OR x.hundredths IS NULL OR x.hundredths<=0 OR x.hundredths>10000)
  OR(SELECT count(DISTINCT x."costCenterId") FROM jsonb_to_recordset(p_rows) x("costCenterId" uuid,hundredths integer))<>v_count
  THEN RAISE EXCEPTION 'Invalid allocation percentages or duplicate cost center' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_rows) x("costCenterId" uuid,hundredths integer) WHERE NOT EXISTS(
  SELECT 1 FROM public.cost_center c WHERE c.id=x."costCenterId" AND c.tenant_id=e.tenant_id AND c.archived_at IS NULL
   AND(c.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment l WHERE l.tenant_id=c.tenant_id AND l.label_kind='cost_center' AND l.label_id=c.id AND l.company_id=p_company))))
  THEN RAISE EXCEPTION 'Cost center is unavailable for this company' USING ERRCODE='23514';END IF;
 INSERT INTO public.employment_cost_allocation_head(employment_id,tenant_id) VALUES(e.id,e.tenant_id) ON CONFLICT DO NOTHING;
 SELECT revision INTO v_revision FROM public.employment_cost_allocation_head WHERE employment_id=e.id FOR UPDATE;
 IF v_revision<>p_revision THEN RAISE EXCEPTION 'Allocation revision changed' USING ERRCODE='40001';END IF;
 SELECT jsonb_agg(jsonb_build_object('setId',s.id,'validFrom',s.valid_from,'validTo',s.valid_to,'revision',s.revision) ORDER BY s.valid_from,s.revision) INTO v_before FROM public.employment_cost_allocation_set s WHERE s.employment_id=e.id AND s.superseded_at IS NULL;
 SELECT min(valid_from) INTO v_next FROM public.employment_cost_allocation_set WHERE employment_id=e.id AND superseded_at IS NULL AND valid_from>p_date;
 UPDATE public.employment_cost_allocation_set SET superseded_at=now() WHERE employment_id=e.id AND superseded_at IS NULL AND valid_from=p_date;
 UPDATE public.employment_cost_allocation_set SET valid_to=p_date WHERE employment_id=e.id AND superseded_at IS NULL AND valid_from<p_date AND(valid_to IS NULL OR valid_to>p_date);
 INSERT INTO public.employment_cost_allocation_set(id,tenant_id,employment_id,company_id,revision,valid_from,valid_to,operation,source,created_by)
  VALUES(v_id,e.tenant_id,e.id,p_company,v_revision+1,p_date,v_next,p_operation,p_source,app.current_user_id());
 INSERT INTO public.employment_cost_allocation_row(tenant_id,set_id,cost_center_id,hundredths,code_snapshot,label_snapshot)
  SELECT e.tenant_id,v_id,c.id,x.hundredths,c.code,coalesce(nullif(trim(c.label),''),c.code) FROM jsonb_to_recordset(p_rows) x("costCenterId" uuid,hundredths integer) JOIN public.cost_center c ON c.id=x."costCenterId" AND c.tenant_id=e.tenant_id;
 UPDATE public.employment_cost_allocation_head SET revision=v_revision+1 WHERE employment_id=e.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(e.tenant_id,'employment',e.id,'employment.cost-allocations.changed','user',app.current_user_id(),e.id,jsonb_build_object('effectiveDate',p_date,'companyId',p_company,'revision',v_revision+1,'operation',p_operation,'source',p_source,'before',v_before,'after',jsonb_build_object('setId',v_id,'rows',p_rows)));
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.employment_cost_allocation_commit(uuid,uuid,date,integer,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_cost_allocation_commit(uuid,uuid,date,integer,text,jsonb,text) TO ai_hr_app;
