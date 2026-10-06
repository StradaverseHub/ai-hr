-- r392 (23bd49d9) — Payment Method, Bank Name, Bank Account and Payroll Cycle become ordinary payslip
-- display fields (core/payslip-information.ts PAYSLIP_INFORMATION_FIELDS). Before this round they were
-- appended after every company's selection whatever its setting said; from this round the payslip prints
-- only what the setting names. So every SAVED setting gains each of the four it does not already name, at
-- the END, in catalogue order — exactly where they printed before — and no issued payslip changes. An empty
-- list (a company that switched everything off) still printed the four, so it gains them too.
--
-- DATA ONLY: no schema change, no GRANT. Re-runnable: a key already present is never appended again, and
-- a row naming all four is not touched. A company with NO row reads the defaults, which now end with the
-- same four, so it needs nothing here. Code from before this round drops unknown keys, so the new keys are
-- harmless across the restart. No event is appended: no company chose this, and the payslip is unchanged.
UPDATE payslip_information_setting s
SET fields = s.fields || (
  SELECT coalesce(jsonb_agg(to_jsonb(k.key) ORDER BY k.ord), '[]'::jsonb)
  FROM unnest(ARRAY['paymentMethod', 'bankName', 'bankAccount', 'payrollCycle']) WITH ORDINALITY AS k(key, ord)
  WHERE NOT (s.fields @> jsonb_build_array(k.key))
)
WHERE jsonb_typeof(s.fields) = 'array'
  AND EXISTS (
    SELECT 1 FROM unnest(ARRAY['paymentMethod', 'bankName', 'bankAccount', 'payrollCycle']) AS m(key)
    WHERE NOT (s.fields @> jsonb_build_array(m.key))
  );
