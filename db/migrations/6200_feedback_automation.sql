-- Operator-side feedback work, not a login, model-spend grant or HR decision authority.
-- The app role cannot read or mutate work claims. The existing SSH operator owns bounded execution.
CREATE UNIQUE INDEX feedback_automation_report_tenant_uq ON feedback_request(tenant_id,id);
CREATE TABLE feedback_automation_work (
 feedback_request_id uuid PRIMARY KEY REFERENCES feedback_request(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES tenant(id), source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 claim_token uuid NOT NULL, worker text NOT NULL CHECK(length(worker) BETWEEN 1 AND 120),
 state text NOT NULL CHECK(state IN ('claimed','completed','failed','escalated')),
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 3), lease_until timestamptz NOT NULL,
 retry_at timestamptz NOT NULL DEFAULT now(), last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,feedback_request_id) REFERENCES feedback_request(tenant_id,id)
);
ALTER TABLE feedback_automation_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feedback_automation_work FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- One snapshot binds report, ordered conversation and attachment bytes. Report text stays private.
CREATE FUNCTION app.feedback_automation_snapshot(wanted uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('report',to_jsonb(f),'block_trail',coalesce((
  SELECT jsonb_agg(to_jsonb(q) ORDER BY q.asked_at,q.id) FROM public.feedback_block q
  WHERE q.feedback_request_id=f.id AND q.tenant_id=f.tenant_id),'[]'::jsonb),
 'attachments',coalesce((SELECT jsonb_agg((to_jsonb(a)-'content')||jsonb_build_object('content_sha256',encode(sha256(a.content),'hex')) ORDER BY a.id)
 FROM public.feedback_attachment a WHERE a.feedback_request_id=f.id AND a.tenant_id=f.tenant_id),'[]'::jsonb))
 FROM public.feedback_request f WHERE f.id=wanted
$$;
REVOKE ALL ON FUNCTION app.feedback_automation_snapshot(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Feedback addresses the actual reporter account, including reporters without an employment.
ALTER TABLE notification ADD COLUMN feedback_request_id uuid REFERENCES feedback_request(id);
ALTER TABLE notification DROP CONSTRAINT notification_audience_xor;
ALTER TABLE notification ADD CONSTRAINT notification_audience_xor CHECK (
 (recipient_employment_id IS NOT NULL AND recipient_user_id IS NULL AND letter_job_id IS NULL AND company_id IS NULL AND feedback_request_id IS NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NOT NULL AND company_id IS NOT NULL AND feedback_request_id IS NULL) OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NULL AND company_id IS NOT NULL AND feedback_request_id IS NULL AND kind='rewards.access-suspended') OR
 (recipient_employment_id IS NULL AND recipient_user_id IS NOT NULL AND letter_job_id IS NULL AND company_id IS NULL AND feedback_request_id IS NOT NULL));
CREATE UNIQUE INDEX notification_feedback_event_uq ON notification(tenant_id,source_event_id,recipient_user_id,kind) WHERE feedback_request_id IS NOT NULL;
CREATE FUNCTION app.validate_feedback_notification(n jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE f public.feedback_request%ROWTYPE;e public.domain_event%ROWTYPE; suffix text;
BEGIN
 -- Row security is retained for app callers; the maintenance projection uses the actual storage owner.
 SELECT * INTO f FROM public.feedback_request WHERE id=(n->>'feedback_request_id')::uuid AND tenant_id=(n->>'tenant_id')::uuid;
 SELECT * INTO e FROM public.domain_event WHERE id=(n->>'source_event_id')::uuid AND tenant_id=f.tenant_id AND aggregate_type='feedback' AND aggregate_id=f.id;
 suffix:=CASE e.event_type WHEN 'feedback.clarification.requested' THEN 'question' WHEN 'feedback.clarification.reminded' THEN 'reminder' WHEN 'feedback.plan.drafted' THEN 'plan' END;
 IF f.id IS NULL OR e.id IS NULL OR suffix IS NULL OR f.reporter_user_id IS DISTINCT FROM (n->>'recipient_user_id')::uuid
 OR n->>'kind' IS DISTINCT FROM 'feedback.'||suffix OR n->>'title' IS DISTINCT FROM 'Feedback update'
 OR n->>'body' IS DISTINCT FROM (CASE suffix WHEN 'question' THEN 'A question is waiting on your report.' WHEN 'reminder' THEN 'Your report is still waiting for an answer. Reply when convenient.' ELSE 'Your report has a plan ready for your review.' END)
 OR n->>'link_path' IS DISTINCT FROM '/feedback/'||f.id::text OR (n->>'portal_visible')::boolean IS DISTINCT FROM true
 OR n->>'severity' IS DISTINCT FROM 'action' OR n->>'read_at' IS NOT NULL
 OR n->>'recipient_employment_id' IS NOT NULL OR n->>'letter_job_id' IS NOT NULL OR n->>'company_id' IS NOT NULL
 THEN RAISE EXCEPTION 'Feedback notification identity invalid' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.validate_feedback_notification(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_letter_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE j public.letter_job%ROWTYPE;e public.domain_event%ROWTYPE;target_path text;expected_kind text;portal boolean;batch uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.recipient_user_id IS NOT NULL THEN RAISE EXCEPTION 'Letter notification history is immutable' USING ERRCODE='42501';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.recipient_user_id IS NOT NULL OR NEW.recipient_user_id IS NOT NULL THEN
   IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'Letter notification is immutable' USING ERRCODE='42501';END IF;
  END IF;RETURN NEW;
 END IF;
 IF NEW.feedback_request_id IS NOT NULL THEN
  PERFORM app.validate_feedback_notification(to_jsonb(NEW));RETURN NEW;
 END IF;
 IF NEW.recipient_user_id IS NULL THEN RETURN NEW;END IF;
 IF NEW.kind='rewards.access-suspended' AND NEW.letter_job_id IS NULL THEN
  IF NOT app.reward_access_account_notice_valid(NEW) THEN RAISE EXCEPTION 'Native Rewards account notification identity is invalid' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NOT app.letter_notification_storage_owner() THEN RAISE EXCEPTION 'Letter projection requires its maintenance connection' USING ERRCODE='42501';END IF;
 SELECT * INTO j FROM public.letter_job WHERE id=NEW.letter_job_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO e FROM public.domain_event WHERE id=j.source_event_id AND tenant_id=j.tenant_id AND aggregate_type='letter' AND aggregate_id=j.letter_id;
 SELECT coalesce((p.policy->>'portalNotifications')::boolean,false),l.batch_id INTO portal,batch FROM public.letter_record l JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id JOIN public.letter_policy_version p ON p.id=b.policy_version_id AND p.tenant_id=b.tenant_id WHERE l.id=j.letter_id AND l.tenant_id=j.tenant_id;
 expected_kind:='letter.'||CASE j.kind WHEN 'notification' THEN CASE WHEN j.payload->>'purpose'='draftCreated' THEN 'created' WHEN j.payload->>'purpose'='recipientAcknowledgement' THEN CASE j.payload->>'outcome' WHEN 'acknowledged' THEN 'acknowledged' WHEN 'signed' THEN 'signed' ELSE NULL END WHEN j.payload->>'purpose'='creatorDecision' THEN CASE j.payload->>'outcome' WHEN 'returned' THEN 'returned' WHEN 'rejected' THEN 'rejected' WHEN 'approved' THEN 'approved' ELSE NULL END WHEN j.payload ? 'artifactId' THEN 'issued' ELSE 'approval' END WHEN 'approvalReminder' THEN 'approvalReminder' WHEN 'escalation' THEN 'escalation' WHEN 'acknowledgementReminder' THEN 'acknowledgementReminder' ELSE NULL END;
 target_path:=CASE WHEN j.payload->>'purpose'='draftCreated' THEN '/letters/generate/'||batch::text WHEN j.payload->>'purpose'='recipientAcknowledgement' THEN '/letters/register/'||j.letter_id::text WHEN j.payload->>'purpose'='creatorDecision' THEN '/letters/generate/'||batch::text ELSE (CASE WHEN j.payload ? 'artifactId' THEN '/me/letters/' ELSE '/letters/approval/' END)||j.letter_id::text END;
 IF j.id IS NULL OR e.id IS NULL OR j.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
  OR NEW.portal_visible IS DISTINCT FROM portal OR NEW.company_id IS DISTINCT FROM j.company_id OR NEW.source_event_id IS DISTINCT FROM e.id OR NEW.link_path IS DISTINCT FROM target_path
  OR expected_kind IS NULL OR NEW.kind IS DISTINCT FROM expected_kind
  OR NEW.severity::text IS DISTINCT FROM (CASE WHEN expected_kind IN ('letter.issued','letter.approved','letter.acknowledged','letter.signed','letter.created') THEN 'info' ELSE 'action' END)
  OR NEW.title IS DISTINCT FROM 'letters.notifications.'||substring(NEW.kind FROM 8)
  OR NEW.body IS DISTINCT FROM 'letters.notifications.body' OR NEW.read_at IS NOT NULL
 THEN RAISE EXCEPTION 'Letter notification identity is invalid' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- The existing account-recipient RLS and immutable/read_at-only guard apply to Feedback too.
-- No new email consent, address disclosure or mail transport is activated by a bell projection.
--> statement-breakpoint
CREATE FUNCTION app.feedback_notification_operator_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.feedback_request_id IS NOT NULL AND NOT app.acting_as_owner() THEN
  RAISE EXCEPTION 'Feedback projection requires the operator connection' USING ERRCODE='42501';
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.feedback_notification_operator_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER feedback_notification_operator_owner BEFORE INSERT ON notification
 FOR EACH ROW EXECUTE FUNCTION app.feedback_notification_operator_owner();
