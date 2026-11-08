-- Bank file arrangement metadata, not payment or settlement state. Old accounts remain unconfirmed.
ALTER TABLE public.company_bank_profile ADD COLUMN maybank_payment_settings jsonb;
ALTER TABLE public.company_bank_profile ADD CONSTRAINT maybank_payment_settings_shape CHECK (
 maybank_payment_settings IS NULL OR coalesce((
  bank='maybank' AND jsonb_typeof(maybank_payment_settings)='object'
  AND maybank_payment_settings->>'version'='7.4'
  AND maybank_payment_settings->>'hashMode' IN('unconfirmed','not-required')
  AND maybank_payment_settings->>'zakatClassification' IN('1','2','3','4','5')
  AND maybank_payment_settings ?& ARRAY['version','hashMode','zakatClassification']
  AND maybank_payment_settings-ARRAY['version','hashMode','zakatClassification']='{}'::jsonb),false));
--> statement-breakpoint
-- Payee banking residency is distinct from tax residency, nationality and employee citizenship.
-- NULL deliberately means not recorded; do not infer it from an employee's tax or EPF profile.
ALTER TABLE public.employee_statutory_my ADD COLUMN bank_payee_residency text
 CHECK(bank_payee_residency IN('resident','non_resident'));
