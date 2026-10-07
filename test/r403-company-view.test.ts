import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '../lib/permissions';

/**
 * 7a595a02 (r403) — the read-only company view, /admin/organization/[companyId]/view.
 *
 * Pure source + catalogue guards. The behaviour (the 404 refusal, run against the editor's over a
 * readers × companies × tenants matrix, and the rendered markup carrying no form control) is in
 * test/organization-list-detail.test.ts, which has the database.
 *
 * Every guard here first proves it read something: a renamed file or a moved marker must fail, not
 * pass on the empty string (CLAUDE.md §8, the r219 slice).
 */
const ROOT = path.resolve(__dirname, '..');
const VIEW_PATH = path.join(ROOT, 'app/admin/organization/[companyId]/view/page.tsx');
const EDIT_PATH = path.join(ROOT, 'app/admin/organization/[companyId]/page.tsx');
const VIEW = fs.readFileSync(VIEW_PATH, 'utf8');
const EDIT = fs.readFileSync(EDIT_PATH, 'utf8');
/** The source with comments removed, so a docblock that NAMES a banned thing does not trip the guard. */
const CODE = VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the view page cannot write, by construction', () => {
  it('was read, and is the real page', () => {
    expect(VIEW.length).toBeGreaterThan(5000);
    expect(CODE.length).toBeGreaterThan(4000);
    expect(CODE).toContain('export default async function CompanyViewPage');
  });

  it('renders no form control and no write', () => {
    for (const banned of ['<form', '<input', '<select', '<textarea', '<button', 'name="', 'formAction', "'use server'", '"use server"']) {
      expect(CODE, `view page contains ${banned}`).not.toContain(banned);
    }
  });

  it('imports no server action and not the editable panel', () => {
    const imports = CODE.match(/^import[\s\S]*?from\s+'[^']+';/gm) ?? [];
    expect(imports.length, 'imports parsed').toBeGreaterThan(10);
    for (const imp of imports) {
      expect(imp, 'no import from the actions module').not.toMatch(/from '(\.\.\/)+actions'|from '@\/app\/admin\/actions'/);
      expect(imp, 'no CompanyPanel').not.toMatch(/company-panel'|CompanyPanel/);
      expect(imp, 'no logo EDIT affordance').not.toContain('CompanyLogoEdit');
    }
    expect(CODE).not.toContain('CompanyPanel');
    expect(CODE).not.toMatch(/Action\b/);
  });

  it('applies the editor’s guard: scopedAdmin first, the adminOnly read, the 404 before any per-company read', () => {
    for (const [name, src] of [['view', VIEW], ['editor', EDIT]] as const) {
      const guard = src.indexOf('await scopedAdmin()');
      const read = src.indexOf('listCompanies(s, { includeArchived: true, adminOnly: true })');
      const refuse = src.indexOf('if (!c) notFound();');
      const firstPerCompany = src.indexOf('listCompanyBankProfiles(s, companyId)');
      expect(guard, `${name}: scopedAdmin`).toBeGreaterThanOrEqual(0);
      expect(read, `${name}: adminOnly read after the guard`).toBeGreaterThan(guard);
      expect(refuse, `${name}: refusal after the read`).toBeGreaterThan(read);
      expect(firstPerCompany, `${name}: per-company reads after the refusal`).toBeGreaterThan(refuse);
    }
  });

  it('validates ?tab= against the closed list, never trusting the string', () => {
    expect(CODE).toContain('isCompanyPanelTab(rawTab) ? rawTab');
  });
});

describe('the view is registered in the EXISTING organization column — no new column, no new right', () => {
  it('sits beside the editor route', () => {
    const org = SCREENS.filter((s) => s.routes.includes('/admin/organization/[companyId]/view'));
    expect(org.map((s) => s.screenKey)).toEqual(['organization']);
    expect(org[0].routes).toContain('/admin/organization/[companyId]');
    expect(org[0].guard).toBe('scopedAdmin');
  });
});

describe('i18n — the view’s new captions in all six locales', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const KEYS = [
    'viewAddress',
    'viewSectionPayrollGroup',
    'viewNoBankProfiles',
    'viewNoParent',
    'viewNoStatutoryPack',
    'viewCycleInactive',
    'viewReadOnlyNote',
  ] as const;
  const org = Object.fromEntries(
    LOCALES.map((l) => [
      l,
      JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8')).admin.organization as Record<string, string>,
    ]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;

  it('every key the view uses is present, non-empty, and translated', () => {
    // Every literal t('…') in the view resolves in en — a key typo is MISSING_MESSAGE at runtime only.
    const used = [...CODE.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(used.length, 'keys found in the view').toBeGreaterThan(30);
    for (const l of LOCALES) {
      for (const k of new Set([...used, ...KEYS])) {
        expect(typeof org[l][k], `messages/${l}.json admin.organization.${k}`).toBe('string');
        expect(org[l][k].trim().length, `${l}.${k} empty`).toBeGreaterThan(0);
      }
    }
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      for (const k of KEYS) expect(org[l][k], `${l}.${k} still English`).not.toBe(org.en[k]);
    }
  });

  it('keeps the placeholders the view interpolates', () => {
    for (const l of LOCALES) {
      expect(org[l].viewNoStatutoryPack).toContain('{country}');
      expect(org[l].viewCycleInactive).toContain('{name}');
    }
  });
});
