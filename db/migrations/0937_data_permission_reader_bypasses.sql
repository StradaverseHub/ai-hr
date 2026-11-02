-- Assigned administrative data scope on role-bypassing readers and asynchronous delivery.
-- Depends on0936's code-owned matches/matches_for.0938 joins value writers to the same
-- access-configuration tenant interval. Existing self and actual approval responsibility remain.
-- No installation authority; coordinated provisional source claim0937/idx759/when1793330000337.
-- Existing owner: db/migrations/0698_information_only_corrections.sql:132
CREATE OR REPLACE FUNCTION app.information_payslip_document(p_payslip uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',f.document_metadata||jsonb_build_object('jobGrade',f.grade,'employmentType',f.employment_type),
 'batch',to_jsonb(b),'payslip',to_jsonb(p)||jsonb_build_object(
 'basic_salary',p.basic_salary::text,'allowance',p.allowance::text,'overtime_pay',p.overtime_pay::text,'bonus',p.bonus::text,
 'gross_pay',p.gross_pay::text,'other_deductions',p.other_deductions::text,'total_deductions',p.total_deductions::text,
 'net_pay',p.net_pay::text,'employer_cost',p.employer_cost::text,'days_worked',p.days_worked::text))
 FROM public.information_payslip_snapshot f JOIN public.payslip p ON p.id=f.payslip_id AND p.employment_id=f.employment_id AND p.tenant_id=f.tenant_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
 JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=f.tenant_id
 WHERE p.id=p_payslip AND f.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (app.payroll_history_effective(p.id) OR app.payroll_history_self_issued(p.id))
 AND ((app.can_admin_payroll_for(b.company_id) AND app.data_permission_matches(e.id)) OR (app.is_self_person(e.person_id) AND b.status='closed' AND (b.released_at IS NULL OR b.released_at<=now())));
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0698_information_only_corrections.sql:173
CREATE OR REPLACE FUNCTION app.information_report_records(p_kind text,p_company uuid,p_period text) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind NOT IN ('employment','person','employee_statutory_my','payslip','assignment','tp1_relief','ea_override')
 OR p_period !~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$' OR NOT app.principal_snapshot_current() THEN RETURN; END IF;
 RETURN QUERY
 SELECT item FROM public.information_payslip_snapshot f
 JOIN public.payslip sl ON sl.id=f.payslip_id AND sl.employment_id=f.employment_id AND sl.tenant_id=f.tenant_id
 JOIN public.payroll_batch b ON b.id=sl.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
 JOIN public.employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN public.employee_statutory_my st ON st.person_id=e.person_id AND st.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT ev.payload->'before' AS value FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>CASE WHEN length(p_period)=4 THEN p_period||'-12-31' ELSE p_period||'-01' END ORDER BY ev.sequence LIMIT 1) prior ON true
 CROSS JOIN LATERAL jsonb_array_elements(CASE p_kind
 WHEN 'employment' THEN jsonb_build_array(jsonb_build_object('id',e.id,'tenant_id',e.tenant_id,'person_id',e.person_id,
 'company_id',coalesce(prior.value->>'companyId',e.company_id::text),'employee_code',f.document_metadata->>'employeeCode',
 'hired_on',coalesce(prior.value->>'hiredOn',e.hired_on::text),'join_date',CASE WHEN prior.value IS NOT NULL THEN prior.value->>'joinDate' ELSE e.join_date::text END,
 'terminated_on',e.terminated_on,'termination_type',e.termination_type))
 WHEN 'person' THEN jsonb_build_array(jsonb_build_object('id',p.id,'tenant_id',p.tenant_id,'full_name',f.document_metadata->>'employeeName','nationality',p.nationality))
 WHEN 'employee_statutory_my' THEN jsonb_build_array(jsonb_build_object('person_id',st.person_id,'tenant_id',st.tenant_id,'ic_number',st.ic_number,'passport_number',st.passport_number,
 'tax_number',st.tax_number,'epf_number',st.epf_number,'socso_number',st.socso_number,'tax_category',st.tax_category,'num_children',st.num_children,'child_relief_mode',st.child_relief_mode,'child_relief_table',st.child_relief_table,
 'epf_citizenship',st.epf_citizenship,'old_ic_number',st.old_ic_number,'passport_issuing_country_code',st.passport_issuing_country_code))
 WHEN 'payslip' THEN jsonb_build_array(app.information_payslip_document(sl.id)->'payslip')
 WHEN 'assignment' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'tenant_id',a.tenant_id,'employment_id',a.employment_id,'position_id',a.position_id,'valid_from',a.valid_from,'valid_to',a.valid_to,'superseded_at',a.superseded_at) ORDER BY a.valid_from,a.id)
 FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.valid_from<=CASE WHEN length(p_period)=4 THEN (p_period||'-12-31')::date ELSE (p_period||'-01')::date END),'[]'::jsonb)
 WHEN 'tp1_relief' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'person_id',r.person_id,'deduction_month',r.deduction_month,'approved_month',r.approved_month,'created_at',r.created_at,'tp1_amount',r.tp1_amount::text,'categories',r.categories,'assessment_year',r.assessment_year,'status',r.status) ORDER BY r.created_at,r.id)
 FROM public.tp1_relief r WHERE r.tenant_id=e.tenant_id AND r.person_id=e.person_id AND r.assessment_year=left(p_period,4)::integer AND r.status='approved'),'[]'::jsonb)
 WHEN 'ea_override' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'employment_id',r.employment_id,'year',r.year,'field',r.field,'amount',r.amount::text,'reason',r.reason) ORDER BY r.field)
 FROM public.ea_override r WHERE r.tenant_id=e.tenant_id AND r.employment_id=e.id AND r.year=left(p_period,4)),'[]'::jsonb)
 ELSE '[]'::jsonb END) item
 WHERE f.tenant_id=app.current_tenant_id() AND (p_company IS NULL OR b.company_id=p_company)
 AND left(b.pay_period,length(p_period))=p_period AND app.can_admin_payroll_for(b.company_id) AND app.data_permission_matches(e.id)
 AND app.information_payslip_document(sl.id) IS NOT NULL
 ORDER BY b.pay_period DESC,b.run_seq DESC,sl.id;
END $$;
--> statement-breakpoint
-- Existing owner: db/migrations/0698_information_only_corrections.sql:213
CREATE OR REPLACE FUNCTION app.ea_signatory(p_employment_id uuid, p_company_id uuid, p_year text)
RETURNS TABLE(officer_name text, officer_position text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT sp.full_name, title.title
  FROM public.employment subject
  JOIN public.company co ON co.id = p_company_id AND co.tenant_id = subject.tenant_id
  JOIN public.company_statutory_authority auth
    ON auth.company_id = co.id AND auth.tenant_id = co.tenant_id AND auth.authority = 'lhdn'
  JOIN public.person sp ON sp.id = auth.signatory_person_id AND sp.tenant_id = co.tenant_id
  LEFT JOIN LATERAL (
    SELECT pos.title
    FROM public.employment se
    JOIN public.assignment a ON a.employment_id = se.id AND a.tenant_id = se.tenant_id
    JOIN public.position pos ON pos.id = a.position_id AND pos.tenant_id = se.tenant_id
    WHERE se.person_id = sp.id AND se.company_id = co.id AND se.tenant_id = co.tenant_id
      AND se.hired_on <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (se.terminated_on IS NULL OR se.terminated_on >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND a.superseded_at IS NULL
      AND a.valid_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND COALESCE(a.company_id, se.company_id) = co.id
    ORDER BY a.valid_from DESC, se.hired_on DESC, a.id
    LIMIT 1
  ) title ON true
  WHERE subject.id = p_employment_id AND subject.tenant_id = app.current_tenant_id()
    AND p_year ~ '^[0-9]{4}$'
    AND (
      EXISTS (SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = subject.tenant_id AND u.person_id = subject.person_id)
      OR (app.can_admin_payroll_for(co.id) AND app.data_permission_matches(subject.id) AND (app.can_admin_payroll_for(subject.company_id)
        OR EXISTS(SELECT 1 FROM public.information_payslip_snapshot f
          JOIN public.payslip sl ON sl.id=f.payslip_id AND sl.employment_id=f.employment_id AND sl.tenant_id=f.tenant_id
          JOIN public.payroll_batch b ON b.id=sl.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
          WHERE f.employment_id=subject.id AND f.tenant_id=subject.tenant_id AND b.company_id=co.id
          AND b.pay_period LIKE p_year||'-%' AND app.information_payslip_document(sl.id) IS NOT NULL)))
    )
    AND (subject.company_id = co.id OR EXISTS (
      SELECT 1 FROM public.payslip ps
      JOIN public.payroll_batch pb ON pb.id = ps.batch_id AND pb.tenant_id = ps.tenant_id
      WHERE app.payroll_history_effective(ps.id) AND ps.employment_id = subject.id AND ps.tenant_id = subject.tenant_id
        AND pb.company_id = co.id AND pb.pay_period LIKE p_year || '-%'
    ));
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0688_payroll_txn_import_attempts.sql:45
CREATE OR REPLACE FUNCTION app.payroll_txn_import_lock_bindings(p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a public.payroll_txn_import_attempt;bound jsonb;field text;uuid_pattern text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.payroll_txn_import_attempt WHERE id=p_attempt AND tenant_id=app.current_tenant_id();
 IF a.id IS NULL OR jsonb_array_length(a.company_ids)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.company_ids) c WHERE NOT app.is_admin_for(c::uuid)) THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 -- Stored JSON is immutable, not trusted: runtime INSERT remains subject to direct-input abuse.
 FOR bound IN SELECT value FROM jsonb_each(a.bindings) LOOP
  IF jsonb_typeof(bound)<>'object' OR NOT (bound ?& ARRAY['employmentId','companyId','componentId','intendedCycleId','targetBatchId','payPeriod']) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  FOREACH field IN ARRAY ARRAY['employmentId','companyId','componentId'] LOOP
   IF (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['intendedCycleId','targetBatchId'] LOOP
   IF bound->field<>'null'::jsonb AND (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF NOT app.data_permission_matches((bound->>'employmentId')::uuid) THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501';END IF;
  IF NOT (a.company_ids ? ((bound->>'companyId')::uuid)::text) THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 -- Filter by actual company before each role-bypassing lock, then verify relationships under locks.
 PERFORM b.id FROM public.payroll_batch b WHERE b.tenant_id=a.tenant_id AND a.company_ids ? b.company_id::text AND b.id IN
  (SELECT (value->>'targetBatchId')::uuid FROM jsonb_each(a.bindings)) ORDER BY b.id FOR UPDATE;
 PERFORM e.id FROM public.employment e WHERE e.tenant_id=a.tenant_id AND a.company_ids ? e.company_id::text AND e.id IN
  (SELECT (value->>'employmentId')::uuid FROM jsonb_each(a.bindings)) ORDER BY e.id FOR SHARE;
 PERFORM c.id FROM public.pay_component c WHERE c.tenant_id=a.tenant_id AND c.id IN
  (SELECT (value->>'componentId')::uuid FROM jsonb_each(a.bindings)) ORDER BY c.id FOR SHARE;
 PERFORM c.id FROM public.payroll_cycle c WHERE c.tenant_id=a.tenant_id AND a.company_ids ? c.company_id::text AND c.id IN
  (SELECT (value->>'intendedCycleId')::uuid FROM jsonb_each(a.bindings)) ORDER BY c.id FOR SHARE;
 FOR bound IN SELECT value FROM jsonb_each(a.bindings) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=(bound->>'companyId')::uuid AND c.tenant_id=a.tenant_id)
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=(bound->>'employmentId')::uuid AND e.tenant_id=a.tenant_id AND e.company_id=(bound->>'companyId')::uuid)
   -- Pay components are tenant-wide catalogue rows, with no company ownership column.
   OR NOT EXISTS(SELECT 1 FROM public.pay_component c WHERE c.id=(bound->>'componentId')::uuid AND c.tenant_id=a.tenant_id)
   OR (bound->>'intendedCycleId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_cycle c WHERE c.id=(bound->>'intendedCycleId')::uuid AND c.tenant_id=a.tenant_id AND c.company_id=(bound->>'companyId')::uuid))
   OR (bound->>'targetBatchId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch r WHERE r.id=(bound->>'targetBatchId')::uuid AND r.tenant_id=a.tenant_id AND r.company_id=(bound->>'companyId')::uuid AND r.pay_period=bound->>'payPeriod')) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- Existing owner: db/migrations/0631_payroll_close_source.sql:107
CREATE OR REPLACE FUNCTION app.payroll_close_source_people(p_batch uuid,p_prior uuid,p_coverage uuid[]) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;ids uuid[];sources uuid[];
BEGIN
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE
  OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_coverage IS NULL OR array_position(p_coverage,NULL) IS NOT NULL OR
  coalesce((SELECT array_agg(DISTINCT q ORDER BY q) FROM unnest(p_coverage) q),'{}'::uuid[]) IS DISTINCT FROM p_coverage
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch prior
  WHERE prior.id=p_prior AND prior.tenant_id=b.tenant_id AND prior.company_id=b.company_id AND prior.pay_period<b.pay_period
   AND NOT EXISTS(SELECT 1 FROM public.payroll_batch newer WHERE newer.company_id=b.company_id AND newer.pay_period<b.pay_period AND newer.pay_period>prior.pay_period))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_coverage) selected(id) LEFT JOIN public.employment e ON e.id=selected.id AND e.tenant_id=b.tenant_id
  WHERE e.id IS NULL OR NOT(EXISTS(SELECT 1 FROM public.payslip slip WHERE slip.batch_id=b.id AND slip.employment_id=e.id AND slip.tenant_id=b.tenant_id)
   OR (b.run_type='regular' AND e.hired_on<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (e.terminated_on IS NULL OR e.terminated_on>=(b.pay_period||'-01')::date)
    -- Membership assertion only, matching entityChangedDuring/employedByCompanyDuring in
    -- core/employment-company.ts and the unchanged closeOwed tenure predicate. No new nomination.
    AND EXISTS(SELECT 1 FROM public.assignment changed WHERE changed.employment_id=e.id AND changed.tenant_id=b.tenant_id AND changed.superseded_at IS NULL AND changed.company_id IS NOT NULL AND changed.company_id<>e.company_id AND changed.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (changed.valid_to IS NULL OR changed.valid_to>(b.pay_period||'-01')::date))
    AND (e.company_id=b.company_id OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=b.tenant_id AND a.company_id=b.company_id AND a.superseded_at IS NULL AND a.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to>(b.pay_period||'-01')::date))))))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO sources FROM (
  SELECT slip.employment_id AS id FROM public.payslip slip WHERE slip.batch_id IN (p_batch,p_prior) AND slip.tenant_id=b.tenant_id
  UNION ALL SELECT unnest(p_coverage)
 ) q;
 IF EXISTS(SELECT 1 FROM unnest(sources) q(id) LEFT JOIN public.employment e ON e.id=q.id AND e.tenant_id=b.tenant_id LEFT JOIN public.person p ON p.id=e.person_id AND p.tenant_id=b.tenant_id WHERE e.id IS NULL OR p.id IS NULL)
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(sources) target(id) WHERE NOT app.data_permission_matches(target.id)) THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT e.person_id ORDER BY e.person_id),'{}'::uuid[]) INTO ids FROM public.employment e WHERE e.id=ANY(sources) AND e.tenant_id=b.tenant_id;
 RETURN ids;
END $$;
--> statement-breakpoint
-- Existing owner: db/migrations/0574_card_assignment_import_guard.sql:16
CREATE OR REPLACE FUNCTION app.card_identifier_free(p_employment uuid, p_card text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment target
   WHERE target.id=p_employment AND target.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(target.company_id) AND app.data_permission_matches(target.id))
 AND NOT app.card_identifier_conflicts(p_employment,p_card)
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0603_letter_lifecycle.sql:1276
CREATE OR REPLACE FUNCTION app.letter_staff_scope(co uuid,creator uuid,batch uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT ((app.is_admin_for(co) OR creator=app.current_user_id()) AND EXISTS(SELECT 1 FROM public.letter_record target WHERE target.id=subject AND target.tenant_id=app.current_tenant_id() AND target.company_id=co AND app.data_permission_matches(target.employment_id)))
 OR (app.letter_permission(co,'issue') AND EXISTS(SELECT 1 FROM public.letter_record target WHERE target.id=subject AND target.tenant_id=app.current_tenant_id() AND target.company_id=co AND app.data_permission_matches(target.employment_id)) AND EXISTS(SELECT 1 FROM public.letter_record l WHERE l.id=subject AND l.tenant_id=app.current_tenant_id() AND l.company_id=co AND l.state IN ('approved','issued','void')))
 OR (app.letter_permission(co,'approve') AND (
  EXISTS(SELECT 1 FROM public.letter_generation_batch b JOIN public.letter_policy_version p ON p.id=b.policy_version_id,
   LATERAL jsonb_array_elements(p.policy->'stages') stage
   WHERE b.id=batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=co AND p.tenant_id=b.tenant_id AND (stage->'userIds' ? app.current_user_id()::text OR p.policy->>'escalationUserId'=app.current_user_id()::text))
  OR EXISTS(SELECT 1 FROM public.letter_approval_decision d WHERE d.letter_id=subject AND d.tenant_id=app.current_tenant_id() AND d.action='delegate' AND d.delegated_to=app.current_user_id())))
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0603_letter_lifecycle.sql:926
CREATE OR REPLACE FUNCTION identity_email.letter_job_current(wanted_tenant uuid,wanted_job uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET TimeZone='Asia/Kuala_Lumpur' AS $$
DECLARE j public.letter_job%ROWTYPE;l public.letter_record%ROWTYPE;p jsonb;delegation public.letter_approval_decision%ROWTYPE;suffix text;expected_key text;stage_time timestamptz;
BEGIN
 SELECT * INTO j FROM public.letter_job WHERE id=wanted_job AND tenant_id=wanted_tenant AND kind<>'eventDraft' AND status<>'cancelled';IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO l FROM public.letter_record WHERE id=j.letter_id AND tenant_id=j.tenant_id AND company_id=j.company_id;IF NOT FOUND THEN RETURN false;END IF;
 IF l.state NOT IN ('issued','void') AND NOT app.letter_automation_source_current_at(wanted_tenant,l.id) THEN RETURN false;END IF;
 SELECT config.policy INTO p FROM public.letter_generation_batch b JOIN public.letter_policy_version config ON config.id=b.policy_version_id AND config.tenant_id=b.tenant_id WHERE b.id=l.batch_id AND b.tenant_id=l.tenant_id;
 IF p IS NULL OR (p->>'emailNotifications')::boolean IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=j.recipient_user_id AND u.tenant_id=j.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN false;END IF;
 IF j.payload->>'purpose'='draftCreated' THEN RETURN app.data_permission_matches_for(j.recipient_user_id,wanted_tenant,l.employment_id) AND app.letter_draft_created_job_current(wanted_tenant,wanted_job);END IF;
 IF j.payload->>'purpose'='recipientAcknowledgement' THEN RETURN app.letter_acknowledgement_job_current(wanted_tenant,wanted_job);END IF;
 IF j.payload->>'purpose'='creatorDecision' THEN
  IF j.kind<>'notification' OR j.recipient_user_id<>l.created_by OR l.state NOT IN ('returned','rejected','approved') OR j.payload->>'outcome' IS DISTINCT FROM l.state OR j.payload->>'revisionId' IS DISTINCT FROM l.current_revision_id::text THEN RETURN false;END IF;
  IF j.dedupe_key<>l.id::text||':'||l.current_revision_id::text||':creator:'||(j.payload->>'decisionId') OR NOT EXISTS(
   SELECT 1 FROM public.letter_approval_decision d JOIN public.domain_event e ON e.id=j.source_event_id AND e.tenant_id=d.tenant_id AND e.aggregate_type='letter' AND e.aggregate_id=d.letter_id
   WHERE d.id::text=j.payload->>'decisionId' AND d.tenant_id=l.tenant_id AND d.letter_id=l.id AND d.revision_id=l.current_revision_id
   AND d.action=(CASE l.state WHEN 'returned' THEN 'return' WHEN 'rejected' THEN 'reject' ELSE 'approve' END)
   AND e.event_type='letter.approval.'||d.action AND e.payload->>'decisionId'=d.id::text AND e.payload->>'revisionId'=d.revision_id::text) THEN RETURN false;END IF;
  RETURN app.data_permission_matches_for(j.recipient_user_id,wanted_tenant,l.employment_id) AND app.letter_creator_eligible_at(wanted_tenant,j.recipient_user_id,l.company_id,l.confidential);
 END IF;
 IF j.payload ? 'artifactId' THEN
  IF l.state<>'issued' OR j.kind NOT IN ('notification','acknowledgementReminder') OR NOT EXISTS(
   SELECT 1 FROM public.letter_artifact a JOIN public.employment e ON e.id=l.employment_id AND e.tenant_id=l.tenant_id JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE a.id::text=j.payload->>'artifactId' AND a.letter_id=l.id AND a.tenant_id=l.tenant_id AND a.revision_id=l.current_revision_id AND u.id=j.recipient_user_id) THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||(j.payload->>'artifactId')||':issued:'||j.recipient_user_id::text||CASE WHEN j.kind='acknowledgementReminder' THEN ':acknowledgement' ELSE '' END;
  IF j.dedupe_key<>expected_key THEN RETURN false;END IF;
  IF j.kind='acknowledgementReminder' THEN
   IF p->>'acknowledgement'='none' OR l.issued_at+(p->>'acknowledgementDueDays')::integer*interval '1 day'>now() OR EXISTS(
    SELECT 1 FROM public.letter_recipient_event e WHERE e.tenant_id=l.tenant_id AND e.letter_id=l.id AND e.artifact_id::text=j.payload->>'artifactId'
     AND e.kind=(CASE WHEN p->>'acknowledgement'='signature' THEN 'signed' ELSE 'acknowledged' END)) THEN RETURN false;END IF;
  END IF;RETURN true;
 END IF;
 IF l.state<>'submitted' OR j.payload->>'revisionId' IS DISTINCT FROM l.current_revision_id::text OR j.payload->>'stageIndex' IS DISTINCT FROM l.stage_index::text OR j.kind NOT IN ('notification','approvalReminder','escalation') THEN RETURN false;END IF;
 IF NOT app.letter_permission_for_user_at(wanted_tenant,j.recipient_user_id,l.company_id,'read') OR NOT app.letter_permission_for_user_at(wanted_tenant,j.recipient_user_id,l.company_id,'approve') OR
  (l.confidential AND NOT app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) FROM public.role_assignment r WHERE r.tenant_id=l.tenant_id AND r.app_user_id=j.recipient_user_id),l.company_id)) THEN RETURN false;END IF;
 SELECT * INTO delegation FROM public.letter_approval_decision d WHERE d.letter_id=l.id AND d.tenant_id=l.tenant_id AND d.revision_id=l.current_revision_id AND d.stage_index=l.stage_index AND d.action='delegate' ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
 suffix:=CASE WHEN delegation.id IS NOT NULL THEN ':delegation:'||delegation.id::text ELSE '' END;
 IF j.kind='escalation' THEN
  IF p->>'escalationUserId' IS DISTINCT FROM j.recipient_user_id::text THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||l.current_revision_id::text||':'||l.stage_index::text||':escalation'||suffix;
 ELSE
  IF j.recipient_user_id=l.created_by OR (delegation.id IS NOT NULL AND delegation.delegated_to<>j.recipient_user_id) OR
   (delegation.id IS NULL AND coalesce(p->'stages'->l.stage_index->'userIds' ? j.recipient_user_id::text,false) IS NOT TRUE) THEN RETURN false;END IF;
  expected_key:=l.id::text||':'||l.current_revision_id::text||':stage:'||l.stage_index::text||':'||j.recipient_user_id::text||suffix||CASE WHEN j.kind='approvalReminder' THEN ':reminder' ELSE '' END;
 END IF;
 IF j.dedupe_key<>expected_key THEN RETURN false;END IF;
 IF j.kind<>'notification' THEN
  IF l.stage_index=0 THEN stage_time:=l.submitted_at;ELSE SELECT d.created_at INTO stage_time FROM public.letter_approval_decision d WHERE d.letter_id=l.id AND d.tenant_id=l.tenant_id AND d.revision_id=l.current_revision_id AND d.stage_index=l.stage_index-1 AND d.action='approve';END IF;
  IF stage_time IS NULL OR stage_time+(CASE WHEN j.kind='escalation' THEN (p->>'approvalDueHours')::integer ELSE (p->>'reminderHours')::integer END)*interval '1 hour'>now() THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
--> statement-breakpoint
-- Existing owner: db/migrations/0564_onboarding_v31.sql:105
CREATE OR REPLACE FUNCTION app.onboarding_directory() RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.id,coalesce(p.full_name,'User '||left(u.id::text,8)) FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id)
 AND (p.id IS NULL OR app.can_see_person(p.id))
 AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id())
 ORDER BY coalesce(p.full_name,'User '||left(u.id::text,8)),u.id
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0516_lifecycle_module.sql:50
CREATE OR REPLACE FUNCTION app.lc_staff_directory(p_company uuid)
  RETURNS TABLE (user_id uuid, full_name text, level text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.user_id, p.full_name, x.level FROM (
    SELECT s.user_id, s.level FROM lc_staff s
     WHERE s.tenant_id = app.current_tenant_id() AND (s.company_id IS NULL OR s.company_id = p_company)
    UNION
    SELECT ra.app_user_id, 'admin' FROM role_assignment ra
     WHERE ra.tenant_id = app.current_tenant_id() AND ra.role IN ('hr_admin', 'super_admin')
       AND (ra.company_id IS NULL OR ra.company_id = p_company)
  ) x
  JOIN app_user u ON u.id = x.user_id AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL
  LEFT JOIN person p ON p.id = u.person_id AND p.tenant_id=u.tenant_id
  WHERE app.lc_level(p_company) >= 1 AND (p.id IS NULL OR app.can_see_person(p.id))
  ORDER BY p.full_name, x.user_id;
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0647_mobile_offline_attendance.sql:414
CREATE OR REPLACE FUNCTION app.mobile_offline_open_context_count(company uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.company co WHERE co.id=$1 AND co.tenant_id=app.current_tenant_id()) AND coalesce(app.can_admin_payroll_for($1),false)
  THEN (SELECT count(*)::integer FROM public.mobile_offline_context c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=$1
   AND app.data_permission_matches(c.employment_id) AND c.closed_at IS NULL AND c.expires_at>clock_timestamp()) END
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0549_employee_master_delivery.sql:7
CREATE OR REPLACE FUNCTION identity_email.report_access_stamp(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'dataPermissionProfiles',(SELECT coalesce(jsonb_agg(jsonb_build_array(p.id,p.xmin::text) ORDER BY p.id),'[]'::jsonb) FROM data_permission_profile p WHERE p.tenant_id=p_tenant),
  'dataPermissionRevisions',(SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.xmin::text) ORDER BY r.id),'[]'::jsonb) FROM data_permission_revision r WHERE r.tenant_id=p_tenant),
  'dataPermissionAssignments',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.user_id,a.xmin::text) ORDER BY a.user_id),'[]'::jsonb) FROM user_data_permission_assignment a WHERE a.tenant_id=p_tenant),
  'accessConfiguration',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM access_configuration a WHERE a.tenant_id=p_tenant),
  'accessGroups',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM access_group a WHERE a.tenant_id=p_tenant),
  'accessGroupGrants',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM access_group_grant a WHERE a.tenant_id=p_tenant),
  'accessMemberships',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM access_membership a WHERE a.tenant_id=p_tenant),
  'accessOverrides',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM access_user_override a WHERE a.tenant_id=p_tenant),
  'profilePeople',(SELECT coalesce(jsonb_agg(jsonb_build_array(p.id,p.xmin::text) ORDER BY p.id),'[]'::jsonb) FROM person p WHERE p.tenant_id=p_tenant),
  'profileEmployments',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.xmin::text) ORDER BY e.id),'[]'::jsonb) FROM employment e WHERE e.tenant_id=p_tenant),
  'profileAssignments',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.xmin::text) ORDER BY a.id),'[]'::jsonb) FROM assignment a WHERE a.tenant_id=p_tenant),
  'tenant',(SELECT jsonb_build_array(t.id,t.status,t.suspended_at,t.trial_ends_at,t.closed_at) FROM tenant t WHERE t.id=p_tenant),
  'roles',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.id,g.app_user_id,g.role,g.company_id) ORDER BY g.id),'[]'::jsonb) FROM role_assignment g WHERE g.tenant_id=p_tenant),
  'permissions',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM payroll_permission_grant g WHERE g.tenant_id=p_tenant),
  'modules',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM tenant_module m WHERE m.tenant_id=p_tenant),
  'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM tenant_setting s WHERE s.tenant_id=p_tenant),
  'companies',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.country,c.statutory_tier,c.parent_company_id) ORDER BY c.id),'[]'::jsonb) FROM company c WHERE c.tenant_id=p_tenant),
  'employments',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.person_id,e.company_id,e.hired_on,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at) ORDER BY e.id),'[]'::jsonb) FROM employment e WHERE e.tenant_id=p_tenant),
  'assignments',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.employment_id,a.company_id,a.department_id,a.valid_from,a.valid_to,a.superseded_at) ORDER BY a.id),'[]'::jsonb) FROM assignment a WHERE a.tenant_id=p_tenant),
  'departments',(SELECT coalesce(jsonb_agg(jsonb_build_array(d.id,d.company_id,d.parent_department_id) ORDER BY d.id),'[]'::jsonb) FROM department d WHERE d.tenant_id=p_tenant),
  'delegationScopes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM reporting_line_scope s WHERE s.tenant_id=p_tenant),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM reporting_line l WHERE l.tenant_id=p_tenant),
  'catalog',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.code),'[]'::jsonb) FROM module m),
  'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM setting_definition s)
 )::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
-- Existing owner: db/migrations/0552_employee_master_internal_delivery.sql:156
CREATE OR REPLACE FUNCTION app.internal_auth_report_lock_context(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.custom_report_occurrence;initial jsonb;fresh jsonb;result jsonb;
 actors uuid[];people uuid[];subjects text[];lock_key text;actor uuid;v_person uuid;
 row_item record;n integer;v_issuer text;prior_timeout text:=current_setting('lock_timeout');
 locked_employments uuid[]:=ARRAY[]::uuid[];locked_grants uuid[]:=ARRAY[]::uuid[];
 locked_bindings jsonb:='[]'::jsonb;observed_ids uuid[];observed_bindings jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Delivery requires its bounded read-committed transaction' USING ERRCODE='22023';
 END IF;
 BEGIN
  PERFORM set_config('lock_timeout','250ms',true);
  -- Canonical order is occurrence -> report -> schedule, including deleted/disabled races.
  SELECT * INTO job FROM public.custom_report_occurrence o
  WHERE o.id=p_id AND o.lease_token=p_token AND o.status='pending' AND o.started_at IS NULL
   AND o.lease_until>clock_timestamp() FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  -- Profile policy and prospective value writers share this canonical tenant interval (0936/0938).
  IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||job.tenant_id::text,0)) THEN RAISE lock_not_available;END IF;
  PERFORM r.id FROM public.custom_report r WHERE r.id=job.report_id AND r.tenant_id=job.tenant_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  PERFORM s.id FROM public.custom_report_schedule s WHERE s.id=job.schedule_id AND s.tenant_id=job.tenant_id
   AND s.report_id=job.report_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  initial:=identity_email.internal_report_context(p_id,p_token,p_origin);
  IF initial IS NULL THEN RAISE no_data_found;END IF;
  v_issuer:=initial->>'issuer';
  SELECT array_agg(DISTINCT v ORDER BY v) INTO actors FROM unnest(ARRAY[job.owner_user_id,job.recipient_user_id]) v;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO subjects FROM unnest(ARRAY[
   initial#>>'{bindings,owner,subject}',initial#>>'{bindings,recipient,subject}']) v;
  -- Same canonical keys as Auth store/settings and Notifications. No alternative lock authority.
  FOREACH lock_key IN ARRAY subjects LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended('internal-auth:'||lock_key,0)) THEN
    RAISE lock_not_available;END IF;
  END LOOP;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('internal-auth:email-state',0)) THEN RAISE lock_not_available;END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workflow-email-policy:'||job.tenant_id::text,0)) THEN RAISE lock_not_available;END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workflow-email-consent:'||job.tenant_id::text||':'||job.recipient_employment_id::text,0)) THEN RAISE lock_not_available;END IF;
  -- Locks only fixed nonce-derived credential keys and existing canonical email-state.
  -- No ciphertext or caller-selectable key is returned. e5 readRecord(...,true) later decrypts.
  FOREACH lock_key IN ARRAY subjects LOOP
   PERFORM r.record_key FROM public.app_internal_auth_record r
   WHERE r.record_key='credential:'||lock_key FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  PERFORM r.record_key FROM public.app_internal_auth_record r WHERE r.record_key='email-state' FOR UPDATE NOWAIT;
  -- Tenant standing is a live receiving prerequisite, not merely the queue-time state.
  PERFORM t.id FROM public.tenant t WHERE t.id=job.tenant_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  FOREACH actor IN ARRAY actors LOOP
   PERFORM u.id FROM public.app_user u WHERE u.id=actor AND u.tenant_id=job.tenant_id FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT u.person_id ORDER BY u.person_id) FILTER(WHERE u.person_id IS NOT NULL),ARRAY[]::uuid[])
   INTO people FROM public.app_user u WHERE u.id=ANY(actors);
  -- Person before preferences: email-change/PDPA writers update Person -> pref without consent advisory.
  FOREACH v_person IN ARRAY people LOOP
   PERFORM p.id FROM public.person p WHERE p.id=v_person AND p.tenant_id=job.tenant_id FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  -- Canonical login_blocked reads ALL employments for its Person. Lock the actual set, not
  -- current-company substitutes; a cross-tenant corrupt reference refuses, never leaks a row.
  FOREACH v_person IN ARRAY people LOOP
   n:=0;
   FOR row_item IN SELECT e.id,e.tenant_id FROM public.employment e WHERE e.person_id=v_person
    ORDER BY e.id LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    IF row_item.tenant_id<>job.tenant_id THEN RAISE no_data_found;END IF;
    locked_employments:=array_append(locked_employments,row_item.id);
   END LOOP;
  END LOOP;
  IF NOT job.recipient_employment_id=ANY(locked_employments) THEN RAISE no_data_found;END IF;
  FOREACH actor IN ARRAY actors LOOP
   n:=0;
   FOR row_item IN SELECT i.issuer,i.subject,i.app_user_id FROM public.app_external_identity i
    WHERE i.app_user_id=actor AND i.issuer=v_issuer ORDER BY i.issuer,i.subject LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    locked_bindings:=locked_bindings||jsonb_build_array(jsonb_build_array(row_item.issuer,row_item.subject,row_item.app_user_id));
   END LOOP;
   n:=0;
   FOR row_item IN SELECT g.id,g.tenant_id FROM public.role_assignment g WHERE g.app_user_id=actor
    ORDER BY g.id LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    IF row_item.tenant_id<>job.tenant_id THEN RAISE no_data_found;END IF;
    locked_grants:=array_append(locked_grants,row_item.id);
   END LOOP;
  END LOOP;
  PERFORM p.id FROM public.notification_email_policy p WHERE p.tenant_id=job.tenant_id
   AND p.category='employee_master_reports' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  PERFORM p.id FROM public.notification_pref p WHERE p.tenant_id=job.tenant_id
   AND p.recipient_employment_id=job.recipient_employment_id AND p.category='employee_master_reports'
   AND p.channel='email' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  -- Recompare exact proof sets. User/Person FOR UPDATE also conflicts with new FK-backed
  -- binding/grant/employment insert/retarget checks; concurrency controls remain mandatory.
  SELECT coalesce(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[]) INTO observed_ids
   FROM public.employment e WHERE e.person_id=ANY(people);
  IF observed_ids IS DISTINCT FROM ARRAY(SELECT v FROM unnest(locked_employments) v ORDER BY v) THEN RAISE no_data_found;END IF;
  SELECT coalesce(array_agg(g.id ORDER BY g.id),ARRAY[]::uuid[]) INTO observed_ids
   FROM public.role_assignment g WHERE g.app_user_id=ANY(actors);
  IF observed_ids IS DISTINCT FROM ARRAY(SELECT v FROM unnest(locked_grants) v ORDER BY v) THEN RAISE no_data_found;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(i.issuer,i.subject,i.app_user_id) ORDER BY i.app_user_id,i.issuer,i.subject),'[]'::jsonb)
   INTO observed_bindings FROM public.app_external_identity i WHERE i.app_user_id=ANY(actors) AND i.issuer=v_issuer;
  IF observed_bindings IS DISTINCT FROM locked_bindings THEN RAISE no_data_found;END IF;
  fresh:=identity_email.internal_report_context(p_id,p_token,p_origin);
  IF fresh IS NULL OR fresh IS DISTINCT FROM initial THEN RAISE no_data_found;END IF;
  result:=jsonb_build_object('status','ready','context',fresh);
  PERFORM set_config('lock_timeout',prior_timeout,true);
 EXCEPTION
  WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN result:=jsonb_build_object('status','busy');
  WHEN no_data_found THEN result:=jsonb_build_object('status','notEligible');
  WHEN program_limit_exceeded THEN result:=jsonb_build_object('status','unavailable');
 END;
 -- Exception rollback restores settings and releases locks acquired inside that subtransaction.
 -- Success retains locks until OUTER commit/rollback. Do not commit after a refused Auth/relay check.
 RETURN result;
END $$;
