-- Handoff acceptance: no matching live workflow is an accepted decision followed by No workflow ran.
-- Replace only the reviewed legacy unconditional live-workflow blocker. Preserve every principal, preview,
-- source, period, reason, revision, accepted-retry and retirement guard from later owner migrations.
DO $repair$
DECLARE definition text:=pg_get_functiondef('app.contract_shared_decision_submit(uuid,integer,jsonb,uuid)'::regprocedure);
 blocker text:=$blocker$ IF NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(v.workflow_id) status,definition FROM public.automation_workflow_version v WHERE tenant_id=f.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest WHERE status='live' AND definition->'trigger'->>'event'='decisionSubmitted') THEN RAISE EXCEPTION 'Set up a live Contract decision workflow before submitting' USING ERRCODE='22023';END IF;$blocker$;
BEGIN
 IF strpos(definition,blocker)>0 THEN
  IF length(definition)-length(replace(definition,blocker,''))<>length(blocker) THEN RAISE EXCEPTION 'Ambiguous native Contract workflow guard preimage';END IF;
  EXECUTE replace(definition,blocker,' -- A ready human preview with zero matching workflows is accepted; its event records no_workflow.');
 ELSIF strpos(definition,'Set up a live Contract decision workflow before submitting')>0 THEN
  RAISE EXCEPTION 'Unreviewed native Contract workflow guard preimage';
 END IF;
END $repair$;
