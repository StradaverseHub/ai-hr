-- Probation letter signers (lane L of the Probation Confirmation build; L3, L4). Tag 5765 / idx 5165 / when 1793330005465.
--
-- app.probation_letter_signers(part): for one generated Probation letter the caller may open (app.probation_part_access,
-- the same check as app.probation_resolved_route), each step of the letter's route with the person holding it, that
-- person's current job title, and the routing or assignment group the step was routed to. The steps are read from the
-- route frozen at generation (re-frozen when the letter is generated again), the signing document's route and the
-- current resolution (a per-part replacement or a general Probation delegation moves a step to another person), so the
-- letter's unsigned signature blocks and its "Required signers" list name the person who will sign instead of
-- "[Signatory]" or a bare "Awaiting signature". Bounded to 50 rows; the name and title come only for people on the
-- route. A letter whose case is gone or not visible returns nothing.
-- No table, row, grant, policy or purpose-owned object changes; the new function is owner-owned and granted to ai_hr_app.
CREATE FUNCTION app.probation_letter_signers(p_part uuid) RETURNS TABLE(step_id text,holder_id uuid,name text,title text,label text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE v_tenant uuid:=app.current_tenant_id();p probation_part;v_company uuid;stored jsonb;resolved jsonb;v_day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF v_tenant IS NULL OR p_part IS NULL THEN RETURN;END IF;
 SELECT * INTO p FROM public.probation_part WHERE id=p_part AND tenant_id=v_tenant;
 IF NOT FOUND OR p.data->>'documentKind' IS DISTINCT FROM 'letter' THEN RETURN;END IF;
 IF app.probation_part_access(p.id) IS NOT TRUE THEN RETURN;END IF;
 SELECT c.company_id INTO v_company FROM public.probation_case c WHERE c.id=p.case_id AND c.tenant_id=v_tenant;
 SELECT d.data->'route' INTO stored FROM public.document_signing_document d WHERE d.tenant_id=v_tenant AND d.subject_type='probation' AND d.subject_id=p.id;
 resolved:=app.probation_resolve_route_unchecked(p.id);
 RETURN QUERY
 WITH steps AS (
  -- A holder id that is not a uuid is never cast (CASE, not a WHERE filter: SQL does not promise evaluation order).
  SELECT DISTINCT ON (x.s->>'id',hid) x.s->>'id' AS sid,
   CASE WHEN x.s->>'holderId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (x.s->>'holderId')::uuid END AS hid,
   x.s->>'role' AS srole,nullif(x.s->>'label','') AS slabel
  FROM (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(routes.r->'steps')='array' THEN routes.r->'steps' ELSE '[]'::jsonb END) AS s
        FROM (VALUES (CASE WHEN jsonb_typeof(p.data->'route')='object' THEN p.data->'route' END),(CASE WHEN jsonb_typeof(stored)='object' THEN stored END),(CASE WHEN jsonb_typeof(resolved)='object' THEN resolved END)) AS routes(r)) x
  WHERE jsonb_typeof(x.s)='object' AND x.s->>'id' IS NOT NULL
  ORDER BY x.s->>'id',hid LIMIT 50)
 SELECT st.sid::text,st.hid,person.full_name::text,
  (SELECT left(pos.title::text,200) FROM public.employment e
    JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=v_day AND (a.valid_to IS NULL OR a.valid_to>v_day)
    JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
   WHERE e.person_id=u.person_id AND e.tenant_id=v_tenant
    AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=v_day)
   ORDER BY (e.company_id=v_company) DESC,e.hired_on DESC,e.id LIMIT 1),
  coalesce(st.slabel,CASE WHEN st.srole ~ '^(routing:|group:)' THEN app.probation_form_approver_label(st.srole) END)::text
 FROM steps st
 LEFT JOIN public.app_user u ON u.id=st.hid AND u.tenant_id=v_tenant
 LEFT JOIN public.person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id;
END $$
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_letter_signers(uuid) FROM PUBLIC
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_letter_signers(uuid) TO ai_hr_app
