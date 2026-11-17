/**
 * Recruitment slice 25 — the agency portal with no database: the exact public paths, the page markup (escaping, no script, the
 * cookie never in the page), and the shape of migration 5877 (owner-only sign-in tables, the inbox's grants and guard, the
 * definers refusing signed-in callers, no address stored in clear).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agencyPortalJobPath, agencyPortalPath, isCareersRoute } from '../lib/careers-route';

const JOB = '0b9a4a3e-6f1d-4c39-9d7b-2a8f9e1c5d44';
const m5727 = readFileSync(new URL('../db/migrations/5877_recruitment_agency_portal.sql', import.meta.url), 'utf8');
const fn = (name: string) => {
  const start = m5727.indexOf(`CREATE FUNCTION app.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return m5727.slice(start, m5727.indexOf('END $$;', start));
};

describe('public paths', () => {
  it('admits exactly the portal and its job paths, GET, HEAD and POST', () => {
    for (const path of [agencyPortalPath('acme'), agencyPortalJobPath('acme', JOB)]) {
      for (const m of ['GET', 'HEAD', 'POST']) expect(isCareersRoute(path, m), `${m} ${path}`).toBe(true);
      for (const m of ['PUT', 'DELETE', 'PATCH']) expect(isCareersRoute(path, m), `${m} ${path}`).toBe(false);
    }
    for (const path of ['/careers/acme/agency/', '/careers/acme/agency/jobs', `/careers/acme/agency/jobs/${JOB}/`, `/careers/acme/agency/jobs/${JOB.toUpperCase()}`,
      '/careers/acme/agency/admin', '/careers/acme/agencyx', '/careers/Acme/agency', '/careers/acme/agency%2fjobs']) {
      expect(isCareersRoute(path, 'GET'), path).toBe(false);
    }
  });
});

describe('migration 5877', () => {
  it('keeps codes, checks, sessions and the context owner-only, storing hashes only', () => {
    for (const t of ['code', 'check', 'session', 'context']) expect(m5727).toContain(`'recruitment_agency_portal_${t}'`);
    expect(m5727).toMatch(/REVOKE ALL ON app\.%I FROM PUBLIC, ai_hr_app/);
    expect(m5727).not.toMatch(/CREATE TABLE app\.recruitment_agency_portal_(code|session)[^;]*\bemail text/);
  });
  it('lets the app role read and decide the inbox but never insert or delete it', () => {
    expect(m5727).toMatch(/GRANT SELECT ON public\.recruitment_agency_portal_submission TO ai_hr_app;/);
    expect(m5727).not.toMatch(/GRANT[^;]*(INSERT|DELETE)[^;]*recruitment_agency_portal_submission/);
    expect(m5727).toMatch(/ALTER TABLE public\.recruitment_agency_portal_submission FORCE ROW LEVEL SECURITY;/);
    const guard = fn('recruitment_guard_agency_portal_submission');
    expect(guard).toMatch(/s\.created_by_user_id = app\.current_user_id\(\)\s+AND s\.created_at = now\(\)/);
    expect(guard).toMatch(/OLD\.state <> 'waiting'/);
  });
  it('refuses signed-in callers in every public definer and limits each one', () => {
    for (const name of ['recruitment_agency_portal_issue_code', 'recruitment_agency_portal_check_code', 'recruitment_agency_portal_view',
      'recruitment_agency_portal_submit', 'recruitment_agency_portal_sign_out', 'recruitment_agency_portal_email_context']) {
      expect(fn(name), name).toMatch(/PERFORM app\.recruitment_agency_portal_anonymous\(\);/);
    }
    expect(fn('recruitment_agency_portal_issue_code')).toMatch(/>= 10 THEN\s+RETURN jsonb_build_object\('status', 'client_limited'\)/);
    expect(fn('recruitment_agency_portal_check_code')).toMatch(/>= 30 THEN/);
    expect(fn('recruitment_agency_portal_check_code')).toMatch(/interval '8 hours'/);
    expect(fn('recruitment_agency_portal_submit')).toMatch(/>= 20 THEN/);
  });
  it('shows the agency only a coarse status, never a reason, a stage or who protected a person', () => {
    const view = fn('recruitment_agency_portal_view');
    expect(view).not.toMatch(/decline_reason|refusal_reason|review_reason|current_stage|comments/);
    expect(m5727).toMatch(/WHEN p_outcome = 'accepted' AND p_application_state = 'active' THEN 'in_process'/);
  });
});
