/** Bounded operator-owned coordinator. No application principal, provider call, build or deploy. */
import {askClarificationSql, pushPlanSql, runFeedbackOperatorSql} from './remote';
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
function id(value: string) {if (!uuid.test(value)) throw Error('A valid bound identifier is required.'); return `'${value}'::uuid`;}
function literal(value: string) {return "'" + value.replaceAll("'", "''") + "'";}
function text(value: string, max: number) {if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw Error('Bounded nonempty text required.'); return value.trim();}
const snapshotDigest = (expr: string) => `encode(sha256(convert_to((${expr})::text,'UTF8')),'hex')`;
export type Pickup = {tenantId: string; worker: string; limit?: number};
export function pickupSql(p: Pickup): string {
 const tenant = id(p.tenantId), worker = literal(text(p.worker,120)), limit = p.limit ?? 3;
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw Error('Pickup admits 1–3 reports.');
 return `BEGIN; SET LOCAL jit=off; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
 CREATE TEMP TABLE _feedback_pickup (result jsonb) ON COMMIT DROP;
 DO $pickup$ DECLARE f feedback_request%ROWTYPE; w feedback_automation_work%ROWTYPE; snapshot jsonb; fingerprint text; token uuid;
 BEGIN
 FOR f IN SELECT r.* FROM feedback_request r LEFT JOIN feedback_automation_work prior ON prior.feedback_request_id=r.id
 WHERE r.tenant_id=${tenant} AND r.status IN ('open','contested')
 AND NOT EXISTS(SELECT 1 FROM feedback_block q WHERE q.feedback_request_id=r.id AND q.resolved_at IS NULL)
 AND (prior.feedback_request_id IS NULL OR ((prior.state<>'claimed' OR prior.lease_until<now()) AND (
 prior.source_digest IS DISTINCT FROM encode(sha256(convert_to(app.feedback_automation_snapshot(r.id)::text,'UTF8')),'hex') OR
 (prior.state IN ('claimed','failed') AND prior.attempts<3 AND prior.retry_at<=now()))))
 ORDER BY r.created_at,r.id LIMIT 100 FOR UPDATE OF r SKIP LOCKED LOOP
  snapshot:=app.feedback_automation_snapshot(f.id); fingerprint:=${snapshotDigest('snapshot')};
  SELECT * INTO w FROM feedback_automation_work WHERE feedback_request_id=f.id FOR UPDATE;
  IF w.feedback_request_id IS NOT NULL AND w.source_digest=fingerprint AND
   (w.state IN ('completed','escalated') OR w.retry_at>now() OR w.attempts>=3) THEN CONTINUE;END IF;
  token:=gen_random_uuid();
  INSERT INTO feedback_automation_work(feedback_request_id,tenant_id,source_digest,claim_token,worker,state,attempts,lease_until)
   VALUES(f.id,f.tenant_id,fingerprint,token,${worker},'claimed',1,now()+interval '30 minutes')
   ON CONFLICT(feedback_request_id) DO UPDATE SET source_digest=excluded.source_digest,claim_token=excluded.claim_token,worker=excluded.worker,
    state='claimed',attempts=CASE WHEN feedback_automation_work.source_digest=excluded.source_digest THEN feedback_automation_work.attempts+1 ELSE 1 END,
    lease_until=excluded.lease_until,retry_at=now(),last_error=NULL,updated_at=now();
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
   VALUES(f.tenant_id,'feedback',f.id,'feedback.automation.claimed','agent',jsonb_build_object('worker',${worker},'claimToken',token,'sourceDigest',fingerprint));
  INSERT INTO _feedback_pickup VALUES(snapshot||jsonb_build_object('claimToken',token,'sourceDigest',fingerprint));
  EXIT WHEN (SELECT count(*) FROM _feedback_pickup)>=${limit};
 END LOOP;
 END $pickup$;
 SELECT coalesce(jsonb_agg(result),'[]') FROM _feedback_pickup; COMMIT;`;
}
export type Completion = {
 tenantId: string; id: string; claimToken: string; sourceDigest: string;
 reporterEmploymentId: string | null; expectedPlanRevision: number; dialogueDigest?: string | null;
} & ({action:'ask'; question: string} | {action:'plan'; plan: string; model: string} | {action:'hold'; reason: string} | {action:'retry'});
export function completeSql(p: Completion): string {
 const tenant=id(p.tenantId), report=id(p.id), token=id(p.claimToken);
 if (!digest.test(p.sourceDigest)) throw Error('Exact reviewed source required.');
 if (!Number.isSafeInteger(p.expectedPlanRevision) || p.expectedPlanRevision<0) throw Error('Current plan revision required.');
 let effect='';
 if(p.action==='ask')effect=askClarificationSql({...p,questionId:p.claimToken});
 else if(p.action==='plan')effect=pushPlanSql({...p,plan:text(p.plan,40000),model:text(p.model,200)}).replace(/^BEGIN;\n/,'').replace(/\nCOMMIT;$/,'');
 else if(p.action!=='hold'&&p.action!=='retry')throw Error('Unsupported action.');
 const reason=p.action==='hold'?text(p.reason,1000):null;
 return `BEGIN; SET LOCAL jit=off; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
 DO $complete$ DECLARE f feedback_request%ROWTYPE; w feedback_automation_work%ROWTYPE;
 BEGIN
 SELECT * INTO f FROM feedback_request WHERE id=${report} AND tenant_id=${tenant} FOR UPDATE;
 IF f.id IS NULL THEN RAISE EXCEPTION 'Report unavailable';END IF;
 SELECT * INTO w FROM feedback_automation_work WHERE feedback_request_id=f.id AND tenant_id=f.tenant_id FOR UPDATE;
 IF w.claim_token IS DISTINCT FROM ${token} OR w.source_digest IS DISTINCT FROM ${literal(p.sourceDigest)} THEN RAISE EXCEPTION 'Work claim changed';END IF;
 IF w.state IN ('completed','escalated') THEN RETURN;END IF;
 IF w.state<>'claimed' OR w.lease_until<=now() THEN RAISE EXCEPTION 'Work claim expired';END IF;
 IF f.status NOT IN ('open','contested') OR f.plan_revision<>${p.expectedPlanRevision}
 OR w.source_digest IS DISTINCT FROM ${snapshotDigest('app.feedback_automation_snapshot(f.id)')}
 THEN RAISE EXCEPTION 'Report source changed; discard this result and investigate the next pickup';END IF;
 IF EXISTS(SELECT 1 FROM feedback_block WHERE feedback_request_id=f.id AND resolved_at IS NULL) THEN RAISE EXCEPTION 'Waiting for an answer';END IF;
 ${p.action==='ask'?`IF (SELECT count(*) FROM domain_event WHERE tenant_id=f.tenant_id AND aggregate_id=f.id AND event_type='feedback.clarification.requested' AND payload->>'planRevision'=f.plan_revision::text)>=2 THEN RAISE EXCEPTION 'Dialogue budget exhausted; escalate to the operator';END IF;`:''}
 ${effect?`EXECUTE ${literal(effect)};`:''}
 UPDATE feedback_automation_work SET state=${literal(p.action==='hold'?'escalated':p.action==='retry'?'failed':'completed')},
  retry_at=now()+interval '15 minutes',last_error=${reason?literal(reason):p.action==='retry'?"'investigation_failed'":'NULL'},updated_at=now() WHERE feedback_request_id=f.id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
  VALUES(f.tenant_id,'feedback',f.id,'feedback.automation.settled','agent',jsonb_build_object('claimToken',${token},'action',${literal(p.action)},'sourceDigest',w.source_digest));
 END $complete$; COMMIT;`;
}
/** One reminder per live question after 48h, no auto-close/rejection. Bell text contains no report text. */
export function notifySql(tenantId: string): string {
 const tenant=id(tenantId);
 return `BEGIN; SET LOCAL jit=off; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
 DO $notify$ DECLARE f feedback_request%ROWTYPE;q feedback_block%ROWTYPE;e domain_event%ROWTYPE;k text;b text;
 BEGIN
 FOR f IN SELECT r.* FROM feedback_request r JOIN app_user u ON u.id=r.reporter_user_id AND u.tenant_id=r.tenant_id
 WHERE r.tenant_id=${tenant} AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.status IN ('open','contested','planned')
 AND (EXISTS(SELECT 1 FROM feedback_block pending_question JOIN domain_event source_event ON source_event.tenant_id=pending_question.tenant_id AND source_event.aggregate_id=pending_question.feedback_request_id
 AND source_event.event_type='feedback.clarification.requested' AND source_event.payload->>'questionId'=pending_question.id::text
 WHERE pending_question.feedback_request_id=r.id AND pending_question.resolved_at IS NULL AND (
 NOT EXISTS(SELECT 1 FROM notification n WHERE n.source_event_id=source_event.id AND n.feedback_request_id=r.id) OR
 (pending_question.asked_at<=now()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM domain_event reminded WHERE reminded.tenant_id=pending_question.tenant_id AND reminded.aggregate_id=r.id AND reminded.event_type='feedback.clarification.reminded' AND reminded.payload->>'questionId'=pending_question.id::text)))) OR
  EXISTS(SELECT 1 FROM domain_event source_event WHERE source_event.tenant_id=r.tenant_id AND source_event.aggregate_id=r.id AND source_event.event_type='feedback.plan.drafted' AND source_event.occurred_at>=r.updated_at AND NOT EXISTS(SELECT 1 FROM notification n WHERE n.source_event_id=source_event.id AND n.feedback_request_id=r.id)))
 ORDER BY r.updated_at,r.id LIMIT 50 FOR UPDATE OF r SKIP LOCKED LOOP
  SELECT * INTO q FROM feedback_block WHERE feedback_request_id=f.id AND resolved_at IS NULL;
  IF q.id IS NOT NULL AND f.status IN ('open','contested') THEN
   SELECT * INTO e FROM domain_event WHERE tenant_id=f.tenant_id AND aggregate_id=f.id AND event_type='feedback.clarification.requested' AND payload->>'questionId'=q.id::text ORDER BY sequence DESC LIMIT 1;
   IF e.id IS NULL THEN CONTINUE;END IF;
   k:='question';b:='A question is waiting on your report.';
   INSERT INTO notification(tenant_id,recipient_user_id,feedback_request_id,kind,title,body,link_path,severity,source_event_id)
    VALUES(f.tenant_id,f.reporter_user_id,f.id,'feedback.'||k,'Feedback update',b,'/feedback/'||f.id,'action',e.id) ON CONFLICT DO NOTHING;
   IF q.asked_at>now()-interval '48 hours' OR EXISTS(SELECT 1 FROM domain_event WHERE tenant_id=f.tenant_id AND aggregate_id=f.id AND event_type='feedback.clarification.reminded' AND payload->>'questionId'=q.id::text) THEN CONTINUE;END IF;
   INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload)
    VALUES(f.tenant_id,'feedback',f.id,'feedback.clarification.reminded','agent',f.reporter_employment_id,jsonb_build_object('questionId',q.id,'planRevision',f.plan_revision)) RETURNING * INTO e;
   k:='reminder';b:='Your report is still waiting for an answer. Reply when convenient.';
  ELSIF f.status='planned' THEN
   SELECT * INTO e FROM domain_event WHERE tenant_id=f.tenant_id AND aggregate_id=f.id AND event_type='feedback.plan.drafted' AND occurred_at>=f.updated_at ORDER BY sequence DESC LIMIT 1;
   IF e.id IS NULL THEN CONTINUE;END IF;
   k:='plan';b:='Your report has a plan ready for your review.';
  ELSE CONTINUE;END IF;
  INSERT INTO notification(tenant_id,recipient_user_id,feedback_request_id,kind,title,body,link_path,severity,source_event_id)
   VALUES(f.tenant_id,f.reporter_user_id,f.id,'feedback.'||k,'Feedback update',b,'/feedback/'||f.id,'action',e.id) ON CONFLICT DO NOTHING;
 END LOOP;
 END $notify$; COMMIT;`;
}
export const pickupFeedback = (p:Pickup): unknown => JSON.parse(runFeedbackOperatorSql(pickupSql(p)));
export const completeFeedback = (p:Completion): void => {runFeedbackOperatorSql(completeSql(p));};
export const notifyFeedback = (tenantId:string): void => {runFeedbackOperatorSql(notifySql(tenantId));};
