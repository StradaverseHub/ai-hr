-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Coordinate allocation; do not edit the installed prefix.
-- Extends only nullable observed-credit validation; exact seven metrics, fixed three calls and receipt ownership remain.
CREATE OR REPLACE FUNCTION app.ai_provider_evaluation_record_v1(evaluation_id uuid,candidate uuid,candidate_version uuid,fingerprint text,principal text,metrics jsonb)
 RETURNS TABLE(issued_at timestamptz,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c ai_provider_candidate;report ai_provider_protocol_evaluation;field text;value jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR jsonb_typeof(metrics)<>'object' OR octet_length(metrics::text)>4096
 OR metrics IS NULL OR (SELECT count(*) FROM jsonb_object_keys(metrics))<>7
 OR metrics->'calls' IS DISTINCT FROM '3'::jsonb
 OR (metrics-'calls'-'elapsedMs'-'usageReportedCalls'-'inputTokens'-'outputTokens'-'cachedInputTokens'-'accountChargeCredits')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 IF jsonb_typeof(metrics->'elapsedMs') IS DISTINCT FROM 'number' OR (metrics->>'elapsedMs') !~ '^[0-9]+$'
 OR (metrics->>'elapsedMs')::numeric>60000 OR jsonb_typeof(metrics->'usageReportedCalls') IS DISTINCT FROM 'number'
 OR (metrics->>'usageReportedCalls') !~ '^[0-3]$' THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 -- A known provider-reported account-credit total, including exact zero, is not an invoice or spend cap.
 IF metrics->'accountChargeCredits' IS DISTINCT FROM 'null'::jsonb AND
  (jsonb_typeof(metrics->'accountChargeCredits') IS DISTINCT FROM 'number' OR
   (metrics->>'accountChargeCredits')::numeric<0 OR
   (metrics->>'accountChargeCredits')::numeric>1.7976931348623157e308::numeric)
 THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 FOREACH field IN ARRAY ARRAY['inputTokens','outputTokens','cachedInputTokens'] LOOP
  value:=metrics->field;
  IF (metrics->>'usageReportedCalls')='3' THEN
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value::text !~ '^[0-9]+$' OR value::text::numeric>9007199254740991
   THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
  ELSIF value IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 END LOOP;
 SELECT * INTO c FROM ai_provider_candidate p WHERE p.id=candidate AND p.tenant_id=app.current_tenant_id() FOR SHARE;
 IF c.id IS NULL OR c.version_token IS DISTINCT FROM ai_provider_evaluation_record_v1.candidate_version THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 INSERT INTO ai_provider_protocol_evaluation(id,tenant_id,evaluated_by_user_id,candidate_id,candidate_version,
 candidate_fingerprint,principal_fingerprint,suite_version,account_review_version,summary)
 VALUES(evaluation_id,app.current_tenant_id(),app.current_user_id(),candidate,ai_provider_evaluation_record_v1.candidate_version,fingerprint,principal,1,1,metrics)
 RETURNING * INTO report;
 RETURN QUERY SELECT report.issued_at,report.expires_at;
END $$;
