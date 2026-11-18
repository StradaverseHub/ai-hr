-- Successful native manual admission resolves only the missing-workflow attention marker.
-- Keep the existing function OID, ACL, actor/source/CAS checks and idempotent early return.
DO $repair$
DECLARE definition text:=pg_get_functiondef('app.contract_shared_manual_start(uuid,integer,uuid,integer,uuid)'::regprocedure);
 before text:=$before$UPDATE public.contract_shared_case SET data=data||jsonb_build_object('revision',revision+1,'lastActivityAt',now()),revision=revision+1,updated_at=now() WHERE tenant_id=v_flow.tenant_id AND case_id=p_case;$before$;
 after text:=$after$UPDATE public.contract_shared_case SET data=data||jsonb_build_object('revision',revision+1,'lastActivityAt',now(),'flags',coalesce((SELECT jsonb_agg(flag) FROM jsonb_array_elements(data->'flags') flag WHERE flag#>>'{}'<>'no_workflow'),'[]'::jsonb)),revision=revision+1,updated_at=now() WHERE tenant_id=v_flow.tenant_id AND case_id=p_case;$after$;
BEGIN
 IF strpos(definition,before)=0 THEN RAISE EXCEPTION 'Unreviewed Contract manual admission preimage';END IF;
 EXECUTE replace(definition,before,after);
END $repair$;
