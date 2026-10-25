-- Preserve the applied0597 bytes. Qualify PL/pgSQL variable identities so deferred
-- Criteria checks can resolve ordinary cost-center and company-assignment writes.
CREATE OR REPLACE FUNCTION app.check_cost_allocation_criteria() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_tenant_id uuid;v_cost_center_id uuid;
BEGIN
 v_tenant_id:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 IF TG_TABLE_NAME='cost_center' THEN v_cost_center_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE IF (CASE WHEN TG_OP='DELETE' THEN OLD.label_kind ELSE NEW.label_kind END)<>'cost_center' THEN RETURN NULL;END IF;v_cost_center_id:=CASE WHEN TG_OP='DELETE' THEN OLD.label_id ELSE NEW.label_id END;END IF;
 IF EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r JOIN public.employment_cost_allocation_set s ON s.id=r.set_id AND s.tenant_id=r.tenant_id
  WHERE r.tenant_id=v_tenant_id AND r.cost_center_id=v_cost_center_id AND s.superseded_at IS NULL AND(s.valid_to IS NULL OR s.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND NOT EXISTS(SELECT 1 FROM public.cost_center c WHERE c.id=v_cost_center_id AND c.tenant_id=v_tenant_id AND(c.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment l WHERE l.tenant_id=v_tenant_id AND l.label_kind='cost_center' AND l.label_id=v_cost_center_id AND l.company_id=s.company_id))))
  THEN RAISE EXCEPTION 'A company still uses this cost center allocation' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_cost_allocation_criteria() FROM PUBLIC;
