-- 4de410ed / 356ae8c1: the reviewer dashboard groups preparing reviews by their Group structure
-- Business unit and states the review year. Same audience, withholding and loop as
-- app.reward_preparation_notices() (3701, left unchanged); it adds identifiers and the cycle year only.
CREATE FUNCTION app.reward_preparation_notices_v2() RETURNS TABLE("unitId" uuid,"companyId" uuid,company text,"businessUnitId" uuid,unit text,cycle text,year integer,"expectedRelease" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE candidate record; notice jsonb;
BEGIN
 FOR candidate IN SELECT u.id,u.company_id,c.legal_name,u.business_unit_id,coalesce(nullif(trim(b.label),''),b.code) AS unit_label,cy.name AS cycle_name,cy.year AS cycle_year
  FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id
  JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
  JOIN public.reward_cycle cy ON cy.id=u.cycle_id AND cy.tenant_id=u.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND u.kind='annual' AND u.preparation_required
  ORDER BY c.legal_name,unit_label,cy.name,u.id
 LOOP
  notice:=app.reward_preparation_view(candidate.id);
  IF notice IS NOT NULL AND NOT (notice->>'released')::boolean AND NOT (notice->>'setupVisible')::boolean THEN
   "unitId":=candidate.id;"companyId":=candidate.company_id;company:=candidate.legal_name;"businessUnitId":=candidate.business_unit_id;
   unit:=candidate.unit_label;cycle:=candidate.cycle_name;year:=candidate.cycle_year;"expectedRelease":=notice->>'expectedRelease';RETURN NEXT;
  END IF;
 END LOOP;
END $$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_preparation_notices()'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_preparation_notices_v2() OWNER TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_notices_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_preparation_notices_v2() TO ai_hr_app;
