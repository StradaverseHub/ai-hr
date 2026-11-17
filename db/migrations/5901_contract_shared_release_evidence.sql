-- Content signatures retain their original hash. A distinct release receipt composes that content with signers.
CREATE TABLE public.contract_shared_release_receipt (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),letter_id uuid NOT NULL,signing_document_id uuid NOT NULL,
 protocol text NOT NULL CHECK(protocol='contract-release-v1'),content_revision integer NOT NULL CHECK(content_revision>0),
 content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),released_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,letter_id),FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id),
 FOREIGN KEY(tenant_id,signing_document_id) REFERENCES public.document_signing_document(tenant_id,id)
);
REVOKE ALL ON public.contract_shared_release_receipt FROM PUBLIC,ai_hr_app;
ALTER TABLE public.contract_shared_release_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_release_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_release_receipt_owner ON public.contract_shared_release_receipt TO ai_hr_owner USING(true) WITH CHECK(true);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_release_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Released document evidence is immutable' USING ERRCODE='42501';END $$;
REVOKE ALL ON FUNCTION app.contract_shared_release_receipt_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_release_receipt_immutable BEFORE UPDATE OR DELETE ON public.contract_shared_release_receipt FOR EACH ROW EXECUTE FUNCTION app.contract_shared_release_receipt_immutable();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_record_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_document public.document_signing_document;v_snapshot jsonb;v_signatures jsonb;v_evidence jsonb;v_fingerprint text;
BEGIN
 IF NEW.data->>'state' IS DISTINCT FROM 'released' OR OLD.data->>'state'='released' THEN RETURN NEW;END IF;
 SELECT * INTO v_document FROM public.document_signing_document WHERE tenant_id=NEW.tenant_id AND id=NEW.signing_document_id;
 IF v_document.id IS NULL OR app.document_signing_returned(v_document.data) OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(v_document.data))
 THEN RAISE EXCEPTION 'A completed canonical document is required for release' USING ERRCODE='40001';END IF;
 SELECT snapshot INTO v_snapshot FROM public.contract_shared_letter_content WHERE tenant_id=NEW.tenant_id AND letter_id=NEW.id
 AND content_revision=(v_document.data->>'contentRevision')::integer AND content_hash=v_document.data->>'contentHash';
 IF v_snapshot IS NULL OR encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex') IS DISTINCT FROM v_document.data->>'contentHash'
 THEN RAISE EXCEPTION 'The exact signed body is unavailable' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) AND jsonb_typeof(NEW.data->'formReleaseEvidence') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Complete the Form response owner before releasing this document' USING ERRCODE='40001';END IF;
 SELECT coalesce(jsonb_agg(action ORDER BY action->>'at',action->>'id'),'[]'::jsonb) INTO v_signatures
 FROM app.document_signing_round_actions(v_document.data) action WHERE action->'signature' IS NOT NULL AND action->'signature'<>'null'::jsonb;
 v_evidence:=jsonb_build_object('protocol','contract-release-v1','letterId',NEW.id,'templateId',NEW.data->'templateId','templateVersion',NEW.data->'templateVersion',
  'contentRevision',v_document.data->'contentRevision','contentHash',v_document.data->'contentHash','releasedAt',NEW.data->>'releasedAt',
  'document',v_snapshot,'signatures',v_signatures,'form',NEW.data->'formReleaseEvidence');
 v_fingerprint:=encode(sha256(convert_to(v_evidence::text,'UTF8')),'hex');
 INSERT INTO public.contract_shared_release_receipt(tenant_id,letter_id,signing_document_id,protocol,content_revision,content_hash,fingerprint,evidence,released_at)
 VALUES(NEW.tenant_id,NEW.id,v_document.id,'contract-release-v1',(v_document.data->>'contentRevision')::integer,v_document.data->>'contentHash',v_fingerprint,v_evidence,(NEW.data->>'releasedAt')::timestamptz);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_record_release() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_record_release AFTER UPDATE OF data ON public.contract_shared_letter FOR EACH ROW EXECUTE FUNCTION app.contract_shared_record_release();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_release_proof(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_letter public.contract_shared_letter;v_receipt public.contract_shared_release_receipt;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This document proof is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO v_letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF app.document_signing_content_visible(v_letter.signing_document_id,v_letter.data->>'state'='released') IS NOT TRUE THEN RAISE EXCEPTION 'This document proof is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO v_receipt FROM public.contract_shared_release_receipt WHERE tenant_id=v_letter.tenant_id AND letter_id=v_letter.id;
 IF v_receipt.letter_id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('protocol',v_receipt.protocol,'fingerprint',v_receipt.fingerprint,'contentHash',v_receipt.content_hash,'contentRevision',v_receipt.content_revision,'releasedAt',v_receipt.released_at);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_release_proof(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_release_proof(uuid) TO ai_hr_app;
