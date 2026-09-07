/**
 * d75b0c11 — PAYROLL PROCESS REMEMBERS THE SELECTED PERIOD AND FILTERS, PROVED END TO END.
 *
 * WHAT THIS FILE IS FOR. The behaviour already works (shipped as 9066bd6c; re-verified on production on
 * 2026-09-07 by curl as an HR Admin). NOTHING GUARDED IT. `test/payroll-back-navigation.test.ts` is a
 * SOURCE-SHAPE file — it proves the list writes `?from=…` and that the destinations mention
 * `payrollListReturnTo` — and that is exactly the shape of guard the defect can walk past, because the
 * defect lives in the CONTRACT BETWEEN the two files: change the encoding on one side, or the parameter
 * name on the other, and both halves still read correct on their own while Back silently returns the
 * operator to the current month. So this file renders the REAL screens against a REAL run in Postgres
 * and walks the whole journey:
 *
 *     filters → dashboardHref → the row link the list actually emits → the `from` a browser would parse
 *     out of it → the destination page's rendered Back → the filters parsed back out of THAT.
 *
 * The round trip is closed at both ends: the value that comes back is compared to the value that went
 * in, both as a href and as a re-parsed filter selection, so a change that mangles the selection in
 * either direction fails here even if the two files still agree with themselves.
 *
 * THE TRAP THIS FILE EXISTS TO PIN, and it is the reason a hand-test of this item is untrustworthy.
 * `from` is a QUERY STRING carried INSIDE a query string, so it must stay percent-encoded. Decoded, its
 * own `&m=1` becomes a parameter of the OUTER url, `?from=/payroll?year=2026` is all that survives, and
 * Back renders `/payroll?year=2026` with the month missing — which looks EXACTLY like the reported fault
 * and is not it. Whoever investigated this item hit that and nearly filed a bug that did not exist. Case
 * B below states it as an assertion instead: a row link has exactly ONE query parameter, `from`, and no
 * stray `m` / `company` / `cycle` / `status` of its own.
 *
 * WHAT IS COVERED, and why each case is separate rather than a single happy path:
 *   · ONE month — the reporter's own example (January 2026, returned to as January 2026).
 *   · THREE months — `dashboardHref` appends one `m=` PER month, so a serialiser that used `set()`
 *     instead of `append()` passes the single-month case and loses two months here.
 *   · The WHOLE YEAR — the empty month set is written EXPLICITLY as `m=all`, because an omitted `m` is
 *     read back as "just opened, default to this month". A round trip that dropped it would bounce the
 *     operator to the current month, i.e. the reported fault, from the one selection that looks like
 *     "no filter at all".
 *   · COMPANY + CYCLE + STATUS together, on top of a month — the reporter's point 4, and the case that
 *     proves the whole query is carried rather than just the period.
 *
 * WHICH SCREENS ARE RENDERED FOR REAL: the Payroll Process list, the run screen, Reprocess, Remove,
 * Reset, the Payroll Process wizard and the wizard's Result screen. The six screens that share
 * `payrollProcessBack` (back-pay, individual-payslip, statutory-adjustment, statutory-forms,
 * transaction-view, process/result) are asserted through that helper itself, which is the exact function
 * their headers call — case C of payroll-back-navigation pins that they call it.
 *
 * SCOPE FENCE, deliberately NOT tested as a defect: opening Payroll fresh from the sidebar does not
 * remember, and must not. It defaults to the current period, which is point 3 of the reporter's own
 * request. Case G states that as an expectation so nobody "fixes" it later.
 *
 * ⚠️ r253 — WHAT THE FIRST CUT OF THIS FILE MISSED, AND WHY THE ITEM WAS ANSWERED WRONGLY. Everything
 * above walks Back LINKS. The reporter's journey ends on a BUTTON, and `closeAction`, `generateAction`,
 * `unlockAction`, `reprocessSelectedAction` and the four anomaly actions all redirected to a HARDCODED
 * `/payroll/<batchId>?toast=…` with no `from` at all — so Close payroll, then Back, really did land on
 * September, exactly as reported, on a branch whose own summary said "no odd one out". Cases H and I
 * pin the two halves of that contract (the form posts it; the action puts it back on the address), and
 * case G now fences the action path too: posting no selection still redirects to today's bare address.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';

/** The session every mocked entry point hands back — replaced once the fixture has seeded. */
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown as SessionContext, scopeIds: [] as string[] } }));

// `notFound()` / `redirect()` THROW rather than no-op: a gate closing under a mis-seeded fixture must
// surface as a loud failure here, not as a page that silently renders a different branch and passes.
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('notFound() — a route gate closed; the fixture is wrong, not the assertion');
  },
  redirect: (u: string) => {
    throw new Error(`redirect(${u})`);
  },
}));
// The Reprocess screen reads the Recalculation-History fold from a cookie on the server.
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/cache', async (orig) => ({
  ...(await orig<typeof import('next/cache')>()),
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
// Identity translations: this file is about hrefs, and test/i18n-coverage.test.ts owns the copy. `rich`
// / `markup` / `raw` / `has` are part of the same callable — the run screen composes copy with `t.rich`,
// and a bare identity function fails there before it ever reaches a Back link.
// Built INSIDE the factory: `vi.mock` calls are hoisted above every declaration in this file, so a
// module-scope const referenced from here is in its temporal dead zone when the factory first runs.
vi.mock('next-intl/server', async (orig) => ({
  ...(await orig<typeof import('next-intl/server')>()),
  getTranslations: async () =>
    Object.assign((k: string) => k, {
      rich: (k: string) => k,
      markup: (k: string) => k,
      raw: (k: string) => k,
      has: () => true,
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/lib/scope', async (orig) => ({
  ...(await orig<typeof import('../lib/scope')>()),
  scopedAdmin: async () => ({ s: scope.s, scopeIds: scope.scopeIds }),
}));
vi.mock('@/lib/authz', async (orig) => ({
  ...(await orig<typeof import('../lib/authz')>()),
  requireAdmin: async () => scope.s,
  requireModule: async () => scope.s,
}));
// r253 — the server ACTIONS are entry points: they resolve their own session rather than being handed
// one, so the fixture's admin has to reach them the way a request would.
vi.mock('@/lib/session', async (orig) => ({
  ...(await orig<typeof import('../lib/session')>()),
  getSession: async () => scope.s,
}));

import { PageHeader } from '../components/ui';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  closeAction,
  evaluateAnomaliesAction,
  generateAction,
  reprocessSelectedAction,
  unlockAction,
} from '../app/payroll/actions';
import {
  asArray,
  dashboardHref,
  parseMonths,
  parseYear,
  type DashboardFilters,
} from '../app/payroll/dashboard-logic';
import { payrollProcessBack } from '../app/payroll/back';
import PayrollListPage from '../app/payroll/page';
import BatchPage from '../app/payroll/[batchId]/page';
import ReprocessPage from '../app/payroll/[batchId]/reprocess/page';
import RemovePage from '../app/payroll/[batchId]/remove/page';
import ResetPage from '../app/payroll/[batchId]/reset/page';
import AnomaliesPage from '../app/payroll/[batchId]/anomalies/page';
import ProcessWizardPage from '../app/payroll/process/page';
import ProcessResultPage from '../app/payroll/process/result/page';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Walking a rendered server-component tree
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Every `href` string anywhere in the tree — including inside props that are nodes (the row menu hands
 *  its links down as children of a client component, and `PageHeader` takes `actions` as a prop). */
function collectHrefs(node: unknown, acc: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectHrefs(n, acc);
    return acc;
  }
  const props = (node as Elementish).props;
  if (props) {
    if (typeof props.href === 'string') acc.push(props.href);
    for (const v of Object.values(props)) collectHrefs(v, acc);
  }
  return acc;
}

/** The `back` a page hands its PageHeader — the actual Back link the operator presses. */
function backOf(node: unknown): { href: string; label: string } | null {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = backOf(n);
      if (found) return found;
    }
    return null;
  }
  const el = node as Elementish;
  if (el.type === PageHeader && el.props?.back) return el.props.back as { href: string; label: string };
  if (!el.props) return null;
  for (const v of Object.values(el.props)) {
    const found = backOf(v);
    if (found) return found;
  }
  return null;
}

/** What a browser (and therefore Next) parses out of `?from=…` on a href the list emitted. */
function fromOf(href: string): string | null {
  return new URL(href, 'https://app.test').searchParams.get('from');
}

/**
 * r253 — THE OTHER HALF OF THE JOURNEY: the `<form>` an operator PRESSES, not the link they click.
 *
 * Every case above walks Back LINKS, and so did the audit that shipped this item — which is why the run
 * flow's own buttons were missed. A form is found by the server action it posts to (identity, not a
 * string), and its hidden fields are the payload a browser would actually send.
 */
function formPostingTo(node: unknown, action: unknown): Elementish | null {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = formPostingTo(n, action);
      if (found) return found;
    }
    return null;
  }
  const el = node as Elementish;
  if (el.type === 'form' && el.props?.action === action) return el;
  if (!el.props) return null;
  for (const v of Object.values(el.props)) {
    const found = formPostingTo(v, action);
    if (found) return found;
  }
  return null;
}

/** The first element anywhere in the tree carrying a string prop by this name. */
function findWithProp(node: unknown, key: string): Elementish | null {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findWithProp(n, key);
      if (found) return found;
    }
    return null;
  }
  const el = node as Elementish;
  if (typeof el.props?.[key] === 'string') return el;
  if (!el.props) return null;
  for (const v of Object.values(el.props)) {
    const found = findWithProp(v, key);
    if (found) return found;
  }
  return null;
}

/** Every `<input type="hidden">` under a node, as name → value. */
function hiddenFields(node: unknown, acc: Record<string, string> = {}): Record<string, string> {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) hiddenFields(n, acc);
    return acc;
  }
  const props = (node as Elementish).props;
  if (props) {
    if (
      (node as Elementish).type === 'input' &&
      props.type === 'hidden' &&
      typeof props.name === 'string' &&
      typeof props.value === 'string'
    ) {
      acc[props.name] = props.value;
    }
    for (const v of Object.values(props)) hiddenFields(v, acc);
  }
  return acc;
}

/**
 * Run a server action and hand back the address it redirected to.
 *
 * `redirect()` is mocked at the top of this file to THROW `redirect(<url>)`, which is also how the real
 * one signals. Every action under test ends in one — success or refusal — so returning without a
 * redirect is itself a failure rather than a silent pass.
 */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const m = /^redirect\(([\s\S]*)\)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error('the action returned without redirecting');
}

/** A submitted form, as the action receives it. */
function post(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type ListQuery = {
  year?: string;
  m?: string | string[];
  company?: string | string[];
  cycle?: string | string[];
  status?: string | string[];
};

/**
 * The address bar as NEXT WOULD HAND IT TO THE PAGE for a filter selection: a repeated parameter arrives
 * as an array, a single one as a string. Derived from `dashboardHref` rather than hand-written, because
 * hand-writing it is how a test starts asserting against a serialisation the product does not emit.
 */
function addressBar(sel: DashboardFilters): ListQuery {
  const u = new URL(dashboardHref(sel), 'https://app.test');
  const one = (k: string): string | string[] | undefined => {
    const all = u.searchParams.getAll(k);
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
  };
  return {
    year: u.searchParams.get('year') ?? undefined,
    m: one('m'),
    company: one('company'),
    cycle: one('cycle'),
    status: one('status'),
  };
}

/** The selection a Back href actually restores, read through the SAME parsers the list page uses. */
function selectionRestoredBy(href: string): DashboardFilters {
  const u = new URL(href, 'https://app.test');
  const many = (k: string) => u.searchParams.getAll(k);
  return {
    // The 1899 default can never be a real answer, so a `year` this fails to read shows up as a
    // mismatch rather than quietly borrowing the fixture's own year.
    year: parseYear(u.searchParams.get('year') ?? undefined, 1899),
    // Same guard on the month default: `parseMonths` falls back to "the tenant's current month" when the
    // parameter is ABSENT, which is precisely the reported fault — so the fallback used here is a value
    // no selection under test contains.
    months: parseMonths(many('m').length ? many('m') : undefined, 99),
    companyIds: asArray(many('company')),
    cycles: asArray(many('cycle')),
    statuses: asArray(many('status')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

let base: Base;
let batchId: string;
let companyId: string;
/** The run's own cycle, as the Cycle filter serialises it (`applyFilters` intersects on run_type). */
let runCycle: string;

describe('d75b0c11 — the Payroll Process filter selection survives the whole round trip', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    companyId = base.companyId;
    // Both gates the row actions ride: Reprocess and Remove need multi-cycle, Remove and Reset need the
    // reset risk switch. Without them the list renders View alone and three of the four links this file
    // is about would be vacuously absent.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    // r253 — case H renders the CLOSED run's Unlock card, which is behind this switch. Inert for every
    // other case: no other case closes a run, and the card is `status === 'closed'` only.
    await setSetting(base.tenantId, 'payroll.unlock_enabled', true);
    const a = await entitledCtx(base);

    const e = await hireEmployee(a, {
      person: { fullName: 'Filter Roundtrip', primaryEmail: `frt${randomUUID()}@acme.test` },
      companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-06-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4200, effectiveFrom: '2025-06-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101012345' });

    // A PROCESSED January run: processed is the status that makes every one of the four row links
    // render (a draft has no Reprocess / Remove / Reset).
    const created = await createBatch(a, { companyId, payPeriod: '2026-01' });
    batchId = created.batchId;
    await generatePayslips(a, { batchId });

    scope.s = { ...adminCtx(base), entitlements: a.entitlements };
    scope.scopeIds = [companyId];
    runCycle = 'regular';
  });

  /** Render the Payroll Process list under a filter selection and hand back the hrefs it emitted. */
  async function renderList(sel: DashboardFilters): Promise<string[]> {
    const tree = await PayrollListPage({ searchParams: Promise.resolve(addressBar(sel)) });
    return collectHrefs(tree);
  }

  const sel = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
    year: 2026,
    months: [1],
    companyIds: [],
    cycles: [],
    statuses: [],
    ...over,
  });

  /** The four selections the reporter's request names, resolved against the seeded run. */
  const scenarios = (): { name: string; sel: DashboardFilters }[] => [
    { name: 'ONE month (the reporter’s own example: January 2026)', sel: sel() },
    { name: 'THREE months (Jan + Feb + Mar 2026)', sel: sel({ months: [1, 2, 3] }) },
    { name: 'the WHOLE YEAR (no month ticked ⇒ ?m=all)', sel: sel({ months: [] }) },
    {
      name: 'company + cycle + status on top of a month',
      sel: sel({ companyIds: [companyId], cycles: [runCycle], statuses: ['processed'] }),
    },
  ];

  it('A. the list emits a row link for View, Reprocess, Remove and Reset, each carrying the selection', async () => {
    for (const { name, sel: s } of scenarios()) {
      const hrefs = await renderList(s);
      for (const path of [
        `/payroll/${batchId}`,
        `/payroll/${batchId}/reprocess`,
        `/payroll/${batchId}/remove`,
        `/payroll/${batchId}/reset`,
      ]) {
        // EVERY link to that destination, not the first one found. The run's period cell and the row's
        // View action are both `/payroll/<id>`, and until d75b0c11 only one of them carried the
        // selection — a `find` here would have picked whichever came first and called it covered.
        const links = hrefs.filter((h) => h === path || h.startsWith(`${path}?`));
        expect(links.length, `${name}: no row link for ${path}`).toBeGreaterThan(0);
        for (const link of links) {
          expect(fromOf(link), `${name}: ${link} lost the selection`).toBe(dashboardHref(s));
        }
      }
    }
  });

  it('B. THE ENCODING: a row link carries exactly one parameter, `from`, and no filter of its own', async () => {
    // The trap in full. If `from` is appended DECODED, the row link's own query gains `m`, `company`,
    // `cycle` and `status` parameters that belong to the LIST, `from` truncates at the first `&`, and
    // Back renders /payroll?year=2026 with the month gone — indistinguishable from the reported fault.
    const s = sel({ months: [1, 2, 3], companyIds: [companyId], cycles: [runCycle], statuses: ['processed'] });
    const hrefs = await renderList(s);
    const link = hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!;
    expect(link, 'no View link to inspect').toBeTruthy();
    const params = new URL(link, 'https://app.test').searchParams;
    expect([...new Set(params.keys())]).toEqual(['from']);
    for (const leaked of ['year', 'm', 'company', 'cycle', 'status']) {
      expect(params.getAll(leaked), `\`${leaked}\` leaked out of the encoded from=`).toEqual([]);
    }
    // …and the encoded form really does still hold all three months.
    expect(selectionRestoredBy(params.get('from')!).months).toEqual([1, 2, 3]);
  });

  it('C. the run screen, Reprocess, Remove and Reset each render a Back that IS that selection', async () => {
    for (const { name, sel: s } of scenarios()) {
      const hrefs = await renderList(s);
      const from = fromOf(hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!)!;
      const params = Promise.resolve({ batchId });

      const screens: [string, { href: string; label: string } | null][] = [
        ['run screen', backOf(await BatchPage({ params, searchParams: Promise.resolve({ from }) }))],
        ['reprocess', backOf(await ReprocessPage({ params, searchParams: Promise.resolve({ from }) }))],
        ['remove', backOf(await RemovePage({ params, searchParams: Promise.resolve({ from }) }))],
        ['reset', backOf(await ResetPage({ params, searchParams: Promise.resolve({ from }) }))],
      ];
      for (const [screen, back] of screens) {
        expect(back, `${name}: ${screen} rendered no Back`).toBeTruthy();
        expect(back!.href, `${name}: ${screen} Back lost the selection`).toBe(dashboardHref(s));
        // The round trip CLOSED: the filters parsed back out of Back are the filters we started with,
        // not merely a string that happens to match. A serialisation both ends agreed to get wrong
        // would satisfy the line above and fail this one.
        expect(selectionRestoredBy(back!.href), `${name}: ${screen} restored a different selection`).toEqual(s);
      }
    }
  });

  it('D. payrollProcessBack — the helper the shared screens build their header from — resolves the selection', async () => {
    // A UNIT TEST OF THE HELPER, and the title says so: this case renders no screen. back-pay ·
    // individual-payslip · statutory-adjustment · statutory-forms · transaction-view build their header
    // from exactly this function, and payroll-back-navigation case C2 pins BY SOURCE that each of them
    // calls it — that pair is the coverage, not a render of the five. process/result IS rendered for
    // real, in case F. (r253 corrected this title: it used to claim six screens were proved here.)
    for (const { name, sel: s } of scenarios()) {
      const hrefs = await renderList(s);
      const from = fromOf(hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!)!;
      const back = await payrollProcessBack(from);
      expect(back.href, `${name}: payrollProcessBack lost the selection`).toBe(dashboardHref(s));
      expect(selectionRestoredBy(back.href)).toEqual(s);
    }
  });

  it('E. the chain holds one screen deeper: run screen → Anomalies → Back → run screen → Back → the list', async () => {
    const s = sel({ months: [1, 2, 3] });
    const hrefs = await renderList(s);
    const from = fromOf(hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!)!;

    const runTree = await BatchPage({
      params: Promise.resolve({ batchId }),
      searchParams: Promise.resolve({ from }),
    });
    const anomaliesHref = collectHrefs(runTree).find((h) => h.startsWith(`/payroll/${batchId}/anomalies`));
    expect(anomaliesHref, 'the run screen offers no Anomalies link').toBeTruthy();

    const anomaliesTree = await AnomaliesPage({
      params: Promise.resolve({ batchId }),
      searchParams: Promise.resolve({ from: fromOf(anomaliesHref!) ?? undefined }),
    });
    const anomaliesBack = backOf(anomaliesTree);
    // r253 — …AND THE BUTTONS ON IT, not only its Back. Every anomaly action redirects to this same
    // screen, so a form that posts no selection wipes it for the rest of the chain: Back to the run,
    // Back again, and the operator is on the current period. Same defect as Close payroll, two screens
    // further down. (`evaluateAnomaliesAction` is the one form that renders in every state.)
    const evaluateForm = formPostingTo(anomaliesTree, evaluateAnomaliesAction);
    expect(evaluateForm, 'the Anomalies screen renders no evaluate form').toBeTruthy();
    expect(hiddenFields(evaluateForm).from, 'the Anomalies screen’s buttons post no selection').toBe(
      dashboardHref(s),
    );
    // Anomalies goes back to the RUN, not to the list — and hands the run its `from` back, so the run's
    // own Back still restores the list. Without that, the selection is lost one screen deeper than
    // anybody was looking, which is exactly the class of hole this sweep was for.
    expect(anomaliesBack!.href.startsWith(`/payroll/${batchId}`)).toBe(true);
    const backToList = backOf(
      await BatchPage({
        params: Promise.resolve({ batchId }),
        searchParams: Promise.resolve({ from: fromOf(anomaliesBack!.href) ?? undefined }),
      }),
    );
    expect(backToList!.href).toBe(dashboardHref(s));
  });

  it('E2. the run screen hands the selection to Transaction View (“View Payroll” for one employee)', async () => {
    const s = sel({ months: [1, 2, 3], statuses: ['processed'] });
    const hrefs = await renderList(s);
    const from = fromOf(hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!)!;
    const runTree = await BatchPage({
      params: Promise.resolve({ batchId }),
      searchParams: Promise.resolve({ from }),
    });
    const txnHref = collectHrefs(runTree).find((h) => h.startsWith('/payroll/transaction-view?'));
    expect(txnHref, 'the payslip rows no longer link to Transaction View').toBeTruthy();
    expect(fromOf(txnHref!), 'Transaction View was handed no selection').toBe(dashboardHref(s));
    expect((await payrollProcessBack(fromOf(txnHref!)!)).href).toBe(dashboardHref(s));
  });

  it('F. the wizard and its Result screen carry it too — New run and Continue are list links as well', async () => {
    const s = sel({ months: [1, 2, 3], companyIds: [companyId] });
    const hrefs = await renderList(s);
    const wizardHref = hrefs.find((h) => h.startsWith('/payroll/process?'));
    expect(wizardHref, 'the New-run button hands the wizard nothing').toBeTruthy();
    const from = fromOf(wizardHref!);
    expect(from, 'the New-run button lost the selection').toBe(dashboardHref(s));

    const wizardBack = backOf(
      await ProcessWizardPage({ searchParams: Promise.resolve({ from: from ?? undefined }) }),
    );
    expect(wizardBack!.href, 'the wizard’s Back ignores ?from=').toBe(dashboardHref(s));
    // r253 — AND THE LABEL IS STILL THIS SCREEN'S OWN. Sending the destination through the shared
    // helper is a href change; taking the helper's LABEL with it silently renamed the wizard's Back
    // from "Back" to "Payroll", which is a user-visible string nobody asked to change. Translations are
    // identity here, so this pins the KEY: `payroll.process.back`, not `payroll.list.title`.
    expect(wizardBack!.label, 'the wizard’s Back label drifted off payroll.process.back').toBe('back');

    // The terminal screen of the run flow. Its Back has read `?from=` since 9066bd6c and never received
    // one, because a redirect is the only way onto it; `r` is deliberately omitted here so the page
    // takes its "this result has expired" branch — which renders the same header, and is the branch a
    // refresh actually lands on.
    const resultBack = backOf(
      await ProcessResultPage({ searchParams: Promise.resolve({ from: from ?? undefined }) }),
    );
    expect(resultBack!.href, 'the Payroll Result screen ignores ?from=').toBe(dashboardHref(s));
    expect(selectionRestoredBy(resultBack!.href)).toEqual(s);
  });

  /**
   * ─── r253: THE ACTION PATH, WHICH IS WHERE THE REPORTER'S COMPLAINT ACTUALLY LIVED ─────────────────
   *
   * Every case above walks Back LINKS, and so did the sweep that shipped this item — which is exactly
   * why it concluded "already works" and was wrong. The reporter's own journey ends on a BUTTON:
   *
   *     Payroll Process → Year 2026 + Month January → View a processed run → Close payroll
   *       → /payroll/<batchId>?toast=Payroll+closed   (no `from` — the action hardcoded the path)
   *       → press Back → /payroll → September 2026.
   *
   * Both halves of that contract are pinned, because either one alone passes while the journey is
   * broken: the FORM has to post the selection (case H) and the ACTION has to put it back on the
   * address it redirects to (case I).
   */
  it('H. the run screen’s action BUTTONS post the selection, not just its links', async () => {
    const s = sel({ months: [1, 2, 3], companyIds: [companyId] });
    const hrefs = await renderList(s);
    const from = fromOf(hrefs.find((h) => h.startsWith(`/payroll/${batchId}?`))!)!;
    const render = (id: string) =>
      BatchPage({ params: Promise.resolve({ batchId: id }), searchParams: Promise.resolve({ from }) });

    // PROCESSED → Close payroll (the reporter's own path) and Reset, which has carried it since 65e2d5de
    // and is the precedent the other three now follow.
    const processed = await render(batchId);
    for (const [name, action] of [['Close payroll', closeAction]] as const) {
      const form = formPostingTo(processed, action);
      expect(form, `the processed run screen renders no ${name} form`).toBeTruthy();
      expect(hiddenFields(form).from, `${name} posts no selection`).toBe(dashboardHref(s));
    }

    // DRAFT → Generate payslips. A second period, because a company already has a January run.
    const draft = await createBatch(scope.s, { companyId, payPeriod: '2026-02' });
    const draftForm = formPostingTo(await render(draft.batchId), generateAction);
    expect(draftForm, 'the draft run screen renders no Generate form').toBeTruthy();
    expect(hiddenFields(draftForm).from, 'Generate payslips posts no selection').toBe(dashboardHref(s));

    // CLOSED → Unlock. The one action that only exists after the run is published.
    await closeBatch(scope.s, { batchId });
    const unlockForm = formPostingTo(await render(batchId), unlockAction);
    expect(unlockForm, 'the closed run screen renders no Unlock form').toBeTruthy();
    expect(hiddenFields(unlockForm).from, 'Unlock posts no selection').toBe(dashboardHref(s));
  });

  it('I. the ACTIONS put it back on the address they redirect to — Close, Generate, Unlock, Reprocess, Anomalies', async () => {
    const s = sel({ months: [1, 2, 3], companyIds: [companyId] });
    const carried = dashboardHref(s);
    const draft = await createBatch(scope.s, { companyId, payPeriod: '2026-02' });

    // Ordered as a real session runs them (close → unlock → reprocess the processed run again), so the
    // run is in a plausible state for each. A REFUSAL is asserted the same way as a success on purpose:
    // both redirect, and the operator who is bounced back by an error needs their filters just as much
    // as the one who succeeds — so `from` has to ride on both branches of every one of these actions.
    const flows: [string, () => Promise<unknown>][] = [
      ['closeAction', () => closeAction(post({ batchId, from: carried }))],
      ['generateAction', () => generateAction(post({ batchId: draft.batchId, from: carried }))],
      ['unlockAction', () => unlockAction(post({ batchId, from: carried, reason: 'r253 round trip' }))],
      ['reprocessSelectedAction', () => reprocessSelectedAction(post({ batchId, from: carried }))],
      ['evaluateAnomaliesAction', () => evaluateAnomaliesAction(post({ batchId, from: carried }))],
    ];
    for (const [name, run] of flows) {
      const to = await redirectOf(run);
      expect(fromOf(to), `${name} redirected to ${to}, dropping the selection`).toBe(carried);
      // …and the round trip closes: what the destination will parse back out is the selection that went
      // in, not merely a string that survived. An encoding that flattened the three months into one
      // would satisfy the line above and fail this one.
      expect(selectionRestoredBy(fromOf(to)!), `${name} mangled the selection`).toEqual(s);
    }
  });

  it('J. the wizard’s draft-adjustment panel returns to the wizard WITH the selection still on it', async () => {
    // The Review step's consolidation bridges (Prefill overtime, Transfer allowances, saving one
    // employee's row…) all post `returnTo` and land back on the wizard. `returnTo` was hardcoded
    // without `from`, so pressing any of them silently emptied the wizard's own Back — and, because the
    // wizard posts the same value onward, the Result screen's Back with it, for the rest of that run.
    const s = sel({ months: [1, 2, 3], companyIds: [companyId] });
    const draft = await createBatch(scope.s, { companyId, payPeriod: '2026-02' });
    const tree = await ProcessWizardPage({
      searchParams: Promise.resolve({ resume: draft.batchId, from: dashboardHref(s) }),
    });
    const panel = findWithProp(tree, 'returnTo');
    expect(panel, 'the resumed wizard renders no adjustment panel').toBeTruthy();
    const returnTo = panel!.props!.returnTo as string;
    expect(returnTo.startsWith(`/payroll/process?resume=${draft.batchId}`), returnTo).toBe(true);
    expect(fromOf(returnTo), 'the adjustment panel throws the selection away').toBe(dashboardHref(s));
    // The whole point of the round trip: the wizard reached through that destination still has a Back
    // that restores the list, rather than one that has quietly collapsed to the current period.
    const backAfter = backOf(
      await ProcessWizardPage({
        searchParams: Promise.resolve({ resume: draft.batchId, from: fromOf(returnTo) ?? undefined }),
      }),
    );
    expect(backAfter!.href).toBe(dashboardHref(s));
  });

  it('G. THE SCOPE FENCE: opening Payroll fresh from the sidebar still defaults, and must', async () => {
    // Point 3 of the reporter's own request: the current period is the default on FIRST entry, and only
    // then. Every screen above resolves a missing `from` to a bare `/payroll`, which is what makes the
    // sidebar entry land on the default rather than on somebody's last filter. Stated as an expectation
    // so a later round cannot read the four cases above as "remember everything, always".
    const params = Promise.resolve({ batchId });
    for (const back of [
      backOf(await BatchPage({ params, searchParams: Promise.resolve({}) })),
      backOf(await ReprocessPage({ params, searchParams: Promise.resolve({}) })),
      backOf(await RemovePage({ params, searchParams: Promise.resolve({}) })),
      backOf(await ResetPage({ params, searchParams: Promise.resolve({}) })),
      backOf(await ProcessWizardPage({ searchParams: Promise.resolve({}) })),
      await payrollProcessBack(undefined),
    ]) {
      expect(back!.href).toBe('/payroll');
    }
    // r253 — and the same fence on the ACTION path: a form that posts no selection redirects to exactly
    // the address it always did, so an operator who never filtered keeps a clean URL and the default
    // period. This is the half that must NOT change; case I is the half that must.
    expect(await redirectOf(() => closeAction(post({ batchId })))).toMatch(
      new RegExp(`^/payroll/${batchId}\\?(toast|error)=`),
    );
    expect(await redirectOf(() => reprocessSelectedAction(post({ batchId })))).toMatch(
      new RegExp(`^/payroll/${batchId}/reprocess\\?error=`),
    );
  });
});
