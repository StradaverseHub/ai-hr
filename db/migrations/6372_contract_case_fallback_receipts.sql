-- Case View sees retained fallback business facts; assigned IDs and frozen routing remain private.
-- Stable array ordinals provide bounded keyset history even when another event is appended.
CREATE FUNCTION app.contract_shared_fallback_page(p_case uuid,p_before integer DEFAULT 2147483647,p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entries jsonb;total integer;upper_ordinal integer;page_rows jsonb;group_names jsonb;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'This Contract case is unavailable' USING ERRCODE='42501';END IF;
 IF p_before IS NULL OR p_before<1 OR p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'Invalid fallback history page' USING ERRCODE='22023';END IF;
 SELECT coalesce(data->'fallbacks','[]'::jsonb) INTO entries FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 entries:=coalesce(entries,'[]'::jsonb);total:=jsonb_array_length(entries);upper_ordinal:=least(total,p_before-1);
 SELECT coalesce(jsonb_object_agg(g->>'id',g->>'name'),'{}'::jsonb) INTO group_names FROM public.lc_v9_config cfg CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'groups','[]'::jsonb)) g WHERE cfg.tenant_id=app.current_tenant_id();
 SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'at',entry->>'at','runId',entry->>'runId','stepId',entry->>'stepId',
  'workflowName',version.definition->>'name','stepNumber',step.number,'stepName',step.definition->>'name',
  'details',coalesce((SELECT jsonb_agg(jsonb_build_object('intended',left(coalesce(nullif(detail->>'meantFor',''),'Required workflow recipient'),500),
   'reason',left(coalesce(nullif(detail->>'reason',''),'No eligible person matched this document routing row.'),1000),
   'groupCurrentName',left(group_names->>(detail->>'fallbackGroupId'),200)) ORDER BY n)
   FROM jsonb_array_elements(coalesce(entry->'details','[]'::jsonb)) WITH ORDINALITY details(detail,n)),'[]'::jsonb)) ORDER BY ordinal DESC),'[]'::jsonb) INTO page_rows
 FROM (SELECT entries->(ordinal-1) AS entry,ordinal FROM generate_series(upper_ordinal,greatest(1,upper_ordinal-p_limit+1),-1) ordinal) item
 LEFT JOIN public.automation_run run ON run.tenant_id=app.current_tenant_id() AND run.id=(entry->>'runId')::uuid AND run.module='contract_staff' AND run.subject_id=p_case
 LEFT JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
 LEFT JOIN LATERAL(SELECT definition,number FROM jsonb_array_elements(coalesce(version.definition->'steps','[]'::jsonb)) WITH ORDINALITY spec(definition,number) WHERE definition->>'id'=entry->>'stepId' LIMIT 1) step ON true;
 RETURN jsonb_build_object('rows',page_rows,'total',total,'hasMore',upper_ordinal>p_limit,'nextBefore',CASE WHEN upper_ordinal>p_limit THEN upper_ordinal-p_limit+1 ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_fallback_page(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_fallback_page(uuid,integer,integer) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_workspace(uuid) RENAME TO contract_shared_workspace_before_fallback_receipts;
REVOKE ALL ON FUNCTION app.contract_shared_workspace_before_fallback_receipts(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_workspace(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=app.contract_shared_workspace_before_fallback_receipts(p_case);
 RETURN result||jsonb_build_object('fallbackPage',app.contract_shared_fallback_page(p_case));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_workspace(uuid) TO ai_hr_app;
