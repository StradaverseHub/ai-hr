/**
 * r298 (board ceb1c560) — "Screens still show payroll sections to a company that has not bought Payroll".
 *
 * Three CORE screens loaded and drew Payroll-pack data without asking whether the tenant holds Payroll:
 *
 *   /admin/personnel/[employmentId]   Pay Items (core/pay-components.ts) · CP38 (core/cp38.ts) ·
 *                                     the Payroll Policy picker (core/payroll-policy.ts)
 *   /admin/organization/[companyId]   the Default Payroll Cycle form (core/payroll-cycle.ts)
 *   /me                               My payslips · Personal tax relief (TP1) · My loans (core/loans.ts) ·
 *                                     the EA tax statement on the Documents tab
 *
 * WHAT IS PINNED, AND WHY IN THIS SHAPE.
 *
 *  1. GATE THE READ, NOT JUST THE RENDER. For a tenant without Payroll each Payroll-owned service read is
 *     NOT CALLED, not merely hidden — those unconditional reads are exactly what core/module-gate.ts names
 *     as stopping core/loans.ts, core/cp38.ts and core/payroll-cycle.ts being bound at the service. So each
 *     read is wrapped in a call-through spy, and the OFF arm asserts the spy never ran as well as that the
 *     section is absent from the element tree the page returns.
 *
 *  2. BOTH ARMS, against the same tenant through a REAL snapshot (`entitledCtx` resolves the tenant's rows;
 *     no `entitlementsExempt` anywhere). A refusal-only test passes against a page that hides these
 *     sections from everyone, which is the worse outcome — so the ON arm asserts every section is PRESENT
 *     WITH ITS DATA (the CP38 reference, the pay item's code, the policy's name, the cycle's name, the
 *     payslip link, the TP1 row count, the loan, the EA link) and that each read ran with the same
 *     arguments it always did.
 *
 *  3. /me's Payroll TAB IS NOT DROPPED: Basic Salary (core/comp.ts, spine) still lives on it, so the tab stays
 *     and `?tab=payroll` / the legacy `?tab=pay` still land on it in both arms.
 *
 * The rendered-page idiom is test/organization-list-detail.test.ts's: mock the session entry point, call the
 * async page, walk the element tree it returns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { s: null as unknown, scopeIds: [] as string[] } }));
const { NOT_FOUND, REDIRECT } = vi.hoisted(() => ({
  NOT_FOUND: new Error('NEXT_NOT_FOUND'),
  REDIRECT: new Error('NEXT_REDIRECT'),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// Both THROW, as they do at runtime, so a page that bails out cannot be mistaken for one that rendered.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw REDIRECT;
  }),
  notFound: vi.fn(() => {
    throw NOT_FOUND;
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => session) }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: vi.fn(async () => session.s),
}));
// Keys come back verbatim, so a section is found by the key its title renders from.
vi.mock('next-intl/server', () => {
  const t = Object.assign((k: string) => k, { rich: (k: string) => k, markup: (k: string) => k, raw: (k: string) => k, has: () => true });
  return {
    getTranslations: vi.fn(async () => t),
    getLocale: vi.fn(async () => 'en'),
    getFormatter: vi.fn(async () => ({ dateTime: () => '', number: () => '', relativeTime: () => '' })),
  };
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '', number: () => '' }),
}));

// ── The Payroll-owned reads, each a CALL-THROUGH spy: the ON arm gets real rows, the OFF arm can prove the
//    function never ran. `vi.fn(actual)` keeps the implementation; only the call record is added.
vi.mock('../core/pay-components', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/pay-components')>();
  return { ...a, listEmploymentPayComponents: vi.fn(a.listEmploymentPayComponents), listPayComponents: vi.fn(a.listPayComponents) };
});
vi.mock('../core/cp38', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/cp38')>();
  return { ...a, listCp38: vi.fn(a.listCp38) };
});
vi.mock('../core/payroll-policy', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/payroll-policy')>();
  return { ...a, listAssignablePolicies: vi.fn(a.listAssignablePolicies) };
});
// The Organization page imports this through the pack facade (packs/payroll/service `export *`), which
// re-exports whatever this module is — so the spy is what the page gets.
vi.mock('../core/payroll-cycle', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/payroll-cycle')>();
  return { ...a, listPayrollCycles: vi.fn(a.listPayrollCycles) };
});
vi.mock('../core/loans', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/loans')>();
  return { ...a, listLoansForEmployment: vi.fn(a.listLoansForEmployment) };
});
// core/read.ts is the SHARED kernel read module (never module-bound — core/module-gate.ts); these four of
// its reads are the ones that read payslips for /me.
vi.mock('../core/read', async (importOriginal) => {
  const a = await importOriginal<typeof import('../core/read')>();
  return {
    ...a,
    myPayslips: vi.fn(a.myPayslips),
    myTaxRelief: vi.fn(a.myTaxRelief),
    myTaxReliefEmploymentIds: vi.fn(a.myTaxReliefEmploymentIds),
    myEmploymentIdsAll: vi.fn(a.myEmploymentIdsAll),
  };
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import {
  listEmploymentPayComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import { listCp38, setCp38 } from '../core/cp38';
import { createPolicy, listAssignablePolicies } from '../core/payroll-policy';
import { listPayrollCycles } from '../core/payroll-cycle';
import { createLoan, listLoansForEmployment } from '../core/loans';
import { myEmploymentIdsAll, myPayslips, myTaxRelief, myTaxReliefEmploymentIds } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { SectionHeader } from '../components/ui';
import { ClientTabs } from '../components/personnel-tabs';
import { TabSaveScope } from '../components/tab-save-scope';
import { CompanyPanel } from '../components/company-panel';
import EmployeePage from '../app/admin/personnel/[employmentId]/page';
import CompanyMaintenancePage from '../app/admin/organization/[companyId]/page';
import MePage from '../app/me/page';
import {
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The element-tree walker. A server page returns React elements; client components and nested async
// server components are NOT invoked, only described — which is exactly what "the page drew this section"
// means here. Props are walked whole (not just `children`), because the tab shells carry their panels in a
// `panels` object.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
type El = { type: unknown; props: Record<string, unknown> };
const isEl = (v: unknown): v is El =>
  !!v && typeof v === 'object' && '$$typeof' in (v as object) && 'props' in (v as object);

function collect(root: unknown, match: (el: El) => boolean): El[] {
  const out: El[] = [];
  const seen = new Set<unknown>();
  const go = (node: unknown) => {
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(go);
    if (isEl(node)) {
      if (match(node)) out.push(node);
      return Object.values(node.props ?? {}).forEach(go);
    }
    if (Object.getPrototypeOf(node) === Object.prototype) Object.values(node).forEach(go);
  };
  go(root);
  return out;
}
/** Every string or number reachable from `root` — the words and figures a section draws. */
function strings(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const go = (node: unknown) => {
    if (typeof node === 'string') return void out.push(node);
    if (typeof node === 'number') return void out.push(String(node));
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(go);
    Object.values(isEl(node) ? node.props ?? {} : node).forEach(go);
  };
  go(root);
  return out;
}
const byId = (tree: unknown, id: string) => collect(tree, (el) => el.props?.id === id);
const sectionTitles = (tree: unknown) =>
  collect(tree, (el) => el.type === SectionHeader).map((el) => el.props.title as string);
const hrefs = (tree: unknown) =>
  collect(tree, (el) => typeof el.props?.href === 'string').map((el) => el.props.href as string);

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  vi.clearAllMocks();
});
afterAll(async () => {
  await closeAll();
});

const today = todayInKualaLumpur();
const thisYear = today.slice(0, 4);
const thisMonth = today.slice(0, 7);
/** Hired on 1 January of the current year: never in the future, and inside the TP1 assessment year. */
const hiredOn = `${thisYear}-01-01`;

async function hire(name: string, ic: string) {
  const a = await entitledCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: hiredOn });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// PERSONNEL
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('r298 — Personnel: Pay Items, CP38 and the Payroll Policy picker follow the Payroll module', () => {
  /** The same employee in both arms, carrying one row in every Payroll-owned section. */
  async function seedPersonnel() {
    const e = await hire('Nurul Huda', '900101015555');
    const a = await entitledCtx(base);
    await seedPayComponentCatalog(a);
    const component = (await listPayComponents(a))[0];
    expect(component, 'the seeded catalogue has a component to assign').toBeTruthy();
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: component.id,
      amount: 321,
      effectiveFrom: hiredOn,
    });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38-R298-REF', amount: 150, validFrom: hiredOn });
    await createPolicy(a, { companyId: base.companyId, name: 'R298 Monthly Policy', policyType: 'monthly' });
    return { e, componentCode: component.code };
  }

  const render = (employmentId: string, tab = 'payroll') =>
    EmployeePage({ params: Promise.resolve({ employmentId }), searchParams: Promise.resolve({ tab }) });

  const payrollCovers = (tree: unknown) => {
    const scopes = collect(tree, (el) => el.type === TabSaveScope && el.props.tabKey === 'payroll');
    expect(scopes, 'the Payroll tab still has its one Save scope').toHaveLength(1);
    return scopes[0].props.covers as string[];
  };

  it('Payroll ON — every section is drawn with its data, and each read ran exactly as before', async () => {
    const { e, componentCode } = await seedPersonnel();
    session.s = await entitledCtx(base);
    session.scopeIds = [base.companyId];
    vi.clearAllMocks();

    const tree = await render(e.employmentId);

    const payItems = byId(tree, 'section-pay-components');
    expect(payItems, 'Pay Items is drawn for a tenant WITH Payroll').toHaveLength(1);
    expect(strings(payItems[0])).toContain(componentCode);
    const cp38 = byId(tree, 'section-cp38');
    expect(cp38, 'CP38 is drawn for a tenant WITH Payroll').toHaveLength(1);
    expect(strings(cp38[0])).toContain('CP38-R298-REF');
    const policy = byId(tree, 'section-payroll-policy');
    expect(policy, 'the Payroll Policy picker is drawn for a tenant WITH Payroll').toHaveLength(1);
    expect(strings(policy[0])).toContain('R298 Monthly Policy');
    // The Save bar names the policy card it owns.
    expect(payrollCovers(tree)).toContain('assignTitle');

    expect(vi.mocked(listEmploymentPayComponents)).toHaveBeenCalledWith(session.s, e.employmentId);
    expect(vi.mocked(listPayComponents)).toHaveBeenCalledWith(session.s);
    expect(vi.mocked(listCp38)).toHaveBeenCalledWith(session.s, { employmentId: e.employmentId });
    expect(vi.mocked(listAssignablePolicies)).toHaveBeenCalledWith(session.s, base.companyId);
  });

  it('Payroll OFF — none of the three is drawn, NONE of their reads runs, and the core cards stay', async () => {
    const { e } = await seedPersonnel();
    await setModule(base.tenantId, 'payroll', null); // a declined module has no row (C7)
    session.s = await entitledCtx(base);
    session.scopeIds = [base.companyId];
    vi.clearAllMocks();

    const tree = await render(e.employmentId);

    expect(byId(tree, 'section-pay-components'), 'Pay Items is drawn for a tenant WITHOUT Payroll').toHaveLength(0);
    expect(byId(tree, 'section-cp38'), 'CP38 is drawn for a tenant WITHOUT Payroll').toHaveLength(0);
    expect(byId(tree, 'section-payroll-policy'), 'the policy picker is drawn for a tenant WITHOUT Payroll').toHaveLength(0);
    // …and the data is nowhere on the page, not merely outside those three ids.
    expect(strings(tree)).not.toContain('CP38-R298-REF');
    expect(strings(tree)).not.toContain('R298 Monthly Policy');
    // A bar may not name a card the reader cannot see (r256): the policy card's name goes with it.
    expect(payrollCovers(tree)).not.toContain('assignTitle');

    expect(vi.mocked(listEmploymentPayComponents), 'listEmploymentPayComponents ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(listPayComponents), 'listPayComponents ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(listCp38), 'listCp38 ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(listAssignablePolicies), 'listAssignablePolicies ran without Payroll').not.toHaveBeenCalled();

    // CORE stays. Basic Salary is core/comp.ts (spine) and must survive on the same tab.
    expect(byId(tree, 'section-compensation'), 'Basic Salary is core and stays').toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// ORGANIZATION
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('r298 — Organization: the Default Payroll Cycle form follows the Payroll module', () => {
  async function seedCycle() {
    await owner.db
      .insert(schema.payrollCycle)
      .values({ tenantId: base.tenantId, companyId: base.companyId, name: 'R298 Month End', runType: 'regular' });
  }
  /** A real hr_admin: role_assignment row AND the grant on the session, so app.is_admin_for agrees. */
  async function orgAdmin(): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_r298_${Date.now()}_${Math.random()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'hr_admin' });
    const ctx = await entitledCtx(base);
    return { ...ctx, userId: u.id, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: null }] };
  }
  const render = () =>
    CompanyMaintenancePage({ params: Promise.resolve({ companyId: base.companyId }), searchParams: Promise.resolve({}) });
  const panelOf = (tree: unknown) => {
    const panels = collect(tree, (el) => el.type === CompanyPanel);
    expect(panels, 'exactly one CompanyPanel').toHaveLength(1);
    return panels[0].props as Parameters<typeof CompanyPanel>[0];
  };

  it('Payroll ON — the cycle is read and the form is drawn with it', async () => {
    await seedCycle();
    session.s = await orgAdmin();
    vi.clearAllMocks();

    const props = panelOf(await render());
    expect(props.activeCycleNames).toEqual(['R298 Month End']);
    expect(vi.mocked(listPayrollCycles)).toHaveBeenCalledWith(session.s, base.companyId, { activeOnly: true });

    const html = renderToStaticMarkup(createElement(CompanyPanel, props));
    expect(html, 'the Default Payroll Cycle form is drawn for a tenant WITH Payroll').toContain('name="defaultPayrollCycle"');
    expect(html).toContain('R298 Month End');
  });

  it('Payroll OFF — the cycle is NOT read and the form is not drawn; the rest of General stays', async () => {
    await seedCycle();
    await setModule(base.tenantId, 'payroll', null);
    session.s = await orgAdmin();
    vi.clearAllMocks();

    const props = panelOf(await render());
    expect(props.activeCycleNames, 'null is the section’s absence, not an empty list').toBeNull();
    expect(vi.mocked(listPayrollCycles), 'listPayrollCycles ran without Payroll').not.toHaveBeenCalled();

    const html = renderToStaticMarkup(createElement(CompanyPanel, props));
    expect(html, 'the Default Payroll Cycle form is drawn for a tenant WITHOUT Payroll').not.toContain(
      'name="defaultPayrollCycle"',
    );
    expect(html).not.toContain('R298 Month End');
    // An empty list would still draw the disabled form and tell the customer to set up a cycle.
    expect(html).not.toContain('defaultPayrollCycleNoActive');
    // The company form around it is core and stays.
    expect(html).toContain('name="legalName"');
    expect(html).toContain('name="parentCompanyId"');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// MY PROFILE
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('r298 — My Profile: payslips, TP1, loans and the EA statement follow the Payroll module', () => {
  /** One employee with a CLOSED (released) payslip carrying applied TP1, and one loan. */
  async function seedMe() {
    const e = await hire('Siti Aminah', '900202026666');
    const a = await entitledCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: thisMonth });
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 0, tp1Deduction: 250 });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    const [slip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(slip, 'the batch produced a payslip').toBeTruthy();
    await createLoan(a, {
      employmentId: e.employmentId,
      loanType: 'personal',
      principal: 1200,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: hiredOn,
    });
    const userId = await createAppUser(base.tenantId, e.personId, 'employee');
    return { e, userId, payslipId: slip.id };
  }
  /** The employee's own session, with a snapshot RESOLVED from the tenant's rows. */
  const essCtx = async (userId: string, personId: string): Promise<SessionContext> => ({
    ...(await entitledCtx(base, ['employee'])),
    userId,
    personId,
  });
  const render = (tab?: string) => MePage({ searchParams: Promise.resolve(tab ? { tab } : {}) });
  const PAYROLL_TITLES = ['myPayslips', 'taxReliefTp1', 'myLoans', 'taxStatementEa'] as const;

  const tabsOf = (tree: unknown) => {
    const shells = collect(tree, (el) => el.type === ClientTabs);
    expect(shells, 'one tab shell').toHaveLength(1);
    return shells[0].props as { defaultTab: string; tabs: { key: string }[] };
  };

  it('Payroll ON — all four cards are drawn with their data, and every read ran as before', async () => {
    const { e, userId, payslipId } = await seedMe();
    session.s = await essCtx(userId, e.personId);
    vi.clearAllMocks();

    const tree = await render('payroll');
    const titles = sectionTitles(tree);
    for (const title of PAYROLL_TITLES) expect(titles, `${title} is drawn for a tenant WITH Payroll`).toContain(title);

    expect(hrefs(tree), 'the released payslip is listed').toContain(`/me/payslip/${payslipId}`);
    const tp1 = collect(tree, (el) => el.type === SectionHeader && el.props.title === 'taxReliefTp1');
    expect(tp1[0].props.count, 'the applied TP1 row is counted').toBe(1);
    const loans = collect(tree, (el) => el.type === SectionHeader && el.props.title === 'myLoans');
    expect(loans[0].props.count, 'the loan is listed').toBe(1);
    expect(strings(tree)).toContain('loanTypeName.personal');
    expect(hrefs(tree), 'the EA statement is offered').toContain(`/me/ea/${e.employmentId}/pdf?year=${thisYear}`);

    expect(vi.mocked(myTaxReliefEmploymentIds)).toHaveBeenCalledWith(session.s);
    expect(vi.mocked(myTaxRelief)).toHaveBeenCalledWith(session.s, [e.employmentId]);
    expect(vi.mocked(myPayslips)).toHaveBeenCalledWith(session.s, [e.employmentId]);
    expect(vi.mocked(myPayslips), 'once for the Payroll tab, once for the EA rows').toHaveBeenCalledTimes(2);
    expect(vi.mocked(myEmploymentIdsAll)).toHaveBeenCalledWith(session.s);
    expect(vi.mocked(listLoansForEmployment)).toHaveBeenCalledWith(session.s, e.employmentId);

    // The tab is there and the address lands on it.
    const tabs = tabsOf(tree);
    expect(tabs.tabs.map((x) => x.key)).toContain('payroll');
    expect(tabs.defaultTab).toBe('payroll');
  });

  it('Payroll OFF — none of the four is drawn and NONE of their reads runs', async () => {
    const { e, userId, payslipId } = await seedMe();
    await setModule(base.tenantId, 'payroll', null);
    session.s = await essCtx(userId, e.personId);
    vi.clearAllMocks();

    const tree = await render('payroll');
    const titles = sectionTitles(tree);
    for (const title of PAYROLL_TITLES) {
      expect(titles, `${title} is drawn for a tenant WITHOUT Payroll`).not.toContain(title);
    }
    expect(hrefs(tree).some((h) => h.startsWith('/me/payslip/') || h.includes(payslipId))).toBe(false);
    expect(hrefs(tree).some((h) => h.startsWith('/me/ea/') || h.startsWith('/payroll/'))).toBe(false);
    expect(hrefs(tree), 'the TP1 card’s manage link goes with it').not.toContain('/me/tax-relief');
    expect(strings(tree)).not.toContain('loanTypeName.personal');

    expect(vi.mocked(myTaxReliefEmploymentIds), 'myTaxReliefEmploymentIds ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(myTaxRelief), 'myTaxRelief ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(myPayslips), 'myPayslips ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(myEmploymentIdsAll), 'myEmploymentIdsAll ran without Payroll').not.toHaveBeenCalled();
    expect(vi.mocked(listLoansForEmployment), 'listLoansForEmployment ran without Payroll').not.toHaveBeenCalled();

    // CORE stays: Basic Salary keeps the Payroll tab non-empty, so the tab is NOT dropped and both the
    // current and the legacy address still land on it rather than on an empty panel.
    expect(byId(tree, 'section-compensation'), 'Basic Salary is core and stays').toHaveLength(1);
    const tabs = tabsOf(tree);
    expect(tabs.tabs.map((x) => x.key)).toContain('payroll');
    expect(tabs.defaultTab).toBe('payroll');
    expect(tabsOf(await render('pay')).defaultTab, 'the legacy ?tab=pay still lands on Payroll').toBe('payroll');
    // The Documents tab keeps its core cards (review outcome, resignation).
    expect(sectionTitles(tree)).toContain('resignationTitle');
  });
});
