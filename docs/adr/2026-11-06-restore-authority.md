# Restored object authority is part of recovery correctness

Status: candidate; hosted positive, negative and full-schema restore witnesses pending. No installation backup or live restore has been performed.

The existing rehearsal restored with `pg_restore --no-owner`. That option makes the restoring role own objects. For this schema, a restricted SECURITY DEFINER owner is part of the permission boundary; replacing it with a superuser can widen access even when application table grants and direct RLS row counts look unchanged.

Preserve archive ownership. Preflight now includes original object owners and function grant recipients as required roles. Do not invent or elevate target roles to make a restore pass. Operator provisioning must preserve their restrictions and memberships separately from the database archive.

Backups record relation owners, forced RLS flags, function owners, definer/invoker mode, function configuration (including search paths) and schema owners in the same exported snapshot as the archive. Rehearsal compares those facts exactly alongside existing table counts, policies, migration count and app-role isolation probes. Missing authority metadata on a legacy manifest produces a visibly weaker verdict, never the current full PASS.

The regression fixture includes a non-bypass definer whose result must remain tenant-scoped after restore. A valid archive deliberately changing that owner must fail even when rows and direct application grants are unchanged. The full-schema witness additionally runs the current Personnel reader and a canonical audited hire in a fresh process against a restored fictional database, then proves the source database was not changed.

This is a database restore qualification, not evidence of production PITR, file/object-store recovery, restored encryption keys, HTTP availability or a production RTO/RPO. Those dependencies remain separately reviewable operational gates. The production deployment hold remains in force.
