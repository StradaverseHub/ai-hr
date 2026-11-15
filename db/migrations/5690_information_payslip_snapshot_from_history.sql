-- Board 4604dccc revision 3 (docs/MIGRATION-ALLOCATION.md): 5690_information_payslip_snapshot_from_history, idx 5090, when 1793330005390.
-- Supersedes the ADR-0163 refusal "Legacy payslips with intervening master changes and no independently reconciled
-- original snapshot refuse correction" (ADR 2026-11-16 payslip snapshots from recorded history).
--
-- Before an Information-Only Correction (or a movement correction behind closed payroll) changes anything, every
-- payslip of the employment that has no display snapshot gets one. Payroll rows are never read for amounts and never
-- written. Each snapshot is taken as at the payslip's batch time T = coalesce(closed_at, created_at):
--  * Group Join Date, Join Date and Job Grade: the "before" value of the earliest recorded change after T
--    (employment.info.updated / employment.grade.changed / employment.information.corrected); none means unchanged.
--  * Employment Type, Business Unit, Department, Position: the assignment row that was the live record at T
--    (created by T, not superseded by T, the latest started by T's date); none found means the record as displayed today.
--  * Everything else is the metadata the document shows today (it has no recorded history).
-- document_metadata.snapshotBasis lists which fields were reconstructed and which were kept as displayed.
-- Existing snapshots are never changed. The staged-row predicate from 5055 is kept on every payslip read.
-- information_payroll_ready no longer depends on payslip history: it answers only who may correct.
CREATE OR REPLACE FUNCTION app.preserve_information_payroll(p_employment uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE e public.employment%ROWTYPE; a public.assignment%ROWTYPE; n integer; assignment_count integer;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL
 OR NOT app.is_admin_for(e.company_id) OR NOT app.access_workforce_employment(e.id,'workforce.maintain') THEN
  RAISE EXCEPTION 'Information correction unavailable' USING ERRCODE='42501';
 END IF;
 -- An ended employment legitimately has no open assignment. Two open records is a data fault, not payroll history.
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF assignment_count>1 OR (assignment_count=0 AND e.terminated_on IS NULL) THEN
  RAISE EXCEPTION 'Historical assignment evidence requires reconciliation';
 END IF;
 SELECT * INTO a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id AND (p.tenant_id<>e.tenant_id OR b.tenant_id<>e.tenant_id OR NOT app.is_admin_for(b.company_id))) THEN
  RAISE EXCEPTION 'Historical payroll company permission is required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
 SELECT s.id,e.tenant_id,e.id,s.company_id,
  CASE WHEN gr.found THEN hg.name ELSE g.name END,
  coalesce(ha.employment_type::text,a.employment_type::text),
  CASE WHEN ho.found THEN ho.value::date ELSE e.hired_on END,
  CASE WHEN jo.found THEN jo.value::date ELSE e.join_date END,
  app.information_document_metadata(s.id)
   ||CASE WHEN ha.id IS NOT NULL THEN jsonb_build_object('businessUnit',hbu.name,'department',hd.name,'position',hpos.title,'employmentType',ha.employment_type) ELSE '{}'::jsonb END
   ||CASE WHEN gr.found THEN jsonb_build_object('jobGrade',hg.name) ELSE '{}'::jsonb END
   ||jsonb_build_object('snapshotBasis',jsonb_build_object(
     'at',s.t,
     'reconstructed',to_jsonb(array_remove(ARRAY[CASE WHEN ho.found THEN 'hiredOn' END,CASE WHEN jo.found THEN 'joinDate' END,CASE WHEN gr.found THEN 'jobGrade' END,
       CASE WHEN ha.id IS NOT NULL THEN 'employmentType' END,CASE WHEN ha.id IS NOT NULL THEN 'businessUnit' END,CASE WHEN ha.id IS NOT NULL THEN 'department' END,CASE WHEN ha.id IS NOT NULL THEN 'position' END],NULL)),
     'unchangedSince',to_jsonb(array_remove(ARRAY[CASE WHEN NOT ho.found THEN 'hiredOn' END,CASE WHEN NOT jo.found THEN 'joinDate' END,CASE WHEN NOT gr.found THEN 'jobGrade' END],NULL)),
     'asDisplayed',to_jsonb(CASE WHEN ha.id IS NULL THEN ARRAY['employmentType','businessUnit','department','position'] ELSE ARRAY[]::text[] END))),
  app.current_user_id()
 FROM (SELECT p.id,b.company_id,coalesce(b.closed_at,b.created_at) AS t FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
   WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id
   AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot f WHERE f.payslip_id=p.id)) s
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 -- Job Grade before the first recorded grade change after T.
 LEFT JOIN LATERAL (SELECT true AS found,CASE WHEN ev.event_type='employment.grade.changed' THEN ev.payload->>'before' ELSE ev.payload->'before'->>'gradeId' END AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND (ev.event_type='employment.grade.changed' OR (ev.event_type='employment.information.corrected' AND ev.payload->'fields' ? 'gradeId'))
   ORDER BY ev.sequence LIMIT 1) gr0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(gr0.found,false) AS found,gr0.value) gr ON true
 LEFT JOIN public.job_grade hg ON gr.found AND hg.id=gr.value::uuid AND hg.tenant_id=e.tenant_id
 -- Group Join Date before the first recorded change of it after T.
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'hiredOn' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'hiredOn'
   AND ev.payload->'before'->>'hiredOn' IS NOT NULL
   ORDER BY ev.sequence LIMIT 1) ho0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(ho0.found,false) AS found,ho0.value) ho ON true
 -- Join Date before the first recorded change of it after T (a null Join Date is a recorded value).
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'joinDate' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'joinDate'
   AND ev.payload->'before' ? 'joinDate'
   ORDER BY ev.sequence LIMIT 1) jo0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(jo0.found,false) AS found,jo0.value) jo ON true
 -- The assignment that was the live record at T: of the rows that existed then (created by T, not yet superseded),
 -- the latest that had started by T's date. valid_to is not read: a later version closes it in place.
 LEFT JOIN LATERAL (SELECT x.id,x.employment_type,x.business_unit_id,x.department_id,x.position_id FROM public.assignment x
   WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.created_at<=s.t AND (x.superseded_at IS NULL OR x.superseded_at>s.t)
   AND x.valid_from<=(s.t AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   ORDER BY x.valid_from DESC,x.created_at DESC LIMIT 1) ha ON true
 LEFT JOIN public.business_unit hbu ON hbu.id=ha.business_unit_id
 LEFT JOIN public.department hd ON hd.id=ha.department_id
 LEFT JOIN public.position hpos ON hpos.id=ha.position_id
 ON CONFLICT(payslip_id) DO NOTHING;
 SELECT count(*) INTO n FROM public.payslip WHERE app.payroll_history_row_visible('payslip',id) AND employment_id=e.id;
 IF n<>(SELECT count(*) FROM public.information_payslip_snapshot WHERE employment_id=e.id) THEN
  RAISE EXCEPTION 'Historical metadata coverage is incomplete';
 END IF;
 RETURN n;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.preserve_information_payroll(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.preserve_information_payroll(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.information_payroll_ready(p_employment uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin_for(e.company_id)
 AND app.access_workforce_employment(e.id,'workforce.maintain'));
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.information_payroll_ready(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.information_payroll_ready(uuid) TO ai_hr_app;
