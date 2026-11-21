-- Earlier periods share the one authorised case's employment and company. Contract's case permission owner uses
-- those same company/subject facts for every period; changing company never broadens this history to another company.
CREATE INDEX contract_case_shared_period_history ON public.contract_case(tenant_id,employment_id,company_id,created_at DESC,id);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_period_history(p_case uuid,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.contract_case;result jsonb;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract history is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO subject FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 WITH matching AS MATERIALIZED(
  SELECT c.id,c.number AS "caseNumber",coalesce(f.data->'period'->>'startOn',t.start_on::text) AS "startOn",coalesce(f.data->'period'->>'endOn',t.end_on::text) AS "endOn",
   nullif(f.data->'period'->>'number','')::integer AS "contractNumber",f.data->>'stage' AS stage,c.data->>'state' AS "legacyState",f.case_id IS NOT NULL AS shared,c.id=p_case AS "current",c.created_at
  FROM public.contract_case c JOIN public.contract_term t ON t.tenant_id=c.tenant_id AND t.id=c.term_id
  LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
  WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=subject.employment_id AND c.company_id=subject.company_id
 ), page AS(SELECT * FROM matching ORDER BY "startOn" DESC,created_at DESC,id LIMIT least(greatest(coalesce(p_limit,50),1),100) OFFSET least(greatest(coalesce(p_offset,0),0),100000))
 SELECT jsonb_build_object('total',(SELECT count(*)::integer FROM matching),'rows',coalesce((SELECT jsonb_agg(to_jsonb(p)-'created_at' ORDER BY "startOn" DESC,created_at DESC,id) FROM page p),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_history(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_history(uuid,integer,integer) TO ai_hr_app;
