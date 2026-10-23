-- Employment cost distribution is independent from the organisational primary cost center and payroll.
CREATE TABLE employment_cost_allocation_head (
 employment_id uuid PRIMARY KEY REFERENCES employment(id),tenant_id uuid NOT NULL REFERENCES tenant(id),revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),UNIQUE(tenant_id,employment_id)
);
CREATE TABLE employment_cost_allocation_set (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL,company_id uuid NOT NULL REFERENCES company(id),
 revision integer NOT NULL CHECK(revision>0),valid_from date NOT NULL,valid_to date,superseded_at timestamptz,operation text NOT NULL CHECK(operation IN ('replace','clear')),
 source text NOT NULL CHECK(source IN ('manual','employee-import','allocation-import')),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,employment_id) REFERENCES employment_cost_allocation_head(tenant_id,employment_id),UNIQUE(tenant_id,id),UNIQUE(employment_id,revision),CHECK(valid_to IS NULL OR valid_to>valid_from),
 EXCLUDE USING gist(employment_id WITH =,daterange(valid_from,valid_to,'[)') WITH &&) WHERE(superseded_at IS NULL)
);
CREATE TABLE employment_cost_allocation_row (
 tenant_id uuid NOT NULL REFERENCES tenant(id),set_id uuid NOT NULL,cost_center_id uuid NOT NULL REFERENCES cost_center(id),hundredths integer NOT NULL CHECK(hundredths>0 AND hundredths<=10000),
 code_snapshot text NOT NULL,label_snapshot text NOT NULL,PRIMARY KEY(set_id,cost_center_id),FOREIGN KEY(tenant_id,set_id) REFERENCES employment_cost_allocation_set(tenant_id,id)
);
CREATE INDEX employment_cost_allocation_label_idx ON employment_cost_allocation_row(tenant_id,cost_center_id,set_id);
ALTER TABLE employment_cost_allocation_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_cost_allocation_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_cost_allocation_row ENABLE ROW LEVEL SECURITY;
CREATE POLICY cost_allocation_head_read ON employment_cost_allocation_head FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.access_workforce_employment(employment_id,'workforce.view'));
CREATE POLICY cost_allocation_set_read ON employment_cost_allocation_set FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.access_workforce_employment(employment_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.view'));
CREATE POLICY cost_allocation_row_read ON employment_cost_allocation_row FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment_cost_allocation_set s WHERE s.id=set_id AND s.tenant_id=employment_cost_allocation_row.tenant_id));
-- Production bootstrap grants arwd on new public tables by default. State SELECT-only explicitly.
REVOKE ALL ON employment_cost_allocation_head,employment_cost_allocation_set,employment_cost_allocation_row FROM PUBLIC,ai_hr_app;
GRANT SELECT ON employment_cost_allocation_head,employment_cost_allocation_set,employment_cost_allocation_row TO ai_hr_app;
--> statement-breakpoint
-- The only write seam. Header CAS, company proof, Criteria, full-set sum and history commit together.
CREATE FUNCTION app.employment_cost_allocation_commit(p_employment uuid,p_company uuid,p_date date,p_revision integer,p_operation text,p_rows jsonb,p_source text) RETURNS uuid
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
  OR p_operation NOT IN ('replace','clear') OR p_source NOT IN ('manual','employee-import','allocation-import') OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>100
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
--> statement-breakpoint
CREATE FUNCTION app.cost_allocation_label_in_use(p_label uuid,p_companies uuid[] DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_admin() AND EXISTS(SELECT 1 FROM public.cost_center c JOIN public.employment_cost_allocation_row r ON r.cost_center_id=c.id AND r.tenant_id=c.tenant_id JOIN public.employment_cost_allocation_set s ON s.id=r.set_id AND s.tenant_id=r.tenant_id
  WHERE c.id=p_label AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.company_id)
   AND(p_companies IS NULL OR(s.superseded_at IS NULL AND(s.valid_to IS NULL OR s.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND s.company_id=ANY(p_companies))));
$$;
REVOKE ALL ON FUNCTION app.cost_allocation_label_in_use(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_label_in_use(uuid,uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Criteria changes are serialized by the existing Criteria locks. Check their final transaction state.
CREATE FUNCTION app.check_cost_allocation_criteria() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;id uuid;
BEGIN
 t:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 IF TG_TABLE_NAME='cost_center' THEN id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE IF (CASE WHEN TG_OP='DELETE' THEN OLD.label_kind ELSE NEW.label_kind END)<>'cost_center' THEN RETURN NULL;END IF;id:=CASE WHEN TG_OP='DELETE' THEN OLD.label_id ELSE NEW.label_id END;END IF;
 IF EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r JOIN public.employment_cost_allocation_set s ON s.id=r.set_id AND s.tenant_id=r.tenant_id
  WHERE r.tenant_id=t AND r.cost_center_id=id AND s.superseded_at IS NULL AND(s.valid_to IS NULL OR s.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND NOT EXISTS(SELECT 1 FROM public.cost_center c WHERE c.id=id AND c.tenant_id=t AND(c.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment l WHERE l.tenant_id=t AND l.label_kind='cost_center' AND l.label_id=id AND l.company_id=s.company_id))))
  THEN RAISE EXCEPTION 'A company still uses this cost center allocation' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_cost_allocation_criteria() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER cost_allocation_label_criteria AFTER UPDATE OR DELETE ON cost_center DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_allocation_criteria();
CREATE CONSTRAINT TRIGGER cost_allocation_company_criteria AFTER INSERT OR UPDATE OR DELETE ON label_company_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_allocation_criteria();
--> statement-breakpoint
CREATE FUNCTION app.cost_allocation_transfer_required(p_employment uuid,p_date date) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_employment(p_employment,'workforce.maintain') THEN RAISE EXCEPTION 'Allocation access denied' USING ERRCODE='42501';END IF;
 RETURN EXISTS(SELECT 1 FROM public.employment_cost_allocation_set s JOIN public.employment_cost_allocation_row r ON r.set_id=s.id AND r.tenant_id=s.tenant_id
  WHERE s.employment_id=p_employment AND s.tenant_id=app.current_tenant_id() AND s.superseded_at IS NULL AND(s.valid_to IS NULL OR s.valid_to>p_date));
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_transfer_required(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_transfer_required(uuid,date) TO ai_hr_app;
--> statement-breakpoint
-- Company-history corrections/cancellations must not make a saved nonempty split apply to another
-- employer. The final dated assignment state is checked, including pending future allocation sets.
CREATE FUNCTION app.check_cost_allocation_company_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted uuid;t uuid;
BEGIN
 IF TG_TABLE_NAME='employment' THEN wanted:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE wanted:=CASE WHEN TG_OP='DELETE' THEN OLD.employment_id ELSE NEW.employment_id END;END IF;
 t:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 IF EXISTS(SELECT 1 FROM public.employment_cost_allocation_set s JOIN public.employment_cost_allocation_row r ON r.set_id=s.id AND r.tenant_id=s.tenant_id
  JOIN public.assignment a ON a.employment_id=s.employment_id AND a.tenant_id=s.tenant_id AND a.superseded_at IS NULL
  WHERE s.employment_id=wanted AND s.tenant_id=t AND s.superseded_at IS NULL
   AND daterange(s.valid_from,s.valid_to,'[)') && daterange(a.valid_from,a.valid_to,'[)') AND a.company_id IS DISTINCT FROM s.company_id)
  THEN RAISE EXCEPTION 'Clear allocations at the transfer date and clear later scheduled sets before changing company history; then create a destination-company set' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_cost_allocation_company_history() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER cost_allocation_assignment_company AFTER INSERT OR UPDATE OR DELETE ON assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_allocation_company_history();
CREATE CONSTRAINT TRIGGER cost_allocation_employment_company AFTER UPDATE OF company_id ON employment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_allocation_company_history();
CREATE CONSTRAINT TRIGGER cost_allocation_set_company AFTER INSERT OR UPDATE ON employment_cost_allocation_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_allocation_company_history();
