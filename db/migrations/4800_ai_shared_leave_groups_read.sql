-- 50d9b809: the AI Centre control for the shared_leave_groups read (core/semantic-model/entities-leave-settings.ts), served
-- as the operations_status topic of the same name. Administrators only; configuration only (group names, member leave
-- type names, shared limit, cap per application, employee placement); read as the caller under tenant RLS by the Shared
-- Leave Groups page's own owners. Enabled by default like every other read, and switchable per tenant on AI Centre.
-- This registers no table, privilege, write or provider-data purpose; unregistered keys stay refused by the SQL owner.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES ('read:shared_leave_groups',true);
