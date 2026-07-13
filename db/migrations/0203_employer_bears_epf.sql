-- Item 0d9bb2da — "Employer Bears EPF Contribution" control on the EPF card.
-- Additive, backward-compatible: default false ⇒ every existing row keeps today's behaviour byte-identical.
-- When on, the EPF employee + employer legs are still computed + reported in full (KWSP file / EPF report
-- unchanged); only the FUNDING of the employee's EPF share moves to the employer (payroll wiring). Mirrors
-- employer_bears_socso/eis/skbbk (mig 0198) and employer_bears_tax (mig 0200).
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "employer_bears_epf" boolean NOT NULL DEFAULT false;
