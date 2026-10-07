/**
 * Organization → list-and-detail (item defd4644).
 *
 * The module used to open straight into a company form with the create form on the same screen and no
 * way to browse. It is now browse → pick → maintain: a table at /admin/organization, a create screen at
 * /admin/organization/new, and one company's maintenance screen at /admin/organization/[companyId].
 *
 * THIS FILE PINS THE THREE THINGS THAT CAN QUIETLY GO WRONG IN THAT SHAPE:
 *
 *  1. THE REFUSAL. Selection now lives in the ADDRESS, which is only safe because the maintenance page
 *     re-derives scope server-side: a `companyId` outside `app.is_admin_for` 404s. A page that
 *     rendered it read-only, or coerced it to "no selection", would still have disclosed another
 *     company's bank accounts and statutory identifiers. The happy path is asserted too, but the
 *     refusal is the assertion that matters — see AGENTS.md on scope guards not being decoration.
 *
 *  2. THE HIERARCHY. `listCompanies` does not select parentCompanyId; `companyTree` does. A flat
 *     redesign built from `listCompanies` alone looks complete and silently drops the group structure
 *     other screens use to decide who can see whose employees. Parent must be READABLE on the listing
 *     row and SETTABLE on the maintenance screen, and companyTree must still resolve the same links.
 *
 *  3. SEARCH / FILTER / SORT. Pure arithmetic over the already-scoped array (`selectCompanyRows`), so
 *     it is unit-tested here directly rather than through a rendered page. It can only ever NARROW —
 *     the permission boundary is the query's adminOnly predicate, not this function.
 *
 * The rendered-screen scope contract (which companies a group-wide vs company-scoped admin sees, and
 * that the totals derive from that same list) lives in test/organization-companies-reachable.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// notFound() THROWS, exactly as it does at runtime. A stub returning undefined would let the page run
// straight past its own guard and we would be asserting on a crash instead of on a refusal.
const { NOT_FOUND } = vi.hoisted(() => ({ NOT_FOUND: new Error('NEXT_NOT_FOUND') }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => {
    throw NOT_FOUND;
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/organization',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '', number: () => '' }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { companyTree } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { CompanyPanel } from '../components/company-panel';
import {
  selectCompanyRows,
  parseCompanySort,
  parseCompanyStatus,
  type CompanyListInput,
} from '../app/admin/organization/company-rows';
import CompanyMaintenancePage from '../app/admin/organization/[companyId]/page';
// 15e5bd93 rev 2 (r353) — the SECOND guarded route onto one company's data. A second door must not be an
// easier door, so the refusal this file runs for the detail page is run for it too.
// rev 3 (r355) added a THIRD, `…/statutory/[authority]`, and rev 4 (r372) DELETED it: the reporter
// contested that per-body page as "an unnecessary intermediate page", so every body is a card on the
// statutory screen itself. Its import, its render helper and its two cases are removed rather than
// loosened — there is no route left to refuse anything.
import CompanyStatutorySetupPage from '../app/admin/organization/[companyId]/statutory/page';
// 7a595a02 (r403) — the THIRD guarded route onto one company's data: the read-only view. Same rule as the
// statutory screen above: a second door must not be an easier door, so the refusal is RUN, not scanned.
import CompanyViewPage from '../app/admin/organization/[companyId]/view/page';
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import NewCompanyPage from '../app/admin/organization/new/page';
import { createCompanyAction } from '../app/admin/actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByType(node: unknown, type: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) findByType(n, type, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as any;
  if (el.type === type) acc.push(el);
  const children = el.props?.children;
  if (children !== undefined) findByType(children, type, acc);
  return acc;
}

/**
 * ⚠️ FILE-LEVEL, moved out of the scope-refusal describe by item 7d2df42a. It sat inside that describe,
 * so the connection pools closed the moment it finished — which was fine while every LATER describe was
 * pure. It stopped being fine when the create screen took a company read of its own: the next describe's
 * setup got `write CONNECTION_ENDED 127.0.0.1:5433`, which reads like a wedged cluster and is not one.
 * `closeAll` is file teardown; this is where it belongs.
 */
afterAll(async () => {
  await closeAll();
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Search / status filter / sort — pure, no DB.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('selectCompanyRows — the browse controls narrow the scoped set and never widen it', () => {
  const rows: CompanyListInput[] = [
    { id: 'a', name: 'Acme Sdn Bhd', companyLabel: 'ACM', registrationNo: '111-A', archivedAt: null },
    { id: 'b', name: 'Beta Holdings Bhd', companyLabel: 'BET', registrationNo: '222-B', archivedAt: null },
    { id: 'c', name: 'Beta East Sdn Bhd', companyLabel: 'BTE', registrationNo: '333-C', archivedAt: null },
    { id: 'd', name: 'Zeta Sdn Bhd', companyLabel: null, registrationNo: null, archivedAt: new Date() },
  ];
  const parentBy = new Map<string, string | null>([
    ['a', null],
    ['b', null],
    ['c', 'b'],
    ['d', null],
  ]);
  const ids = (o: Parameters<typeof selectCompanyRows>[2]) =>
    selectCompanyRows(rows, parentBy, o).map((r) => r.id);

  it('searches on CODE — the column the reporter asked for, which no previous search covered', () => {
    expect(ids({ q: 'BTE' })).toEqual(['c']);
    // Case-insensitive, and a partial code still matches.
    expect(ids({ q: 'bt' })).toEqual(['c']);
  });

  it('searches on PARTIAL NAME, which is the point of having a search at all', () => {
    expect(ids({ q: 'beta' }).sort()).toEqual(['b', 'c']);
    expect(ids({ q: 'east' })).toEqual(['c']);
  });

  it('still searches on registration number (the behaviour the old inline search had)', () => {
    expect(ids({ q: '222' })).toEqual(['b']);
  });

  it('filters by status, and an unrecognised ?status= shows everything rather than guessing', () => {
    expect(ids({ status: 'archived' })).toEqual(['d']);
    expect(ids({ status: 'active' }).sort()).toEqual(['a', 'b', 'c']);
    expect(ids({ status: 'banana' })).toHaveLength(4);
    expect(parseCompanyStatus('banana')).toBeNull();
  });

  it('sorts on a CLOSED set of keys — an unknown ?sort= falls back to name, it does not throw', () => {
    expect(parseCompanySort('nonsense')).toBe('name');
    expect(ids({ sort: 'nonsense' })).toEqual(['a', 'c', 'b', 'd']);
    expect(ids({ sort: 'code' })).toEqual(['d', 'a', 'b', 'c']); // null code sorts first
    expect(ids({ sort: 'regNo' })).toEqual(['d', 'a', 'b', 'c']);
    expect(ids({ sort: 'status' })).toEqual(['a', 'c', 'b', 'd']); // active before archived
    // Blank sorts first on every text column (code, regNo, parent alike), so the group ROOTS lead and
    // the subsidiaries follow their parent's name — consistent, not a special case for hierarchy.
    expect(ids({ sort: 'parent' })).toEqual(['a', 'b', 'd', 'c']);
  });

  it('names the parent company on the row, and NEVER names one outside the passed-in set', () => {
    const all = selectCompanyRows(rows, parentBy);
    expect(all.find((r) => r.id === 'c')!.parentName).toBe('Beta Holdings Bhd');
    expect(all.find((r) => r.id === 'b')!.parentName).toBeNull();

    // A parent id that is not among the scoped companies resolves to no parent rather than to a name
    // the viewer is not allowed to know exists.
    const danglings = selectCompanyRows(rows, new Map([['c', 'not-in-scope']]));
    expect(danglings.find((r) => r.id === 'c')!.parentName).toBeNull();
  });

  it('combines filters — search AND status, applied to the same array', () => {
    expect(ids({ q: 'sdn', status: 'active' }).sort()).toEqual(['a', 'c']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 1 + 2. The maintenance screen: the refusal, and the hierarchy.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('/admin/organization/[companyId] — the scope refusal and the parent picker', () => {
  let base: Base;
  const ids: Record<string, string> = {};

  async function addCompany(name: string, parentId: string | null = null): Promise<string> {
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: name, parentCompanyId: parentId })
      .returning({ id: schema.company.id });
    ids[name] = c.id;
    return c.id;
  }

  /** A REAL hr_admin: the role_assignment row exists AND the grant is on the session, so
   *  app.current_grants() (which reads the app.grants GUC) and the DB agree. */
  async function scopedAdminCtx(companyId: string | null): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
    return { ...adminCtx(base), userId: u.id, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId }] };
  }

  const render = (companyId: string) =>
    CompanyMaintenancePage({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    });
  /** 7a595a02 — the read-only view, whose guard must refuse exactly what the editor's refuses. */
  const renderView = (companyId: string, tab?: string) =>
    CompanyViewPage({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve(tab ? { tab } : {}),
    });
  /** The Statutory Payment Setup LIST, whose guard mirrors the detail page's line for line. */
  const renderStatutory = (companyId: string) =>
    CompanyStatutorySetupPage({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    });

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    for (const k of Object.keys(ids)) delete ids[k];
    ids['Acme Sdn Bhd'] = base.companyId;
    await addCompany('Beta Sdn Bhd');
    await addCompany('Beta East Sdn Bhd', ids['Beta Sdn Bhd']);
    await addCompany('Gamma Sdn Bhd');
  });

  it('REFUSES a company the signed-in admin cannot administer — 404, not read-only, not coerced', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];

    // Gamma is a real company in the same tenant. This admin's grant does not reach it.
    await expect(render(ids['Gamma Sdn Bhd'])).rejects.toThrow(NOT_FOUND);
    await expect(render(ids['Acme Sdn Bhd'])).rejects.toThrow(NOT_FOUND);
  });

  it('REFUSES an id that is not a company at all, without leaking whether it exists', async () => {
    scope.s = await scopedAdminCtx(null);
    scope.scopeIds = [];
    await expect(render(randomUUID())).rejects.toThrow(NOT_FOUND);
  });

  /**
   * 15e5bd93 REVISION 2 (r353) — THE SAME REFUSAL ON THE SECOND ROUTE, AND IT IS NOT A FORMALITY.
   *
   * The reporter's approved redesign puts the statutory bodies on `/admin/organization/<id>/statutory`. That
   * screen reads the same company, the same `company_statutory_my` row and the same bank accounts as the
   * detail page — so a guard that was merely COPIED rather than run is a guard nobody has checked. The
   * writes are independently refused by RLS, but a screen that renders another company's bank accounts has
   * already leaked them whether or not the save would have failed.
   *
   * ⚠️ RUN, NOT SCANNED: `page.tsx` calling `scopedAdmin()` proves nothing about the 404. The refusal is the
   * `companies.find(...)` miss, which only executing the page can show.
   */
  it('REFUSES the same companies on the Statutory Payment Setup list', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];
    await expect(renderStatutory(ids['Gamma Sdn Bhd'])).rejects.toThrow(NOT_FOUND);
    await expect(renderStatutory(ids['Acme Sdn Bhd'])).rejects.toThrow(NOT_FOUND);
    await expect(renderStatutory(randomUUID()), 'and a non-company id').rejects.toThrow(NOT_FOUND);
  });

  /**
   * 7a595a02 (r403) — THE READ-ONLY VIEW REFUSES WHAT THE EDITOR REFUSES, AND NOTHING LESS.
   *
   * The view reads the same company row, bank accounts and statutory setup as the editor. A view that
   * rendered a company the editor 404s would leak its bank accounts without any save being attempted, so
   * the refusal is executed on both pages over one matrix of readers × companies — including a company in
   * ANOTHER TENANT — and the two outcomes must agree cell by cell.
   */
  it('REFUSES on the read-only view exactly what the editor refuses — across companies and tenants', async () => {
    // A second tenant with its own company and its own tenant-wide admin.
    const other = await seedBase();
    const readers: Record<string, SessionContext> = {
      'Beta-scoped admin': await scopedAdminCtx(ids['Beta Sdn Bhd']),
      'tenant-wide admin': await scopedAdminCtx(null),
    };
    const targets: Record<string, string> = {
      Acme: ids['Acme Sdn Bhd'],
      Beta: ids['Beta Sdn Bhd'],
      'Beta East': ids['Beta East Sdn Bhd'],
      Gamma: ids['Gamma Sdn Bhd'],
      'other tenant’s company': other.companyId,
      'not a company': randomUUID(),
    };
    const outcome = async (p: Promise<unknown>) =>
      p.then(
        () => 'rendered',
        (e: unknown) => (e === NOT_FOUND ? '404' : `threw ${String(e)}`),
      );
    const seen = new Set<string>();
    for (const [who, ctx] of Object.entries(readers)) {
      for (const [what, id] of Object.entries(targets)) {
        scope.s = ctx;
        scope.scopeIds = [];
        const editor = await outcome(render(id));
        const view = await outcome(renderView(id));
        expect(view, `${who} → ${what}: the view must answer as the editor does`).toBe(editor);
        expect(['rendered', '404'], `${who} → ${what}`).toContain(view);
        seen.add(view);
      }
    }
    // Non-vacuity: the matrix held BOTH answers, so agreement is not "both always 404" or "both always render".
    expect([...seen].sort()).toEqual(['404', 'rendered']);

    // And the cells that matter, stated outright rather than only as agreement.
    scope.s = readers['Beta-scoped admin'];
    await expect(renderView(ids['Gamma Sdn Bhd']), 'a sibling company outside the grant').rejects.toThrow(NOT_FOUND);
    await expect(renderView(ids['Acme Sdn Bhd']), 'the grant does not reach upward').rejects.toThrow(NOT_FOUND);
    await expect(renderView(ids['Beta East Sdn Bhd']), 'the grant reaches the subsidiary').resolves.toBeTruthy();
    scope.s = readers['tenant-wide admin'];
    await expect(renderView(other.companyId), 'another tenant, even for a tenant-wide admin').rejects.toThrow(NOT_FOUND);
    // …and an ?tab= cannot route around it.
    await expect(renderView(other.companyId, 'bank'), 'nor via the bank tab').rejects.toThrow(NOT_FOUND);
  });

  it('the view renders the company as TEXT — no form control, no write — with Edit into the editor', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];
    await owner.db.update(schema.company).set({ companyLabel: 'BTE', city: 'Ipoh' }).where(eq(schema.company.id, ids['Beta East Sdn Bhd']));
    await owner.db.insert(schema.companyBankProfile).values([
      { tenantId: base.tenantId, companyId: ids['Beta East Sdn Bhd'], bank: 'maybank', corporateId: 'CORP-EAST', debitAccountNo: '5140-EAST-001' },
      // A sibling's account: must never surface on Beta East's view.
      { tenantId: base.tenantId, companyId: ids['Gamma Sdn Bhd'], bank: 'maybank', corporateId: 'CORP-GAMMA', debitAccountNo: '5140-GAMMA-009' },
    ]);
    const id = ids['Beta East Sdn Bhd'];
    const pages: Record<string, string> = {};
    for (const tab of ['general', 'bank', 'statutory', 'bogus'] as const) {
      pages[tab] = renderToStaticMarkup((await renderView(id, tab)) as never);
    }
    for (const [tab, html] of Object.entries(pages)) {
      expect(html.length, `${tab}: rendered something substantial`).toBeGreaterThan(1500);
      for (const banned of ['<form', '<input', '<select', '<textarea', '<button', ' name="', 'formaction']) {
        expect(html.toLowerCase(), `${tab}: the read-only view rendered ${banned}`).not.toContain(banned);
      }
      // Edit opens the EXISTING editor (keeping the tab), never another view.
      const editTags = html.match(/<a\b[^>]*data-company-edit-link[^>]*>/g) ?? [];
      expect(editTags, `${tab}: exactly one Edit link`).toHaveLength(1);
      const editHref = editTags[0].match(/href="([^"]*)"/)?.[1];
      expect(editHref, `${tab}: Edit opens the editor`).toBe(
        tab === 'bank' || tab === 'statutory' ? `/admin/organization/${id}?tab=${tab}` : `/admin/organization/${id}`,
      );
      expect(html, `${tab}: never names a company outside the grant`).not.toContain('Gamma Sdn Bhd');
      expect(html).not.toContain('5140-GAMMA-009');
    }
    // General: the editor's fields, as text — code, city, and the parent the tree resolves.
    expect(pages.general).toContain('BTE');
    expect(pages.general).toContain('Ipoh');
    expect(pages.general).toContain('Beta Sdn Bhd');
    // An unrecognised ?tab= opens General, exactly as the editor treats it.
    expect(pages.bogus).toBe(pages.general);
    // Bank: this company's account, and only on the bank tab.
    expect(pages.bank).toContain('5140-EAST-001');
    expect(pages.bank).toContain('CORP-EAST');
    expect(pages.general).not.toContain('5140-EAST-001');
    // Statutory: the bodies list, read-only.
    expect(pages.statutory).toContain('data-statutory-body="epf"');
    expect(pages.statutory).toContain('aria-current="page"');
  });

  /**
   * ⚠️ REVERSED TWICE, AND THIS ROUND REVERSES IT BACK — WITH THE REASON IT WAS REVERSED KEPT.
   *
   * r353's version: "renders the setup screen … WITH THE TWO WRITERS WIRED", because that screen held
   * eight editors. r355's version, quoted in full so the claim being reversed is on the record: "the
   * list cannot write, so it is given nothing to write with" — the reporter had asked for a table of
   * rows with "no fields, no forms, nothing expanded", so the writers belonged to the per-body route and
   * a `'use server'` action passed to a screen that never submits it would have been a second door onto
   * `company_statutory_authority` that nothing was watching.
   *
   * ⚠️ THAT REASONING IS UNCHANGED AND IT IS WHY THE WRITERS BELONG HERE NOW. The reporter contested the
   * per-body route; every body's form is on THIS screen, so this screen is exactly where the writers are
   * submitted from. The test of "is this action a second door?" is whether the screen renders a form
   * that posts it, and all three now do:
   *   · `saveStatutoryScreen`      — the one Save, pressed on this screen
   *   · `setStatutoryAuthority`    — each card's own form binding, intercepted by the save scope
   *   · `removeStatutoryAuthority` — Clear, which is bucket (b) and still redirects
   * The signatory candidates come back for the same reason: there are eight pickers on this page.
   */
  it('renders the SCREEN for the company it DOES administer, with all three writers wired', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];
    const tree = await renderStatutory(ids['Beta East Sdn Bhd']);
    const screens = findByType(tree, StatutorySetupScreen);
    expect(screens, 'exactly one setup screen — this page maintains ONE company').toHaveLength(1);
    const props = screens[0].props;
    expect(props.companyId).toBe(ids['Beta East Sdn Bhd']);
    // Both bucket-(a) writers and the bucket-(b) one: without the last, "Clear this authority" would have
    // no home in the product at all.
    expect(typeof props.actions.saveStatutoryScreen, 'the one Save').toBe('function');
    expect(typeof props.actions.setStatutoryAuthority, 'each card’s form binding').toBe('function');
    expect(typeof props.actions.removeStatutoryAuthority, 'Clear').toBe('function');
    // Back and Cancel both return to the company's STATUTORY tab, not to the company list.
    expect(props.backHref).toBe(`/admin/organization/${ids['Beta East Sdn Bhd']}?tab=statutory`);
    // The signatory candidates are COMPANY-scoped: the service refuses to newly appoint anyone who is not
    // an active employee of this company, so a tenant-wide list would only offer choices that fail on save.
    for (const sg of props.signatories ?? []) {
      expect(sg.personId, 'a candidate is a person of this company').toBeTruthy();
    }
  });

  it('renders the company it DOES administer, with the panel open and the actions wired', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];

    const tree = await render(ids['Beta East Sdn Bhd']);
    const panels = findByType(tree, CompanyPanel);
    expect(panels, 'exactly one CompanyPanel — this page maintains ONE company').toHaveLength(1);
    const props = panels[0].props;

    expect(props.company.id).toBe(ids['Beta East Sdn Bhd']);
    expect(props.company.name).toBe('Beta East Sdn Bhd');

    // ── THE MAINTENANCE SCREEN OPENS ────────────────────────────────────────────────────────────
    // This assertion used to read `expect(props.defaultExpanded).toBe(true)`. Item 3c2f55d7 did not
    // reverse what it was protecting — it made the protection unnecessary: the panel no longer folds
    // at ALL, so there is no flag left to pass. (This page was its only caller and always passed it,
    // and the three folds INSIDE the panel went with it.) The half that still matters is the
    // BEHAVIOUR, not the prop, so it is now asserted on the markup, where a reintroduced disclosure
    // would actually show up. `defaultExpanded` must NOT come back as a silently-ignored prop.
    expect(props, 'the panel no longer takes an expand flag').not.toHaveProperty('defaultExpanded');
    const openHtml = renderToStaticMarkup(createElement(CompanyPanel, props));
    expect(openHtml, 'nothing on an opened company may need opening again').not.toContain('<details');
    expect(openHtml, 'the General tab renders its content on arrival').toContain('name="legalName"');

    // Every write the panel offers still reaches a real server action.
    for (const k of [
      'updateCompany',
      'archiveCompany',
      'deleteCompany',
      'setParent',
      'setStatutory',
      'setBankProfile',
      'removeBankProfile',
      'setStatutoryAuthority',
      'removeStatutoryAuthority',
      'setCompanyLogo',
      'removeCompanyLogo',
      'updateCompanyDefaultCycle',
    ]) {
      expect(typeof props.actions[k], `actions.${k}`).toBe('function');
    }
  });

  it('carries the PARENT through, and companyTree still resolves the same hierarchy', async () => {
    const s = await scopedAdminCtx(null);
    scope.s = s;
    scope.scopeIds = [];

    const tree = await render(ids['Beta East Sdn Bhd']);
    const props = findByType(tree, CompanyPanel)[0].props;

    // Readable: the panel is pre-set to the saved parent, so an unrelated save cannot silently
    // re-root the company by posting a blank picker.
    expect(props.company.parentId).toBe(ids['Beta Sdn Bhd']);

    // …and it is the SAME link companyTree reports. listCompanies does not carry parentCompanyId, so
    // this is the assertion that fails if the separate tree read is ever dropped for a flat listing.
    const treeRows = await companyTree(s);
    const east = treeRows.find((n) => n.id === ids['Beta East Sdn Bhd'])!;
    expect(east.parentId).toBe(ids['Beta Sdn Bhd']);
    expect(props.company.parentId).toBe(east.parentId);

    // Settable: the rendered panel carries the Set-parent form with a real picker.
    const html = renderToStaticMarkup(createElement(CompanyPanel, props));
    expect(html).toContain('name="parentCompanyId"');
    expect(html).toContain(`value="${ids['Beta Sdn Bhd']}"`);
    // A company cannot be offered itself as its own parent.
    expect(html).not.toContain(`<option value="${ids['Beta East Sdn Bhd']}"`);
  });

  it('the parent picker offers ONLY administrable companies — it never discloses one the listing hides', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [];

    const tree = await render(ids['Beta East Sdn Bhd']);
    const props = findByType(tree, CompanyPanel)[0].props;
    const html = renderToStaticMarkup(createElement(CompanyPanel, props));

    expect(html).toContain('Beta Sdn Bhd');
    expect(html).not.toContain('Gamma Sdn Bhd');
    expect(html).not.toContain('Acme Sdn Bhd');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The create screen — off the listing, and posting only what the action reads.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('/admin/organization/new — the create form has its own screen', () => {
  const LISTING = fs.readFileSync(
    path.resolve(__dirname, '../app/admin/organization/page.tsx'),
    'utf8',
  );

  /**
   * ⚠️ UPDATED BY ITEM 7d2df42a — THIS SCREEN NOW TAKES A COMPANY READ, so it needs a real session.
   *
   * It used to run none, and the case below said so ("scopedAdmin is mocked and the page runs no
   * company read of its own"). That stopped being true when the Company Code field learned to warn —
   * and NAME the other company — when the operator types a code somebody else already uses: the page
   * reads `listCompanies(s, { adminOnly: true })` to know which codes are taken and who holds them.
   * A null session now throws out of withTenant before the form is built.
   *
   * The guard itself is unchanged and is not loosened: what is asserted below is still the EXACT field
   * set the create action reads, and still that `legalName` is the only required input. Only the
   * precondition moved.
   */
  let createBase: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    createBase = await seedBase();
    // Group-wide hr_admin, the grant on the SESSION as well as in role_assignment, because the new read
    // resolves scope through the database's own app.is_admin_for (which reads the app.grants GUC).
    scope.s = { ...adminCtx(createBase), grants: [{ role: 'hr_admin', companyId: null }] };
    scope.scopeIds = [];
  });

  it('the LISTING no longer renders a create form — it links to the create screen', () => {
    expect(LISTING).not.toContain('createCompanyAction');
    expect(LISTING).toContain('href="/admin/organization/new"');
  });

  it('renders a form bound to createCompanyAction with exactly the fields that action reads', async () => {
    // The session comes from this describe's beforeEach — see the note above it: since 7d2df42a the
    // page runs one company read (the codes already in use, for the duplicate warning).
    const tree = await NewCompanyPage({ searchParams: Promise.resolve({}) });
    const forms = findByType(tree, 'form');
    expect(forms).toHaveLength(1);
    expect(forms[0].props.action).toBe(createCompanyAction);

    const html = renderToStaticMarkup(tree as never);
    /**
     * ⚠️ UPDATED BY ITEM 3783fd87 — A SIXTH FIELD ADDED, AND THE GUARD TIGHTENED RATHER THAN LOOSENED.
     *
     * This case pinned five names with the note "a sixth would be a field whose value is silently
     * discarded the moment the operator types into it". That risk is unchanged and the note still
     * stands; what changed is that `createCompanyAction` now reads a SIXTH — `companyLabel`, the
     * Company Code, which `company.company_label` has always stored and which the listing has always
     * headed "Code". It was reachable only AFTER creation, which is why 7 of the 13 production
     * companies carry no code and two of the six that do hold something that is not one.
     *
     * The list is now an EXACT SET both ways: every name below is present AND no name that is not
     * below appears in the form. A `toContain` per name could never have caught the fault it was
     * written for — an extra input the action ignores — because it only ever looked for what it
     * expected. The end-to-end proof that the value is actually STORED (and that a blank one still
     * creates a company) lives in test/organization-company-code.test.ts; this half is the contract
     * between the form and the action, pinned in the file that owns the create screen's shape.
     */
    const EXPECTED = ['legalName', 'companyLabel', 'registrationNo', 'country', 'currency', 'defaultPayrollCycle'];
    for (const name of EXPECTED) {
      expect(html, name).toContain(`name="${name}"`);
    }
    const posted = [...html.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(posted)].sort(), 'no field the create action does not read').toEqual(
      [...EXPECTED].sort(),
    );
    expect(html).toContain('required');
    // …and `legalName` is the ONLY required one. The code is nullable free text (the General tab can
    // clear it), so a create form that refused a blank would contradict the edit form — see the header
    // of app/admin/organization/new/page.tsx.
    expect([...html.matchAll(/<input[^>]*\brequired\b[^>]*>/g)]).toHaveLength(1);
    expect(html).toMatch(/name="legalName"[^>]*\brequired\b|\brequired\b[^>]*name="legalName"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// i18n — a key present in en and missing in ms renders MISSING_MESSAGE at RUNTIME ONLY.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('i18n — every new Organization string in all six locales', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  // 3c2f55d7 rev 2 — `open` LEAVES this list and the six catalogues with the single Open link it
  // captioned: the listing's last column is now View · Edit · Archive (see company-rows.tsx). The case is
  // updated rather than dropped (AGENTS.md rule 18) — the four captions that replaced it are asserted in
  // exactly the same two ways, present AND actually translated.
  const NEW_KEYS = [
    'colCode',
    'colStatus',
    'statusActive',
    'statusArchived',
    'allStatuses',
    'searchLabel',
    'searchPlaceholder',
    'applyFilter',
    'colActions',
    'actionView',
    'actionEdit',
    'actionArchive',
    'actionUnarchive',
    'backToCompanies',
    'createDescription',
  ] as const;
  const org = Object.fromEntries(
    LOCALES.map((l) => [
      l,
      JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${l}.json`), 'utf8')).admin
        .organization as Record<string, string>,
    ]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;

  it('carries every new key, non-empty, in each locale', () => {
    for (const l of LOCALES) {
      for (const k of NEW_KEYS) {
        expect(typeof org[l][k], `messages/${l}.json admin.organization.${k}`).toBe('string');
        expect(org[l][k].trim().length, `messages/${l}.json admin.organization.${k} empty`).toBeGreaterThan(0);
      }
    }
  });

  // Presence alone passes if the English value is pasted into all six — five locales shipped in
  // English behind a fully green build. `colStatus` is deliberately excluded: "Status" is the correct
  // Malay word for it, so requiring a difference there would force a wrong translation.
  it('is actually translated in the five non-English locales', () => {
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      for (const k of NEW_KEYS.filter((x) => x !== 'colStatus')) {
        expect(org[l][k], `${l}: admin.organization.${k} is still the en value`).not.toBe(org.en[k]);
      }
    }
  });

  // The keys the redesign REUSES rather than reinventing. They already existed; this pins that a
  // future cleanup of the retired inline create form does not take them with it.
  it('keeps the reused keys the new screens depend on', () => {
    for (const l of LOCALES) {
      for (const k of ['legalName', 'regNo', 'parentCompany', 'addNewCompany', 'addCompany', 'noMatches']) {
        expect(org[l][k], `messages/${l}.json admin.organization.${k}`).toBeTruthy();
      }
    }
  });

  it('drops `open` rather than leaving it to rot in six catalogues', () => {
    // Its one consumer — the listing's Open column — became View · Edit · Archive. i18n-check enforces
    // parity, not usefulness, so a retired key survives a green build forever unless something says so.
    for (const l of LOCALES) {
      expect(org[l], `messages/${l}.json admin.organization.open`).not.toHaveProperty('open');
    }
    expect(
      fs.readFileSync(path.resolve(__dirname, '../app/admin/organization/page.tsx'), 'utf8'),
    ).not.toContain("t('open')");
  });
});

/**
 * Item 3c2f55d7 rev 2 — the listing's actions column.
 *
 * A static-source guard, because the interesting parts are shape, not behaviour: that Archive is a WRITE
 * posting to the EXISTING company archive action (no new service, no new permission surface), that it
 * states archived=true/false EXPLICITLY rather than relying on a hidden field's presence (AGENTS.md rule
 * 17 — a hidden input is submitted whatever its value, so a presence check reads every row as "archive
 * me"), and that an archived row is offered Unarchive instead of a dead Archive.
 */
describe('Organization listing — View · Edit · Archive (3c2f55d7 rev 2)', () => {
  const ROWS = fs.readFileSync(
    path.resolve(__dirname, '../app/admin/organization/company-rows.tsx'),
    'utf8',
  );
  const LIST = fs.readFileSync(path.resolve(__dirname, '../app/admin/organization/page.tsx'), 'utf8');

  it('offers all three actions on every row', () => {
    for (const l of ['labels.view', 'labels.edit', 'labels.archive', 'labels.unarchive']) {
      expect(ROWS, l).toContain(l);
    }
  });

  it('archives through the EXISTING server action, bound by the page', () => {
    expect(ROWS).toContain('action={archiveAction}');
    expect(LIST).toContain("import { archiveCompanyAction } from '../actions'");
    expect(LIST).toContain('archiveAction={archiveCompanyAction}');
  });

  it('posts archived as an explicit true/false, never by field presence', () => {
    expect(ROWS).toContain(`value={r.archived ? 'false' : 'true'}`);
    // …and the caption flips with it, so an archived company is never offered Archive again.
    expect(ROWS).toContain('{r.archived ? labels.unarchive : labels.archive}');
  });

  /**
   * ⚠️ REVERSED BY 7a595a02 (r403). This case read "View and Edit both open the company page — there is no
   * read-only rendering of it", and pinned two identical hrefs. The read-only view now exists
   * (app/admin/organization/[companyId]/view), so View — and the company's NAME — go there, and Edit alone
   * opens the editor. Updated, not deleted: the half that still holds (Edit opens the editor) is asserted.
   */
  it('View and the company name open the read-only view; Edit alone opens the editor', () => {
    const viewAt = ROWS.indexOf('{labels.view}');
    const editAt = ROWS.indexOf('{labels.edit}');
    const nameAt = ROWS.indexOf('{r.name}\n');
    expect(viewAt, 'View caption found').toBeGreaterThanOrEqual(0);
    expect(editAt, 'Edit caption found').toBeGreaterThan(viewAt);
    expect(nameAt, 'name cell found').toBeGreaterThanOrEqual(0);
    const cell = ROWS.slice(ROWS.lastIndexOf('<td', viewAt), ROWS.indexOf('</td>', viewAt));
    expect(cell.length, 'the actions cell slice is real').toBeGreaterThan(200);
    // The link immediately before each caption.
    const hrefBefore = (at: number) => {
      const linkAt = ROWS.lastIndexOf('<Link href=', at);
      return ROWS.slice(linkAt, ROWS.indexOf('}', ROWS.indexOf('`}', linkAt)) + 1);
    };
    expect(hrefBefore(viewAt)).toBe('<Link href={`${basePath}/${r.id}/view`}');
    expect(hrefBefore(nameAt)).toBe('<Link href={`${basePath}/${r.id}/view`}');
    expect(hrefBefore(editAt)).toBe('<Link href={`${basePath}/${r.id}`}');
  });
});
