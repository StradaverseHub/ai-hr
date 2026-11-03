-- The public command ports only activate after the storage owner publishes
-- their exact actions. Private calculation and proof primitives stay private.
CREATE FUNCTION app.reward_save_entry(p_unit uuid,p_revision integer,p_entry uuid,p_recommendation jsonb,p_facts jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT FROM public.access_capability WHERE id='function.rewards.entries.edit' AND supported) THEN
  RAISE EXCEPTION 'Reward entry command unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM app.reward_entry_save_command(p_unit,p_revision,p_entry,p_recommendation,p_facts);
END;
$$;
CREATE FUNCTION app.reward_import_facts(p_unit uuid,p_revision integer,p_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT FROM public.access_capability WHERE id='function.rewards.facts.edit' AND supported) THEN
  RAISE EXCEPTION 'Reward facts command unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM app.reward_facts_import_command(p_unit,p_revision,p_rows);
END;
$$;
REVOKE ALL ON FUNCTION app.reward_save_entry(uuid,integer,uuid,jsonb,jsonb),app.reward_import_facts(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_save_entry(uuid,integer,uuid,jsonb,jsonb),app.reward_import_facts(uuid,integer,jsonb) TO ai_hr_app;
