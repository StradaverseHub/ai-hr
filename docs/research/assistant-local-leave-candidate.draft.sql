-- Unallocated. Apply to a disposable database as the migration owner for rehearsal.
-- The release coordinator must allocate a journal slot after surveying both installed ledgers.
DO $migration$
DECLARE
  expected text;
  actual_name text;
  targets integer;
BEGIN
  CREATE TEMP TABLE aihr_local_leave_constraint_oracle
    (LIKE public.ai_agent_candidate EXCLUDING CONSTRAINTS) ON COMMIT DROP;
  ALTER TABLE pg_temp.aihr_local_leave_constraint_oracle ADD CONSTRAINT expected_configuration
    CHECK ((kind IN('typed_route_priority_v1','read_plan_prompt_v1') AND module_code='assistant') OR
 (kind='assistant_answer_prompt_v1' AND module_code='assistant' AND (configuration=jsonb_build_object('kind','assistant_answer_prompt_v1','variant','baseline_v1') OR configuration=jsonb_build_object('kind','assistant_answer_prompt_v1','variant','focused_v1'))) OR
 (kind='canonical_specialist_v1' AND module_code IN('employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing') AND
 (configuration=jsonb_build_object('kind','canonical_specialist_v1','module',module_code,'playbook','canonical_domain_v1') OR configuration=jsonb_build_object('kind','canonical_specialist_v1','module',module_code,'playbook','canonical_followup_v1'))));
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT expected
    FROM pg_constraint
    WHERE conrelid='pg_temp.aihr_local_leave_constraint_oracle'::regclass
      AND conname='expected_configuration';
  SELECT count(*),min(conname) INTO targets,actual_name
    FROM pg_constraint
    WHERE conrelid='public.ai_agent_candidate'::regclass AND contype='c'
      AND pg_get_expr(conbin,conrelid)=expected;
  IF targets<>1 THEN
    RAISE EXCEPTION 'Assistant conversation candidate configuration prerequisite changed';
  END IF;
  EXECUTE format('ALTER TABLE public.ai_agent_candidate DROP CONSTRAINT %I',actual_name);
  EXECUTE format($definition$
    ALTER TABLE public.ai_agent_candidate ADD CONSTRAINT %I CHECK (
      (%s) OR (
        kind='assistant_answer_prompt_v1' AND module_code='assistant' AND
        configuration=jsonb_build_object('kind','assistant_answer_prompt_v1','variant','local_leave_count_v1')
      )
    )
  $definition$,actual_name,expected);
  DROP TABLE pg_temp.aihr_local_leave_constraint_oracle;
END $migration$;
