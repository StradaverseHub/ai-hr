-- Supporting Document Configuration in Leave. Additive columns only — no new tables, no new RLS (the new
-- columns are reachable by the existing leave_type / leave_request FOR ALL tenant + can_see_employment
-- policies, same as 0084's requires_document). Discrete typed columns (claims-style) so the admin update
-- is a flat set with no JSONB partial-merge.
--   leave_type.mandatory_after_days: require a doc only when days > this value. NULL/0 ⇒ always require
--     (when requires_document). Strict '>' against the integer config: "Required after more than N days".
--   leave_type.allowed_mime_types: allow-list of accepted file types; NULL/empty ⇒ any type (backward-
--     compat). Subset of the fixed set {application/pdf, image/jpeg, image/png}.
--   leave_type.max_doc_bytes: per-file size ceiling. Replaces the hard-coded 10 MB; default keeps it.
--   leave_type.employee_remark_required: require a non-empty employee remark on submission.
--   leave_type.hr_remark_required: STORED ONLY this slice (config round-trips); no enforcement ships yet.
--   leave_request.employee_remark: the applicant's mandatory remark (nullable; null for types not needing it).
ALTER TABLE leave_type ADD COLUMN mandatory_after_days integer;--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN allowed_mime_types text[];--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN max_doc_bytes integer NOT NULL DEFAULT 10485760;--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN employee_remark_required boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN hr_remark_required boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE leave_request ADD COLUMN employee_remark text;
