/**
 * 6df24751 — Payroll Cycles and Pay Schedule become COMPANY-FIRST.
 *
 * The reported fault was one shape shared by both screens: a company selector (or no selector at all), a
 * list, and an editing FORM opened underneath that list on the same page. This file pins the replacement
 * so it cannot regress, in the two directions that matter:
 *
 * 1. STRUCTURE (source-level, no DB). Neither listing page renders an upsert form — that is the exact
 *    regression the item is about, and a behavioural test can never see it because the form and the
 *    service both work perfectly well; it is WHERE the form is that was wrong. Also: every new route
 *    exists on disk AND is registered in lib/permissions.ts under its EXISTING screen key, because a
 *    guarded page with no matrix column is a screen nobody can grant or revoke.
 *
 * 2. LAST UPDATED (behavioural, against the database). `payroll_cycle` had no `updated_at` before
 *    migration 0443, so the new column's contract is worth stating in a test rather than a comment: rows
 *    that existed before it are BLANK (nothing was backfilled — any backfilled date would be a claim
 *    about history nobody made), and every write from here on stamps it, the activate/deactivate toggle
 *    included. `payrollCycleReadiness` surfaces the per-company maximum, which is the listing's column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { listPayrollCycles, setPayrollCycleActive, upsertPayrollCycle } from '../core/payroll-cycle';
import { payrollCycleReadiness } from '../core/payroll-readiness';
import { REGISTERED_ROUTES } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped (the test/payroll-settings-relocation.test.ts convention). A docblock
 *  saying "this page renders no savePayrollConfigAction" is not a call to it. */
const readSource = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('the company-first route exists, on disk and on the access grid', () => {
  const ROUTES: { route: string; file: string }[] = [
    { route: '/admin/payroll-cycle', file: 'app/admin/payroll-cycle/page.tsx' },
    { route: '/admin/payroll-cycle/[companyId]', file: 'app/admin/payroll-cycle/[companyId]/page.tsx' },
    { route: '/admin/payroll-cycle/[companyId]/new', file: 'app/admin/payroll-cycle/[companyId]/new/page.tsx' },
    { route: '/admin/payroll-cycle/[companyId]/[cycleId]', file: 'app/admin/payroll-cycle/[companyId]/[cycleId]/page.tsx' },
    { route: '/admin/payroll-config', file: 'app/admin/payroll-config/page.tsx' },
    { route: '/admin/payroll-config/[companyId]', file: 'app/admin/payroll-config/[companyId]/page.tsx' },
    { route: '/admin/payroll-config/[companyId]/edit', file: 'app/admin/payroll-config/[companyId]/edit/page.tsx' },
  ];

  for (const { route, file } of ROUTES) {
    it(`${route} exists and is registered`, () => {
      expect(exists(file), `${file} missing`).toBe(true);
      expect(REGISTERED_ROUTES.has(route), `${route} has no matrix column`).toBe(true);
    });
  }

  // Same screen keys as before, so the same roles reach the same data. A redesign that quietly widened
  // access would be a far worse outcome than the layout it fixed.
  it('the guards are unchanged — no new screen key was minted for either screen', () => {
    expect(read('app/admin/payroll-cycle/[companyId]/page.tsx')).toContain('scopedAdmin');
    expect(read('app/admin/payroll-cycle/[companyId]/new/page.tsx')).toContain('scopedAdmin');
    expect(read('app/admin/payroll-cycle/[companyId]/[cycleId]/page.tsx')).toContain('scopedAdmin');
    expect(read('app/admin/payroll-config/[companyId]/page.tsx')).toContain('scopedSession');
    expect(read('app/admin/payroll-config/[companyId]/edit/page.tsx')).toContain('scopedSession');
  });
});

describe('no listing page opens an editing form underneath itself', () => {
  it('the Payroll Cycles company listing renders no upsert form', () => {
    const src = readSource('app/admin/payroll-cycle/page.tsx');
    expect(src).not.toContain('upsertCycleAction');
    // Nor any of the other write actions: the listing is a way IN, not a place to change things.
    expect(src).not.toContain('deleteCycleAction');
    expect(src).not.toContain('copyCycleAction');
    expect(src).not.toContain('setActiveAction');
  });

  it('the Pay Schedule company listing renders no save form', () => {
    const src = readSource('app/admin/payroll-config/page.tsx');
    expect(src).not.toContain('savePayrollConfigAction');
  });

  // The other half of the same rule: the form did not vanish, it moved to screens of its own.
  it('the maintenance form lives on its own routes, shared by Add and Edit', () => {
    expect(read('app/admin/payroll-cycle/cycle-form.tsx')).toContain('upsertCycleAction');
    expect(read('app/admin/payroll-cycle/[companyId]/new/page.tsx')).toContain('CycleForm');
    expect(read('app/admin/payroll-cycle/[companyId]/[cycleId]/page.tsx')).toContain('CycleForm');
    expect(read('app/admin/payroll-config/[companyId]/edit/page.tsx')).toContain('savePayrollConfigAction');
  });
});

/**
 * The two faults below are invisible to every other gate: a hardcoded string resolves, so tsc, the suite,
 * i18n-coverage (which checks CATALOGUES, not literals) and `next build` all pass, and the page returns
 * 200 with plausible-looking English. They are pinned here because only a source-level check can see them.
 */
type Ns = {
  emptyScope?: string;
  emptyCompanies?: string;
  toast?: { saved?: string };
  errors?: { invalidDefaultPolicy?: string };
};
const enJson = JSON.parse(read('messages/en.json')) as Record<string, Ns>;

describe('what a redirect puts in the URL is TEXT the admin reads', () => {
  it('the Pay Schedule save action pushes no hardcoded English into ?toast= / ?error=', () => {
    const src = readSource('app/admin/payroll-config/actions.ts');
    // ToastFromQuery (app/layout.tsx) and ErrorBanner render the query string RAW, so a literal here is
    // English for the ms/ta/th/vi/zh reader too. The rule is written at app/admin/_redirects.ts.
    expect(src).toContain("await toastMsg('saved')");
    expect(src).toContain('await localise(e)');
    expect(src, 'a literal was passed as the toast/error value').not.toMatch(/'(?:toast|error)',\s*'[^']*'/);
  });

  it('both messages the action can emit have catalogue entries', () => {
    expect(enJson.payrollConfig.toast?.saved).toBeTruthy();
    expect(enJson.payrollConfig.errors?.invalidDefaultPolicy).toBeTruthy();
  });
});

describe('the empty row says WHICH nothing it is', () => {
  // One string for both states tells an admin whose search matched nothing that their scope is empty and
  // points them at the company switcher — advice for a problem they do not have. The fix is the box above.
  for (const file of ['app/admin/payroll-config/page.tsx', 'app/admin/payroll-cycle/page.tsx']) {
    it(`${file} tells an empty scope apart from a search that matched nothing`, () => {
      expect(readSource(file)).toContain("q ? t('emptyCompanies') : t('emptyScope')");
    });
  }

  it('both namespaces carry both sentences, and they are not the same sentence', () => {
    for (const ns of ['payrollConfig', 'payrollCycleConfig'] as const) {
      const n = enJson[ns];
      expect(n.emptyScope, `${ns}.emptyScope`).toBeTruthy();
      expect(n.emptyCompanies, `${ns}.emptyCompanies`).toBeTruthy();
      expect(n.emptyCompanies).not.toBe(n.emptyScope);
    }
  });
});

describe('migration 0443 — payroll_cycle.updated_at', () => {
  let b: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });

  /** Force a cycle back to the pre-0443 shape: a row that was never edited under a schema that could say so. */
  const blank = (id: string) =>
    owner.db.update(schema.payrollCycle).set({ updatedAt: null }).where(eq(schema.payrollCycle.id, id));

  const updatedAtOf = async (ctx: Parameters<typeof listPayrollCycles>[0], companyId: string, id: string) =>
    (await listPayrollCycles(ctx, companyId)).find((c) => c.id === id)?.updatedAt ?? null;

  it('a legacy row reads blank, and the first edit fills it in', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly', runType: 'regular' });
    // A row created after 0443 is stamped by the column default — creating IS the first change.
    expect(await updatedAtOf(a, b.companyId, id)).not.toBeNull();

    await blank(id);
    expect(await updatedAtOf(a, b.companyId, id)).toBeNull();

    await upsertPayrollCycle(a, { id, companyId: b.companyId, name: 'Monthly payroll', runType: 'regular' });
    expect(await updatedAtOf(a, b.companyId, id)).not.toBeNull();
  });

  it('deactivating counts as an edit (the toggle stamps it too)', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Bonus', runType: 'bonus' });
    await blank(id);
    await setPayrollCycleActive(a, { id, active: false });
    expect(await updatedAtOf(a, b.companyId, id)).not.toBeNull();
  });

  it('cycle readiness carries the newest edit per company — the listing’s Last Updated column', async () => {
    const a = adminCtx(b);
    const { id } = await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly', runType: 'regular' });

    const [withEdit] = await payrollCycleReadiness(a, [b.companyId]);
    expect(withEdit.lastUpdatedAt).toBeInstanceOf(Date);

    // Blank every row and the company reports nothing rather than inventing a date.
    await blank(id);
    const [untouched] = await payrollCycleReadiness(a, [b.companyId]);
    expect(untouched.lastUpdatedAt).toBeNull();
    // ...and the readiness answer itself is unchanged by any of this — it is the same two-query aggregate.
    expect(untouched.activeCycles).toBe(1);
    expect(untouched.canRunRegularPayroll).toBe(true);
  });
});
