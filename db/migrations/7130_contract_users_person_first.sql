-- Contract preview at group scale (measured 23 November 2026). app.contract_users_for_employment ran the per-account
-- active-user and verified-person checks against every tenant account before matching the employee's Person, so one
-- decision preview made about 35,000 such calls when a tenant held 5,000 unrelated accounts and crossed the native 8 s
-- statement limit under load. Same signature, owner, ACL (CREATE OR REPLACE keeps the 0950 EXECUTE grant to ai_hr_app)
-- and result: the Person's accounts are matched first, then
-- the same checks run on those accounts only. Guarded by the exact live body that 6436 also pins.
DO $source_guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_users_for_employment(uuid)'::regprocedure) IS DISTINCT FROM '94fc17908f21402dba6de97c9a55175f50d66fa367893c5d0dc658b750409cc1' THEN RAISE EXCEPTION 'Expected the original 0950 Contract account source';END IF;
END;
$source_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_users_for_employment(wanted_employment uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH target AS MATERIALIZED(
  SELECT e.tenant_id,e.person_id FROM public.employment e
  WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (least(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR least(e.terminated_on,e.last_working_date,e.resignation_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ),
 -- Every account of that Person in this tenant, matched by plain columns before any per-account function runs.
 person_accounts AS MATERIALIZED(
  SELECT u.id FROM target t JOIN public.app_user u ON u.person_id=t.person_id AND u.tenant_id=t.tenant_id
 )
 SELECT a.id FROM person_accounts a
 WHERE app.contract_verified_human(a.id) AND 1=(SELECT count(*) FROM person_accounts x WHERE app.contract_active_user(x.id));
$$;
