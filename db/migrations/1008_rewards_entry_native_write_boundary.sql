-- A published entry/facts action owns ordinary recommendation and fact edits.
-- Match its private admission to the exact OLD row, proposed values and root
-- transaction. Independent source refresh and Senior selection retain their
-- distinct write shapes and still run under the original native row policy.
CREATE FUNCTION app.reward_entry_published_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit; assessment jsonb; expected_facts jsonb;
 floor record; levels text[]:=ARRAY['standard','bg','ec']; current_rank integer; old_floor_rank integer; next_floor_rank integer;
 next_confidentiality text; floor_changed boolean; floor_reason jsonb;
BEGIN
 floor_changed:=ROW(NEW.source->'confidentialityFloor',NEW.source->'confidentialityReason')
  IS DISTINCT FROM ROW(OLD.source->'confidentialityFloor',OLD.source->'confidentialityReason');
 IF app.access_workforce_storage_owner()
  OR NOT floor_changed AND ROW(NEW.recommendation,NEW.facts) IS NOT DISTINCT FROM ROW(OLD.recommendation,OLD.facts)
  OR NOT EXISTS (SELECT FROM public.access_capability
   WHERE id IN ('function.rewards.entries.edit','function.rewards.facts.edit') AND supported)
 THEN RETURN NEW; END IF;

 IF EXISTS (
  SELECT FROM app.reward_entry_native_effect effect
  JOIN app.reward_entry_native_target target ON target.effect_id=effect.id AND target.entry_id=OLD.id
  WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=OLD.tenant_id
   AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id()
   AND effect.unit_id=OLD.unit_id AND effect.active AND NOT effect.completed
   AND target.before_row=to_jsonb(OLD)
   AND NEW.recommendation=target.admission->'recommendation' AND NEW.facts=target.admission->'facts'
   AND NEW.source=OLD.source
 ) THEN RETURN NEW; END IF;

 IF NEW.recommendation IS NOT DISTINCT FROM OLD.recommendation THEN
  SELECT source.* INTO unit FROM public.reward_unit source WHERE source.id=OLD.unit_id AND source.tenant_id=OLD.tenant_id;
  IF unit.status='draft' AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit.id))) THEN
   IF NEW.source=OLD.source AND NEW.facts-'seniorPlan'=OLD.facts-'seniorPlan'
    AND unit.kind='annual' AND jsonb_typeof(NEW.facts->'seniorPlan')='boolean' THEN RETURN NEW; END IF;

   IF unit.kind='annual' AND NEW.source->'onehrFactImport' IS DISTINCT FROM OLD.source->'onehrFactImport' THEN
    assessment:=app.reward_onehr_source(unit.id,OLD.employment_id,(unit.policy->>'year')::integer);
    IF assessment IS NOT NULL AND NEW.source->'onehr'=assessment
     AND NEW.source->'onehrFactImport'->'resultId'=assessment->'id'
     AND NEW.source->'onehrFactImport'->'digest'=assessment->'digest'
     AND NEW.source->'performanceReviewId'=assessment->'reviewId'
     AND NEW.source->'performanceRating'='null'::jsonb
     AND NEW.source-ARRAY['onehr','onehrFactImport','performanceReviewId','performanceRating']
      =OLD.source-ARRAY['onehr','onehrFactImport','performanceReviewId','performanceRating']
    THEN
     expected_facts:=OLD.facts||jsonb_build_object(
      'performance',coalesce(assessment->>'performance',OLD.facts->>'performance'),
      'talent',CASE WHEN assessment->>'pip'='true' THEN 'PIP'
       ELSE CASE assessment->>'talent' WHEN 'Super Star' THEN 'SSTAR' WHEN 'Star' THEN 'STAR'
        WHEN 'Solid Core' THEN 'SCORE' WHEN 'PIP/Improvement' THEN 'IMPRO' ELSE OLD.facts->>'talent' END END,
      'pipCase',coalesce(assessment->>'pip'='true',false) OR coalesce(OLD.facts->>'pipCase'='true',false),
      'reviewed',false);
     IF NEW.facts=expected_facts THEN RETURN NEW; END IF;
    END IF;
   END IF;
  END IF;
  IF unit.kind='annual' AND unit.status='draft' AND NEW.source IS DISTINCT FROM OLD.source
   AND NEW.facts-ARRAY['reviewed','confidentiality']=OLD.facts-ARRAY['reviewed','confidentiality']
   AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit.id))) OR (
    app.reward_admin(unit.company_id)
    AND NEW.source-ARRAY['confidentialityFloor','confidentialityReason']=OLD.source-ARRAY['confidentialityFloor','confidentialityReason']))
  THEN
   IF NOT floor_changed AND NEW.facts->'confidentiality'=OLD.facts->'confidentiality'
    AND NEW.facts->'reviewed'='false'::jsonb THEN RETURN NEW; END IF;

   SELECT * INTO floor FROM app.reward_confidentiality_floors(unit.id,ARRAY[OLD.employment_id],unit.snapshot_date);
   floor_reason:=CASE WHEN floor.level IS NULL THEN NULL
    ELSE jsonb_build_object('seat',floor.level,'managerEmploymentId',floor.manager_employment_id) END;
   IF NEW.source->>'confidentialityFloor' IS NOT DISTINCT FROM floor.level
    AND NEW.source->'confidentialityReason' IS NOT DISTINCT FROM floor_reason
   THEN
    current_rank:=array_position(levels,OLD.facts->>'confidentiality');
    old_floor_rank:=array_position(levels,coalesce(OLD.source->>'confidentialityFloor','standard'));
    next_floor_rank:=array_position(levels,coalesce(floor.level,'standard'));
    next_confidentiality:=levels[greatest(CASE WHEN current_rank>old_floor_rank THEN current_rank ELSE 1 END,next_floor_rank)];
    IF NEW.facts->>'confidentiality'=next_confidentiality
     AND (NEW.facts->'reviewed'='false'::jsonb OR (
      NEW.facts->>'confidentiality'=OLD.facts->>'confidentiality' AND NEW.facts->'reviewed'=OLD.facts->'reviewed'))
    THEN RETURN NEW; END IF;
   END IF;
  END IF;
 END IF;

 RAISE EXCEPTION 'Published Reward entry changes require their fixed command' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.reward_entry_published_write_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_reward_entry_published_write BEFORE UPDATE ON public.reward_entry
 FOR EACH ROW EXECUTE FUNCTION app.reward_entry_published_write_guard();
--> statement-breakpoint
CREATE FUNCTION app.rewards_entry_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH ports(signature,executable) AS (
  VALUES ('app.reward_save_entry(uuid,integer,uuid,jsonb,jsonb)',true),
   ('app.reward_import_facts(uuid,integer,jsonb)',true),
   ('app.reward_entry_save_command(uuid,integer,uuid,jsonb,jsonb)',false),
   ('app.reward_facts_import_command(uuid,integer,jsonb)',false),
   ('app.reward_entry_native(uuid,integer,text,jsonb)',false),
   ('app.reward_entry_prepare_source(uuid,integer,uuid,jsonb,jsonb,text)',false)
 ), guards(relation,trigger_name,handler,kind,deferred) AS (
  VALUES ('public.reward_entry','z_reward_entry_published_write','app.reward_entry_published_write_guard()'::regprocedure,19,false),
   ('public.reward_entry','reward_recommendation_action','app.reward_recommendation_action_guard()'::regprocedure,19,false),
   ('public.reward_entry','rewards_entry_native_capture','app.reward_entry_native_capture()'::regprocedure,17,false),
   ('public.reward_unit','rewards_entry_native_capture','app.reward_entry_native_capture()'::regprocedure,17,false),
   ('app.reward_entry_native_effect','rewards_entry_native_effect','app.reward_entry_native_validate()'::regprocedure,17,true)
 )
 SELECT NOT EXISTS (
  SELECT FROM ports e WHERE NOT EXISTS (
   SELECT FROM pg_proc p JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE p.oid=to_regprocedure(e.signature) AND p.proowner=c.relowner AND p.prosecdef
    AND has_function_privilege('ai_hr_app',p.oid,'EXECUTE')=e.executable
  )
 ) AND NOT EXISTS (
  SELECT FROM guards e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE c.oid=to_regclass(e.relation) AND c.relrowsecurity
    AND t.tgname=e.trigger_name AND t.tgfoid=e.handler AND t.tgtype=e.kind
    AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.rewards_entry_bindings_complete() FROM PUBLIC,ai_hr_app;
