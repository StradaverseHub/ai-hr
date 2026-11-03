-- The APP role must never read the capability catalogue. Expose only the
-- installed-state bit for the fixed Rewards command ports.
CREATE FUNCTION app.reward_command_port_installed(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_capability IN (
  'function.rewards.entries.edit','function.rewards.facts.edit',
  'function.rewards.decisions.submit.execute','function.rewards.decisions.approve.approve',
  'function.rewards.decisions.return.execute','function.rewards.decisions.reject.execute',
  'function.rewards.decisions.withdraw.execute','function.rewards.cancellation.assigned.execute',
  'function.rewards.posting.execute'
 ) AND EXISTS (SELECT FROM public.access_capability WHERE id=p_capability AND supported);
$$;
REVOKE ALL ON FUNCTION app.reward_command_port_installed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_command_port_installed(text) TO ai_hr_app;
