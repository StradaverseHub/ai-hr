/**
 * ADR-0161 — static pins on the mobile setup intent migration. The file is found by its SUFFIX so these
 * survive the integrator's renumbering; the behaviour is asserted against a real database in
 * test/operator-mobile-setup.test.ts once the migration is journaled.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(__dirname, '../db/migrations');
const files = readdirSync(dir).filter(name => name.endsWith('_mobile_workplace_setup_issuance.sql'));
const sql = files.length === 1 ? readFileSync(resolve(dir, files[0]), 'utf8') : '';
const code = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const body = (name: string) => {
  const start = code.indexOf(`CREATE FUNCTION app.${name}(`), end = code.indexOf('END $$;', start);
  return start >= 0 && end > start ? code.slice(start, end) : '';
};

describe('mobile setup intent migration', () => {
  it('exists exactly once and is not empty', () => {
    expect(files).toHaveLength(1);
    expect(code.length).toBeGreaterThan(2000);
  });
  it('narrows the default privileges to an RLS-confined SELECT and grants it explicitly', () => {
    expect(code).toMatch(/CREATE TABLE mobile_setup_request \(/);
    expect(code).toContain('ALTER TABLE mobile_setup_request ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('REVOKE ALL ON mobile_setup_request FROM PUBLIC, ai_hr_app;');
    expect(code).toContain('GRANT SELECT ON mobile_setup_request TO ai_hr_app;');
    expect(code).toMatch(/CREATE POLICY mobile_setup_request_read ON mobile_setup_request FOR SELECT USING \(tenant_id = app\.current_tenant_id\(\)\);/);
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*mobile_setup_request/);
  });
  it('allows one open intent per customer and no column that could hold a key', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX mobile_setup_request_one_open ON mobile_setup_request \(tenant_id\) WHERE status IN \('pending', 'running'\);/);
    const table = code.slice(code.indexOf('CREATE TABLE mobile_setup_request'), code.indexOf(');', code.indexOf('CREATE TABLE mobile_setup_request')));
    expect(table.length).toBeGreaterThan(400);
    expect(table).not.toMatch(/private|pem|secret|key_material|signing_key/i);
    expect(table).toContain("CHECK ((action = 'import') = (setup IS NOT NULL))");
  });
  it.each(['operator_mobile_setup', 'operator_request_mobile_setup'])('%s is a definer that re-checks the operator and is not PUBLIC', name => {
    const fn = body(name);
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain('SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp');
    expect(fn.indexOf('PERFORM app.assert_customer_operator();')).toBeGreaterThan(0);
    expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION app\\.${name}\\([a-z,]+\\) FROM PUBLIC;`));
    expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${name}\\([a-z,]+\\) TO ai_hr_app;`));
  });
  it('the request writer serializes per customer, refuses a second open intent and audits the actor', () => {
    const fn = body('operator_request_mobile_setup');
    expect(fn).toContain("pg_advisory_xact_lock(hashtextextended('mobile-setup-request:'");
    expect(fn).toContain("RAISE EXCEPTION 'OPERATOR_SETUP_PENDING'");
    expect(fn).toContain("'mobile.workplace-setup.requested','user',app.current_user_id()");
    const audit = fn.slice(fn.indexOf('INSERT INTO public.domain_event'), fn.indexOf(';', fn.indexOf('INSERT INTO public.domain_event')));
    expect(audit.length).toBeGreaterThan(100);
    // The audit record names the action, never the uploaded setup.
    expect(audit).toContain("jsonb_build_object('action',p_action)");
    expect(audit).not.toContain('p_setup');
  });
});
