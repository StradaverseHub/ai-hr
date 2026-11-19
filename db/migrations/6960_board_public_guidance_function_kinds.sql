-- Register only the three literal public page-guidance reads behind the existing AI control owner.
-- Unknown functions still fail closed; tenant stop/read controls, admin/module gates and native human actions are unchanged.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES
 ('read:offboarding_requisitions_guidance',true),
 ('read:document_signing_guidance',true),
 ('read:payroll_history_records_guidance',true);
