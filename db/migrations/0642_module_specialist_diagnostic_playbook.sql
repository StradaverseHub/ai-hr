-- AI specialist diagnostic playbook (N1). Filename 0642 per docs/MIGRATION-RESERVATIONS.md (AI filename map).
-- Journaled after the forwarded 0627 it depends on. Shadow/installed-baseline validation is still required.
-- One atomic persistent change: replace only the exact old closed configuration CHECK.
-- The temporary oracle compares complete PostgreSQL-parsed expressions, not guessed deparser text.
DO $migration$
DECLARE expected_expression text; actual_name text; actual_expression text; targets integer;
BEGIN
 IF to_regclass('public.ai_agent_candidate') IS NULL OR to_regclass('pg_temp.aihr_0642_constraint_oracle') IS NOT NULL THEN
  RAISE EXCEPTION 'Specialist diagnostic constraint prerequisites unavailable';
 END IF;
 CREATE TEMP TABLE aihr_0642_constraint_oracle (LIKE public.ai_agent_candidate EXCLUDING CONSTRAINTS) ON COMMIT DROP;
 ALTER TABLE pg_temp.aihr_0642_constraint_oracle ADD CONSTRAINT aihr_0642_expected CHECK ((kind IN('typed_route_priority_v1','read_plan_prompt_v1') AND module_code='assistant') OR
  (kind='canonical_specialist_v1' AND module_code IN('employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing')
   AND configuration=jsonb_build_object('kind','canonical_specialist_v1','module',module_code,'playbook','canonical_domain_v1')));
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT expected_expression FROM pg_constraint
  WHERE conrelid='pg_temp.aihr_0642_constraint_oracle'::regclass AND conname='aihr_0642_expected' AND contype='c';
 SELECT count(*),min(conname),min(pg_get_expr(conbin,conrelid)) INTO targets,actual_name,actual_expression
  FROM pg_constraint WHERE conrelid='public.ai_agent_candidate'::regclass AND contype='c'
  AND pg_get_expr(conbin,conrelid)=expected_expression;
 IF targets<>1 OR actual_name IS NULL OR actual_expression IS DISTINCT FROM expected_expression THEN
  RAISE EXCEPTION 'Specialist diagnostic constraint source changed';
 END IF;
 DROP TABLE pg_temp.aihr_0642_constraint_oracle;
 EXECUTE format('ALTER TABLE public.ai_agent_candidate DROP CONSTRAINT %I',actual_name);
 EXECUTE format('ALTER TABLE public.ai_agent_candidate ADD CONSTRAINT %I CHECK ((kind IN(''typed_route_priority_v1'',''read_plan_prompt_v1'') AND module_code=''assistant'') OR
  (kind=''canonical_specialist_v1'' AND module_code IN(''employees'',''org'',''leave'',''ess'',''approvals'',''knowledge_base'',''payroll'',''attendance'',''claims'',''performance'',''rewards'',''lifecycle'',''toil'',''multi_cycle_payroll'',''typed_pay_components'',''country-my'',''notifications'',''system_explorer'',''assistant'',''system_testing'')
   AND (configuration=jsonb_build_object(''kind'',''canonical_specialist_v1'',''module'',module_code,''playbook'',''canonical_domain_v1'')
    OR configuration=jsonb_build_object(''kind'',''canonical_specialist_v1'',''module'',module_code,''playbook'',''canonical_followup_v1''))))',actual_name);
END;
$migration$;
