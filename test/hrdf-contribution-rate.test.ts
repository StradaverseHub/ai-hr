/**
 * HRDF Contribution Rate (Organization ▸ Statutory) — headcount framing removed.
 *
 * The company-level HRDF setting used to be worded as a HEADCOUNT band ("Mandatory — 10+ employees",
 * "Optional — 5–9 employees") on two separate admin screens that disagreed with each other. HRDF
 * eligibility is a free company choice, so the wording is now a plain rate on BOTH editable surfaces:
 *   No Contribution / 1.0% Contribution / 0.5% Contribution.
 *
 * Nothing moves in storage: company_statutory_my.hrdf_status keeps its three values
 * (not_registered / mandatory / optional), which map one-to-one onto the three labels — so every
 * existing company keeps its exact rate and no payroll figure changes. The calculator (hrdfLevy /
 * hrdfSubject) is deliberately untouched and is covered by hrdf-levy / hrdf-subject.
 *
 * Guards here:
 *   (a) the audit trail records a rate change as a { before, after } pair (the repo convention that
 *       lib/audit-format renders as an accented "old → new" line), and stays MINIMAL when the rate
 *       did not change — both forms post hrdfStatus on every save, so a "provided" gate would spam
 *       the trail with before == after noise on every EPF/SOCSO-only edit;
 *   (b) the ONE writer path (Organization ▸ Statutory) persists and audits it. r79a (feedback 4fb8b75a
 *       step 4): Admin ▸ Payroll config used to be a SECOND writer of this same record, with no
 *       coordination between the two screens — whichever saved last silently won. It is now a read-only
 *       view with a link, and this file pins that its action no longer changes the record at all;
 *   (c) the Organization form no longer renders the headcount hint, and keeps its stored option values;
 *   (d) i18n: the new wording in all 6 locales, no headcount text left anywhere in either namespace,
 *       and the org-level hrdfHint key removed from every locale (not just en — the coverage test only
 *       flags MISSING keys, so an en-only delete would leave five stale headcount strings behind).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() in real Next.js THROWS to abort the request; the mock must throw too, or the action
// body would fall through. The sentinel carries the target path so tests can assert it.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
// requireAdmin() (Clerk/session) is unavailable in the harness — return the seeded admin ctx.
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirectSpy(p),
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(() => undefined),
  revalidateTag: vi.fn(() => undefined),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { describePayload } from '../lib/audit-format';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { setCompanyStatutoryAction } from '../app/admin/actions';
import { savePayrollConfigAction } from '../app/admin/payroll-config/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

type Messages = {
  admin: { organization: Record<string, string> };
  payrollConfig: Record<string, string>;
  payroll: { config: Record<string, string> };
};
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Messages;
/** vi writes decimals with a comma ("1,0%"); compare on a normalised form. */
const dot = (s: string) => s.replace(/,/g, '.');

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run a server action that ends in redirect() (throws RedirectError here) and return the target. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  actionCtx = adminCtx(base);
});
afterAll(closeAll);

describe('HRDF Contribution Rate — audit trail on the shared writer', () => {
  it('records a rate change as before → after, so the Audit Trail shows old and new', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });

    const payload = await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated');
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      companyId: base.companyId,
      before: { hrdfStatus: 'mandatory' },
      after: { hrdfStatus: 'optional' },
    });
  });

  it('renders that payload as a single accented "old → new" line', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, {
      companyId: base.companyId,
      hrdfStatus: 'not_registered',
    });
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const payload = await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated');

    const changed = describePayload(payload).filter((l) => l.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0].key).toBe('hrdfStatus');
    expect(changed[0].value).toBe('not_registered → mandatory');
  });

  it('stays minimal when the rate did NOT change (no before/after noise on an EPF-only save)', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    // The forms always post hrdfStatus (a select with a defaultValue) — same value, other field edited.
    await setCompanyStatutoryMY(a, {
      companyId: base.companyId,
      hrdfStatus: 'mandatory',
      epfEmployerNo: 'A-1234',
    });

    const payload = await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated');
    expect(payload).toEqual({ companyId: base.companyId });
    expect(describePayload(payload).some((l) => l.changed)).toBe(false);
  });

  it('stays minimal when hrdfStatus is omitted entirely', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    await setCompanyStatutoryMY(a, { companyId: base.companyId, lhdnEmployerNo: 'E 908915-10' });

    const payload = await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated');
    expect(payload).toEqual({ companyId: base.companyId });
  });

  it('the first-ever save is a created event with the minimal payload (no prior rate to compare)', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const payload = await latestEventPayload(base.tenantId, id, 'company.statutory.my.created');
    expect(payload).toEqual({ companyId: base.companyId });
  });
});

describe('HRDF Contribution Rate — the single editable surface audits the change', () => {
  it('Organization ▸ Statutory (setCompanyStatutoryAction) persists the rate and audits old → new', async () => {
    const a = adminCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'not_registered' });

    await captureRedirect(() =>
      setCompanyStatutoryAction(fd({ country: 'MY', companyId: base.companyId, hrdfStatus: 'optional' })),
    );

    const row = await getCompanyStatutoryMY(a, base.companyId);
    expect(row?.hrdfStatus).toBe('optional');
    const payload = await latestEventPayload(base.tenantId, row!.id, 'company.statutory.my.updated');
    expect(payload).toMatchObject({
      before: { hrdfStatus: 'not_registered' },
      after: { hrdfStatus: 'optional' },
    });
  });

  // r79a step 4 — the second writer is closed at the ACTION, not merely hidden from the form. A POST
  // carrying hrdfStatus (hand-crafted, or a stale cached page) must change nothing: leaving the field out
  // of the JSX while the action still read it would have left the last-save-wins race exactly as it was.
  it('Admin ▸ Payroll config (savePayrollConfigAction) NO LONGER writes the statutory record', async () => {
    const a = adminCtx(base);
    const { id } = await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    const before = await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated');

    const to = await captureRedirect(() =>
      savePayrollConfigAction(
        fd({ companyId: base.companyId, hrdfStatus: 'mandatory', epfEmployerNo: 'HIJACK-1' }),
      ),
    );
    expect(to).toContain('/admin/payroll-config');

    // The rate Organization set stands, and no statutory event was appended by the payroll save.
    const row = await getCompanyStatutoryMY(a, base.companyId);
    expect(row?.hrdfStatus).toBe('optional');
    expect(row?.epfEmployerNo ?? null).not.toBe('HIJACK-1');
    expect(await latestEventPayload(base.tenantId, id, 'company.statutory.my.updated')).toEqual(before);
  });
});

describe('HRDF Contribution Rate — Organization form layout', () => {
  const PANEL = read('components/company-panel.tsx');

  it('no longer renders the employer-headcount hint', () => {
    expect(PANEL).not.toContain("t('hrdfHint')");
  });

  it('keeps the stored option values (no data migration) in rate order: none, 1.0%, 0.5%', () => {
    const start = PANEL.indexOf('name="hrdfStatus"');
    expect(start).toBeGreaterThan(-1);
    const select = PANEL.slice(start, PANEL.indexOf('</select>', start));
    const none = select.indexOf('value="not_registered"');
    const one = select.indexOf('value="mandatory"');
    const half = select.indexOf('value="optional"');
    expect(none).toBeGreaterThan(-1);
    expect(one).toBeGreaterThan(none);
    expect(half).toBeGreaterThan(one);
    // Labels come from i18n; the form still speaks the label key, not a hard-coded string.
    expect(select).toContain("t('hrdfNotRegistered')");
    expect(select).toContain("t('hrdfMandatory')");
    expect(select).toContain("t('hrdfOptional')");
  });

  // 6df24751 — the file moved (Pay Schedule is company-first now, and the read-only statutory block sits
  // on the company's own screen), the assertion did not: the same three values, in the same rate order.
  it('the Admin payroll-config surface offers the same three values in the same order', () => {
    const PAGE = read('app/admin/payroll-config/[companyId]/page.tsx');
    expect(PAGE).toContain("const HRDF = ['not_registered', 'mandatory', 'optional'] as const;");
  });
});

describe('HRDF Contribution Rate — i18n across all 6 locales', () => {
  // Headcount / band framing in any of the six languages — none of it may survive.
  const HEADCOUNT = /10\+|5–9|5-9|10名|band|jalur|bậc|ระดับ|等级/i;

  for (const loc of LOCALES) {
    const m = msgs(loc);

    it(`${loc}: the org field is renamed and its three options read as rates`, () => {
      const o = m.admin.organization;
      for (const k of ['hrdfStatusLabel', 'hrdfNotRegistered', 'hrdfMandatory', 'hrdfOptional']) {
        expect(o[k], `${loc}.${k}`).toBeTruthy();
        expect(o[k], `${loc}.${k}`).not.toMatch(HEADCOUNT);
      }
      expect(dot(o.hrdfMandatory), `${loc}.hrdfMandatory`).toContain('1.0%');
      expect(dot(o.hrdfOptional), `${loc}.hrdfOptional`).toContain('0.5%');
    });

    it(`${loc}: the org headcount hint key is GONE (deleted from every locale, not just en)`, () => {
      expect(m.admin.organization).not.toHaveProperty('hrdfHint');
    });

    it(`${loc}: the Admin payroll-config surface uses the same rate wording`, () => {
      const p = m.payrollConfig;
      const o = m.admin.organization;
      for (const k of ['hrdfStatus', 'hrdf_not_registered', 'hrdf_mandatory', 'hrdf_optional', 'hrdfHint']) {
        expect(p[k], `${loc}.payrollConfig.${k}`).toBeTruthy();
        expect(p[k], `${loc}.payrollConfig.${k}`).not.toMatch(HEADCOUNT);
      }
      expect(dot(p.hrdf_mandatory)).toContain('1.0%');
      expect(dot(p.hrdf_optional)).toContain('0.5%');
      // The two editable surfaces must now say exactly the same thing.
      expect(p.hrdfStatus).toBe(o.hrdfStatusLabel);
      expect(p.hrdf_not_registered).toBe(o.hrdfNotRegistered);
      expect(p.hrdf_mandatory).toBe(o.hrdfMandatory);
      expect(p.hrdf_optional).toBe(o.hrdfOptional);
    });

    it(`${loc}: the read-only Payroll configuration rate page is untouched (out of scope)`, () => {
      const c = m.payroll.config;
      expect(c.hrdfMandatory).toBeTruthy();
      expect(c.hrdfOptional).toBeTruthy();
      expect(c.hrdfNote).toBeTruthy();
    });
  }
});
