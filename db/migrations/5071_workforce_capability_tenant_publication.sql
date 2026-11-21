-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5071_workforce_capability_tenant_publication, idx 4471, when 1793330004771.
-- Draft name on its branch: 9962_workforce_capability_tenant_publication. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-labels-20261110 (bulk-operation conversion, 10 Nov 2026): not a
-- reservation, not an installation allocation. The journal position (idx 9962, when 1793330090962) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Discard this file's position, not its bytes.
--
-- Per-tenant, resumable workforce capability publication (deploy/access/publish-workforce-capabilities.ts). The
-- publication used to flip the global catalogue and fence every tenant (Access configuration revision, physical
-- writer generation, audit event) in one transaction holding every tenant's access-configuration and
-- profile-edit-policy locks: 286 / 786 / 1,546 ms at 10 / 100 / 300 tenants. Now the catalogue flip opens a
-- publication version that keeps showing each tenant its previous catalogue until that tenant's own short
-- transaction publishes it, together with that tenant's fence and event, exactly as the single transaction did for
-- it. A run stopped part way resumes with the tenants not yet published.
CREATE TABLE app.access_capability_publication (
 version integer PRIMARY KEY CHECK(version>0),
 bindings_sha256 text NOT NULL CHECK(bindings_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('publishing','published')),
 -- The catalogue rows this version replaced ({capabilityId:{supported,bindings}}), shown to unpublished tenants.
 previous jsonb NOT NULL CHECK(jsonb_typeof(previous)='object'),
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX access_capability_publication_open ON app.access_capability_publication((true)) WHERE state='publishing';
--> statement-breakpoint
CREATE TABLE app.access_capability_tenant_publication (
 version integer NOT NULL REFERENCES app.access_capability_publication(version),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(version,tenant_id)
);
--> statement-breakpoint
REVOKE ALL ON app.access_capability_publication,app.access_capability_tenant_publication FROM PUBLIC;
--> statement-breakpoint
-- The catalogue as one tenant sees it. While a version is publishing, a tenant it has not yet reached keeps the
-- rows that version replaced; every other case is the stored catalogue. SQL, invoker, no SET clause: inlined into
-- each definer reader below, a single probe of an empty partial index when nothing is publishing.
CREATE FUNCTION app.access_capability_effective(p_tenant uuid) RETURNS TABLE(id text,scope text,supported boolean,bindings jsonb)
LANGUAGE sql STABLE AS $$
 SELECT c.id,c.scope,
  CASE WHEN pending.previous IS NULL THEN c.supported ELSE (pending.previous->>'supported')::boolean END,
  CASE WHEN pending.previous IS NULL THEN c.bindings ELSE pending.previous->'bindings' END
 FROM public.access_capability c
 LEFT JOIN LATERAL (SELECT p.previous->c.id AS previous FROM app.access_capability_publication p
  WHERE p.state='publishing' AND p.previous ? c.id
   AND NOT EXISTS(SELECT 1 FROM app.access_capability_tenant_publication t WHERE t.version=p.version AND t.tenant_id=p_tenant)) pending ON true;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_capability_effective(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Every installed reader of the catalogue's supported/bindings reads it per tenant. Re-created from its installed
-- definition, after checking it has exactly one catalogue read. Readers of id/scope only (default grants, grant
-- scope validation, configuration commit) are unaffected: a publication never changes them.
DO $$
DECLARE r record; def text; found integer; owner_ name;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('app._payroll_completion_authority(uuid,uuid,uuid)','FROM public\.access_capability','c','p_tenant'),
  ('app.access_allowed_for_tenant(uuid,uuid,text,uuid)','JOIN public\.access_capability','c','p_tenant'),
  ('app.access_can_delegate(text,uuid)','FROM public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_configuration_state()','FROM public\.access_capability','c','t'),
  ('app.access_profile_review_for_user(uuid,uuid)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_require_delegate(text,uuid)','FROM public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_workforce_command_company(uuid)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_workforce_company(uuid,text)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_workforce_not_denied(uuid,text)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_workforce_projection_company(uuid)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.access_workforce_unassigned(text)','JOIN public\.access_capability','c','app.current_tenant_id()'),
  ('app.company_org_hr(uuid,uuid[])','FROM access_capability','cap','app.current_tenant_id()'),
  ('app.job_document_reviewer_eligible(uuid,uuid)','JOIN public\.access_capability','cap','app.current_tenant_id()'),
  ('app.letter_automation_owner_eligible_at(uuid,uuid,uuid,boolean)','JOIN public\.access_capability','c','wanted_tenant')
 ) v(sig,source,alias,tenant) LOOP
  def:=pg_catalog.pg_get_functiondef(r.sig::regprocedure);
  SELECT count(*) INTO found FROM regexp_matches(def,'\maccess_capability\M','g');
  IF found<>1 THEN RAISE EXCEPTION 'capability publication reader: % reads the catalogue % times, expected 1',r.sig,found; END IF;
  SELECT count(*) INTO found FROM regexp_matches(def,r.source||' '||r.alias||'\M','g');
  IF found<>1 THEN RAISE EXCEPTION 'capability publication reader: % has % reads matching % %, expected 1',r.sig,found,r.source,r.alias; END IF;
  EXECUTE regexp_replace(def,r.source||' '||r.alias||'\M',split_part(r.source,' ',1)||' app.access_capability_effective('||r.tenant||') '||r.alias);
  SELECT o.rolname INTO owner_ FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid=r.sig::regprocedure;
  IF owner_<>current_user THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION app.access_capability_effective(uuid) TO %I',owner_);
   EXECUTE format('GRANT SELECT ON app.access_capability_publication,app.access_capability_tenant_publication TO %I',owner_);
  END IF;
 END LOOP;
END $$;
