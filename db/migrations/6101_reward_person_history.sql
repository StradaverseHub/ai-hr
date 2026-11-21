-- Board d8d2123a: provisional source reservation 6101 / idx5501 / when1794841006101.
-- The production migration ledger must be rechecked before installation.
CREATE TABLE public.reward_person_history(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),employment_id uuid NOT NULL REFERENCES public.employment(id),
 year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),kind text NOT NULL CHECK(kind IN('annual','offcycle')),
 source text NOT NULL CHECK(source IN('review','upload')),unit_id uuid REFERENCES public.reward_unit(id),entry_id uuid REFERENCES public.reward_entry(id),
 upload_batch_id uuid REFERENCES public.bulk_job(id),talent text CHECK(talent IS NULL OR talent IN('SSTAR','STAR','SCORE','IMPRO','PIP')),
 performance text CHECK(performance IS NULL OR performance IN('UA','BE','ME','AE','OU')),
 merit_bp integer NOT NULL CHECK(merit_bp>=0),promotion_bp integer NOT NULL CHECK(promotion_bp>=0),special_bp integer NOT NULL CHECK(special_bp>=0),
 increment_cents bigint NOT NULL CHECK(increment_cents BETWEEN 0 AND 100000000000),total_increase_bp bigint NOT NULL CHECK(total_increase_bp>=0),promoted boolean NOT NULL,promotion_grade text,
 bonus_cents bigint NOT NULL CHECK(bonus_cents>=0),bonus_months_bp bigint NOT NULL CHECK(bonus_months_bp>=0),lump_cents bigint NOT NULL CHECK(lump_cents>=0),
 withheld jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(withheld)='object'),created_by uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),superseded_at timestamptz,
 CHECK((source='review' AND unit_id IS NOT NULL AND entry_id IS NOT NULL AND upload_batch_id IS NULL)
  OR(source='upload' AND unit_id IS NULL AND entry_id IS NULL AND upload_batch_id IS NOT NULL)),
 CHECK(source='upload' OR superseded_at IS NULL),
 CONSTRAINT reward_person_history_company_tenant_fk FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id) ON DELETE NO ACTION
);
CREATE INDEX reward_person_history_company ON public.reward_person_history(tenant_id,company_id);
CREATE UNIQUE INDEX reward_person_history_review ON public.reward_person_history(entry_id) WHERE source='review';
CREATE UNIQUE INDEX reward_person_history_upload_current ON public.reward_person_history(tenant_id,company_id,employment_id,year,kind) WHERE source='upload' AND superseded_at IS NULL;
CREATE INDEX reward_person_history_person_year ON public.reward_person_history(tenant_id,employment_id,year DESC,kind,created_at,id) WHERE superseded_at IS NULL;
ALTER TABLE public.reward_person_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_person_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Company deletion sees retained usage without granting the deleting administrator private award rows.
CREATE FUNCTION app.reward_history_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
  SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id),c.id))
 ) THEN EXISTS(SELECT 1 FROM public.reward_person_history h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app.reward_history_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_history_upload_authorized(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND app.reward_not_viewing_as() AND app.reward_actor_holds_role('gr')
  AND app.reward_setup_allowed(NULL,'manage') AND app.reward_setup_allowed(wanted_company,'manage')
$$;
REVOKE ALL ON FUNCTION app.reward_history_upload_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_upload_authorized(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_history_upload_subject(wanted_employment uuid,wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_history_upload_authorized(wanted_company) AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=wanted_employment AND e.company_id=wanted_company
  AND e.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id))
$$;
REVOKE ALL ON FUNCTION app.reward_history_upload_subject(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_upload_subject(uuid,uuid) TO ai_hr_app;
CREATE POLICY reward_history_owner_read ON public.reward_person_history FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_history_owner_insert ON public.reward_person_history FOR INSERT TO ai_hr_owner WITH CHECK(tenant_id=app.current_tenant_id() AND source='review' AND created_by=app.current_user_id());
CREATE POLICY reward_history_upload_read ON public.reward_person_history FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND source='upload' AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id));
-- Native review rows enter only through the set-authorized owner writer below. The ordinary role
-- keeps INSERT solely for independently checked upload checkpoints.
CREATE POLICY reward_history_insert ON public.reward_person_history FOR INSERT TO ai_hr_app WITH CHECK(
 tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_not_viewing_as()
 AND source='upload' AND app.reward_history_upload_authorized(company_id));
CREATE POLICY reward_history_supersede ON public.reward_person_history FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NULL AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NOT NULL AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id));
GRANT INSERT ON public.reward_person_history TO ai_hr_app;
REVOKE SELECT ON public.reward_person_history FROM ai_hr_app;
-- Superseding needs identity columns only. Award amounts are available solely through the
-- current-review disclosure function, including for a Group Rewards uploader.
GRANT SELECT(id,tenant_id,company_id,employment_id,year,kind,source,superseded_at) ON public.reward_person_history TO ai_hr_app;
GRANT UPDATE(superseded_at) ON public.reward_person_history TO ai_hr_app;
--> statement-breakpoint
-- Group Rewards need not hold generic Personnel access to bind a history upload. No names or salary
-- facts leave this narrow owner projection, and the uploader's own person is excluded.
CREATE FUNCTION app.reward_history_upload_context(wanted_company uuid,wanted_codes text[]) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('firstReviewYear',(SELECT min((u.policy->>'year')::integer) FROM public.reward_unit u
  WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=wanted_company AND u.status='posted' AND u.deleted_at IS NULL),
  'people',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'code',e.employee_code) ORDER BY e.employee_code,e.id),'[]'::jsonb)
  FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND e.employee_code=ANY(wanted_codes)
   AND NOT app.is_self_person(e.person_id)))
 WHERE app.reward_history_upload_authorized(wanted_company)
$$;
REVOKE ALL ON FUNCTION app.reward_history_upload_context(uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_upload_context(uuid,text[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_history_shape() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.source<>'upload' OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR (to_jsonb(NEW)-'superseded_at') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_at') THEN
   RAISE EXCEPTION 'Reward history is append only' USING ERRCODE='42501';
  END IF;RETURN NEW;
 END IF;
 -- Native bindings are adjudicated as a complete set by the owner writer, with no query per inserted row.
 IF NEW.source='review' THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id) THEN
  RAISE EXCEPTION 'Reward history employment binding is invalid' USING ERRCODE='23514';END IF;
 IF NEW.source='upload' AND (NEW.year>=extract(year from timezone('Asia/Kuala_Lumpur',now()))::integer OR NOT EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=NEW.upload_batch_id AND j.tenant_id=NEW.tenant_id
  AND j.kind='reward_person_history' AND j.created_by=app.current_user_id() AND j.input->>'companyId'=NEW.company_id::text)
  OR EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND u.status='posted' AND u.deleted_at IS NULL AND (u.policy->>'year')::integer<=NEW.year)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND app.is_self_person(e.person_id))) THEN
  RAISE EXCEPTION 'Reward history upload binding or year is invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_history_shape() FROM PUBLIC;
CREATE TRIGGER reward_history_shape BEFORE INSERT OR UPDATE ON public.reward_person_history FOR EACH ROW EXECUTE FUNCTION app.reward_history_shape();
CREATE FUNCTION app.reward_history_write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Rewards View as is read-only' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_history_write_guard() FROM PUBLIC;
CREATE TRIGGER reward_history_readonly BEFORE INSERT OR UPDATE OR DELETE ON public.reward_person_history FOR EACH STATEMENT EXECUTE FUNCTION app.reward_history_write_guard();
--> statement-breakpoint
-- Only the new history writer may open this transaction-local owner read window. No application ACL.
CREATE TABLE public.reward_history_post_read_lease(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),unit_id uuid NOT NULL REFERENCES public.reward_unit(id),transaction_id bigint NOT NULL,
 PRIMARY KEY(tenant_id,unit_id,transaction_id)
);
ALTER TABLE public.reward_history_post_read_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_history_post_read_lease FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_history_post_read_lease FROM PUBLIC,ai_hr_app;
CREATE POLICY reward_history_post_read_lease_owner ON public.reward_history_post_read_lease FOR ALL TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND transaction_id=txid_current())
 WITH CHECK(tenant_id=app.current_tenant_id() AND transaction_id=txid_current());
CREATE POLICY reward_history_uploaded_post_selection ON public.reward_uploaded_award FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.reward_not_viewing_as()
  AND EXISTS(SELECT 1 FROM public.reward_history_post_read_lease l WHERE l.tenant_id=reward_uploaded_award.tenant_id AND l.unit_id=reward_uploaded_award.unit_id AND l.transaction_id=txid_current())
  AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=reward_uploaded_award.unit_id AND u.tenant_id=reward_uploaded_award.tenant_id AND u.deleted_at IS NULL
   AND u.status IN('approved','posted') AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id)))));
--> statement-breakpoint
-- Payroll posters have no general SELECT policy on stored history. The writer returns a count,
-- preventing INSERT RETURNING from requiring an overly broad disclosure policy for that role.
CREATE FUNCTION app.reward_record_person_history(wanted_unit uuid,wanted_rows jsonb) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u public.reward_unit;n integer;submitted bigint;unique_entries bigint;bound_entries bigint;selected_count bigint;uploaded boolean;selected_ids uuid[];self_award boolean;
BEGIN
 SELECT * INTO u FROM public.reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 IF u.id IS NULL OR u.status NOT IN('approved','posted') OR NOT app.principal_snapshot_current() OR NOT app.reward_not_viewing_as()
  OR NOT app.reward_admin(u.company_id) OR NOT 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id))) THEN
  RAISE EXCEPTION 'Reward history posting authority is required' USING ERRCODE='42501';END IF;
 -- Native review capacity is the selected unit's actual entry set, never an unrelated upload-file cap.
 IF jsonb_typeof(wanted_rows) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Invalid reward history rows' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(wanted_rows) r(value) WHERE
  jsonb_typeof(r.value) IS DISTINCT FROM 'object'
  OR NOT(r.value ?& ARRAY['entryId','employmentId','talent','performance','meritBp','promotionBp','specialBp','incrementCents','totalIncreaseBp','promoted','promotionGrade','bonusCents','bonusMonthsBp','lumpCents','withheld'])
  OR jsonb_typeof(r.value->'entryId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(r.value->'employmentId') IS DISTINCT FROM 'string'
  OR coalesce(r.value->>'entryId','') !~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
  OR coalesce(r.value->>'employmentId','') !~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
  OR jsonb_typeof(r.value->'talent') NOT IN('string','null')
  OR jsonb_typeof(r.value->'performance') NOT IN('string','null')
  OR jsonb_typeof(r.value->'promotionGrade') NOT IN('string','null')
  OR jsonb_typeof(r.value->'promoted') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(r.value->'withheld') IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['meritBp','promotionBp','specialBp','incrementCents','totalIncreaseBp','bonusCents','bonusMonthsBp','lumpCents']) f(key)
   WHERE jsonb_typeof(r.value->f.key) IS DISTINCT FROM 'number' OR coalesce(r.value->>f.key,'') !~ '^[0-9]+$'
    OR CASE WHEN coalesce(r.value->>f.key,'') ~ '^[0-9]+$' THEN (r.value->>f.key)::numeric>9007199254740991 ELSE false END)
  OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(r.value->'withheld')='object' THEN r.value->'withheld' ELSE '{}'::jsonb END) w(key,value)
   WHERE w.key NOT IN('increase','bonus','lump') OR jsonb_typeof(w.value) IS DISTINCT FROM 'string' OR length(w.value#>>'{}') NOT BETWEEN 10 AND 1000)) THEN
  RAISE EXCEPTION 'Invalid reward history row types' USING ERRCODE='23514';END IF;
 SELECT EXISTS(SELECT 1 FROM public.reward_uploaded_review r WHERE r.unit_id=u.id AND r.tenant_id=u.tenant_id) INTO uploaded;
 IF uploaded THEN
  INSERT INTO public.reward_history_post_read_lease(tenant_id,unit_id,transaction_id) VALUES(u.tenant_id,u.id,txid_current());
  BEGIN
   -- Same native selected award set, including explicit zero awards. Refuse the WHOLE unit on self pay,
   -- rather than hiding that award and accidentally accepting an incomplete subset.
   SELECT coalesce(array_agg(a.entry_id),ARRAY[]::uuid[]),coalesce(bool_or(actor.person_id::text=e.source->>'personId' OR actor.person_id=employee.person_id),false)
    INTO selected_ids,self_award
   FROM public.reward_uploaded_award a JOIN public.reward_entry e ON e.id=a.entry_id AND e.unit_id=a.unit_id AND e.tenant_id=a.tenant_id
   JOIN public.employment employee ON employee.id=e.employment_id AND employee.tenant_id=e.tenant_id
   JOIN public.app_user actor ON actor.id=app.current_user_id() AND actor.tenant_id=a.tenant_id
   WHERE a.unit_id=u.id AND a.tenant_id=u.tenant_id;
   DELETE FROM public.reward_history_post_read_lease WHERE tenant_id=u.tenant_id AND unit_id=u.id AND transaction_id=txid_current();
  EXCEPTION WHEN OTHERS THEN
   DELETE FROM public.reward_history_post_read_lease WHERE tenant_id=u.tenant_id AND unit_id=u.id AND transaction_id=txid_current();
   RAISE;
  END;
  IF self_award THEN RAISE EXCEPTION 'A different authorized Payroll reviewer must post this review' USING ERRCODE='42501';END IF;
 END IF;
 WITH selected AS MATERIALIZED(SELECT e.id,e.employment_id FROM public.reward_entry e WHERE e.unit_id=u.id AND e.tenant_id=u.tenant_id AND(NOT uploaded OR e.id=ANY(selected_ids))),
 wanted AS(SELECT (r.value->>'entryId')::uuid AS entry_id,(r.value->>'employmentId')::uuid AS employment_id FROM jsonb_array_elements(wanted_rows) r(value))
 SELECT count(*),count(DISTINCT w.entry_id),count(p.id),(SELECT count(*) FROM selected) INTO submitted,unique_entries,bound_entries,selected_count
 FROM wanted w LEFT JOIN selected e ON e.id=w.entry_id AND e.employment_id=w.employment_id
 LEFT JOIN public.employment p ON p.id=e.employment_id AND p.tenant_id=u.tenant_id AND p.company_id=u.company_id;
 IF submitted=0 OR submitted<>unique_entries OR submitted<>bound_entries
  OR (u.status='approved' AND submitted<>selected_count) THEN
  RAISE EXCEPTION 'Reward history must match the selected review entry set' USING ERRCODE='23514';END IF;
 -- A historical backfill may contain only the proven subset. SQL independently checks the enacted
 -- basic identity; the Rewards service remains the sole owner of the complete recalculation.
 IF u.status='posted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(wanted_rows) r(value)
  JOIN public.reward_entry e ON e.id=(r.value->>'entryId')::uuid AND e.unit_id=u.id AND e.tenant_id=u.tenant_id
  LEFT JOIN public.compensation c ON c.id=e.enacted_compensation_id AND c.employment_id=e.employment_id AND c.tenant_id=e.tenant_id
  WHERE c.id IS NULL OR c.basic_salary*100 IS DISTINCT FROM (e.source->>'basicCents')::numeric+(r.value->>'incrementCents')::numeric) THEN
  RAISE EXCEPTION 'Reward history needs matching enacted compensation evidence' USING ERRCODE='23514';END IF;
 INSERT INTO public.reward_person_history(tenant_id,company_id,employment_id,year,kind,source,unit_id,entry_id,talent,performance,
  merit_bp,promotion_bp,special_bp,increment_cents,total_increase_bp,promoted,promotion_grade,bonus_cents,bonus_months_bp,lump_cents,withheld,created_by)
 SELECT u.tenant_id,u.company_id,v."employmentId",(u.policy->>'year')::integer,CASE WHEN u.kind='annual' THEN 'annual' ELSE 'offcycle' END,'review',u.id,v."entryId",
  v.talent,v.performance,v."meritBp",v."promotionBp",v."specialBp",v."incrementCents",v."totalIncreaseBp",v.promoted,v."promotionGrade",v."bonusCents",v."bonusMonthsBp",v."lumpCents",coalesce(v.withheld,'{}'::jsonb),app.current_user_id()
 FROM jsonb_to_recordset(wanted_rows) AS v("entryId" uuid,"employmentId" uuid,talent text,performance text,"meritBp" integer,"promotionBp" integer,"specialBp" integer,
  "incrementCents" bigint,"totalIncreaseBp" bigint,promoted boolean,"promotionGrade" text,"bonusCents" bigint,"bonusMonthsBp" bigint,"lumpCents" bigint,withheld jsonb);
 -- No ON CONFLICT path: a repeated native posted request returns before this writer; any historical
 -- conflict here must be reconciled, never silently adopted or overwritten.
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.reward_record_person_history(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_record_person_history(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Current-review visibility is the sole disclosure authority. Historical rows do not grant access.
CREATE FUNCTION app.reward_person_history(wanted_unit uuid,wanted_entry uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH principal AS MATERIALIZED(
  SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
   AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.principal_snapshot_current()
 ),roles AS MATERIALIZED(SELECT coalesce(array_agg(role),ARRAY[]::text[]) AS value FROM app.reward_roles(wanted_unit) role),
 subject AS MATERIALIZED(
  SELECT e.employment_id,u.tenant_id,(u.policy->>'year')::integer AS year,
   NOT(coalesce((e.facts->>'seniorPlan')::boolean,false) OR(coalesce(u.policy->>'seniorMembershipMode','legacy-grades')<>'named-members' AND u.policy->'seniorGrades' ? (e.source->>'grade')))
    OR(roles.value&&ARRAY['gr','ctro','ec'] AND app.reward_level_rank(app.reward_unit_level(u.id,'senior.manage'))>=1) AS amounts
  FROM public.reward_unit u JOIN public.reward_entry e ON e.unit_id=u.id AND e.tenant_id=u.tenant_id
  JOIN public.employment employee ON employee.id=e.employment_id AND employee.tenant_id=e.tenant_id CROSS JOIN principal CROSS JOIN roles
  WHERE u.id=wanted_unit AND e.id=wanted_entry AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL
   -- Use native review authority, not the Access-directory scope (which intentionally excludes EC/payroll).
   AND app.reward_capability(u.id,'review.view') AND cardinality(roles.value)>0
   AND principal.person_id::text IS DISTINCT FROM e.source->>'personId'
   AND principal.person_id IS DISTINCT FROM employee.person_id
   AND(e.facts->>'reviewed'='true' OR 'gr'=ANY(roles.value))
   AND(e.facts->>'confidentiality'<>'bg' OR roles.value&&ARRAY['bg','gr','ctro','ec','payroll'])
   AND((e.facts->>'confidentiality'<>'ec' AND e.employment_id NOT IN(SELECT app.reward_group_ec_direct_reports(u.id)))
    OR(roles.value&&ARRAY['gr','ctro','ec'] AND app.reward_level_rank(app.reward_unit_level(u.id,'restricted.view'))>=1))
 ),records AS(
  SELECT h.*,s.amounts FROM subject s JOIN public.reward_person_history h ON h.tenant_id=s.tenant_id AND h.employment_id=s.employment_id
  WHERE h.superseded_at IS NULL AND h.year BETWEEN s.year-2 AND s.year AND(h.year<s.year OR h.kind='offcycle')
  ORDER BY h.year DESC,h.kind,h.created_at,h.id LIMIT 100
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'year',year,'kind',kind,'source',source,'talent',talent,'performance',performance,
  'meritBp',CASE WHEN amounts THEN merit_bp END,'promotionBp',CASE WHEN amounts THEN promotion_bp END,'specialBp',CASE WHEN amounts THEN special_bp END,
  'incrementCents',CASE WHEN amounts THEN increment_cents END,'totalIncreaseBp',CASE WHEN amounts THEN total_increase_bp END,'promoted',promoted,'promotionGrade',promotion_grade,
  'bonusCents',CASE WHEN amounts THEN bonus_cents END,'bonusMonthsBp',CASE WHEN amounts THEN bonus_months_bp END,'lumpCents',CASE WHEN amounts THEN lump_cents END,
  'withheld',CASE WHEN amounts THEN withheld END) ORDER BY year DESC,kind,created_at,id),'[]'::jsonb) FROM records
$$;
REVOKE ALL ON FUNCTION app.reward_person_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_person_history(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_history_recorded_entries(wanted_unit uuid) RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT h.entry_id FROM public.reward_person_history h JOIN public.reward_unit u ON u.id=h.unit_id AND u.tenant_id=h.tenant_id
 WHERE h.unit_id=wanted_unit AND h.tenant_id=app.current_tenant_id() AND h.source='review'
  AND u.deleted_at IS NULL AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id)))
$$;
REVOKE ALL ON FUNCTION app.reward_history_recorded_entries(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_recorded_entries(uuid) TO ai_hr_app;
--> statement-breakpoint
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('reward_person_history',NULL,'tenant','{"companyId":"string","token":"string"}'::jsonb,false);
--> statement-breakpoint
CREATE FUNCTION app.reward_history_audit_value(wanted_field text,value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN wanted_field='withhold' AND jsonb_typeof(value)='object' THEN jsonb_strip_nulls(jsonb_build_object(
  'increase',CASE WHEN jsonb_typeof(value->'increase')='string' THEN left(value->>'increase',2000) END,
  'bonus',CASE WHEN jsonb_typeof(value->'bonus')='string' THEN left(value->>'bonus',2000) END,
  'lump',CASE WHEN jsonb_typeof(value->'lump')='string' THEN left(value->>'lump',2000) END))
  WHEN jsonb_typeof(value)='string' THEN to_jsonb(left(value#>>'{}',8000))
  WHEN jsonb_typeof(value) IN('number','boolean','null') THEN value ELSE 'null'::jsonb END
$$;
REVOKE ALL ON FUNCTION app.reward_history_audit_value(text,jsonb) FROM PUBLIC;
CREATE FUNCTION app.reward_review_activity_changes(wanted_units uuid[],wanted_actor uuid,wanted_subject uuid)
 RETURNS TABLE(id uuid,changes jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT d.id,coalesce((SELECT jsonb_agg(jsonb_build_object('field',c.value->>'field',
   'before',app.reward_history_audit_value(c.value->>'field',c.value->'before'),
   'after',app.reward_history_audit_value(c.value->>'field',c.value->'after')) ORDER BY c.ordinality)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'changes')='array' THEN d.payload->'changes' ELSE '[]'::jsonb END) WITH ORDINALITY c(value,ordinality)
  WHERE c.value->>'field' IN('meritBp','promotionGrade','promotionBp','specialBp','multiplierBp','bonusCents','lumpCents',
   'reason','note','erDecision','pipDecision','caseReason','currentRoleSummary','proposedRoleSummary','withhold')),'[]'::jsonb)
 FROM app.reward_review_activity(wanted_units,wanted_actor,wanted_subject) allowed
 JOIN public.domain_event d ON d.id=allowed.id AND d.tenant_id=app.current_tenant_id()
 JOIN public.reward_entry e ON e.id::text=d.payload->>'entryId' AND e.unit_id=allowed.unit_id AND e.tenant_id=d.tenant_id
 JOIN public.reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id
 WHERE d.event_type='reward-unit.recommendation-updated' AND app.reward_private_entry_visible(u.id,e.id)
  AND NOT EXISTS(SELECT 1 FROM public.employment employee WHERE employee.id=e.employment_id AND employee.tenant_id=e.tenant_id AND app.is_self_person(employee.person_id))
  AND((e.facts->>'confidentiality'<>'ec' AND e.employment_id NOT IN(SELECT app.reward_group_ec_direct_reports(u.id)))
   OR app.reward_level_rank(app.reward_unit_level(u.id,'restricted.view'))>=1)
  AND(NOT(coalesce((e.facts->>'seniorPlan')::boolean,false) OR(coalesce(u.policy->>'seniorMembershipMode','legacy-grades')<>'named-members' AND u.policy->'seniorGrades' ? (e.source->>'grade')))
   OR app.reward_level_rank(app.reward_unit_level(u.id,'senior.manage'))>=1)
$$;
REVOKE ALL ON FUNCTION app.reward_review_activity_changes(uuid[],uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_review_activity_changes(uuid[],uuid,uuid) TO ai_hr_app;
