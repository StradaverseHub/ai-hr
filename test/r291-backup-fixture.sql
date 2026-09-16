-- r291 / readiness 1.5 — the source database the backup + restore-rehearsal tests dump and restore.
--
-- It is NOT the ai-hr schema, and it is not a substitute for it. It is the SHAPE of the ai-hr schema
-- reduced to the parts the rehearsal's verdict depends on, so that every check the rehearsal makes is
-- exercised for real rather than asserted about source text:
--
--   • app.current_tenant_id() reading current_setting('app.tenant_id', true) — db/migrations/0001
--   • tenant-scoped tables with ROW LEVEL SECURITY ENABLED (not FORCED) and a tenant_isolation policy
--   • SELECT granted to ai_hr_app, which is NOBYPASSRLS, so the policies actually bind for it
--   • one table with RLS OFF, so a manifest that always printed 't' would be caught
--   • drizzle.__drizzle_migrations, because the migration watermark is one of the compared facts
--   • two tenants, so "the app sees only its own tenant" is a claim with something to be wrong about
--
-- Building it from the real migration chain instead was considered and rejected: 465 migrations take
-- minutes, need MIGRATION_DATABASE_URL and the drizzle toolchain, and would make these tests fail
-- whenever an unrelated migration broke — which is a different test's job (scripts/shadow-migrate.sh).
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS drizzle;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
  SELECT 'hash-' || g, 1700000000000 + g FROM generate_series(1, 465) g;

CREATE TABLE public.tenant (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.company (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenant(id), name text NOT NULL);
CREATE TABLE public.employment (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenant(id), company_id uuid NOT NULL REFERENCES public.company(id), ref text NOT NULL);
CREATE TABLE public.payslip (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenant(id), employment_id uuid NOT NULL REFERENCES public.employment(id), net numeric(12,2) NOT NULL);
-- Control-plane shape (readiness 1.7): RLS deliberately OFF, no tenant_id, app role has nothing.
CREATE TABLE public.platform_note (id serial PRIMARY KEY, body text NOT NULL);

INSERT INTO public.tenant VALUES
  ('11111111-1111-1111-1111-111111111111', 'Tenant One'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant Two');
INSERT INTO public.company
  SELECT ('33333333-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
         CASE WHEN g <= 3 THEN '11111111-1111-1111-1111-111111111111' ELSE '22222222-2222-2222-2222-222222222222' END::uuid,
         'Company ' || g
    FROM generate_series(1, 5) g;
INSERT INTO public.employment
  SELECT ('44444444-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
         CASE WHEN g <= 40 THEN '11111111-1111-1111-1111-111111111111' ELSE '22222222-2222-2222-2222-222222222222' END::uuid,
         CASE WHEN g <= 40 THEN '33333333-0000-0000-0000-000000000001' ELSE '33333333-0000-0000-0000-000000000004' END::uuid,
         'EMP' || lpad(g::text, 4, '0')
    FROM generate_series(1, 60) g;
INSERT INTO public.payslip
  SELECT ('55555555-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, e.tenant_id, e.id, 1000 + g
    FROM generate_series(1, 120) g
    JOIN public.employment e ON e.ref = 'EMP' || lpad((((g - 1) % 60) + 1)::text, 4, '0');
INSERT INTO public.platform_note (body) SELECT 'note ' || g FROM generate_series(1, 4) g;

ALTER TABLE public.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON public.tenant FOR ALL USING (id = app.current_tenant_id());
ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.company FOR ALL USING (tenant_id = app.current_tenant_id());
ALTER TABLE public.employment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.employment FOR ALL USING (tenant_id = app.current_tenant_id());
CREATE POLICY employment_readonly_probe ON public.employment FOR SELECT USING (tenant_id = app.current_tenant_id());
ALTER TABLE public.payslip ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payslip FOR ALL USING (tenant_id = app.current_tenant_id());

GRANT USAGE ON SCHEMA app, public TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant, public.company, public.employment, public.payslip TO ai_hr_app;
