-- Source reservation after 4101. Recheck peer claims and the applied watermark at integration.
-- A digest is an audited notification from the nightly sweep, never an app-supplied recipient or message.
CREATE POLICY employee_loop_digest_maintenance_only ON public.domain_event AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK (event_type<>'teras-loop.employee-digest-queued');
--> statement-breakpoint
CREATE UNIQUE INDEX employee_loop_digest_once_per_hr_day
 ON public.domain_event (tenant_id,aggregate_id,(payload->>'day'))
 WHERE aggregate_type='teras-loop-employee-digest' AND event_type='teras-loop.employee-digest-queued';
--> statement-breakpoint
-- Internal to event admission and leased delivery. Counts only the original case references still open now.
CREATE FUNCTION app.employee_loop_digest_open_count(e public.domain_event) RETURNS integer
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT count(*)::integer
 FROM public.teras_loop_case c
 JOIN public.employment em ON em.tenant_id=c.tenant_id AND em.id=c.employment_id AND em.company_id=c.company_id
 JOIN public.teras_worker_control w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id AND w.enabled
  AND w.changed_at<=e.occurred_at
 WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.subject_employment_id AND c.state='open' AND c.recipient='employee'
  AND c.opened_at<=e.occurred_at
  AND c.worker_id IN ('loop_missed_clock_outs','loop_missing_employee_data','loop_document_expiry')
  AND e.payload->'caseIds' ? c.id::text
  AND e.payload->>'day'=((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::text
  AND em.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (em.terminated_on IS NULL OR em.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND NOT EXISTS (SELECT 1 FROM public.teras_loop_pause p WHERE p.tenant_id=c.tenant_id AND p.company_id=c.company_id AND p.worker_id=c.worker_id AND p.paused)
  AND NOT EXISTS (SELECT 1 FROM public.teras_loop_level l WHERE l.tenant_id=c.tenant_id AND l.company_id=c.company_id AND l.worker_id=c.worker_id AND l.level=0);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_loop_digest_open_count(public.domain_event) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_centre_stamp_event(wanted_event uuid,expected_generation integer) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.domain_event;g integer;
BEGIN
 g:=app.ai_centre_assert_running(expected_generation);
 IF g IS NULL OR expected_generation IS NULL THEN RAISE EXCEPTION 'AI activity stopped' USING ERRCODE='55000'; END IF;
 -- The caller can only stamp an AI event it inserted in this transaction. Old events cannot be revived.
 SELECT * INTO e FROM public.domain_event WHERE id=wanted_event AND tenant_id=app.current_tenant_id() AND xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR (e.event_type NOT LIKE 'automatic-chase.%' AND e.event_type NOT IN ('readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied','teras-loop.request.sent','teras-loop.cut-off-reminder','teras-loop.employee-digest-queued')) THEN
  RAISE EXCEPTION 'AI event stamp unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.ai_centre_event_generation(event_id,tenant_id,generation) VALUES(e.id,e.tenant_id,g) ON CONFLICT(event_id) DO NOTHING;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_centre_event_allowed(wanted_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.domain_event;c public.teras_mandate_control;g integer;
BEGIN
 SELECT * INTO e FROM public.domain_event WHERE id=wanted_event AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN false; END IF;
 IF e.event_type NOT LIKE 'automatic-chase.%' AND e.event_type NOT IN ('readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied','teras-loop.request.sent','teras-loop.cut-off-reminder','teras-loop.employee-digest-queued') THEN RETURN true; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(e.tenant_id::text));
 SELECT * INTO c FROM public.teras_mandate_control WHERE tenant_id=e.tenant_id;
 IF coalesce(c.stopped,false) THEN RETURN false; END IF;
 SELECT generation INTO g FROM app.ai_centre_event_generation WHERE event_id=e.id AND tenant_id=e.tenant_id;
 IF e.event_type='teras-loop.employee-digest-queued' THEN
  RETURN g IS NOT NULL AND g=coalesce(c.version,0) AND app.employee_loop_digest_open_count(e)>0;
 END IF;
 IF g IS NOT NULL THEN RETURN g=coalesce(c.version,0); END IF;
 RETURN c.tenant_id IS NULL OR e.occurred_at>=c.changed_at;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_centre_delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.domain_event;c public.teras_mandate_control;g integer;
BEGIN
 IF NEW.started_at IS NULL OR OLD.started_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO e FROM public.domain_event WHERE id=NEW.source_event_id AND tenant_id=NEW.tenant_id;
 IF e.event_type LIKE 'automatic-chase.%' OR e.event_type IN ('readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied','teras-loop.request.sent','teras-loop.cut-off-reminder','teras-loop.employee-digest-queued') THEN
  PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
  SELECT * INTO c FROM public.teras_mandate_control WHERE tenant_id=NEW.tenant_id;
  SELECT generation INTO g FROM app.ai_centre_event_generation WHERE event_id=e.id AND tenant_id=e.tenant_id;
  IF e.event_type='teras-loop.employee-digest-queued' AND (g IS NULL OR app.employee_loop_digest_open_count(e)=0) THEN
   RAISE EXCEPTION 'Employee loop digest is no longer eligible' USING ERRCODE='55000';
  END IF;
  IF coalesce(c.stopped,false) OR (g IS NOT NULL AND g<>coalesce(c.version,0)) OR (g IS NULL AND c.tenant_id IS NOT NULL AND e.occurred_at<c.changed_at) THEN
   RAISE EXCEPTION 'AI delivery stopped' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.private_workflow_mail(p_delivery uuid,p_token uuid,p_origin text,p_compatibility boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target record;d notification_delivery;e domain_event;message jsonb;open_count integer;
BEGIN
 IF p_compatibility THEN
  SELECT * INTO target FROM identity_email.delivery_target(p_delivery,p_token,p_origin);
 ELSE
  SELECT * INTO target FROM app.internal_auth_notification_target(p_delivery,p_token,p_origin);
 END IF;
 IF NOT FOUND THEN RETURN jsonb_build_object('required',true,'message',NULL);END IF;
 SELECT * INTO d FROM notification_delivery WHERE id=p_delivery AND recipient_user_id=target.user_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('required',true,'message',NULL);END IF;
 SELECT * INTO e FROM domain_event WHERE id=d.source_event_id AND tenant_id=d.tenant_id;
 IF e.event_type='probation.notification-due' THEN
  IF to_regprocedure('app.probation_notification_content(uuid,uuid,uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT app.probation_notification_content($1,$2,$3)' INTO message USING d.tenant_id,e.id,target.user_id;
  END IF;
 ELSIF e.event_type='contract.notification-due' THEN
  IF to_regprocedure('app.contract_notification_content(uuid,uuid,uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT app.contract_notification_content($1,$2,$3)' INTO message USING d.tenant_id,e.id,target.user_id;
  END IF;
 ELSIF e.event_type='teras-loop.employee-digest-queued' THEN
  open_count:=app.employee_loop_digest_open_count(e);
  IF open_count>0 THEN
   message:=CASE target.locale
    WHEN 'ms' THEN jsonb_build_object('subject','Ringkasan tindakan harian anda','body',format('%s perkara memerlukan perhatian anda. Buka Hari Ini untuk menyemak senarai dan membuat tindakan.',open_count))
    WHEN 'zh' THEN jsonb_build_object('subject','您的每日待办摘要','body',format('您有 %s 项待办事项。请打开「今天」查看并处理。',open_count))
    WHEN 'vi' THEN jsonb_build_object('subject','Tóm tắt việc cần làm hằng ngày','body',format('Có %s việc cần bạn xử lý. Mở Hôm nay để xem danh sách và thực hiện.',open_count))
    WHEN 'ta' THEN jsonb_build_object('subject','உங்கள் தினசரி பணி சுருக்கம்','body',format('%s பணிகளுக்கு உங்கள் கவனம் தேவை. பட்டியலைப் பார்க்கவும் செயல்படவும் இன்றைய பக்கத்தைத் திறக்கவும்.',open_count))
    WHEN 'th' THEN jsonb_build_object('subject','สรุปสิ่งที่ต้องทำประจำวัน','body',format('มี %s รายการที่คุณต้องดำเนินการ เปิดหน้าวันนี้เพื่อดูรายการและดำเนินการ',open_count))
    ELSE jsonb_build_object('subject','Your daily action digest','body',format('%s item%s need%s your attention. Open Today to review and act on the list.',open_count,
     CASE WHEN open_count=1 THEN '' ELSE 's' END, CASE WHEN open_count=1 THEN 's' ELSE '' END))
   END;
  END IF;
 ELSE RETURN jsonb_build_object('required',false,'message',NULL);
 END IF;
 RETURN jsonb_build_object('required',true,'message',message);
END $$;
