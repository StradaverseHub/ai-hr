-- Hosted synthetic populated581 fixture ONLY. Owner INSERTs prove populated DDL/ACL preservation,
-- not a native creation, ciphertext, human review, crypto or business execution proof.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.tenant(id,workos_org_id,name) VALUES('8a000000-0000-4000-8000-000000000001','org_fixture_operator581','Fictional Operator Qualification');
INSERT INTO public.person(id,tenant_id,full_name,primary_email) VALUES('8a000000-0000-4000-8000-000000000002','8a000000-0000-4000-8000-000000000001','Fictional Baseline Person','operator-fixture@example.invalid');
INSERT INTO public.app_user(id,tenant_id,workos_user_id,person_id) VALUES('8a000000-0000-4000-8000-000000000003','8a000000-0000-4000-8000-000000000001','user_fixture_operator581','8a000000-0000-4000-8000-000000000002');
INSERT INTO public.company(id,tenant_id,legal_name,country,currency) VALUES('8a000000-0000-4000-8000-000000000004','8a000000-0000-4000-8000-000000000001','Fictional Baseline Company','MY','MYR');
INSERT INTO public.employment(id,tenant_id,person_id,company_id,employee_code,hired_on) VALUES('8a000000-0000-4000-8000-000000000005','8a000000-0000-4000-8000-000000000001','8a000000-0000-4000-8000-000000000002','8a000000-0000-4000-8000-000000000004','FIC-OP581','2025-01-01');
INSERT INTO public.employee_draft(id,tenant_id,company_id,created_by_person_id,label,data) VALUES('8a000000-0000-4000-8000-000000000006','8a000000-0000-4000-8000-000000000001','8a000000-0000-4000-8000-000000000004','8a000000-0000-4000-8000-000000000002','Fictional preserved draft','{"fixture":"operator581"}');
INSERT INTO app.assistant_own_leave_review(id,tenant_id,user_id,person_id,employment_id,company_id,action_kind,state,intent_digest,reviewed_digest,created_at,expires_at) VALUES('8a000000-0000-4000-8000-000000000007','8a000000-0000-4000-8000-000000000001','8a000000-0000-4000-8000-000000000003','8a000000-0000-4000-8000-000000000002','8a000000-0000-4000-8000-000000000005','8a000000-0000-4000-8000-000000000004','leave.apply','awaiting_confirmation',repeat('a',64),repeat('b',64),clock_timestamp(),clock_timestamp()+interval '1 day');
INSERT INTO app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) VALUES('8a000000-0000-4000-8000-000000000007','0123456789abcdef','fictional-not-crypto-proof','fictional-populated-body-not-a-valid-encrypted-review');
COMMIT;
