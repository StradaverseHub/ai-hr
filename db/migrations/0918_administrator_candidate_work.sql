-- Unapplied native write-path work only. Match administrator memberships before live eligibility.
-- No authorization result is cached; last-administrator recovery, tenant and company predicates stay live.
DO $administrator_candidate_work$
DECLARE
 f_oid oid := 'app.access_assert_administrator_for(uuid)'::regprocedure;
 f_definition text;
 f_body text;
 f_attributes jsonb;
 old_predicate constant text := $old_predicate$SELECT 1 FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
  WHERE g.tenant_id=p_tenant AND g.system_administrator AND g.retired_at IS NULL
   AND m.company_id IS NULL
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.system_admin',NULL)
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.configure',NULL)
   AND app.access_recovery_available(m.user_id)$old_predicate$;
 new_predicate constant text := $new_predicate$WITH candidate_administrators AS MATERIALIZED (
 SELECT m.user_id FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
 WHERE g.tenant_id=p_tenant AND g.system_administrator AND g.retired_at IS NULL AND m.company_id IS NULL
 ) SELECT 1 FROM candidate_administrators m
 WHERE app.access_allowed_for_tenant(p_tenant,m.user_id,'access.system_admin',NULL)
 AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.configure',NULL)
 AND app.access_recovery_available(m.user_id)$new_predicate$;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc' INTO f_definition,f_body,f_attributes FROM pg_proc p WHERE p.oid=f_oid;
 IF encode(sha256(convert_to(f_body,'UTF8')),'hex') IS DISTINCT FROM 'e1533050337da12c2e16d2d9e657bc6dcc29617648541e4c189067713839f07a' OR
    length(f_body)-length(replace(f_body,old_predicate,''))<>length(old_predicate) THEN
  RAISE EXCEPTION 'Unexpected native last-administrator predicate; reviewed predecessor required';
 END IF;
 EXECUTE replace(f_definition,old_predicate,new_predicate);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=f_oid) IS DISTINCT FROM f_attributes OR
    (SELECT prosrc FROM pg_proc WHERE oid=f_oid) IS DISTINCT FROM replace(f_body,old_predicate,new_predicate) THEN
  RAISE EXCEPTION 'Native administrator attributes or predicate changed unexpectedly';
 END IF;
END;
$administrator_candidate_work$;
