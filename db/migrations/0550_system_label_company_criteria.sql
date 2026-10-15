-- 0550: System Labels availability has one owner: Global OR an explicit company set.
-- Applied migration history and legacy company flags are untouched. Creation company remains provenance.
-- Reserve idx550/when1791900000030 centrally; journal union follows integration of prerequisites0541-0549.
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
  EXECUTE format('SELECT id,is_global,archived_at,lower(trim(%I)) AS code FROM public.%I WHERE tenant_id=$1 AND id=$2',v_key,v_kind)
    INTO v_label USING v_tenant,v_id;
  IF v_label.id IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.label_company_assignment WHERE tenant_id=v_tenant AND label_kind=v_kind AND label_id=v_id) THEN
      RAISE EXCEPTION 'Criteria must reference a label in the same tenant' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
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
    AND ($4 OR other.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment a
      JOIN public.label_company_assignment b ON b.tenant_id=a.tenant_id AND b.label_kind=a.label_kind AND b.company_id=a.company_id
      WHERE a.tenant_id=$1 AND a.label_kind=$5 AND a.label_id=$2 AND b.label_id=other.id)))',v_kind,v_key)
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
