/**
 * Organization → Companies: the list is EVERY company the signed-in person can reach, and the totals
 * on the screen are derived from that SAME list (feedback ae3bd088).
 *
 * WHAT THE PREVIOUS ROUND GOT (0f1802bf, test/organization-companies-unscoped.test.ts) AND WHAT IT
 * MISSED. That round proved the card ignores the company-switcher cookie, which it does. It proved it
 * with a GROUP-WIDE admin and two companies, so `listCompanies` — which is scoped to the TENANT and to
 * nothing else — passed for the wrong reason: a tenant-wide read and a "everything this admin can
 * reach" read are indistinguishable when the admin can reach everything. Nothing in the suite pinned
 * the other direction, so the screen's contract was never actually stated.
 *
 * THIS FILE STATES IT, IN BOTH DIRECTIONS:
 *
 *   1. GROUP-WIDE hr_admin (companyId null on the grant) → every company in the tenant, archived ones
 *      included, and the header total equals the list length. This is the reporter's own case: 8
 *      companies, one group-wide grant, so the correct answer is 8. A fix that narrowed this would be
 *      "fixing" the complaint by making it worse.
 *
 *   2. COMPANY-SCOPED hr_admin (grant pinned to one company) → that company and its SUBTREE only, and
 *      the header total equals THAT length. This is the case that proves the total is not `count(*)`
 *      over `company`: without it, a total computed from the whole table passes test 1 and ships.
 *
 * The scope predicate is the database's own `app.is_admin_for` (migration 0016) — the same function the
 * company table's own WITH CHECK uses — so the list can never disagree with what the person is allowed
 * to EDIT on the panel they are being shown. A group-wide grant satisfies it for every company, which
 * is why case 1 is all-8 rather than a narrowing.
 *
 * The Group Structure tree is asserted too: it draws from the same resolved set, so its bracketed count
 * cannot drift from the card's. A subsidiary whose parent is out of reach is re-rooted rather than
 * dropped — CompanyTree only descends from `parentId === null`, so leaving the dangling parent id in
 * place would render the row nowhere while still counting it.
 *
 * UPDATED for item defd4644 (list-and-detail redesign), NOT weakened. The browse surface is now a
 * server-rendered table (`CompanyRows`) instead of a client list of mounted panels; the create form and
 * the per-company panel moved to their own routes. Every assertion below is the same contract stated
 * against the new shape, plus one the old shape could not state: the PARENT COMPANY is on the row, so
 * a redesign that rendered only `listCompanies` — which does not select parentCompanyId — fails here
 * rather than silently shipping a flat table.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin holder — mutated per test so we control s + scopeIds. next/cache + next/navigation are
// stubbed inert because the page imports server actions that pull them at module load.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// `useRouter` is part of the stub because the shared <Pager> pulls in the page-size selector, which is
// a client component — the page imports it even though this test never renders the pager itself.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => undefined),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/organization',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
// next-intl's client hook, for anything under a 'use client' boundary that this file renders.
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '', number: () => '' }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { SectionHeader } from '../components/ui';
import { CompanyRows, type CompanyRow } from '../app/admin/organization/company-rows';
import OrganizationPage from '../app/admin/organization/page';

/** Depth-first walk of a rendered React element tree collecting every node whose `type` matches. */
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

/** The CompanyTree element the page renders inside the Group Structure card (a local function component). */
function findTreeNodes(node: unknown): { id: string; parentId: string | null }[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findTreeNodes(n);
      if (found) return found;
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as any;
  if (typeof el.type === 'function' && el.type.name === 'CompanyTree' && Array.isArray(el.props?.nodes)) {
    return el.props.nodes;
  }
  return findTreeNodes(el.props?.children);
}

let base: Base;
/** name → id for every company seeded in the fixture. */
const ids: Record<string, string> = {};

async function addCompany(name: string, parentId: string | null = null): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: base.tenantId, legalName: name, parentCompanyId: parentId })
    .returning({ id: schema.company.id });
  ids[name] = c.id;
  return c.id;
}

/** A REAL company-scoped hr_admin: the role_assignment row exists AND the grant is on the session, so
 *  app.current_grants() (which reads the app.grants GUC) and the DB agree. */
async function scopedAdminCtx(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: base.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return {
    ...adminCtx(base),
    userId: u.id,
    roles: ['hr_admin'],
    grants: [{ role: 'hr_admin', companyId }],
  };
}

/** Render the page and pull out the four things the screen shows: the rows, the header total, the tree,
 *  and the table's ACTUAL markup — props are what the page hands the table, markup is what the reporter
 *  sees, and the round before last only ever checked the first.
 *
 *  `searchParams` is threaded through so a test can prove the address-bar filters narrow the SAME
 *  resolved set rather than re-querying with a different scope. */
async function renderScreen(sp: Record<string, string> = {}) {
  const tree = await OrganizationPage({ searchParams: Promise.resolve(sp) });
  const lists = findByType(tree, CompanyRows);
  expect(lists, 'the listing renders exactly one CompanyRows body').toHaveLength(1);
  // Found by title key (getTranslations is identity-mocked) so the statutory-gap card's own
  // SectionHeader can never be read as the Companies count.
  const headers = findByType(tree, SectionHeader).filter((h) => h.props.title === 'companies');
  expect(headers).toHaveLength(1);
  const rows = (lists[0].props.rows ?? []) as CompanyRow[];
  return {
    rows,
    listIds: rows.map((r) => r.id),
    total: headers[0].props.count as number,
    treeNodes: findTreeNodes(tree) ?? [],
    // Rendered inside a real table so the <tr>s are legal children; next/link resolves to plain <a>.
    html: renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement('tbody', null, createElement(CompanyRows, lists[0].props)),
      ),
    ),
  };
}

describe('Organization → Companies: reachable companies, and totals derived from that same list', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    for (const k of Object.keys(ids)) delete ids[k];
    ids['Acme Sdn Bhd'] = base.companyId;
    // A group with a subsidiary chain (Beta → Beta East), plus three unrelated companies and one
    // archived company — the archived row matters because the card asks for includeArchived.
    await addCompany('Beta Sdn Bhd');
    await addCompany('Beta East Sdn Bhd', ids['Beta Sdn Bhd']);
    await addCompany('Gamma Sdn Bhd');
    await addCompany('Delta Sdn Bhd');
    const zeta = await addCompany('Zeta Sdn Bhd');
    // Archived, and still expected in the list: the card reads includeArchived so an archived company
    // stays manageable (un-archiving it is one of the panel's actions).
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, zeta));
  });
  afterAll(async () => {
    await closeAll();
  });

  it('GROUP-WIDE admin sees every company in the tenant, and the total equals the list', async () => {
    scope.s = await scopedAdminCtx(null);
    // The switcher is deliberately narrowed to ONE company: this screen must ignore it (0f1802bf).
    scope.scopeIds = [base.companyId];

    const { rows, listIds, total, treeNodes, html } = await renderScreen();

    expect(listIds.sort()).toEqual(Object.values(ids).sort());
    expect(total).toBe(listIds.length);
    expect(total).toBe(6);
    // The Group Structure count uses the same number, so the tree must cover the same set.
    expect(treeNodes.map((n) => n.id).sort()).toEqual(listIds.slice().sort());
    // …and all six are actually IN THE MARKUP. The names are fixture data, not catalog strings, so a
    // match here cannot come from an i18n bundle the way a label match can.
    for (const name of Object.keys(ids)) expect(html, name).toContain(name);

    // THE HIERARCHY IS ON THE ROW (defd4644). `listCompanies` does not select parentCompanyId, so a
    // listing rebuilt from it alone would show every parent as blank and look perfectly fine. Beta
    // East's parent must be NAMED, and the archived company must still be listed with a status.
    const east = rows.find((r) => r.id === ids['Beta East Sdn Bhd'])!;
    expect(east.parentId).toBe(ids['Beta Sdn Bhd']);
    expect(east.parentName).toBe('Beta Sdn Bhd');
    expect(rows.find((r) => r.id === ids['Zeta Sdn Bhd'])!.archived).toBe(true);
    expect(rows.find((r) => r.id === ids['Acme Sdn Bhd'])!.archived).toBe(false);
  });

  // The address bar is where selection lives now, so the filters have to narrow the SAME resolved set
  // — never re-query it. A search that widened scope would show up here as an extra id.
  it('the ?q= search matches on partial NAME and stays inside the administrable set', async () => {
    scope.s = await scopedAdminCtx(null);
    scope.scopeIds = [];

    const { listIds, total } = await renderScreen({ q: 'beta' });

    expect(listIds.sort()).toEqual([ids['Beta Sdn Bhd'], ids['Beta East Sdn Bhd']].sort());
    expect(total).toBe(2);
  });

  it('the ?status= filter separates active from archived, and neither can exceed the scoped set', async () => {
    scope.s = await scopedAdminCtx(null);
    scope.scopeIds = [];

    const archived = await renderScreen({ status: 'archived' });
    expect(archived.listIds).toEqual([ids['Zeta Sdn Bhd']]);

    const active = await renderScreen({ status: 'active' });
    expect(active.listIds).not.toContain(ids['Zeta Sdn Bhd']);
    expect(active.listIds).toHaveLength(5);
  });

  it('COMPANY-SCOPED admin sees only their company + subtree, and the total equals THAT list', async () => {
    scope.s = await scopedAdminCtx(ids['Beta Sdn Bhd']);
    scope.scopeIds = [ids['Beta Sdn Bhd']];

    const { listIds, total, treeNodes, html } = await renderScreen();

    // Beta and its subsidiary — never Acme/Gamma/Delta/Zeta, which this admin cannot administer.
    expect(listIds.sort()).toEqual([ids['Beta Sdn Bhd'], ids['Beta East Sdn Bhd']].sort());
    // THE ASSERTION THAT MAKES THE PAIR MEANINGFUL: a total computed as count(*) over `company`
    // would be 6 here and would still have passed the group-wide test above.
    expect(total).toBe(listIds.length);
    expect(total).toBe(2);
    expect(listIds).not.toContain(ids['Acme Sdn Bhd']);
    expect(listIds).not.toContain(ids['Gamma Sdn Bhd']);

    // The tree shows the same two, and Beta is re-rooted (its own parent is null anyway) while Beta
    // East keeps its in-reach parent.
    expect(treeNodes.map((n) => n.id).sort()).toEqual(listIds.slice().sort());
    const east = treeNodes.find((n) => n.id === ids['Beta East Sdn Bhd'])!;
    expect(east.parentId).toBe(ids['Beta Sdn Bhd']);

    // In the markup too. The parent PICKER moved to /admin/organization/[companyId] with the panel —
    // that it offers only administrable companies is asserted in test/organization-list-detail.test.ts.
    expect(html).toContain('Beta Sdn Bhd');
    expect(html).toContain('Beta East Sdn Bhd');
    expect(html).not.toContain('Gamma Sdn Bhd');
    expect(html).not.toContain('Acme Sdn Bhd');
  });

  it('a subsidiary whose PARENT is out of reach is re-rooted, so the tree still draws every row it counts', async () => {
    // Admin scoped to the SUBSIDIARY only: Beta East is reachable, its parent Beta is not.
    scope.s = await scopedAdminCtx(ids['Beta East Sdn Bhd']);
    scope.scopeIds = [];

    const { rows, listIds, total, treeNodes, html } = await renderScreen();

    expect(listIds).toEqual([ids['Beta East Sdn Bhd']]);
    expect(total).toBe(1);
    expect(treeNodes).toHaveLength(1);
    // Left as Beta's id, CompanyTree (which descends from parentId === null) would render NOTHING
    // while the card still said 1 — the exact list/total drift this item is about.
    expect(treeNodes[0].parentId).toBeNull();

    // The Parent column obeys the same rule for the same reason: a parent this admin cannot
    // administer is not named, so the column can never disclose a company the listing itself refuses
    // to show. Blank parent + one row, not "Beta Sdn Bhd" leaking through a join.
    expect(rows[0].parentId).toBeNull();
    expect(rows[0].parentName).toBeNull();
    expect(html).not.toContain('Beta Sdn Bhd');
    expect(html).toContain('Beta East Sdn Bhd');
  });
});
