-- Probation letters with signing and review routing (lane D2 / W1 of the Probation Confirmation build; ADR
-- docs/adr/2026-11-15-probation-shared-automation.md build step 3; handoff A2). Tag 5752 / idx 5152 / when 1793330005452.
--
-- A Probation letter template version may now carry a signing and review routing (lib/document-signing-routing.ts):
-- rows {order, Review | Approve | Sign, who, owns the document}. A template version without routing, and every letter
-- already prepared, keeps exactly today's behaviour; each replaced function branches on the routing and keeps the
-- previous body otherwise.
--  1. app.probation_definition_save_legacy_organisation (0949 body; 2111 renamed it behind app.probation_definition_save): accepts and checks `routing` on a template version; a routed version
--     publishes with `step:<id>` signature blocks linked to its Sign steps instead of the HR and employee blocks.
--  2. app.probation_prepare_letter (0949 body): a routed version stores its routing on the new letter (letterRouting)
--     with a placeholder route and no required roles, and returns the routing, template key, case owner (the case's
--     PBP) and fallback group (the case's pinned settings fallback group, else the GBS People Ops group).
--  3. app.probation_letter_routing_context(part) and app.probation_letter_freeze_route(part, route, unresolved) (new):
--     the caller resolves the routing on those facts and freezes the route step for step before the signing document is
--     created; unresolved steps stay on the letter and are recorded on the case.
--  4. app.probation_resolve_route_unchecked (5751 body): a routed letter keeps its frozen route (completed steps as
--     signed, a current per-part replacement still moves a pending step).
--  5. app.probation_signing_action_allowed (0949), app.probation_signatures_complete, app.probation_pending_signers
--     (0949): only the current round's send-back holds a document (app.document_signing_returned), and the owner of a
--     routed letter may send it round again (`resent`). For documents never re-sent this is the same as before.
--  6. app.probation_signing_access (5751 body): routed letters are signed by the people their route names, re-sent by
--     their owner and revised by the owner or the pending reviewer (the signing store enforces the edit lock).
--  7. app.probation_letter_transition, app.probation_letter_tasks, app.probation_notification_recipients (0949 bodies):
--     routed letters count Review and Approve decisions and the current round, and a re-sent letter returns to signing.
--  8. app.probation_part_access (0949 body): a routed letter is readable by its owner, the people who acted on it and the
--     holders whose turn it is (as app.document_signing_content_visible), besides the storage runner, PBP and GBS.
-- No table, row, grant or purpose-owned object changes; the two new functions are granted to ai_hr_app and the three
-- new helpers are owner-only.
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_routed(p_data jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_typeof(p_data->'routing')='array' AND jsonb_array_length(p_data->'routing')>0,false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_routing_valid(p_routing jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s jsonb;w jsonb;ids text[]:='{}';owners integer:=0;signs integer:=0;
BEGIN
 IF p_routing IS NULL OR jsonb_typeof(p_routing) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p_routing)=0 THEN RETURN true;END IF;
 IF jsonb_array_length(p_routing)>30 THEN RETURN false;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_routing) LOOP
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF jsonb_typeof(s->'id') IS DISTINCT FROM 'string' OR length(s->>'id') NOT BETWEEN 1 AND 120 OR (s->>'id')=ANY(ids) THEN RETURN false;END IF;
  ids:=array_append(ids,s->>'id');
  IF jsonb_typeof(s->'order') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  IF (s->>'order') !~ '^[0-9]+$' THEN RETURN false;END IF;
  IF (s->>'order')::integer NOT BETWEEN 1 AND 30 THEN RETURN false;END IF;
  IF coalesce(s->>'action','') NOT IN('review','approve','sign') OR jsonb_typeof(s->'owner') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  IF s ? 'pick' AND coalesce(s->>'pick','') NOT IN('any','roundRobin') THEN RETURN false;END IF;
  w:=s->'who';
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF coalesce(w->>'kind','') NOT IN('routing','group','people','employee','directSuperior') THEN RETURN false;END IF;
  IF w->>'kind'='routing' AND coalesce(w->>'routingId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  IF w->>'kind'='group' AND length(coalesce(w->>'groupId','')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
  IF w->>'kind'='people' THEN
   IF jsonb_typeof(w->'userIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(w->'userIds') NOT BETWEEN 1 AND 50 THEN RETURN false;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(w->'userIds') u WHERE jsonb_typeof(u) IS DISTINCT FROM 'string' OR u#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false;END IF;
  END IF;
  IF s->'owner'='true'::jsonb THEN owners:=owners+1;END IF;
  IF s->>'action'='sign' THEN signs:=signs+1;END IF;
 END LOOP;
 RETURN owners<=1 AND signs>=1;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_routing_signatures_ok(p_data jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_typeof(p_data->'blocks')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'routing') s WHERE s->>'action'='sign'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') b WHERE b->>'type'='signature' AND b->>'role'='step:'||(s->>'id')))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') b WHERE b->>'type'='signature'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'routing') s WHERE s->>'action'='sign' AND b->>'role'='step:'||(s->>'id')))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_letter_routed(jsonb),app.probation_letter_routing_valid(jsonb),app.probation_letter_routing_signatures_ok(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_definition_save_legacy_organisation(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;n integer;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('workflow','template') OR p_data->>'module' IS DISTINCT FROM 'probation' OR p_key !~ '^[a-zA-Z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'Named probation builder administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind||p_key,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind) THEN RAISE EXCEPTION 'Probation builder definition changed; reload before saving';END IF;
 IF p_publish AND length(btrim(coalesce(p_data->>'name','')))=0 THEN RAISE EXCEPTION 'Name this probation definition';END IF;
 IF p_publish AND p_kind='workflow' AND (jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps')=0) THEN RAISE EXCEPTION 'Add workflow steps before publishing';END IF;
 IF p_publish AND p_kind='workflow' AND (p_data->'trigger'->>'event' IS NULL OR p_data->'trigger'->>'event' NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','letter_signing_pending','letter_release_pending','letter_returned','overdue_summary') OR jsonb_array_length(p_data->'steps')>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'steps') step WHERE step->>'type' IS DISTINCT FROM 'notify' OR length(btrim(coalesce(step->>'subject',''))) NOT BETWEEN 1 AND 200 OR step->>'subject'~E'[\r\n]' OR length(btrim(coalesce(step->>'body',''))) NOT BETWEEN 1 AND 20000 OR coalesce(step->>'id','')='' OR jsonb_typeof(step->'to') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'to') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'to') r WHERE r NOT IN('employee','lm','hod','pbp','gbs')))) THEN RAISE EXCEPTION 'Complete bounded messages, supported events and scoped recipients';END IF;
 IF p_publish AND p_kind='template' AND (jsonb_typeof(p_data->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'blocks')=0 OR p_data->>'unfinished' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'HR must finish and approve letter wording before publishing';END IF;
 IF p_kind='template' AND (jsonb_typeof(coalesce(p_data->'rules','{}')) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_data->'rules','{}')) rule WHERE rule.key NOT IN('businessGroup','businessUnit','company','department','grade','outcome','extensionNumber') OR jsonb_typeof(rule.value) IS DISTINCT FROM 'array' OR jsonb_array_length(rule.value)>200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value) item WHERE jsonb_typeof(item)<>'string'))) THEN RAISE EXCEPTION 'Use supported bounded probation letter matching rules';END IF;
 -- 5752: a template version may carry signing and review routing (lib/document-signing-routing.ts). Empty or absent
 -- routing keeps every rule below exactly as before.
 IF p_kind='template' AND p_data ? 'routing' AND app.probation_letter_routing_valid(p_data->'routing') IS NOT TRUE THEN RAISE EXCEPTION 'Complete every step of the signing and review routing';END IF;
 IF p_publish AND p_kind='template' THEN PERFORM app.probation_validate_letter_fields(coalesce(p_data->'fields','[]'),'{}'::jsonb,false);IF coalesce(p_data->>'outcome','') NOT IN('confirm','extend','not_confirm') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='text' AND length(btrim(coalesce(block->>'text','')))>0) OR (CASE WHEN app.probation_letter_routed(p_data) THEN app.probation_letter_routing_signatures_ok(p_data) IS NOT TRUE ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='hr') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='employee') END) THEN RAISE EXCEPTION 'Complete the outcome wording and both actual signature blocks';END IF;END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind;
 INSERT INTO probation_builder_definition(tenant_id,company_id,definition_key,kind,version,state,data,created_by) VALUES(app.current_tenant_id(),p_company,p_key,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,p_data,app.current_user_id()) RETURNING id INTO v_id;RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_prepare_letter(p_outcome uuid,p_template uuid,p_merge jsonb,p_expected integer,p_source_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;p probation_part;source jsonb;merged jsonb;rules jsonb;v_part uuid:=gen_random_uuid();basehash text;descriptor jsonb;old_pointer uuid;routed boolean;placeholder jsonb;holders jsonb;fallback text;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RAISE EXCEPTION 'Recorded outcome unavailable';END IF;old_pointer:=o.letter_part_id;IF old_pointer IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_pointer AND tenant_id=o.tenant_id FOR UPDATE;END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF o.letter_part_id IS DISTINCT FROM old_pointer THEN RAISE EXCEPTION 'The letter revision changed; reload before preparing';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.state='release_requested' OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed recorded outcome required';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use a complete published matching template';END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;descriptor:=app.probation_letter_preview(o.id,t.id,p_merge,p_expected);IF descriptor->>'sourceDigest' IS DISTINCT FROM p_source_digest THEN RAISE EXCEPTION 'The letter source changed; preview and render it again';END IF;PERFORM app.probation_validate_letter_fields(descriptor->'fields',descriptor->'merge',true);merged:=descriptor->'merge';
 routed:=app.probation_letter_routed(t.data);
 -- 5752: a routed template version freezes its own routing (resolved by the caller, then app.probation_letter_freeze_route);
 -- the legacy role route below applies only to versions without routing, exactly as before.
 IF routed THEN
 IF app.probation_letter_routing_valid(t.data->'routing') IS NOT TRUE THEN RAISE EXCEPTION 'Complete every step of the signing and review routing';END IF;
 rules:=jsonb_build_object('requiredRoles','[]'::jsonb);
 SELECT jsonb_build_object('version',1,'steps',jsonb_agg(jsonb_build_object('id',s->>'id','role','routing','kind',s->>'action','stage',(s->>'order')::integer,'holderId',NULL,'required',true) ORDER BY (s->>'order')::integer,n)) INTO placeholder FROM jsonb_array_elements(t.data->'routing') WITH ORDINALITY x(s,n);
 ELSE
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 IF rules->'requiredRoles' IS NULL OR jsonb_array_length(rules->'requiredRoles')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'role' NOT IN('pbp','lm','hod','employee') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Letter routes need current source roles and required signers';END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',t.data->'route','actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') staff CROSS JOIN jsonb_array_elements(t.data->'route'->'steps') hr WHERE staff->>'role'='employee' AND hr->>'role'<>'employee' AND (staff->>'stage')::integer<=(hr->>'stage')::integer) THEN RAISE EXCEPTION 'HR signing must precede employee acknowledgement';END IF;
 END IF;
 basehash:=descriptor->>'sourceDigest';
 -- A new draft has its own immutable signing subject; previous signed subjects remain readable history.
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,jsonb_build_object('id',v_part,'documentKind','letter','evaluationPartId',o.part_id,'letterOutcomeId',o.id,'letterTemplateId',t.id,'letterTemplateVersion',t.version,'letterTemplateName',t.data->>'name','letterMerge',merged,'letterBlocks',t.data->'blocks','letterFields',coalesce(t.data->'fields','[]'),'letterBaseHash',basehash,'letterSourceStamp',descriptor->'sourceStamp','letterGuardrails',rules,'route',CASE WHEN routed THEN placeholder ELSE t.data->'route' END,'state','pending_approval','type',0,'cycle',o.revision)||CASE WHEN routed THEN jsonb_build_object('letterRouting',t.data->'routing','letterRoutingPending',true) ELSE '{}'::jsonb END);
 IF o.letter_part_id IS NOT NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=o.letter_part_id AND tenant_id=o.tenant_id;END IF;
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,merge_data=merged,letter_part_id=v_part,state='awaiting_release',revision=revision+1,updated_at=now() WHERE id=o.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(c.tenant_id,v_part,'meta',1,(SELECT data FROM probation_part WHERE id=v_part),app.current_user_id(),'Prepared outcome letter');
 PERFORM app.probation_audit(c.id,v_part,'letter_prepared');
 holders:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=c.tenant_id));
 RETURN app.probation_signing_content(v_part)||CASE WHEN routed THEN jsonb_build_object('routing',t.data->'routing','templateKey',t.definition_key,'caseOwnerId',holders->>'pbp','fallbackGroupId',fallback) ELSE '{}'::jsonb END||jsonb_build_object('partId',v_part,'outcomeRevision',o.revision+1,'route',app.probation_resolved_route(v_part),'guardrails',rules,'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'));
END $$;
--> statement-breakpoint
-- The facts a routed letter's routing resolves against, for the PBP or GBS preparing it (core/probation-letter.ts runs
-- lib/document-signing-routing.ts resolveDocumentRouting on them). Bounded: only the routings and groups the version
-- names, at most 30 steps, 500 members per group and the last 2,000 routed Probation documents for round robin.
CREATE FUNCTION app.probation_letter_routing_context(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;routing jsonb;fallback text;routing_ids uuid[];group_ids text[];result jsonb;title text;bg uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array'
  OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Scoped letter preparer required';END IF;
 routing:=p.data->'letterRouting';h:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t));
 SELECT pos.title INTO title FROM assignment a JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
  WHERE a.employment_id=c.employment_id AND a.tenant_id=t AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1;
 SELECT coalesce(co.parent_company_id,co.id) INTO bg FROM company co WHERE co.id=c.company_id AND co.tenant_id=t;
 SELECT coalesce(array_agg(DISTINCT (s->'who'->>'routingId')::uuid),'{}') INTO routing_ids FROM jsonb_array_elements(routing) s WHERE s->'who'->>'kind'='routing';
 WITH r AS MATERIALIZED (
  SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v
  WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC)
 SELECT array_agg(DISTINCT g) INTO group_ids FROM (
  SELECT s->'who'->>'groupId' AS g FROM jsonb_array_elements(routing) s WHERE s->'who'->>'kind'='group'
  UNION ALL SELECT row->'assignTo'->>'groupId' FROM r CROSS JOIN LATERAL jsonb_array_elements(r.routing_rows) row WHERE NOT r.retired AND row->'assignTo'->>'kind'='group'
  UNION ALL SELECT fallback) x WHERE g IS NOT NULL;
 SELECT jsonb_build_object(
  'employeeUserId',h->>'employee','directSuperiorUserId',h->>'lm','caseOwnerId',h->>'pbp','fallbackGroupId',fallback,
  'facts',jsonb_build_object('businessGroup',h->>'businessUnitId','businessGroupCompany',bg,'company',c.company_id,'department',h->>'departmentId','jobTitle',title),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (
    SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v
    WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC) r WHERE NOT r.retired),'[]'::jsonb),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','members',coalesce((
    SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'[]'::jsonb)))
   FROM lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
   WHERE v.tenant_id=t AND g->>'id'=ANY(coalesce(group_ids,'{}'))),'[]'::jsonb),
  'recent',coalesce((SELECT jsonb_object_agg(x.holder,x.n) FROM (
    SELECT st->>'holderId' AS holder,count(*) AS n FROM (SELECT d.data FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND jsonb_typeof(d.data->'routing')='object' ORDER BY d.created_at DESC LIMIT 2000) recent
    CROSS JOIN LATERAL jsonb_array_elements(recent.data->'route'->'steps') st WHERE st->>'holderId' IS NOT NULL GROUP BY 1) x),'{}'::jsonb)) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
-- Freezes the resolved routing of a just-prepared routed letter before its signing document is created. The route must be
-- the version's routing step for step (id, action, order, owner, who); Employee and Direct Superior steps must be held by
-- the case's own holders unless the fallback group took them (`meantFor`); every holder is an active login of the tenant.
-- Steps nobody could take are kept on the letter (letterRoutingUnresolved) and audited on the case.
CREATE FUNCTION app.probation_letter_freeze_route(p_part uuid,p_route jsonb,p_unresolved jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;s jsonb;r jsonb;expected_role text;cleaned jsonb:='[]'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array' OR p.data->'letterRoutingPending' IS DISTINCT FROM 'true'::jsonb
  OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id)
  OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'A just-prepared routed letter and its scoped preparer are required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF jsonb_typeof(p_route) IS DISTINCT FROM 'object' OR p_route->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p.data->'letterRouting') OR jsonb_typeof(p_unresolved) IS DISTINCT FROM 'array' OR jsonb_array_length(p_unresolved)>30 THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
 h:=app.probation_holders(c.employment_id);
 FOR s IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
  SELECT value INTO r FROM jsonb_array_elements(p.data->'letterRouting') WHERE value->>'id'=s->>'id';
  IF r IS NULL THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  expected_role:=CASE r->'who'->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'routing' THEN 'routing:'||(r->'who'->>'routingId') WHEN 'group' THEN 'group:'||(r->'who'->>'groupId') ELSE 'people' END;
  IF s->>'role' IS DISTINCT FROM expected_role OR s->>'kind' IS DISTINCT FROM r->>'action' OR s->'stage' IS DISTINCT FROM r->'order' OR s->'required' IS DISTINCT FROM 'true'::jsonb
   OR coalesce(s->'owner','false'::jsonb) IS DISTINCT FROM r->'owner' OR s ? 'coveredStepIds' OR s ? 'coveredByStepId' OR s ? 'representedId'
   OR s ? 'meantFor' AND (jsonb_typeof(s->'meantFor') IS DISTINCT FROM 'string' OR length(s->>'meantFor')>300) THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  IF s->>'holderId' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A routed letter step holder is unavailable';END IF;
   IF NOT s ? 'meantFor' AND (r->'who'->>'kind'='employee' AND s->>'holderId' IS DISTINCT FROM h->>'employee' OR r->'who'->>'kind'='directSuperior' AND s->>'holderId' IS DISTINCT FROM h->>'lm'
    OR r->'who'->>'kind'='people' AND NOT (r->'who'->'userIds') ? (s->>'holderId')) THEN RAISE EXCEPTION 'A routed letter step names someone its routing does not';END IF;
  END IF;
  cleaned:=cleaned||jsonb_build_array(s-'holderPersonId');
 END LOOP;
 UPDATE probation_part SET data=(data-'letterRoutingPending')||jsonb_build_object('route',jsonb_build_object('version',1,'steps',cleaned),'letterRoutingUnresolved',p_unresolved),revision=revision+1,updated_at=now() WHERE id=p.id;
 IF jsonb_array_length(p_unresolved)>0 THEN
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.letter_routing_fallback',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,
   jsonb_build_object('caseId',c.id,'partId',p.id,'unresolved',(SELECT jsonb_agg(jsonb_build_object('stepId',x->>'stepId','meantFor',left(coalesce(x->>'meantFor',''),300),'reason',left(coalesce(x->>'reason',''),300),'fallbackGroupId',x->>'fallbackGroupId','holderId',x->>'holderId')) FROM jsonb_array_elements(p_unresolved) x)));
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_resolve_route_unchecked(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE general uuid;p probation_part;c probation_case;holders jsonb;route jsonb;steps jsonb:='[]';step jsonb;delegated probation_delegate;
 holder uuid;identity uuid;seen uuid[]:='{}';represented uuid;alternate uuid;policy jsonb;mode text;covering jsonb;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;stored document_signing_document;historic jsonb;frozen_hash text;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN p.data->'route';END IF;
 -- 5752: a letter generated from a routed template version keeps the route frozen from that version's routing; only a
 -- current per-part replacement (missing holder, holder changed, delegation) moves a step to another person.
 IF p.data->>'documentKind'='letter' AND jsonb_typeof(p.data->'letterRouting')='array' THEN
  SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
  RETURN jsonb_set(p.data->'route','{steps}',coalesce((SELECT jsonb_agg(CASE WHEN h.s IS NOT NULL AND app.document_signing_step_fulfilled(stored.data,h.s) THEN h.s WHEN x.holder_id IS NULL THEN a.s ELSE a.s||jsonb_build_object('holderId',x.holder_id,'representedId',x.represented_id) END ORDER BY a.n)
   FROM jsonb_array_elements(p.data->'route'->'steps') WITH ORDINALITY a(s,n)
   LEFT JOIN LATERAL(SELECT value AS s FROM jsonb_array_elements(stored.data->'route'->'steps') WHERE value->>'id'=a.s->>'id' LIMIT 1) h ON true
   LEFT JOIN LATERAL(SELECT x.holder_id,x.represented_id FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=a.s->>'id' AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
    AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=x.holder_id AND u.tenant_id=x.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) ORDER BY x.created_at DESC,x.id DESC LIMIT 1) x ON true),'[]'::jsonb));
 END IF;
 holders:=app.probation_holders(c.employment_id);route:=p.data->'route';
 -- 5751: a route frozen from form approval rows carries the form version's policy; otherwise the route configuration's.
 policy:=p.data->'routePolicy';
 IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN SELECT data->'duplicateRolePolicy' INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;END IF;
 mode:=coalesce(policy->>'mode','escalate');
 SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 IF stored.id IS NOT NULL THEN frozen_hash:=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(route->'steps') WITH ORDINALITY AS authored(value,ordinal) ORDER BY (value->>'stage')::integer,ordinal LOOP
  step:=step-ARRAY['coveredStepIds','coveredByStepId','holderPersonId','representedId'];general:=NULL;
  SELECT original INTO historic FROM jsonb_array_elements(stored.data->'route'->'steps') original
   WHERE original->>'id'=step->>'id' AND stored.data->>'contentHash'=frozen_hash AND app.document_signing_step_fulfilled(stored.data,original);
  IF historic IS NOT NULL THEN
   steps:=steps||jsonb_build_array(historic);
   IF historic->>'required'='true' AND historic->>'holderPersonId' IS NOT NULL THEN seen:=array_append(seen,(historic->>'holderPersonId')::uuid);END IF;
   CONTINUE;
  END IF;
  holder:=(holders->>(step->>'role'))::uuid;
  SELECT * INTO delegated FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=step->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day)
   AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=probation_delegate.holder_id AND u.tenant_id=probation_delegate.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF delegated.id IS NOT NULL THEN holder:=delegated.holder_id;step:=step||jsonb_build_object('representedId',delegated.represented_id);
   -- 5751 (E4): a step held by a group (GBS People Ops) has no holder until someone is assigned to it on this Part
   -- (missing_holder / holder_changed). Once assigned, that person's general Probation delegation applies exactly as it
   -- does to a Head of Department or PBP holder. An explicit per-part delegation (kind 'delegation') never chains.
   IF delegated.kind IN('missing_holder','holder_changed') AND step->>'role' IN('hod','pbp','gbs') AND step->>'kind' IN('approve','review','sign') THEN
    general:=app.probation_general_delegate(holder,c.employment_id,CASE WHEN step->>'kind'='review' THEN 'probation.review' WHEN p.data->>'documentKind'='letter' THEN 'probation.letter_sign' ELSE 'probation.approve' END);
    IF general IS NOT NULL THEN step:=step||jsonb_build_object('representedId',holder);holder:=general;END IF;
   END IF;
  -- Decision 7: a general delegation with Probation ticked moves a Head of Department, PBP or GBS Review, Approve or
  -- letter Sign step to the delegate, on behalf of the holder. Line Manager and employee steps never move.
  ELSIF holder IS NOT NULL AND step->>'role' IN('hod','pbp','gbs') AND step->>'kind' IN('approve','review','sign') THEN
   general:=app.probation_general_delegate(holder,c.employment_id,CASE WHEN step->>'kind'='review' THEN 'probation.review' WHEN p.data->>'documentKind'='letter' THEN 'probation.letter_sign' ELSE 'probation.approve' END);
   IF general IS NOT NULL THEN step:=step||jsonb_build_object('representedId',holder);holder:=general;END IF;
  END IF;
  SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
  IF step->>'kind'='approve' AND step->>'required'='true' AND identity=ANY(seen) THEN
   covering:=NULL;
   IF mode='sign_once' AND delegated.id IS NULL AND general IS NULL THEN
    SELECT previous INTO covering FROM jsonb_array_elements(steps) previous WHERE previous->>'kind'='approve' AND previous->>'required'='true' AND previous->>'holderId'=holder::text
     AND previous->>'role'<>step->>'role' AND previous->>'coveredByStepId' IS NULL AND previous->'coveredStepIds' IS NULL
     AND (previous->>'stage')::integer<(step->>'stage')::integer
     AND (stored.id IS NULL OR NOT app.document_signing_step_fulfilled(stored.data,previous))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') intervening WHERE intervening->>'required'='true'
      AND intervening->>'id' NOT IN(previous->>'id',step->>'id') AND (intervening->>'stage')::integer BETWEEN (previous->>'stage')::integer AND (step->>'stage')::integer)
     ORDER BY (previous->>'stage')::integer DESC LIMIT 1;
   END IF;
   IF covering IS NOT NULL THEN
    SELECT jsonb_agg(CASE WHEN previous->>'id'=covering->>'id' THEN previous||jsonb_build_object('coveredStepIds',jsonb_build_array(step->>'id')) ELSE previous END ORDER BY ordinal)
    INTO steps FROM jsonb_array_elements(steps) WITH ORDINALITY AS emitted(previous,ordinal);
    step:=step||jsonb_build_object('coveredByStepId',covering->>'id');
   ELSE
    represented:=holder;
    IF mode='named_alternate' THEN
     alternate:=(policy->>'alternateUserId')::uuid;
     SELECT u.person_id INTO identity FROM app_user u WHERE u.id=alternate AND u.tenant_id=c.tenant_id;
     holder:=CASE WHEN identity IS NOT NULL AND NOT(identity=ANY(seen)) AND app.probation_signer_candidate(c.id,alternate) THEN alternate ELSE NULL END;
    ELSE
     holder:=app.probation_escalated_signer(c.id,holder,seen);
    END IF;
    SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
    step:=step||jsonb_build_object('representedId',represented);
   END IF;
  END IF;
  steps:=steps||jsonb_build_array(step||jsonb_build_object('holderId',holder));
  IF step->>'required'='true' AND identity IS NOT NULL THEN seen:=array_append(seen,identity);END IF;
 END LOOP;
 RETURN jsonb_set(route,'{steps}',steps);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_signing_action_allowed(p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;draft jsonb;form jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO d FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR d.id IS NULL OR app.probation_active_user() IS NOT TRUE OR app.probation_case_access(c.id) IS NOT TRUE THEN RETURN false;END IF;
 -- 5752: the owner of a routed letter may send it round again after a send-back (app.document_signing_act checks who).
 IF p_action->>'action'='resent' THEN RETURN p.data->>'documentKind'='letter' AND jsonb_typeof(d.data->'routing')='object';END IF;
 -- Only the current round's send-back holds the document (identical to before for documents that were never re-sent).
 IF app.document_signing_returned(d.data) THEN RETURN false;END IF;
 SELECT value INTO step FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'id'=p_action->>'stepId';IF step IS NULL THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' OR p_action->>'action'<>'signed' OR step->>'role'<>'employee' THEN RETURN true;END IF;
 SELECT data INTO draft FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='employee';SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;
 RETURN coalesce(p_action->>'comment','')=coalesce(draft->>'employeeComments','') AND (p.data->>'type'='1' OR form->>'employeeCommentsRequired' IS DISTINCT FROM 'true' OR length(btrim(coalesce(draft->>'employeeComments','')))>0);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN('create','read','sign','revise','reroute','decline') THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT app.probation_company_entitled(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued','release_requested') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 -- 5752: a routed letter. Its steps are held by the people its routing froze, not by Probation roles. A holder named on the
 -- current route acts at their step; after a send-back only the owner may send it round again; the owner or the pending
 -- reviewer may revise (app.document_signing_store enforces the edit lock).
 IF jsonb_typeof(p.data->'letterRouting')='array' THEN
  SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
  IF p_operation='revise' AND d.id IS NOT NULL THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.document_signing_can_edit(d.data,app.current_user_id());END IF;
  IF p_operation='sign' THEN RETURN d.id IS NOT NULL AND app.probation_letter_source_current(p.id) AND (CASE WHEN app.document_signing_returned(d.data) THEN app.document_signing_owner(d.data)=app.current_user_id() ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE st->>'holderId'=app.current_user_id()::text) END) IS TRUE;END IF;
 END IF;
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') cur WHERE cur->>'id'=st->>'id' AND cur->>'holderId'=app.current_user_id()::text AND cur->>'representedId' IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND (app.probation_part_role(p.id,'lm') OR app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision));END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (step->>'role' IN('hod','pbp') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_part_role(p.id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') current_step WHERE current_step->>'id'=step->>'id' AND current_step->>'holderId'=app.current_user_id()::text) THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;d document_signing_document;event_kind text;roles jsonb;users jsonb;w probation_builder_definition;step jsonb;v_id uuid;v_event uuid;key text;found_workflow boolean:=false;stage integer;h jsonb;step_roles jsonb;step_users jsonb;routed boolean;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id FOR UPDATE;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.letter_part_id IS DISTINCT FROM p.id OR d.id IS NULL OR NOT(app.probation_storage_runner() AND o.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM probation_render_request q WHERE q.tenant_id=p.tenant_id AND q.part_id=p.id AND q.state='sealed' AND q.file_id=o.letter_file_id) OR app.probation_active_user() AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash'))) THEN RAISE EXCEPTION 'Current letter and authenticated transition actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='release_requested' THEN RETURN;END IF;
 routed:=jsonb_typeof(d.data->'routing')='object';
 -- 5752: a routed letter the owner sent round again returns to signing.
 IF routed AND NOT app.document_signing_returned(d.data) AND p.data->>'state'='returned' AND o.released_at IS NULL THEN
  UPDATE probation_part SET data=jsonb_set(data,'{state}','"pending_approval"'),revision=revision+1 WHERE id=p.id;
  UPDATE probation_outcome SET state='awaiting_release',failure=NULL,updated_at=now() WHERE id=o.id AND state='awaiting_revision';
 END IF;
 IF o.released_at IS NOT NULL THEN event_kind:='letter_released';roles:='["employee","lm","pbp"]';
 ELSIF (CASE WHEN routed THEN app.document_signing_returned(d.data) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END) THEN
 event_kind:='letter_returned';roles:='["pbp","gbs"]';UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=p.id AND data->>'state'<>'returned';UPDATE probation_outcome SET state='awaiting_revision',failure='The letter was returned. Prepare a new revision before signing continues.' WHERE id=o.id;
 ELSE
 event_kind:='letter_signing_pending';SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT CASE WHEN routed THEN app.document_signing_step_fulfilled(d.data,s) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END;
 IF stage IS NULL THEN event_kind:='letter_release_pending';roles:=CASE WHEN o.outcome='confirm' THEN '["pbp","gbs"]'::jsonb ELSE '["pbp"]'::jsonb END;ELSE SELECT jsonb_agg(DISTINCT s->>'role'),jsonb_agg(DISTINCT s->>'holderId') INTO roles,users FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL;END IF;
 END IF;
 IF event_kind<>'letter_signing_pending' THEN users:=app.probation_users_for_roles(c.employment_id,roles);END IF;
 IF coalesce(jsonb_array_length(users),0)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'=event_kind AND c.data->'workflowIds'?id::text LOOP
 FOR step IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
 SELECT jsonb_agg(r) INTO step_roles FROM jsonb_array_elements_text(roles) r WHERE step->'to'?r;IF coalesce(jsonb_array_length(step_roles),0)=0 THEN CONTINUE;END IF;
 IF event_kind='letter_signing_pending' THEN SELECT jsonb_agg(DISTINCT st->>'holderId') INTO step_users FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE step_roles?(st->>'role') AND (st->>'stage')::integer=stage AND st->>'holderId' IS NOT NULL;ELSE step_users:=app.probation_users_for_roles(c.employment_id,step_roles);END IF;IF coalesce(jsonb_array_length(step_users),0)=0 THEN CONTINUE;END IF;found_workflow:=true;key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':'||w.id::text||':'||(step->>'id');
 IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,step_users,step_roles,'scheduled',p.revision,v_event,w.id,step->>'id');
 END LOOP;END LOOP;
 -- Even an unconfigured email definition cannot hide the next assigned in-app signing task.
 IF NOT found_workflow THEN key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,v_event);END IF;END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_signatures_complete(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;manager_person text;required jsonb;step jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE subject_type='probation' AND subject_id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;
 IF d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p_part)::text,'UTF8')),'hex') THEN RETURN false;END IF;
 IF app.document_signing_returned(d.data) THEN RETURN false;END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'required'='true' LOOP
 IF NOT app.document_signing_step_fulfilled(d.data,step) THEN RETURN false;END IF;
 END LOOP;
 IF d.guardrails->>'independentApprovalFromRole' IS NOT NULL THEN
 SELECT a->>'actorPersonId' INTO manager_person FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash';
 IF manager_person IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a JOIN jsonb_array_elements(d.data->'route'->'steps') s ON s->>'id'=a->>'stepId' WHERE s->>'kind'='approve' AND a->>'action'='signed' AND a->>'actorPersonId'<>manager_person AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_pending_signers(p_part uuid) RETURNS TABLE(role text,user_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;stage integer;route jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=app.current_tenant_id() AND subject_type='probation' AND subject_id=p_part;IF NOT FOUND OR app.document_signing_returned(d.data) THEN RETURN;END IF;
 route:=app.probation_signing_refresh_route(p_part);
 IF route IS NULL THEN RETURN;END IF;
 SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
 RETURN QUERY SELECT s->>'role',(s->>'holderId')::uuid FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL AND s->>'coveredByStepId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,s);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_tasks(p_case uuid) RETURNS TABLE("partId" uuid,label text,state text,"waitingRole" text,"waitingName" text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.probation_case_access(p_case) IS NOT TRUE THEN RETURN;END IF;
 RETURN QUERY SELECT p.id,coalesce(t.data->>'name','Probation outcome letter'),CASE WHEN o.released_at IS NOT NULL THEN 'released' WHEN o.state='release_requested' THEN 'awaiting_owner_seal' WHEN p.data->>'state'='returned' AND (jsonb_typeof(d.data->'routing') IS DISTINCT FROM 'object' OR app.document_signing_returned(d.data)) THEN 'awaiting_revision' WHEN pending.role IS NULL THEN 'awaiting_release' ELSE 'awaiting_signature' END,CASE WHEN o.released_at IS NOT NULL OR app.probation_case_company_current(c.id) IS NOT TRUE THEN NULL WHEN o.state='release_requested' THEN 'system' ELSE coalesce(pending.role,'pbp') END,CASE WHEN o.state='release_requested' THEN NULL ELSE person.full_name END FROM probation_part p JOIN probation_outcome o ON o.letter_part_id=p.id AND o.tenant_id=p.tenant_id JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id LEFT JOIN probation_builder_definition t ON t.id=(p.data->>'letterTemplateId')::uuid AND t.tenant_id=p.tenant_id LEFT JOIN document_signing_document d ON d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id LEFT JOIN LATERAL(SELECT st->>'role' as role,(st->>'holderId')::uuid as holder FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE st->>'required'='true' AND NOT CASE WHEN jsonb_typeof(d.data->'routing')='object' THEN app.document_signing_step_fulfilled(d.data,st) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END ORDER BY (st->>'stage')::integer,st->>'id' LIMIT 1) pending ON true LEFT JOIN app_user u ON u.id=CASE WHEN o.released_at IS NOT NULL OR app.probation_case_company_current(c.id) IS NOT TRUE THEN NULL ELSE coalesce(pending.holder,(app.probation_holders(c.employment_id)->>'pbp')::uuid) END AND u.tenant_id=p.tenant_id LEFT JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE p.case_id=p_case AND p.tenant_id=app.current_tenant_id() AND p.data->>'documentKind'='letter' AND app.probation_part_access(p.id) ORDER BY p.created_at DESC,p.id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_notification_recipients(p_occurrence uuid,p_event uuid) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_occurrence;c probation_case;p probation_part;h jsonb;
BEGIN
 IF (app.probation_storage_runner() OR app.probation_active_user() AND app.is_group_admin()) IS NOT TRUE THEN RETURN;END IF;
 SELECT * INTO o FROM probation_occurrence WHERE id=p_occurrence AND tenant_id=app.current_tenant_id() AND source_event_id=p_event AND state='scheduled';IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=o.due_on AND o.created_at>=updated_at) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind<>'letter_released' THEN RETURN;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=o.tenant_id;IF o.kind='route_attention' AND coalesce(p.data->>'state','') NOT IN('pending_ack','pending_approval') THEN RETURN;END IF;IF o.kind='letter_returned' AND (p.data->>'state' IS DISTINCT FROM 'returned' OR NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id)) OR o.kind='letter_release_pending' AND NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id AND x.released_at IS NULL) THEN RETURN;END IF;h:=app.probation_holders(c.employment_id);
 IF o.kind IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending') THEN
 IF o.kind IN('review_reminder','review_due') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>(p.data->>'dueOn')::date THEN RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM app.probation_pending_parties(p.id) party JOIN app_user u ON u.id=party.user_id AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE o.recipient_user_ids?u.id::text AND o.recipient_roles?party.role AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);RETURN;END IF;
 IF o.kind='letter_signing_pending' AND jsonb_typeof((SELECT d.data->'routing' FROM document_signing_document d WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation'))='object' THEN
 -- 5752: a routed letter's pending holders, counting Review and Approve decisions and the current round only.
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL app.document_signing_pending_steps(d.data) st WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation' AND st->>'holderId'=u.id::text AND app.probation_signing_route_allowed(p.id,d.data->'route'));RETURN;END IF;
 IF o.kind='letter_signing_pending' THEN
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') st WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation' AND st->>'holderId'=u.id::text AND app.probation_signing_route_allowed(p.id,d.data->'route') AND p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) role WHERE role<>'gbs' AND h->>role=u.id::text AND NOT(o.kind='review_reminder' AND role='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND role='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL))
 OR o.recipient_roles?'gbs' AND app.probation_gbs_user(c.employment_id,u.id));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;e uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT employment_id INTO e FROM probation_case WHERE id=p.case_id AND tenant_id=app.current_tenant_id();
 IF app.probation_case_company_current(p.case_id) IS NOT TRUE THEN IF app.probation_storage_runner() THEN RETURN true;END IF;IF p.data->>'documentKind'='letter' THEN RETURN p.data->>'state'='locked';END IF;RETURN p_rater IS NULL OR p_rater='employee' OR p_rater='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p.data->>'documentKind'='letter' AND jsonb_typeof(p.data->'letterRouting')='array' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND (app.document_signing_owner(d.data)=app.current_user_id() OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text) OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data) st WHERE st->>'holderId'=app.current_user_id()::text)));END IF;
 IF p.data->>'documentKind'='letter' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND st->>'holderId'=app.current_user_id()::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));END IF;
 IF p_rater IS NULL OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') THEN RETURN true;END IF;
 IF p_rater='employee' THEN RETURN app.probation_role(e,'employee') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'acknowledgedAt' IS NOT NULL;END IF;
 IF p_rater='lm' THEN RETURN app.probation_part_role(p.id,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_letter_routing_context(uuid),app.probation_letter_freeze_route(uuid,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_letter_routing_context(uuid),app.probation_letter_freeze_route(uuid,jsonb,jsonb) TO ai_hr_app
