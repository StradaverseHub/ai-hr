-- 0550: System Labels availability has one owner: Global OR an explicit company set.
-- Applied migration history and legacy company flags are untouched. Creation company remains provenance.
-- Reserve idx550/when1791900000030 centrally; journal union follows integration of prerequisites0541-0549.
-- Capture and install guards against one stable incumbent set, before new epoch triggers exist.
LOCK TABLE department,position,cost_center,business_unit,label_company_assignment IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
INSERT INTO label_company_assignment(tenant_id,label_kind,label_id,company_id)
SELECT tenant_id,'department',id,company_id FROM department WHERE NOT is_global
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO label_company_assignment(tenant_id,label_kind,label_id,company_id)
SELECT tenant_id,'position',id,company_id FROM position WHERE NOT is_global
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO label_company_assignment(tenant_id,label_kind,label_id,company_id)
SELECT tenant_id,'cost_center',id,company_id FROM cost_center WHERE NOT is_global
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO label_company_assignment(tenant_id,label_kind,label_id,company_id)
SELECT tenant_id,'business_unit',id,company_id FROM business_unit WHERE NOT is_global
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Preserve inherited ambiguity by exact pair below; invalid tenancy/orphans still refuse.
-- Never rename, delete or silently narrow an incumbent label to make migration pass.
DO $$
DECLARE v_kind text;v_key text;
BEGIN
 IF EXISTS(SELECT 1 FROM (SELECT tenant_id,id,company_id FROM department UNION ALL SELECT tenant_id,id,company_id FROM position UNION ALL SELECT tenant_id,id,company_id FROM cost_center UNION ALL SELECT tenant_id,id,company_id FROM business_unit) labels
  LEFT JOIN company co ON co.id=labels.company_id AND co.tenant_id=labels.tenant_id WHERE co.id IS NULL) THEN
  RAISE EXCEPTION 'Existing System Labels have invalid creation-company tenancy; reconcile before upgrading';
 END IF;
 IF EXISTS(SELECT 1 FROM label_company_assignment lca LEFT JOIN company co ON co.id=lca.company_id AND co.tenant_id=lca.tenant_id
  LEFT JOIN (SELECT tenant_id,id,'department'::text AS kind FROM department UNION ALL SELECT tenant_id,id,'position' FROM position UNION ALL SELECT tenant_id,id,'cost_center' FROM cost_center UNION ALL SELECT tenant_id,id,'business_unit' FROM business_unit) labels
   ON labels.id=lca.label_id AND labels.tenant_id=lca.tenant_id AND labels.kind=lca.label_kind
  WHERE co.id IS NULL OR labels.id IS NULL) THEN
  RAISE EXCEPTION 'Existing System Labels have invalid or orphan company Criteria; reconcile before upgrading';
 END IF;
END $$;
--> statement-breakpoint

-- ADR-0124. This is a migration observation, never a caller-controlled collision exemption.
CREATE TABLE system_label_collision_baseline (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 label_kind text NOT NULL CHECK(label_kind IN ('department','position','cost_center','business_unit')),
 normalized_code text NOT NULL CHECK(normalized_code=lower(trim(normalized_code))),
 first_label_id uuid NOT NULL, second_label_id uuid NOT NULL CHECK(first_label_id<second_label_id),
 all_companies boolean NOT NULL, company_ids uuid[] NOT NULL DEFAULT '{}',
 retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT system_label_collision_baseline_pair_uq UNIQUE(tenant_id,label_kind,normalized_code,first_label_id,second_label_id),
 CHECK(NOT all_companies OR cardinality(company_ids)=0),
 CHECK(retired_at IS NOT NULL OR all_companies OR cardinality(company_ids)>0)
);--> statement-breakpoint
ALTER TABLE system_label_collision_baseline ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON system_label_collision_baseline FROM PUBLIC,ai_hr_app;--> statement-breakpoint
GRANT SELECT ON system_label_collision_baseline TO ai_hr_app;--> statement-breakpoint
CREATE POLICY label_collision_baseline_read ON system_label_collision_baseline FOR SELECT
USING(tenant_id=app.current_tenant_id());--> statement-breakpoint

-- BEGIN INHERITED LABEL COLLISION CAPTURE: exactly once, as migration owner, no callable seeder.
DO $$
DECLARE v_kind text;v_key text;
BEGIN
 FOREACH v_kind IN ARRAY ARRAY['department','position','cost_center','business_unit'] LOOP
  v_key:=CASE v_kind WHEN 'department' THEN 'name' WHEN 'position' THEN 'title' ELSE 'code' END;
  EXECUTE format('INSERT INTO public.system_label_collision_baseline
   (tenant_id,label_kind,normalized_code,first_label_id,second_label_id,all_companies,company_ids)
   SELECT a.tenant_id,$1,lower(trim(a.%I)),a.id,b.id,a.is_global AND b.is_global,overlap.companies
   FROM public.%I a JOIN public.%I b ON a.tenant_id=b.tenant_id AND a.id<b.id
   CROSS JOIN LATERAL (SELECT ARRAY(SELECT DISTINCT x.company_id FROM public.label_company_assignment x
    WHERE x.tenant_id=a.tenant_id AND x.label_kind=$1 AND
     ((a.is_global AND NOT b.is_global AND x.label_id=b.id) OR
      (b.is_global AND NOT a.is_global AND x.label_id=a.id) OR
      (NOT a.is_global AND NOT b.is_global AND x.label_id=a.id AND EXISTS(
       SELECT 1 FROM public.label_company_assignment y WHERE y.tenant_id=x.tenant_id AND y.label_kind=x.label_kind
        AND y.label_id=b.id AND y.company_id=x.company_id))) ORDER BY x.company_id) AS companies) overlap
   WHERE a.archived_at IS NULL AND b.archived_at IS NULL AND lower(trim(a.%I))=lower(trim(b.%I))
    AND ((a.is_global AND b.is_global) OR cardinality(overlap.companies)>0)
   ON CONFLICT DO NOTHING',v_key,v_kind,v_kind,v_key,v_key) USING v_kind;
 END LOOP;
END $$;
-- END INHERITED LABEL COLLISION CAPTURE
--> statement-breakpoint

-- Invoker, read-only: projected workbook facts are not authorization. Actual write guards pass
-- final stored rows. A new identity (NULL in preview), code or overlap cannot borrow a baseline.
CREATE FUNCTION app.system_label_collision_allowed(p_tenant uuid,p_kind text,p_code text,
 p_first uuid,p_second uuid,p_first_global boolean,p_second_global boolean,
 p_first_companies uuid[],p_second_companies uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_overlap uuid[];v_baseline public.system_label_collision_baseline%ROWTYPE;
BEGIN
 IF p_tenant IS NULL OR p_kind IS NULL OR p_kind NOT IN ('department','position','cost_center','business_unit') OR p_code IS NULL
  OR p_first_global IS NULL OR p_second_global IS NULL OR p_first_companies IS NULL OR p_second_companies IS NULL THEN RETURN false;END IF;
 IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id()<>p_tenant THEN RETURN false;END IF;
 SELECT ARRAY(SELECT DISTINCT c FROM unnest(CASE WHEN p_first_global THEN p_second_companies ELSE p_first_companies END) c
  WHERE c IS NOT NULL AND (p_first_global OR p_second_global OR c=ANY(p_second_companies)) ORDER BY c) INTO v_overlap;
 IF NOT(p_first_global AND p_second_global) AND cardinality(v_overlap)=0 THEN RETURN true;END IF;
 IF p_first IS NULL OR p_second IS NULL OR p_first=p_second THEN RETURN false;END IF;
 SELECT * INTO v_baseline FROM public.system_label_collision_baseline
  WHERE tenant_id=p_tenant AND label_kind=p_kind AND normalized_code=lower(trim(p_code))
   AND first_label_id=least(p_first,p_second) AND second_label_id=greatest(p_first,p_second) AND retired_at IS NULL;
 IF NOT FOUND THEN RETURN false;END IF;
 IF p_first_global AND p_second_global THEN RETURN v_baseline.all_companies;END IF;
 RETURN v_baseline.all_companies OR v_overlap<@v_baseline.company_ids;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.system_label_collision_allowed(uuid,text,text,uuid,uuid,boolean,boolean,uuid[],uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.system_label_collision_allowed(uuid,text,text,uuid,uuid,boolean,boolean,uuid[],uuid[]) TO ai_hr_app;--> statement-breakpoint

-- Only this private trigger can reduce captured caps. It never inserts, deletes, expands or revives.
-- Deferred execution observes final batch Criteria, not transient DELETE/INSERT junction rows.
CREATE FUNCTION app.reduce_system_label_collision_baseline() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_tenant uuid;v_kind text;v_id uuid;v_key text;v_a record;v_b record;
 v_row public.system_label_collision_baseline%ROWTYPE;v_overlap uuid[];v_all boolean;v_retire boolean;
BEGIN
 IF TG_RELID NOT IN ('public.department'::regclass,'public.position'::regclass,'public.cost_center'::regclass,
   'public.business_unit'::regclass,'public.label_company_assignment'::regclass) THEN
  RAISE EXCEPTION 'Invalid label collision trigger relation' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='label_company_assignment' THEN
  IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;v_kind:=OLD.label_kind;v_id:=OLD.label_id;
  ELSE v_tenant:=NEW.tenant_id;v_kind:=NEW.label_kind;v_id:=NEW.label_id;END IF;
 ELSE
  v_kind:=TG_TABLE_NAME;
  IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;v_id:=OLD.id;ELSE v_tenant:=NEW.tenant_id;v_id:=NEW.id;END IF;
 END IF;
 IF v_kind NOT IN ('department','position','cost_center','business_unit') OR
  (app.current_tenant_id() IS NOT NULL AND app.current_tenant_id()<>v_tenant) THEN
  RAISE EXCEPTION 'Invalid label collision trigger identity' USING ERRCODE='42501';END IF;
 v_key:=CASE v_kind WHEN 'department' THEN 'name' WHEN 'position' THEN 'title' ELSE 'code' END;
 FOR v_row IN SELECT * FROM public.system_label_collision_baseline WHERE tenant_id=v_tenant AND label_kind=v_kind
  AND (first_label_id=v_id OR second_label_id=v_id) AND retired_at IS NULL ORDER BY first_label_id,second_label_id FOR UPDATE LOOP
  EXECUTE format('SELECT is_global,archived_at,lower(trim(%I)) AS code FROM public.%I WHERE tenant_id=$1 AND id=$2',v_key,v_kind) INTO v_a USING v_tenant,v_row.first_label_id;
  EXECUTE format('SELECT is_global,archived_at,lower(trim(%I)) AS code FROM public.%I WHERE tenant_id=$1 AND id=$2',v_key,v_kind) INTO v_b USING v_tenant,v_row.second_label_id;
  v_retire:=v_a.code IS NULL OR v_b.code IS NULL OR v_a.archived_at IS NOT NULL OR v_b.archived_at IS NOT NULL
   OR v_a.code<>v_row.normalized_code OR v_b.code<>v_row.normalized_code;
  v_all:=false;v_overlap:='{}'::uuid[];
  IF NOT v_retire THEN
   IF v_a.is_global AND v_b.is_global THEN
    -- A finite cap cannot become Global again. Leave it finite for the collision guard to refuse.
    v_all:=v_row.all_companies;v_overlap:=v_row.company_ids;
   ELSE
    SELECT ARRAY(SELECT DISTINCT x.company_id FROM public.label_company_assignment x WHERE x.tenant_id=v_tenant AND x.label_kind=v_kind
     AND ((v_a.is_global AND x.label_id=v_row.second_label_id) OR (v_b.is_global AND x.label_id=v_row.first_label_id)
      OR (NOT v_a.is_global AND NOT v_b.is_global AND x.label_id=v_row.first_label_id AND EXISTS(
       SELECT 1 FROM public.label_company_assignment y WHERE y.tenant_id=x.tenant_id AND y.label_kind=x.label_kind
        AND y.label_id=v_row.second_label_id AND y.company_id=x.company_id)))
     AND (v_row.all_companies OR x.company_id=ANY(v_row.company_ids)) ORDER BY x.company_id) INTO v_overlap;
    v_retire:=cardinality(v_overlap)=0;
   END IF;
  END IF;
  IF v_retire OR v_all IS DISTINCT FROM v_row.all_companies OR v_overlap IS DISTINCT FROM v_row.company_ids THEN
   UPDATE public.system_label_collision_baseline SET all_companies=v_all,company_ids=v_overlap,
    retired_at=CASE WHEN v_retire THEN now() ELSE NULL END,updated_at=now() WHERE id=v_row.id;
   INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
   VALUES(v_tenant,'system-label-collision',v_row.id,'system-label-collision.reduced',
    CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),
    jsonb_build_object('kind',v_kind,'code',v_row.normalized_code,'firstLabelId',v_row.first_label_id,'secondLabelId',v_row.second_label_id,
     'before',jsonb_build_object('allCompanies',v_row.all_companies,'companyIds',v_row.company_ids),
     'after',jsonb_build_object('allCompanies',v_all,'companyIds',v_overlap),'retired',v_retire));
  END IF;
 END LOOP;
 RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reduce_system_label_collision_baseline() FROM PUBLIC,ai_hr_app;--> statement-breakpoint

-- A persistent coordination row makes concurrent writers restart even under REPEATABLE READ;
-- advisory locks alone serialize timing but cannot refresh an already pinned MVCC snapshot.
CREATE TABLE system_label_criteria_epoch (
  tenant_id uuid NOT NULL REFERENCES tenant(id), label_kind text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id,label_kind),
  CHECK(label_kind IN ('department','position','cost_center','business_unit'))
);--> statement-breakpoint
ALTER TABLE system_label_criteria_epoch ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON system_label_criteria_epoch TO ai_hr_app;--> statement-breakpoint
CREATE POLICY label_criteria_epoch_admin ON system_label_criteria_epoch FOR ALL
USING(tenant_id=app.current_tenant_id() AND app.is_admin())
WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lock_system_label_criteria(p_tenant uuid,p_kind text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF p_kind NOT IN ('department','position','cost_center','business_unit') OR p_tenant IS NULL THEN
    RAISE EXCEPTION 'Invalid label criteria identity' USING ERRCODE='23514';
  END IF;
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'Label tenant mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind) VALUES(p_tenant,p_kind) ON CONFLICT DO NOTHING;
  UPDATE public.system_label_criteria_epoch SET revision=revision+1 WHERE tenant_id=p_tenant AND label_kind=p_kind;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_system_label_criteria(uuid,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_system_label_criteria(uuid,text) TO ai_hr_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.lock_label_criteria_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE v_tenant uuid; v_kind text;
BEGIN
  IF TG_TABLE_NAME='label_company_assignment' THEN
    IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.label_kind,NEW.label_id,NEW.company_id)
      IS DISTINCT FROM (OLD.tenant_id,OLD.label_kind,OLD.label_id,OLD.company_id) THEN
      RAISE EXCEPTION 'Replace criteria assignments; do not retarget their identity' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;v_kind:=OLD.label_kind;
    ELSE v_tenant:=NEW.tenant_id;v_kind:=NEW.label_kind;END IF;
  ELSE
    IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.company_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id) THEN
      RAISE EXCEPTION 'Label creation identity is immutable; change Criteria instead' USING ERRCODE='23514';
    END IF;
    v_kind:=TG_TABLE_NAME;
    IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;ELSE v_tenant:=NEW.tenant_id;END IF;
  END IF;
  PERFORM app.lock_system_label_criteria(v_tenant,v_kind);
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.seed_label_company_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT NEW.is_global THEN
    INSERT INTO public.label_company_assignment(tenant_id,label_kind,label_id,company_id)
    VALUES(NEW.tenant_id,TG_TABLE_NAME,NEW.id,NEW.company_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- Clearing a Global row is the same group-level decision as making it Global.
CREATE OR REPLACE FUNCTION app.guard_is_global() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF ((TG_OP='INSERT' AND NEW.is_global) OR
      (TG_OP='UPDATE' AND NEW.is_global IS DISTINCT FROM OLD.is_global)) AND NOT app.is_group_admin() THEN
    RAISE EXCEPTION 'Only a group admin may change Global criteria' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.can_manage_label_criteria(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE v_company uuid;v_global boolean;
BEGIN
  IF p_kind NOT IN ('department','position','cost_center','business_unit') THEN RETURN false;END IF;
  EXECUTE format('SELECT company_id,is_global FROM public.%I WHERE id=$1 AND tenant_id=app.current_tenant_id()',p_kind)
    INTO v_company,v_global USING p_id;
  RETURN v_company IS NOT NULL AND app.is_admin_for(v_company) AND (NOT v_global OR app.is_group_admin());
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.can_manage_label_criteria(text,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_manage_label_criteria(text,uuid) TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS label_company_assignment_rls ON label_company_assignment;--> statement-breakpoint
CREATE POLICY label_criteria_read ON label_company_assignment FOR SELECT
USING(tenant_id=app.current_tenant_id());--> statement-breakpoint
CREATE POLICY label_criteria_insert ON label_company_assignment FOR INSERT
WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_manage_label_criteria(label_kind,label_id));--> statement-breakpoint
CREATE POLICY label_criteria_update ON label_company_assignment FOR UPDATE
USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_manage_label_criteria(label_kind,label_id))
WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_manage_label_criteria(label_kind,label_id));--> statement-breakpoint
CREATE POLICY label_criteria_delete ON label_company_assignment FOR DELETE
USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_manage_label_criteria(label_kind,label_id));--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.check_label_company_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE v_tenant uuid;v_kind text;v_id uuid;v_key text;v_label record;v_collision boolean;v_cross boolean;v_used boolean;v_fk text;
BEGIN
  IF TG_TABLE_NAME='label_company_assignment' THEN
    IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;v_kind:=OLD.label_kind;v_id:=OLD.label_id;
    ELSE v_tenant:=NEW.tenant_id;v_kind:=NEW.label_kind;v_id:=NEW.label_id;END IF;
  ELSE
    v_kind:=TG_TABLE_NAME;
    IF TG_OP='DELETE' THEN v_tenant:=OLD.tenant_id;v_id:=OLD.id;
    ELSE v_tenant:=NEW.tenant_id;v_id:=NEW.id;END IF;
  END IF;
  IF v_kind NOT IN ('department','position','cost_center','business_unit') THEN
    RAISE EXCEPTION 'Invalid label criteria kind' USING ERRCODE='23514';
  END IF;
  v_key:=CASE v_kind WHEN 'department' THEN 'name' WHEN 'position' THEN 'title' ELSE 'code' END;
  EXECUTE format('SELECT id,company_id,is_global,archived_at,lower(trim(%I)) AS code FROM public.%I WHERE tenant_id=$1 AND id=$2',v_key,v_kind)
    INTO v_label USING v_tenant,v_id;
  IF v_label.id IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.label_company_assignment WHERE tenant_id=v_tenant AND label_kind=v_kind AND label_id=v_id) THEN
      RAISE EXCEPTION 'Criteria must reference a label in the same tenant' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=v_label.company_id AND tenant_id=v_tenant) THEN RAISE EXCEPTION 'Label creation company must belong to the same tenant' USING ERRCODE='23514';END IF;
  SELECT EXISTS(SELECT 1 FROM public.label_company_assignment lca LEFT JOIN public.company co
    ON co.id=lca.company_id AND co.tenant_id=lca.tenant_id
    WHERE lca.tenant_id=v_tenant AND lca.label_kind=v_kind AND lca.label_id=v_id AND co.id IS NULL) INTO v_cross;
  IF v_cross THEN RAISE EXCEPTION 'Criteria company must belong to the same tenant' USING ERRCODE='23514';END IF;
  IF NOT v_label.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment
    WHERE tenant_id=v_tenant AND label_kind=v_kind AND label_id=v_id) THEN
    RAISE EXCEPTION 'Scoped criteria require at least one company' USING ERRCODE='23514';
  END IF;
  IF NOT v_label.is_global THEN
    v_fk:=CASE v_kind WHEN 'department' THEN 'department_id' WHEN 'position' THEN 'position_id' WHEN 'cost_center' THEN 'cost_center_id' ELSE 'business_unit_id' END;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.assignment a JOIN public.employment e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.%I=$2 AND a.superseded_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment lca
        WHERE lca.tenant_id=$1 AND lca.label_kind=$3 AND lca.label_id=$2 AND lca.company_id=coalesce(a.company_id,e.company_id)))',v_fk)
      INTO v_used USING v_tenant,v_id,v_kind;
    IF v_used THEN RAISE EXCEPTION 'A company still uses this label; retain its Criteria' USING ERRCODE='23514';END IF;
    IF v_kind='business_unit' AND EXISTS(SELECT 1 FROM public.department d WHERE d.tenant_id=v_tenant AND d.business_unit_id=v_id
      AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment lca WHERE lca.tenant_id=v_tenant AND lca.label_kind='business_unit' AND lca.label_id=v_id AND lca.company_id=d.company_id)) THEN
      RAISE EXCEPTION 'A department still uses this business unit; retain its Criteria' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_label.archived_at IS NOT NULL THEN RETURN NULL;END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I other WHERE other.tenant_id=$1 AND other.id<>$2
    AND other.archived_at IS NULL AND lower(trim(other.%I))=$3
    AND NOT app.system_label_collision_allowed($1,$5,$3,$2,other.id,$4,other.is_global,
     ARRAY(SELECT company_id FROM public.label_company_assignment WHERE tenant_id=$1 AND label_kind=$5 AND label_id=$2),
     ARRAY(SELECT company_id FROM public.label_company_assignment WHERE tenant_id=$1 AND label_kind=$5 AND label_id=other.id)))',v_kind,v_key)
    INTO v_collision USING v_tenant,v_id,v_label.code,v_label.is_global,v_kind;
  IF v_collision THEN RAISE EXCEPTION 'Active label code or name conflicts in selected Criteria' USING ERRCODE='23505';END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.remove_label_company_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM app.lock_system_label_criteria(OLD.tenant_id,TG_TABLE_NAME);
  DELETE FROM public.label_company_assignment WHERE tenant_id=OLD.tenant_id AND label_kind=TG_TABLE_NAME AND label_id=OLD.id;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER department_criteria_cleanup BEFORE DELETE ON department
FOR EACH ROW EXECUTE FUNCTION app.remove_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER position_criteria_cleanup BEFORE DELETE ON position
FOR EACH ROW EXECUTE FUNCTION app.remove_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER cost_center_criteria_cleanup BEFORE DELETE ON cost_center
FOR EACH ROW EXECUTE FUNCTION app.remove_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER business_unit_criteria_cleanup BEFORE DELETE ON business_unit
FOR EACH ROW EXECUTE FUNCTION app.remove_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER department_criteria_lock BEFORE INSERT OR UPDATE OR DELETE ON department
FOR EACH ROW EXECUTE FUNCTION app.lock_label_criteria_write();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER department_criteria_check AFTER INSERT OR UPDATE OR DELETE ON department
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER department_criteria_seed AFTER INSERT ON department
FOR EACH ROW EXECUTE FUNCTION app.seed_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER position_criteria_lock BEFORE INSERT OR UPDATE OR DELETE ON position
FOR EACH ROW EXECUTE FUNCTION app.lock_label_criteria_write();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER position_criteria_check AFTER INSERT OR UPDATE OR DELETE ON position
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER position_criteria_seed AFTER INSERT ON position
FOR EACH ROW EXECUTE FUNCTION app.seed_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER cost_center_criteria_lock BEFORE INSERT OR UPDATE OR DELETE ON cost_center
FOR EACH ROW EXECUTE FUNCTION app.lock_label_criteria_write();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cost_center_criteria_check AFTER INSERT OR UPDATE OR DELETE ON cost_center
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER cost_center_criteria_seed AFTER INSERT ON cost_center
FOR EACH ROW EXECUTE FUNCTION app.seed_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER business_unit_criteria_lock BEFORE INSERT OR UPDATE OR DELETE ON business_unit
FOR EACH ROW EXECUTE FUNCTION app.lock_label_criteria_write();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER business_unit_criteria_check AFTER INSERT OR UPDATE OR DELETE ON business_unit
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER business_unit_criteria_seed AFTER INSERT ON business_unit
FOR EACH ROW EXECUTE FUNCTION app.seed_label_company_criteria();--> statement-breakpoint
CREATE TRIGGER label_company_assignment_criteria_lock BEFORE INSERT OR UPDATE OR DELETE ON label_company_assignment
FOR EACH ROW EXECUTE FUNCTION app.lock_label_criteria_write();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER label_company_assignment_criteria_check AFTER INSERT OR UPDATE OR DELETE ON label_company_assignment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_label_company_criteria();--> statement-breakpoint

--> statement-breakpoint
CREATE CONSTRAINT TRIGGER department_collision_reduce AFTER INSERT OR UPDATE OR DELETE ON department
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reduce_system_label_collision_baseline();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER position_collision_reduce AFTER INSERT OR UPDATE OR DELETE ON position
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reduce_system_label_collision_baseline();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cost_center_collision_reduce AFTER INSERT OR UPDATE OR DELETE ON cost_center
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reduce_system_label_collision_baseline();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER business_unit_collision_reduce AFTER INSERT OR UPDATE OR DELETE ON business_unit
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reduce_system_label_collision_baseline();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER label_company_assignment_collision_reduce AFTER INSERT OR UPDATE OR DELETE ON label_company_assignment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reduce_system_label_collision_baseline();--> statement-breakpoint

-- Reference writers participate in the same coordination order. A pinned MVCC writer cannot commit
-- a reference validated before another transaction removed its company from the saved Criteria.
CREATE FUNCTION app.lock_assignment_label_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM app.lock_system_label_criteria(NEW.tenant_id,'department');
  PERFORM app.lock_system_label_criteria(NEW.tenant_id,'position');
  PERFORM app.lock_system_label_criteria(NEW.tenant_id,'cost_center');
  PERFORM app.lock_system_label_criteria(NEW.tenant_id,'business_unit');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.check_assignment_label_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE a public.assignment;e public.employment;v_company uuid;v_kind text;v_id uuid;v_allowed boolean;
BEGIN
 SELECT * INTO a FROM public.assignment WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 IF NOT FOUND OR a.superseded_at IS NOT NULL THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.employment WHERE id=a.employment_id AND tenant_id=a.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Assignment employment must belong to the same tenant' USING ERRCODE='23514';END IF;
 v_company:=coalesce(a.company_id,e.company_id);
 IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=v_company AND tenant_id=a.tenant_id) THEN RAISE EXCEPTION 'Assignment company must belong to the same tenant' USING ERRCODE='23514';END IF;
 FOR v_kind,v_id IN SELECT * FROM (VALUES('department',a.department_id),('position',a.position_id),('cost_center',a.cost_center_id),('business_unit',a.business_unit_id)) refs(kind,id) LOOP
  IF v_id IS NULL THEN CONTINUE;END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I label WHERE label.id=$1 AND label.tenant_id=$2 AND
   (label.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment lca WHERE lca.label_id=label.id AND lca.tenant_id=label.tenant_id AND lca.label_kind=$3 AND lca.company_id=$4)))',v_kind)
   INTO v_allowed USING v_id,a.tenant_id,v_kind,v_company;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Assignment label Criteria do not include its recorded company' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_assignment_label_criteria(),app.check_assignment_label_criteria() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER assignment_label_criteria_lock BEFORE INSERT OR UPDATE OF department_id,position_id,cost_center_id,business_unit_id,company_id,employment_id,superseded_at ON assignment
FOR EACH ROW EXECUTE FUNCTION app.lock_assignment_label_criteria();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assignment_label_criteria_check AFTER INSERT OR UPDATE OF department_id,position_id,cost_center_id,business_unit_id,company_id,employment_id,superseded_at ON assignment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_assignment_label_criteria();

--> statement-breakpoint
CREATE FUNCTION app.lock_department_business_unit_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.business_unit_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.business_unit_id IS NOT NULL) THEN
  PERFORM app.lock_system_label_criteria(NEW.tenant_id,'business_unit');
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.check_department_business_unit_criteria() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE d public.department;
BEGIN
 SELECT * INTO d FROM public.department WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 IF NOT FOUND OR d.business_unit_id IS NULL THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.business_unit bu WHERE bu.id=d.business_unit_id AND bu.tenant_id=d.tenant_id AND
  (bu.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment lca WHERE lca.tenant_id=bu.tenant_id AND lca.label_kind='business_unit' AND lca.label_id=bu.id AND lca.company_id=d.company_id))) THEN
  RAISE EXCEPTION 'Department business-unit Criteria must include its creation company' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_department_business_unit_criteria(),app.check_department_business_unit_criteria() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER department_link_criteria_lock BEFORE INSERT OR UPDATE OF business_unit_id,company_id ON department
FOR EACH ROW EXECUTE FUNCTION app.lock_department_business_unit_criteria();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER department_link_criteria_check AFTER INSERT OR UPDATE OF business_unit_id,company_id ON department
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_department_business_unit_criteria();
