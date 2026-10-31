-- PRIVATE UNALLOCATED COMPOSITION ONLY. Source-cleared V3 components; NEVER EXECUTED.
-- Root assigns identity/journal and adopts after its current complete-plan barrier.
-- APPEND after mapped0841/0850/0852 and central0861; do not rewrite any predecessor.

-- COMPOSITION COMPONENT: native-interval.sql
-- PRIVATE V2 PURPOSE-OWNED LEDGER INTERVAL. Unallocated, unadopted, never executed.
-- Root custody owns eventual unapplied identity/order. No app-writable fact/GUC or new table.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN catalogue_native_phase text,ADD COLUMN catalogue_native_root xid8,
 ADD COLUMN catalogue_native_event uuid,ADD COLUMN catalogue_native_tid tid,
 ADD CONSTRAINT assistant_catalogue_native_interval_columns CHECK(CASE WHEN action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') THEN
  (catalogue_native_phase IS NULL AND catalogue_native_root IS NULL AND catalogue_native_event IS NULL AND catalogue_native_tid IS NULL)
  OR(catalogue_native_phase IS NOT NULL AND catalogue_native_root IS NOT NULL AND
   (catalogue_native_phase='armed' AND catalogue_native_event IS NULL AND catalogue_native_tid IS NULL
    OR catalogue_native_phase='written' AND catalogue_native_event IS NULL AND catalogue_native_tid IS NOT NULL
    OR catalogue_native_phase IN('recorded','completed') AND catalogue_native_event IS NOT NULL AND catalogue_native_tid IS NOT NULL))
 ELSE catalogue_native_phase IS NULL AND catalogue_native_root IS NULL AND catalogue_native_event IS NULL AND catalogue_native_tid IS NULL END);
--> statement-breakpoint

CREATE UNIQUE INDEX assistant_catalogue_one_active_native ON app.assistant_own_leave_review(tenant_id,catalogue_native_root)
WHERE catalogue_native_phase IN('armed','written','recorded');
--> statement-breakpoint

CREATE INDEX assistant_catalogue_native_root_lookup ON app.assistant_own_leave_review(catalogue_native_root,tenant_id) WHERE catalogue_native_phase IS NOT NULL;
--> statement-breakpoint


-- Private guarded transition; callers cannot invoke it. Every UPDATE rechecks the WHOLE actual ledger
-- postimage after callbacks, not merely the kind-specific phase columns.
CREATE FUNCTION app._assistant_catalogue_native_phase(p_id uuid,p_phase text,p_tid tid DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;expected jsonb;actual jsonb;root xid8:=pg_current_xact_id();
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR r.action_kind NOT IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  OR r.state<>'awaiting_confirmation' OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 IF p_phase='armed' THEN
  IF r.catalogue_native_phase IS NOT NULL OR p_tid IS NOT NULL OR p_event IS NOT NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_phase='written' THEN
  IF r.catalogue_native_phase IS DISTINCT FROM 'armed' OR r.catalogue_native_root IS DISTINCT FROM root OR p_tid IS NULL OR p_event IS NOT NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_phase='recorded' THEN
  IF r.catalogue_native_phase IS DISTINCT FROM 'written' OR r.catalogue_native_root IS DISTINCT FROM root OR p_tid IS DISTINCT FROM r.catalogue_native_tid OR p_event IS NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 expected:=to_jsonb(r)||jsonb_build_object('catalogue_native_phase',p_phase,'catalogue_native_root',root,'catalogue_native_tid',p_tid,'catalogue_native_event',p_event);
 UPDATE app.assistant_own_leave_review SET catalogue_native_phase=p_phase,catalogue_native_root=root,catalogue_native_tid=p_tid,catalogue_native_event=p_event WHERE id=r.id;
 SELECT to_jsonb(saved) INTO actual FROM app.assistant_own_leave_review saved WHERE id=r.id;
 IF actual IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Catalogue interval postimage changed' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_native_phase(uuid,text,tid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint


-- Only this nomination command is app-callable. It derives current actor, own pending body and actual
-- native source/authority; it accepts no proposed row/event/root/hash, nor an arbitrary executor.
CREATE FUNCTION app.assistant_catalogue_native_arm(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;held app.assistant_own_leave_review%ROWTYPE;source jsonb;after_source jsonb;k text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status');
 IF NOT FOUND OR r.state<>'awaiting_confirmation' OR r.catalogue_native_phase IS NOT NULL OR clock_timestamp()>=r.expires_at
  OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF r.action_kind<>'org.employee_id_template.status' THEN
  IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
   OR NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||r.tenant_id::text,0)) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
  FOREACH k IN ARRAY ARRAY['department','position','cost_center','business_unit'] LOOP
   INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind) VALUES(r.tenant_id,k) ON CONFLICT DO NOTHING;
   PERFORM revision FROM public.system_label_criteria_epoch WHERE tenant_id=r.tenant_id AND label_kind=k FOR UPDATE;
  END LOOP;
 END IF;
 IF r.action_kind='org.position.archive' THEN
  PERFORM 1 FROM public.position WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.position_archive_grid_source(r.receipt_subject_id);
  IF(source->>'archived')::boolean IS NOT DISTINCT FROM r.position_archive_desired OR(r.position_archive_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.action_kind='org.department.archive' THEN
  PERFORM 1 FROM public.department WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.department_archive_grid_source(r.receipt_subject_id);
  IF(source->>'archived')::boolean IS NOT DISTINCT FROM r.department_archive_desired OR(r.department_archive_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSE
  PERFORM 1 FROM public.employee_id_config WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.employee_id_template_status_source(r.receipt_subject_id);
  IF source->>'status' IS NOT DISTINCT FROM r.employee_id_template_desired_status THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO held FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF to_jsonb(held) IS DISTINCT FROM to_jsonb(r) THEN RAISE EXCEPTION 'Catalogue pending binding changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_catalogue_native_phase(r.id,'armed');
 after_source:=CASE r.action_kind WHEN 'org.position.archive' THEN app.position_archive_grid_source(r.receipt_subject_id) WHEN 'org.department.archive' THEN app.department_archive_grid_source(r.receipt_subject_id) ELSE app.employee_id_template_status_source(r.receipt_subject_id) END;
 IF after_source IS DISTINCT FROM source THEN RAISE EXCEPTION 'Catalogue source changed while arming' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.assistant_catalogue_native_arm(uuid) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.assistant_catalogue_native_arm(uuid) TO ai_hr_app;
--> statement-breakpoint


-- Actual native AFTER UPDATE has the real independent OLD even when a later BEFORE hook changed NEW.
-- Comparison is against persisted whole row, not a copy of NEW or a caller-supplied source hash.
CREATE FUNCTION app._assistant_catalogue_native_row_observer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;kind text;before_row jsonb:=to_jsonb(OLD);actual jsonb;expected jsonb;physical tid;is_root boolean;desired boolean;
BEGIN
 kind:=CASE TG_RELID WHEN 'public.position'::regclass THEN 'org.position.archive' WHEN 'public.department'::regclass THEN 'org.department.archive' WHEN 'public.employee_id_config'::regclass THEN 'org.employee_id_template.status' END;
 IF TG_OP<>'UPDATE' OR kind IS NULL THEN RAISE EXCEPTION 'Catalogue observation unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE action_kind=kind AND catalogue_native_root=pg_current_xact_id()
 AND catalogue_native_phase='armed' AND tenant_id=(before_row->>'tenant_id')::uuid AND receipt_subject_id=(before_row->>'id')::uuid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.user_id IS DISTINCT FROM app.current_user_id() OR r.state<>'awaiting_confirmation' OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Catalogue observation unavailable' USING ERRCODE='42501';END IF;
 IF kind='org.position.archive' THEN
  desired:=r.position_archive_desired;IF(OLD.archived_at IS NOT NULL)=desired THEN RAISE EXCEPTION 'Catalogue native delta changed' USING ERRCODE='42501';END IF;
  expected:=before_row||jsonb_build_object('archived_at',CASE WHEN desired THEN transaction_timestamp() ELSE NULL::timestamptz END);
  SELECT to_jsonb(p),p.ctid,p.xmin=pg_current_xact_id()::xid INTO actual,physical,is_root FROM public.position p WHERE id=NEW.id AND tenant_id=r.tenant_id;
 ELSIF kind='org.department.archive' THEN
  desired:=r.department_archive_desired;IF(OLD.archived_at IS NOT NULL)=desired THEN RAISE EXCEPTION 'Catalogue native delta changed' USING ERRCODE='42501';END IF;
  expected:=before_row||jsonb_build_object('archived_at',CASE WHEN desired THEN transaction_timestamp() ELSE NULL::timestamptz END);
  SELECT to_jsonb(p),p.ctid,p.xmin=pg_current_xact_id()::xid INTO actual,physical,is_root FROM public.department p WHERE id=NEW.id AND tenant_id=r.tenant_id;
 ELSE
  IF OLD.status=r.employee_id_template_desired_status THEN RAISE EXCEPTION 'Catalogue native delta changed' USING ERRCODE='42501';END IF;
  expected:=before_row||jsonb_build_object('status',r.employee_id_template_desired_status,'updated_at',transaction_timestamp());
  SELECT to_jsonb(p),p.ctid,p.xmin=pg_current_xact_id()::xid INTO actual,physical,is_root FROM public.employee_id_config p WHERE id=NEW.id AND tenant_id=r.tenant_id;
 END IF;
 IF actual IS DISTINCT FROM expected OR is_root IS NOT TRUE OR physical IS NULL THEN RAISE EXCEPTION 'Catalogue native delta changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_catalogue_native_phase(r.id,'written',physical);
 RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_native_row_observer() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_native_row_observer AFTER UPDATE ON public.position FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_native_row_observer();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_native_row_observer AFTER UPDATE ON public.department FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_native_row_observer();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_native_row_observer AFTER UPDATE ON public.employee_id_config FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_native_row_observer();
--> statement-breakpoint


CREATE FUNCTION app._assistant_catalogue_native_event_observer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;aggregate text;kind text;payload jsonb;actual jsonb;is_root boolean;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.domain_event'::regclass THEN RAISE EXCEPTION 'Catalogue event observation unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE catalogue_native_root=pg_current_xact_id() AND catalogue_native_phase='written'
 AND tenant_id=NEW.tenant_id AND receipt_subject_id=NEW.aggregate_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 aggregate:=CASE r.action_kind WHEN 'org.position.archive' THEN 'position' WHEN 'org.department.archive' THEN 'department' WHEN 'org.employee_id_template.status' THEN 'employee-id-config' END;
 IF aggregate IS NULL OR NEW.aggregate_type<>aggregate THEN RETURN NULL;END IF;
 IF r.action_kind='org.position.archive' THEN SELECT jsonb_build_object('title',p.title,'archived',r.position_archive_desired) INTO payload FROM public.position p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid;kind:='position.updated';
 ELSIF r.action_kind='org.department.archive' THEN SELECT jsonb_build_object('name',p.name,'archived',r.department_archive_desired) INTO payload FROM public.department p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid;kind:='department.updated';
 ELSE SELECT jsonb_build_object('status',r.employee_id_template_desired_status) INTO payload FROM public.employee_id_config p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid;kind:=CASE r.employee_id_template_desired_status WHEN 'active' THEN 'employee-id-config.activated' ELSE 'employee-id-config.deactivated' END;END IF;
 SELECT to_jsonb(d),d.xmin=pg_current_xact_id()::xid INTO actual,is_root FROM public.domain_event d WHERE id=NEW.id AND tenant_id=r.tenant_id;
 IF payload IS NULL OR NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM r.user_id OR NEW.actor_id IS DISTINCT FROM app.current_user_id()
  OR NEW.event_type<>kind OR NEW.subject_employment_id IS NOT NULL OR NEW.payload IS DISTINCT FROM payload
  OR NEW.occurred_at IS DISTINCT FROM transaction_timestamp() OR actual IS DISTINCT FROM to_jsonb(NEW) OR is_root IS NOT TRUE
  OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Catalogue native event changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_catalogue_native_phase(r.id,'recorded',r.catalogue_native_tid,NEW.id);RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_native_event_observer() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_native_event_observer AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_native_event_observer();
--> statement-breakpoint


-- Cancellation/erasure/expiry removes transient nomination metadata with its pending body. A completed
-- fact keeps its non-PII root/physical identity for the rest of that root; no raw rowset is retained.
CREATE FUNCTION app._assistant_catalogue_body_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID<>'app.assistant_own_leave_review_content'::regclass THEN RAISE EXCEPTION 'Catalogue cleanup unavailable' USING ERRCODE='42501';END IF;
 -- DELETE is deliberately outside central0861 (INSERT/UPDATE only). The body tuple can
 -- already be owned here; a blocking UPDATE would invert parent->body ordering. Acquire the
 -- exact live parent FOR UPDATE NOWAIT FIRST, including the upgrade from a competing SHARE.
 -- Missing/cascaded parent, another kind, completed or already-clear nomination remains a no-op.
 PERFORM 1 FROM app.assistant_own_leave_review WHERE id=OLD.action_id AND state<>'completed'
 AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') AND catalogue_native_phase IS NOT NULL
 FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE app.assistant_own_leave_review SET catalogue_native_phase=NULL,catalogue_native_root=NULL,catalogue_native_event=NULL,catalogue_native_tid=NULL
 WHERE id=OLD.action_id AND state<>'completed' AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') AND catalogue_native_phase IS NOT NULL;
 RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_body_retired() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_body_retired AFTER DELETE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_body_retired();

--> statement-breakpoint

-- COMPOSITION COMPONENT: permanent-guards.sql
-- PRIVATE UNAPPLIED SOURCE PROPOSAL. NOT EXECUTED; root owns source identity/adoption.
-- No witness column/table, new app grant, caller digest or GUC stamp. Actual existing completed
-- review/event tuples establish the root interval; native authority/source owners are unchanged.
CREATE FUNCTION app._assistant_catalogue_completed_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass THEN RAISE EXCEPTION 'Catalogue guard unavailable' USING ERRCODE='42501';END IF;
 IF OLD.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') AND OLD.state='completed' THEN
  IF TG_OP='DELETE' THEN
   -- Existing actual tenant/USER/PERSON FK parent deletion remains owned by canonical privacy.
   IF EXISTS(SELECT 1 FROM public.tenant WHERE id=OLD.tenant_id) AND EXISTS(SELECT 1 FROM public.app_user WHERE id=OLD.user_id)
    AND(OLD.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person WHERE id=OLD.person_id)) THEN
    RAISE EXCEPTION 'Completed catalogue review immutable' USING ERRCODE='42501';
   END IF;
  ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Completed catalogue review immutable' USING ERRCODE='42501';END IF;
 END IF;RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_completed_immutable() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_completed_immutable AFTER UPDATE OR DELETE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_completed_immutable();
--> statement-breakpoint


CREATE FUNCTION app._assistant_catalogue_completed_content() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review_content'::regclass THEN RAISE EXCEPTION 'Catalogue body guard unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review WHERE id=NEW.action_id AND state='completed'
  AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')) THEN
  RAISE EXCEPTION 'Completed catalogue body unavailable' USING ERRCODE='42501';
 END IF;RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_completed_content() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_completed_content AFTER INSERT OR UPDATE ON app.assistant_own_leave_review_content
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_completed_content();


--> statement-breakpoint

-- COMPOSITION COMPONENT: root-fences.sql
-- PRIVATE V2, no execution. Protected actual native phase/root/physical identity belongs to the
-- observer, not caller input. Root uses that durable claim even after body cleanup/IMMEDIATE.
CREATE FUNCTION app._assistant_catalogue_root_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;kind text;r app.assistant_own_leave_review%ROWTYPE;physical tid;claimed boolean;
BEGIN
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW);END IF;
 IF TG_RELID='public.domain_event'::regclass THEN
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review s WHERE s.catalogue_native_phase='completed'
   AND s.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
   AND s.catalogue_native_event IN((before_row->>'id')::uuid,(after_row->>'id')::uuid)) THEN RAISE EXCEPTION 'Completed catalogue native event immutable' USING ERRCODE='42501';END IF;
  FOR r IN SELECT * FROM app.assistant_own_leave_review s WHERE s.catalogue_native_root=pg_current_xact_id() AND s.catalogue_native_phase IN('written','recorded','completed')
   AND s.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
   AND(s.catalogue_native_event IN((before_row->>'id')::uuid,(after_row->>'id')::uuid)
    OR(s.tenant_id=(before_row->>'tenant_id')::uuid AND s.receipt_subject_id=(before_row->>'aggregate_id')::uuid AND before_row->>'aggregate_type'=CASE s.action_kind WHEN 'org.position.archive' THEN 'position' WHEN 'org.department.archive' THEN 'department' ELSE 'employee-id-config' END)
    OR(s.tenant_id=(after_row->>'tenant_id')::uuid AND s.receipt_subject_id=(after_row->>'aggregate_id')::uuid AND after_row->>'aggregate_type'=CASE s.action_kind WHEN 'org.position.archive' THEN 'position' WHEN 'org.department.archive' THEN 'department' ELSE 'employee-id-config' END)) LOOP
   -- The initial INSERT may reach this AFTER fence before or after its actual observer. Once
   -- recorded, only that exact initial INSERT is allowed; later matching/extraneous events refuse.
   IF TG_OP='INSERT' AND(r.catalogue_native_phase='written' OR r.catalogue_native_event=(after_row->>'id')::uuid) THEN CONTINUE;END IF;
   RAISE EXCEPTION 'Catalogue root event changed' USING ERRCODE='42501';
  END LOOP;
 ELSE
  kind:=CASE TG_RELID WHEN 'public.position'::regclass THEN 'org.position.archive' WHEN 'public.department'::regclass THEN 'org.department.archive' WHEN 'public.employee_id_config'::regclass THEN 'org.employee_id_template.status' END;
  IF kind IS NULL THEN RAISE EXCEPTION 'Catalogue native guard unavailable' USING ERRCODE='42501';END IF;
  FOR r IN SELECT * FROM app.assistant_own_leave_review s WHERE s.action_kind=kind AND s.catalogue_native_root=pg_current_xact_id()
   AND s.catalogue_native_phase IN('armed','written','recorded','completed')
   AND(s.tenant_id=(before_row->>'tenant_id')::uuid AND s.receipt_subject_id=(before_row->>'id')::uuid OR s.tenant_id=(after_row->>'tenant_id')::uuid AND s.receipt_subject_id=(after_row->>'id')::uuid) LOOP
   IF r.catalogue_native_phase='armed' AND TG_OP='UPDATE'
    AND(before_row->>'id')::uuid=r.receipt_subject_id AND(before_row->>'tenant_id')::uuid=r.tenant_id AND(before_row->>'company_id')::uuid=r.company_id THEN
    -- BEFORE admits only the actual nominated preimage, not unrelated OLD retargeted into it.
    -- The AFTER observer independently checks that original OLD against the persisted closed delta.
    IF(kind='org.position.archive' AND(before_row->>'archived_at' IS NOT NULL)<>r.position_archive_desired)
     OR(kind='org.department.archive' AND(before_row->>'archived_at' IS NOT NULL)<>r.department_archive_desired)
     OR(kind='org.employee_id_template.status' AND before_row->>'status'<>r.employee_id_template_desired_status) THEN CONTINUE;END IF;
   END IF;
   IF TG_WHEN='AFTER' AND TG_OP='UPDATE' THEN
    -- The observer can precede this fence on the initial UPDATE. Only the observer's exact
    -- persisted physical version is allowed, not a later no-op/rewrite with the same xmin.
    IF kind='org.position.archive' THEN SELECT p.ctid INTO physical FROM public.position p WHERE id=(after_row->>'id')::uuid AND tenant_id=r.tenant_id AND xmin=pg_current_xact_id()::xid;
    ELSIF kind='org.department.archive' THEN SELECT p.ctid INTO physical FROM public.department p WHERE id=(after_row->>'id')::uuid AND tenant_id=r.tenant_id AND xmin=pg_current_xact_id()::xid;
    ELSE SELECT p.ctid INTO physical FROM public.employee_id_config p WHERE id=(after_row->>'id')::uuid AND tenant_id=r.tenant_id AND xmin=pg_current_xact_id()::xid;END IF;
    IF physical IS NOT NULL AND physical=r.catalogue_native_tid THEN CONTINUE;END IF;
   ELSIF TG_WHEN='BEFORE' AND TG_OP='UPDATE' AND before_row IS NOT DISTINCT FROM after_row THEN CONTINUE;
   END IF;
   RAISE EXCEPTION 'Catalogue root native effect changed' USING ERRCODE='42501';
  END LOOP;
 END IF;
 IF TG_WHEN='BEFORE' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_root_fence() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_position_root_before BEFORE UPDATE OR DELETE ON public.position FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_position_root_after AFTER INSERT OR UPDATE OR DELETE ON public.position FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_department_root_before BEFORE UPDATE OR DELETE ON public.department FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_department_root_after AFTER INSERT OR UPDATE OR DELETE ON public.department FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_template_root_before BEFORE UPDATE OR DELETE ON public.employee_id_config FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_template_root_after AFTER INSERT OR UPDATE OR DELETE ON public.employee_id_config FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_event_root_before BEFORE DELETE ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_event_root_after AFTER INSERT OR UPDATE OR DELETE ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_root_fence();
--> statement-breakpoint


-- Bounded semantic dependency set: exact origin company; selected label's explicit Criteria rows;
-- selected department's existing BU/head rows. Parent POINTER is in the protected department row.
-- No unrelated company/label, tenant authority table, global epoch or unrelated employment freeze.
CREATE FUNCTION app._assistant_catalogue_dependency_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;r app.assistant_own_leave_review%ROWTYPE;matches boolean;
BEGIN
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW);END IF;
 FOR r IN SELECT * FROM app.assistant_own_leave_review WHERE catalogue_native_root=pg_current_xact_id()
 AND catalogue_native_phase IN('armed','written','recorded','completed') AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') LOOP
  matches:=false;
  IF TG_RELID='public.company'::regclass THEN matches:=(r.company_id IN((before_row->>'id')::uuid,(after_row->>'id')::uuid));
  ELSIF TG_RELID='public.label_company_assignment'::regclass THEN
   matches:=(r.action_kind='org.position.archive' AND(before_row->>'label_kind'='position' AND r.receipt_subject_id=(before_row->>'label_id')::uuid OR after_row->>'label_kind'='position' AND r.receipt_subject_id=(after_row->>'label_id')::uuid))
    OR(r.action_kind='org.department.archive' AND(before_row->>'label_kind'='department' AND r.receipt_subject_id=(before_row->>'label_id')::uuid OR after_row->>'label_kind'='department' AND r.receipt_subject_id=(after_row->>'label_id')::uuid));
  ELSIF TG_RELID='public.business_unit'::regclass THEN
   SELECT EXISTS(SELECT 1 FROM public.department d WHERE r.action_kind='org.department.archive' AND d.id=r.receipt_subject_id AND d.tenant_id=r.tenant_id AND d.business_unit_id IN((before_row->>'id')::uuid,(after_row->>'id')::uuid)) INTO matches;
  ELSIF TG_RELID='public.employment'::regclass THEN
   SELECT EXISTS(SELECT 1 FROM public.department d WHERE r.action_kind='org.department.archive' AND d.id=r.receipt_subject_id AND d.tenant_id=r.tenant_id AND d.head_employment_id IN((before_row->>'id')::uuid,(after_row->>'id')::uuid)) INTO matches;
  ELSE RAISE EXCEPTION 'Catalogue dependency guard unavailable' USING ERRCODE='42501';END IF;
  IF matches AND(r.tenant_id IN((before_row->>'tenant_id')::uuid,(after_row->>'tenant_id')::uuid))
   AND(TG_OP<>'UPDATE' OR before_row IS DISTINCT FROM after_row) THEN RAISE EXCEPTION 'Catalogue root dependency changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_WHEN='BEFORE' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;RETURN NULL;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_dependency_fence() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_company_dependency_before BEFORE UPDATE OR DELETE ON public.company FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_company_dependency_after AFTER INSERT OR UPDATE OR DELETE ON public.company FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_criteria_dependency_before BEFORE UPDATE OR DELETE ON public.label_company_assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_criteria_dependency_after AFTER INSERT OR UPDATE OR DELETE ON public.label_company_assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_bu_dependency_before BEFORE UPDATE OR DELETE ON public.business_unit FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_bu_dependency_after AFTER INSERT OR UPDATE OR DELETE ON public.business_unit FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_head_dependency_before BEFORE UPDATE OR DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_head_dependency_after AFTER INSERT OR UPDATE OR DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_dependency_fence();

--> statement-breakpoint

-- COMPOSITION COMPONENT: verify-interval.sql
-- PRIVATE actual-root verifier, not app-callable. Independent OLD->actual NEW was checked by the
-- native observer; this checks the protected physical/event correlate before AND after completion.
CREATE FUNCTION app._assistant_catalogue_interval_verified(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r JOIN public.domain_event e ON e.id=r.catalogue_native_event AND e.tenant_id=r.tenant_id
 WHERE r.id=p_id AND r.catalogue_native_root=pg_current_xact_id() AND r.catalogue_native_phase IN('recorded','completed')
 AND r.user_id=app.current_user_id() AND e.actor_type='user' AND e.actor_id=r.user_id AND e.subject_employment_id IS NULL
 AND e.aggregate_id=r.receipt_subject_id AND e.xmin=pg_current_xact_id()::xid AND e.occurred_at=transaction_timestamp()
 AND CASE r.action_kind
 WHEN 'org.position.archive' THEN EXISTS(SELECT 1 FROM public.position p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND(p.archived_at IS NOT NULL)=r.position_archive_desired
  AND e.aggregate_type='position' AND e.event_type='position.updated' AND e.payload=jsonb_build_object('title',p.title,'archived',r.position_archive_desired))
 WHEN 'org.department.archive' THEN EXISTS(SELECT 1 FROM public.department p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND(p.archived_at IS NOT NULL)=r.department_archive_desired
  AND e.aggregate_type='department' AND e.event_type='department.updated' AND e.payload=jsonb_build_object('name',p.name,'archived',r.department_archive_desired))
 WHEN 'org.employee_id_template.status' THEN EXISTS(SELECT 1 FROM public.employee_id_config p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND p.status=r.employee_id_template_desired_status
  AND e.aggregate_type='employee-id-config' AND e.event_type=CASE r.employee_id_template_desired_status WHEN 'active' THEN 'employee-id-config.activated' ELSE 'employee-id-config.deactivated' END
  AND e.payload=jsonb_build_object('status',r.employee_id_template_desired_status)) ELSE false END);
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_interval_verified(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint

-- COMPOSITION COMPONENT: 0733_assistant_position_archive_custody.sql command only
CREATE OR REPLACE FUNCTION app.assistant_position_archive_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_position uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired boolean DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.position p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.position.archive' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND app.is_admin_for(p.company_id) AND NOT p.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=t AND a.label_kind='position' AND a.label_id=p.id AND a.company_id<>p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.position_archive_grid_source(p_position);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired=(source->>'archived')::boolean OR(p_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.position.archive' AND receipt_subject_id=p_position AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.position.archive' AND expired.receipt_subject_id=p_position AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,position_archive_desired,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.position.archive',p_id,t,u,p_person,p_company,'position',p_position,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_position_archive_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.position.archive';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.position.archive' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.position_archive_grid_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('positionId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.position_archive_grid_current_event(r.receipt_subject_id,r.position_archive_desired) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.position_archive_grid_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.position_archive_grid_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_position_archive_json(p_id);
END $$;
--> statement-breakpoint

-- COMPOSITION COMPONENT: 0743_assistant_department_archive_custody.sql command only
CREATE OR REPLACE FUNCTION app.assistant_department_archive_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_department uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired boolean DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.department p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.department.archive' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND app.is_admin_for(p.company_id) AND NOT p.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=t AND a.label_kind='department' AND a.label_id=p.id AND a.company_id<>p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.department_archive_grid_source(p_department);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired=(source->>'archived')::boolean OR(p_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.department.archive' AND receipt_subject_id=p_department AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.department.archive' AND expired.receipt_subject_id=p_department AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,department_archive_desired,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.department.archive',p_id,t,u,p_person,p_company,'department',p_department,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_department_archive_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.department_archive_grid_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('departmentId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.department_archive_grid_current_event(r.receipt_subject_id,r.department_archive_desired) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.department_archive_grid_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.department_archive_grid_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_department_archive_json(p_id);
END $$;
--> statement-breakpoint

-- COMPOSITION COMPONENT: 0745_assistant_employee_id_template_status_custody.sql command only
CREATE OR REPLACE FUNCTION app.assistant_employee_id_template_status_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_config uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired text DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.employee_id_config p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.employee_id_template.status' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND p.company_id IS NOT NULL AND app.is_admin_for(p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.employee_id_template_status_source(p_config);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired NOT IN('active','inactive') OR p_desired=source->>'status' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' AND receipt_subject_id=p_config AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.employee_id_template.status' AND expired.receipt_subject_id=p_config AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,employee_id_template_desired_status,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.employee_id_template.status',p_id,t,u,p_person,p_company,'employee_id_config',p_config,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_employee_id_template_status_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.employee_id_template_status_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('configId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.employee_id_template_status_current_event(r.receipt_subject_id,r.employee_id_template_desired_status) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.employee_id_template_status_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.employee_id_template_status_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_employee_id_template_status_json(p_id);
END $$;
--> statement-breakpoint

--> statement-breakpoint
-- Catalogue audit-slot closure: original reviewed V3 prefix retained EXACT, this0864 is UNAPPLIED.
-- Shared V6 helpers/Bank observer are predecessors; root owns final allocation/integration/runtime.

-- REVIEWED COMPONENT schema.sql
-- CONDITIONAL PRIVATE PORT ONLY. UNALLOCATED / UNADOPTED / UNRUN.
-- Requires exact root-cleared canonical Bank V6 API; this purpose/schema/test packet needs review.
ALTER TABLE app.assistant_own_leave_review ADD COLUMN catalogue_audit_preimage jsonb;
--> statement-breakpoint


-- Never invent a PRE-native fact for an old unsupported committed nomination. Parent first;
-- retire pending control metadata/body only, preserving actual native objects/events and history.
DO $retire_legacy$ DECLARE item record;BEGIN
 FOR item IN SELECT id FROM app.assistant_own_leave_review
  WHERE action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  AND state<>'completed' AND catalogue_native_phase IN('armed','written','recorded') AND catalogue_audit_preimage IS NULL
  ORDER BY id FOR UPDATE NOWAIT LOOP
  UPDATE app.assistant_own_leave_review SET
   state=CASE WHEN state='awaiting_confirmation' THEN 'refused' ELSE state END,
   intent_digest=NULL,reviewed_digest=NULL,
   catalogue_native_phase=NULL,catalogue_native_root=NULL,catalogue_native_event=NULL,catalogue_native_tid=NULL
  WHERE id=item.id;
  -- A separate command observes the cleared parent before invoking the existing body DELETE trigger.
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=item.id;
 END LOOP;
END $retire_legacy$;
--> statement-breakpoint


ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_catalogue_audit_preimage CHECK((
 CASE WHEN action_kind NOT IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  OR catalogue_native_phase IS NULL THEN catalogue_audit_preimage IS NULL
 ELSE
  -- Legacy completed=NULL is retained, never backfilled; new-qualified history safely refuses it.
  (catalogue_native_phase='completed' AND state='completed' AND catalogue_audit_preimage IS NULL)
  OR(catalogue_audit_preimage IS NOT NULL AND jsonb_typeof(catalogue_audit_preimage)='object'
   AND catalogue_audit_preimage ?& ARRAY['armed','priorSeq','priorHash']
   AND catalogue_audit_preimage-ARRAY['armed','priorSeq','priorHash']='{}'::jsonb
   AND jsonb_typeof(catalogue_audit_preimage->'armed')='boolean'
   AND CASE WHEN catalogue_audit_preimage->'armed'='false'::jsonb THEN
    catalogue_audit_preimage->'priorSeq'='null'::jsonb AND catalogue_audit_preimage->'priorHash'='null'::jsonb
   ELSE (catalogue_audit_preimage->'priorSeq'='null'::jsonb AND catalogue_audit_preimage->'priorHash'='null'::jsonb)
    OR(jsonb_typeof(catalogue_audit_preimage->'priorSeq')='number'
     AND catalogue_audit_preimage->>'priorSeq' ~ '^[1-9][0-9]*$'
     AND length(catalogue_audit_preimage->>'priorSeq')<=19
     AND (length(catalogue_audit_preimage->>'priorSeq')<19 OR catalogue_audit_preimage->>'priorSeq'<='9223372036854775807')
     AND jsonb_typeof(catalogue_audit_preimage->'priorHash')='string'
     AND catalogue_audit_preimage->>'priorHash' ~ '^[a-f0-9]{64}$') END)
 END) IS TRUE);

--> statement-breakpoint

-- REVIEWED COMPONENT preimage-guard.sql
CREATE FUNCTION app._assistant_catalogue_audit_preimage_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'Catalogue audit guard unavailable' USING ERRCODE='42501';END IF;
 -- Foreign kinds remain owned by their named NULL CHECK, including JSON null poison.
 IF NEW.action_kind NOT IN('org.position.archive','org.department.archive','org.employee_id_template.status') THEN
  IF TG_OP='INSERT' THEN IF TG_WHEN='BEFORE' THEN RETURN NEW;ELSE RETURN NULL;END IF;
  ELSIF OLD.action_kind NOT IN('org.position.archive','org.department.archive','org.employee_id_template.status') THEN
   IF TG_WHEN='BEFORE' THEN RETURN NEW;ELSE RETURN NULL;END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.catalogue_audit_preimage IS NOT NULL THEN RAISE EXCEPTION 'Catalogue audit preimage immutable' USING ERRCODE='42501';END IF;
 ELSIF NEW.catalogue_audit_preimage IS DISTINCT FROM OLD.catalogue_audit_preimage THEN
  IF OLD.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
   AND NEW.action_kind=OLD.action_kind AND OLD.state='awaiting_confirmation' AND NEW.state=OLD.state
   AND OLD.catalogue_native_phase IS NULL AND OLD.catalogue_native_root IS NULL AND OLD.catalogue_native_event IS NULL AND OLD.catalogue_native_tid IS NULL
   AND OLD.catalogue_audit_preimage IS NULL AND NEW.catalogue_native_phase='armed' AND NEW.catalogue_native_root=pg_current_xact_id()
   AND NEW.catalogue_native_event IS NULL AND NEW.catalogue_native_tid IS NULL
   AND NEW.catalogue_audit_preimage IS NOT DISTINCT FROM app._domain_event_next(OLD.tenant_id,true) THEN NULL;
  ELSIF OLD.state<>'completed' AND NEW.state<>'completed' AND NEW.catalogue_audit_preimage IS NULL
   AND NEW.catalogue_native_phase IS NULL AND NEW.catalogue_native_root IS NULL AND NEW.catalogue_native_event IS NULL AND NEW.catalogue_native_tid IS NULL
   AND NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=OLD.id) THEN NULL;
  ELSE RAISE EXCEPTION 'Catalogue audit preimage immutable' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_WHEN='BEFORE' THEN RETURN NEW;END IF;RETURN NULL;
END $$;
--> statement-breakpoint

DO $purpose_owner$ DECLARE owner_name name;BEGIN
 SELECT r.rolname INTO STRICT owner_name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='app._assistant_catalogue_native_phase(uuid,text,tid,uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app._assistant_catalogue_audit_preimage_guard() OWNER TO %I',owner_name);
END $purpose_owner$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_audit_preimage_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint


CREATE TRIGGER assistant_catalogue_audit_preimage_before BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_audit_preimage_guard();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_audit_preimage_after AFTER INSERT OR UPDATE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_audit_preimage_guard();

--> statement-breakpoint

-- REVIEWED COMPONENT audit-dependency-guard.sql
CREATE FUNCTION app._assistant_catalogue_audit_dependency_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;r app.assistant_own_leave_review%ROWTYPE;selected_event public.domain_event%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.domain_event'::regclass OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
  RAISE EXCEPTION 'Catalogue audit dependency unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW);END IF;
 FOR r IN SELECT * FROM app.assistant_own_leave_review s
  WHERE s.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  AND s.catalogue_native_root=pg_current_xact_id() AND s.catalogue_native_phase IN('armed','written','recorded','completed')
  AND s.catalogue_audit_preimage IS NOT NULL LOOP
  -- Actual missing tenant is the existing canonical FK parent-deletion route, never a caller hint.
  IF NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=r.tenant_id) THEN CONTINUE;END IF;
  -- Exact protected PRE predecessor; no recomputed hash, sequence arithmetic or post-event head.
  IF r.catalogue_audit_preimage->'priorSeq'<>'null'::jsonb AND(
   (r.tenant_id=(before_row->>'tenant_id')::uuid AND before_row->'chain_seq'=r.catalogue_audit_preimage->'priorSeq')
   OR(r.tenant_id=(after_row->>'tenant_id')::uuid AND after_row->'chain_seq'=r.catalogue_audit_preimage->'priorSeq')) THEN
   RAISE EXCEPTION 'Catalogue audit predecessor changed' USING ERRCODE='42501';END IF;
  -- Before observation, PRE equality and the shared decoder must detect genuine interposition.
  -- Once recorded, protect only the actual selected generated slot against a different row.
  IF r.catalogue_native_phase IN('recorded','completed') THEN
   SELECT * INTO selected_event FROM public.domain_event WHERE id=r.catalogue_native_event AND tenant_id=r.tenant_id;
   IF FOUND AND selected_event.chain_seq IS NOT NULL AND(
    (r.tenant_id=(before_row->>'tenant_id')::uuid AND (before_row->>'id')::uuid<>selected_event.id
      AND before_row->'chain_seq'=to_jsonb(selected_event.chain_seq))
    OR(r.tenant_id=(after_row->>'tenant_id')::uuid AND (after_row->>'id')::uuid<>selected_event.id
      AND after_row->'chain_seq'=to_jsonb(selected_event.chain_seq))) THEN
    RAISE EXCEPTION 'Catalogue audit selected position changed' USING ERRCODE='42501';END IF;
  END IF;
 END LOOP;
 IF TG_WHEN='BEFORE' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;RETURN NULL;
END $$;
--> statement-breakpoint

DO $purpose_owner$ DECLARE owner_name name;BEGIN
 SELECT r.rolname INTO STRICT owner_name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='app._assistant_catalogue_native_phase(uuid,text,tid,uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app._assistant_catalogue_audit_dependency_guard() OWNER TO %I',owner_name);
END $purpose_owner$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_audit_dependency_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint


-- Sort AFTER canonical domain_event_chain_tg: native supplied slots normalize before this guard.
CREATE TRIGGER domain_event_native_catalogue_audit_dependency_before BEFORE INSERT OR UPDATE OR DELETE ON public.domain_event
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_audit_dependency_guard();
--> statement-breakpoint

CREATE TRIGGER assistant_catalogue_audit_dependency_after AFTER INSERT OR UPDATE OR DELETE ON public.domain_event
FOR EACH ROW EXECUTE FUNCTION app._assistant_catalogue_audit_dependency_guard();

--> statement-breakpoint

-- REVIEWED COMPONENT native-owner-frame-guard.sql
-- CONDITIONAL V6 shared-owner consumer. No NEW/caller-event filter selects protected relevance.
CREATE FUNCTION app._assistant_catalogue_audit_owner_frame_guard() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 FOR r IN SELECT q.* FROM app.assistant_own_leave_review q
  WHERE q.action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  AND q.state='awaiting_confirmation' AND q.catalogue_native_root=pg_current_xact_id()
  AND q.catalogue_native_phase IN('armed','written','recorded') AND q.catalogue_audit_preimage IS NOT NULL LOOP
  -- Purpose arm already owns this native key. No caller bool/tenant/actor/event chooses relevance.
  IF app._domain_event_next(r.tenant_id,true) IS DISTINCT FROM r.catalogue_audit_preimage THEN
   RAISE EXCEPTION 'Catalogue audit decision changed before native INSERT' USING ERRCODE='42501';END IF;
 END LOOP;
END $$;
--> statement-breakpoint

DO $native_owner$ DECLARE owner_name name;BEGIN
 SELECT r.rolname INTO STRICT owner_name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='app.domain_event_chain_tg()'::regprocedure;
 EXECUTE format('ALTER FUNCTION app._assistant_catalogue_audit_owner_frame_guard() OWNER TO %I',owner_name);
END $native_owner$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app._assistant_catalogue_audit_owner_frame_guard() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint

-- REVIEWED COMPONENT phase-replacement.sql
CREATE OR REPLACE FUNCTION app._assistant_catalogue_native_phase(p_id uuid,p_phase text,p_tid tid DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;expected jsonb;actual jsonb;root xid8:=pg_current_xact_id();audit_pre jsonb;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR r.action_kind NOT IN('org.position.archive','org.department.archive','org.employee_id_template.status')
  OR r.state<>'awaiting_confirmation' OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 IF p_phase='armed' THEN
  IF r.catalogue_native_phase IS NOT NULL OR p_tid IS NOT NULL OR p_event IS NOT NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_phase='written' THEN
  IF r.catalogue_native_phase IS DISTINCT FROM 'armed' OR r.catalogue_native_root IS DISTINCT FROM root OR p_tid IS NULL OR p_event IS NOT NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_phase='recorded' THEN
  IF r.catalogue_native_phase IS DISTINCT FROM 'written' OR r.catalogue_native_root IS DISTINCT FROM root OR p_tid IS DISTINCT FROM r.catalogue_native_tid OR p_event IS NULL THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 IF p_phase='armed' THEN
  -- Pinned shared V6 canonical owner; never substitute a local algorithm or caller JSON.
  audit_pre:=app._domain_event_next(r.tenant_id,true);
 ELSE audit_pre:=r.catalogue_audit_preimage;END IF;
 IF audit_pre IS NULL THEN RAISE EXCEPTION 'Catalogue audit preimage unavailable' USING ERRCODE='42501';END IF;
 expected:=to_jsonb(r)||jsonb_build_object('catalogue_native_phase',p_phase,'catalogue_native_root',root,'catalogue_native_tid',p_tid,'catalogue_native_event',p_event,'catalogue_audit_preimage',audit_pre);
 UPDATE app.assistant_own_leave_review SET catalogue_native_phase=p_phase,catalogue_native_root=root,catalogue_native_tid=p_tid,catalogue_native_event=p_event,catalogue_audit_preimage=audit_pre WHERE id=r.id;
 SELECT to_jsonb(saved) INTO actual FROM app.assistant_own_leave_review saved WHERE id=r.id;
 IF actual IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Catalogue interval postimage changed' USING ERRCODE='42501';END IF;
 IF p_phase='armed' AND app._domain_event_next(r.tenant_id,true) IS DISTINCT FROM audit_pre THEN
  RAISE EXCEPTION 'Catalogue audit preimage changed while arming' USING ERRCODE='42501';END IF;
END $$;

--> statement-breakpoint

-- REVIEWED COMPONENT body-retirement-replacement.sql
CREATE OR REPLACE FUNCTION app._assistant_catalogue_body_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID<>'app.assistant_own_leave_review_content'::regclass THEN RAISE EXCEPTION 'Catalogue cleanup unavailable' USING ERRCODE='42501';END IF;
 -- DELETE is deliberately outside central0861 (INSERT/UPDATE only). The body tuple can
 -- already be owned here; a blocking UPDATE would invert parent->body ordering. Acquire the
 -- exact live parent FOR UPDATE NOWAIT FIRST, including the upgrade from a competing SHARE.
 -- Missing/cascaded parent, another kind, completed or already-clear nomination remains a no-op.
 PERFORM 1 FROM app.assistant_own_leave_review WHERE id=OLD.action_id AND state<>'completed'
 AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') AND catalogue_native_phase IS NOT NULL
 FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE app.assistant_own_leave_review SET catalogue_native_phase=NULL,catalogue_native_root=NULL,catalogue_native_event=NULL,catalogue_native_tid=NULL,catalogue_audit_preimage=NULL
 WHERE id=OLD.action_id AND state<>'completed' AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status') AND catalogue_native_phase IS NOT NULL;
 RETURN NULL;
END $$;

--> statement-breakpoint

-- REVIEWED COMPONENT interval-verifier-replacement.sql
CREATE OR REPLACE FUNCTION app._assistant_catalogue_interval_verified(p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE native_ok boolean;saved app.assistant_own_leave_review%ROWTYPE;actual_event public.domain_event%ROWTYPE;candidate jsonb;
BEGIN
 -- Only call this after native INSERT/appendEvent RETURNS. It is not an AFTER INSERT witness.
 native_ok:=(SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r JOIN public.domain_event e ON e.id=r.catalogue_native_event AND e.tenant_id=r.tenant_id
 WHERE r.id=p_id AND r.catalogue_native_root=pg_current_xact_id() AND r.catalogue_native_phase IN('recorded','completed')
 AND r.user_id=app.current_user_id() AND e.actor_type='user' AND e.actor_id=r.user_id AND e.subject_employment_id IS NULL
 AND e.aggregate_id=r.receipt_subject_id AND e.xmin=pg_current_xact_id()::xid AND e.occurred_at=transaction_timestamp()
 AND CASE r.action_kind
 WHEN 'org.position.archive' THEN EXISTS(SELECT 1 FROM public.position p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND(p.archived_at IS NOT NULL)=r.position_archive_desired
  AND e.aggregate_type='position' AND e.event_type='position.updated' AND e.payload=jsonb_build_object('title',p.title,'archived',r.position_archive_desired))
 WHEN 'org.department.archive' THEN EXISTS(SELECT 1 FROM public.department p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND(p.archived_at IS NOT NULL)=r.department_archive_desired
  AND e.aggregate_type='department' AND e.event_type='department.updated' AND e.payload=jsonb_build_object('name',p.name,'archived',r.department_archive_desired))
 WHEN 'org.employee_id_template.status' THEN EXISTS(SELECT 1 FROM public.employee_id_config p WHERE p.id=r.receipt_subject_id AND p.tenant_id=r.tenant_id AND p.company_id=r.company_id
  AND p.ctid=r.catalogue_native_tid AND p.xmin=pg_current_xact_id()::xid AND p.status=r.employee_id_template_desired_status
  AND e.aggregate_type='employee-id-config' AND e.event_type=CASE r.employee_id_template_desired_status WHEN 'active' THEN 'employee-id-config.activated' ELSE 'employee-id-config.deactivated' END
  AND e.payload=jsonb_build_object('status',r.employee_id_template_desired_status)) ELSE false END));
 IF native_ok IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO saved FROM app.assistant_own_leave_review WHERE id=p_id;
 IF NOT FOUND OR saved.catalogue_audit_preimage IS NULL THEN RETURN false;END IF;
 SELECT * INTO actual_event FROM public.domain_event WHERE id=saved.catalogue_native_event AND tenant_id=saved.tenant_id;
 IF NOT FOUND THEN RETURN false;END IF;
 -- Candidate is qualified by the reviewed canonical owner, NOT used as its own expected fact.
 -- Exact V6 private decoder is root-cleared; this new purpose integration still needs review.
 candidate:=app._domain_event_preimage_for(actual_event);
 RETURN candidate IS NOT NULL AND candidate IS NOT DISTINCT FROM saved.catalogue_audit_preimage;
END $$;

--> statement-breakpoint

-- REVIEWED COMPONENT commands-replacement.sql
CREATE OR REPLACE FUNCTION app.assistant_position_archive_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_position uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired boolean DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.position p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.position.archive' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND app.is_admin_for(p.company_id) AND NOT p.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=t AND a.label_kind='position' AND a.label_id=p.id AND a.company_id<>p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.position_archive_grid_source(p_position);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired=(source->>'archived')::boolean OR(p_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.position.archive' AND receipt_subject_id=p_position AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.position.archive' AND expired.receipt_subject_id=p_position AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,position_archive_desired,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.position.archive',p_id,t,u,p_person,p_company,'position',p_position,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_position_archive_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.position.archive';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.position.archive' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.position_archive_grid_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('positionId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id OR r.catalogue_audit_preimage IS NULL) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.position_archive_grid_current_event(r.receipt_subject_id,r.position_archive_desired) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.position_archive_grid_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.position_archive_grid_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_position_archive_json(p_id);
END $$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION app.assistant_department_archive_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_department uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired boolean DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.department p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.department.archive' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND app.is_admin_for(p.company_id) AND NOT p.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=t AND a.label_kind='department' AND a.label_id=p.id AND a.company_id<>p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.department_archive_grid_source(p_department);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired=(source->>'archived')::boolean OR(p_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.department.archive' AND receipt_subject_id=p_department AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.department.archive' AND expired.receipt_subject_id=p_department AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,department_archive_desired,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.department.archive',p_id,t,u,p_person,p_company,'department',p_department,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_department_archive_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.department_archive_grid_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('departmentId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id OR r.catalogue_audit_preimage IS NULL) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.department_archive_grid_current_event(r.receipt_subject_id,r.department_archive_desired) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.department_archive_grid_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.department_archive_grid_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_department_archive_json(p_id);
END $$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION app.assistant_employee_id_template_status_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_config uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired text DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;

 expected_ledger jsonb;actual_ledger jsonb;expected_native jsonb;expected_event jsonb;actual_event jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.employee_id_config p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.employee_id_template.status' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND p.company_id IS NOT NULL AND app.is_admin_for(p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.employee_id_template_status_source(p_config);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired NOT IN('active','inactive') OR p_desired=source->>'status' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' AND receipt_subject_id=p_config AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.employee_id_template.status' AND expired.receipt_subject_id=p_config AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,employee_id_template_desired_status,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.employee_id_template.status',p_id,t,u,p_person,p_company,'employee_id_config',p_config,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_employee_id_template_status_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.employee_id_template_status_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('configId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF r.state='completed' AND(r.catalogue_native_phase IS DISTINCT FROM 'completed' OR r.catalogue_native_root IS NULL OR r.catalogue_native_event IS DISTINCT FROM r.receipt_event_id OR r.catalogue_audit_preimage IS NULL) THEN RAISE EXCEPTION 'Catalogue completed provenance unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.employee_id_template_status_current_event(r.receipt_subject_id,r.employee_id_template_desired_status) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
   IF r.catalogue_native_phase IS DISTINCT FROM 'recorded' OR r.catalogue_native_root IS DISTINCT FROM pg_current_xact_id()
    OR r.catalogue_native_event IS DISTINCT FROM p_event OR NOT app._assistant_catalogue_interval_verified(r.id) THEN RAISE EXCEPTION 'Catalogue actual native proof unavailable' USING ERRCODE='42501';END IF;
   expected_native:=app.employee_id_template_status_source(r.receipt_subject_id);
   SELECT to_jsonb(e) INTO expected_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
   expected_ledger:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event,'catalogue_native_phase','completed');
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,catalogue_native_phase='completed' WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF expected_ledger IS NOT NULL THEN
  SELECT to_jsonb(saved) INTO actual_ledger FROM app.assistant_own_leave_review saved WHERE saved.id=r.id;
  SELECT to_jsonb(e) INTO actual_event FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=r.tenant_id;
  IF clock_timestamp()>=r.expires_at OR actual_ledger IS DISTINCT FROM expected_ledger OR actual_event IS DISTINCT FROM expected_event
   OR app.employee_id_template_status_source(r.receipt_subject_id) IS DISTINCT FROM expected_native OR NOT app._assistant_catalogue_interval_verified(r.id)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
   RAISE EXCEPTION 'Catalogue completion postimage changed' USING ERRCODE='42501';
  END IF;
 END IF;

 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_employee_id_template_status_json(p_id);
END $$;

--> statement-breakpoint

-- REVIEWED COMPONENT shared-native-trigger-composition.sql
-- Exact cleared Bank V6 owner definition plus ONE closed Catalogue observer; no algorithm fork.
CREATE OR REPLACE FUNCTION app.domain_event_chain_tg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pre jsonb;
BEGIN
 pre:=app._domain_event_next(NEW.tenant_id);
 PERFORM app._bank_audit_owner_frame_guard();
 PERFORM app._assistant_catalogue_audit_owner_frame_guard();
 IF NOT (pre->>'armed')::boolean THEN RETURN NEW;END IF;
 NEW.chain_seq:=coalesce((pre->>'priorSeq')::bigint,0)+1;
 NEW.prev_hash:=coalesce(pre->>'priorHash','GENESIS');
 NEW.hash:=app.domain_event_hash(NEW.prev_hash,NEW.tenant_id,NEW.chain_seq,NEW.aggregate_type,
  NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload);
 RETURN NEW;
END $$;

--> statement-breakpoint
