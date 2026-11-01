-- Unapplied performance reservation. Fresh principal, scope and login results remain live.
-- Same predicate: fence matching identities before login checks; never scan unrelated logins.
-- Replace the exact native body through its own definition to retain every owner/ACL/config attribute.
DO $delegation_candidate_work$
DECLARE
 f_oid oid := 'app.delegation_line_covers(uuid,uuid,text,text)'::regprocedure;
 f_definition text;
 f_body text;
 f_attributes jsonb;
 old_predicate constant text := $old_predicate$EXISTS(SELECT 1 FROM public.app_user u WHERE u.person_id=delegate.person_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))$old_predicate$;
 new_predicate constant text := $new_predicate$EXISTS(WITH candidate_users AS MATERIALIZED (SELECT u.id FROM public.app_user u WHERE u.person_id=delegate.person_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL) SELECT 1 FROM candidate_users u WHERE NOT app.login_blocked(u.id))$new_predicate$;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc' INTO f_definition,f_body,f_attributes FROM pg_proc p WHERE p.oid=f_oid;
 IF encode(sha256(convert_to(f_body,'UTF8')),'hex') IS DISTINCT FROM 'd184c868d4486ad39a1f9183b17cde7a10e98b30957c1fb07df8fd00dcf87b94' OR
    length(f_body)-length(replace(f_body,old_predicate,''))<>length(old_predicate) THEN
  RAISE EXCEPTION 'Unexpected native delegation predicate; reviewed predecessor required';
 END IF;
 EXECUTE replace(f_definition,old_predicate,new_predicate);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=f_oid) IS DISTINCT FROM f_attributes OR
    (SELECT prosrc FROM pg_proc WHERE oid=f_oid) IS DISTINCT FROM replace(f_body,old_predicate,new_predicate) THEN
  RAISE EXCEPTION 'Native delegation attributes or predicate changed unexpectedly';
 END IF;
END;
$delegation_candidate_work$;
--> statement-breakpoint
-- Same regular visibility set, represented as a hashable membership subplan. Delegation policies
-- and every command/WITH CHECK/role attribute stay byte-identical; no authority result is cached.
DO $claim_membership_work$
DECLARE
 p_oid oid;
 p_attributes jsonb;
BEGIN
 SELECT p.oid,to_jsonb(p)-'polqual' INTO p_oid,p_attributes FROM pg_policy p
 WHERE p.polrelid='public.claim_request'::regclass AND p.polname='claim_request_rls';
 IF p_oid IS NULL OR (SELECT pg_get_expr(polqual,polrelid) FROM pg_policy WHERE oid=p_oid)
    IS DISTINCT FROM $expected_qual$((tenant_id = app.current_tenant_id()) AND (employment_id = ANY (( SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[])))$expected_qual$ THEN
  RAISE EXCEPTION 'Unexpected regular Claims policy; reviewed predecessor required';
 END IF;
 ALTER POLICY claim_request_rls ON public.claim_request USING (
  tenant_id=app.current_tenant_id() AND employment_id IN (SELECT unnest(app.visible_employment_ids()))
 );
 IF (SELECT to_jsonb(p)-'polqual' FROM pg_policy p WHERE p.oid=p_oid) IS DISTINCT FROM p_attributes THEN
  RAISE EXCEPTION 'Claims command, role or WITH CHECK attributes changed';
 END IF;
END;
$claim_membership_work$;
