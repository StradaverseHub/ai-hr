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
  afterAll(async () => {
    await closeAll();
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

  it('the LISTING no longer renders a create form — it links to the create screen', () => {
    expect(LISTING).not.toContain('createCompanyAction');
    expect(LISTING).toContain('href="/admin/organization/new"');
  });

  it('renders a form bound to createCompanyAction with exactly the fields that action reads', async () => {
    // No session is needed to inspect the element tree: scopedAdmin is mocked and the page runs no
    // company read of its own — the create form is the whole screen.
    scope.s = null;
    scope.scopeIds = [];
    const tree = await NewCompanyPage({ searchParams: Promise.resolve({}) });
    const forms = findByType(tree, 'form');
    expect(forms).toHaveLength(1);
    expect(forms[0].props.action).toBe(createCompanyAction);

    const html = renderToStaticMarkup(tree as never);
    // createCompanyAction reads exactly these five. A sixth would be a field whose value is silently
    // discarded the moment the operator types into it.
    for (const name of ['legalName', 'registrationNo', 'country', 'currency', 'defaultPayrollCycle']) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toContain('required');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// i18n — a key present in en and missing in ms renders MISSING_MESSAGE at RUNTIME ONLY.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('i18n — every new Organization string in all six locales', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const NEW_KEYS = [
    'colCode',
    'colStatus',
    'statusActive',
    'statusArchived',
    'allStatuses',
    'searchLabel',
    'searchPlaceholder',
    'applyFilter',
    'open',
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
});
