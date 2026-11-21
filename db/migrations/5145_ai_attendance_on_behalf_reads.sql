-- 96a54ed2 (owner decision, 12 November 2026): the AI Centre controls for the attendance_on_behalf_subjects and
-- attendance_on_behalf_approvers reads (core/semantic-model/entities-attendance-on-behalf.ts), served as operations_status
-- topics of the same names. Managers and administrators holding the on-behalf permission key; the first page of the Request
-- On Behalf and Approve On Behalf lists (names as placeholders; company, department and position), read as the caller under
-- tenant RLS by the pages' own owner. Enabled by default like every other read, and switchable per tenant on AI Centre.
-- This registers no table, privilege or write; unregistered keys stay refused by the SQL owner.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES ('read:attendance_on_behalf_approvers',true),('read:attendance_on_behalf_subjects',true);
