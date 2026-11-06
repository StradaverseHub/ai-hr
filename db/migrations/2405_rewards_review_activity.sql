-- Give Group Rewards a bounded projection, not access to the generic event payload.
CREATE FUNCTION app.reward_review_activity(wanted_units uuid[], wanted_actor uuid, wanted_subject uuid)
RETURNS TABLE (id uuid, unit_id uuid, event_type text, occurred_at timestamptz, actor_name text,
  subject_id uuid, subject_name text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH principal AS (
   SELECT u.id,u.person_id FROM public.app_user u
   WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
     AND u.archived_at IS NULL AND app.principal_snapshot_current() AND NOT app.login_blocked(u.id)
 ), allowed_units AS (
   SELECT u.id,u.tenant_id FROM public.reward_unit u CROSS JOIN principal
   WHERE u.tenant_id=app.current_tenant_id() AND u.id=ANY(wanted_units) AND u.deleted_at IS NULL
     AND app.reward_access_scope(u.id) AND 'gr' IN (SELECT app.reward_roles(u.id))
     AND app.reward_capability(u.id,'review.view')
 )
 SELECT d.id, d.aggregate_id, d.event_type, d.occurred_at, actor.full_name,
        e.employment_id, left(e.source->>'name',250), left(d.payload->>'reason',1000)
 FROM allowed_units u
 JOIN public.domain_event d ON d.tenant_id=u.tenant_id AND d.aggregate_type='reward-unit' AND d.aggregate_id=u.id
 LEFT JOIN public.reward_entry e ON e.tenant_id=u.tenant_id AND e.unit_id=u.id AND e.id::text=d.payload->>'entryId'
 LEFT JOIN public.app_user a ON a.tenant_id=d.tenant_id AND a.id=d.actor_id
 LEFT JOIN public.person actor ON actor.id=a.person_id AND actor.tenant_id=d.tenant_id AND app.access_workforce_person(actor.id,'workforce.view')
 WHERE d.event_type IN (
   'reward-unit.access-changed','reward-unit.cancelled','reward-unit.facts-imported',
   'reward-unit.final-pool-changed','reward-unit.lump-updated','reward-unit.onehr-results-imported',
   'reward-unit.posted','reward-unit.recommendation-updated','reward-unit.routed',
   'reward-unit.senior-membership-updated','reward-unit.upload-source-refreshed')
   AND (wanted_actor IS NULL OR d.actor_id=wanted_actor)
   AND (wanted_subject IS NULL OR e.employment_id=wanted_subject)
   AND NOT EXISTS (SELECT 1 FROM principal p WHERE p.person_id::text=e.source->>'personId')
 ORDER BY d.occurred_at DESC,d.sequence DESC
 LIMIT 200
$$;
REVOKE ALL ON FUNCTION app.reward_review_activity(uuid[],uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_review_activity(uuid[],uuid,uuid) TO ai_hr_app;
