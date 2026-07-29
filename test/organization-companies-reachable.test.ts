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
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin holder — mutated per test so we control s + scopeIds. next/cache + next/navigation are
// stubbed inert because the page imports server actions that pull them at module load.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
// The client half: CompanyPanel / CompaniesCardHeader / OrganizationList all call useTranslations, and
// the list below is rendered for real (see the render test) rather than inspected as props.
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
import { OrganizationList } from '../components/organization-list';
import { CompaniesCardHeader } from '../components/add-company';
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

/** Render the page and pull out the four things the screen shows: the list, the header total, the tree,
 *  and the list's ACTUAL markup — props are what the page hands the list, markup is what the reporter
 *  sees, and the previous round's test only ever checked the first. */
async function renderScreen() {
  const tree = await OrganizationPage({ searchParams: Promise.resolve({}) });
  const lists = findByType(tree, OrganizationList);
  const headers = findByType(tree, CompaniesCardHeader);
  expect(headers).toHaveLength(1);
  const items = (lists[0]?.props.items ?? []) as { id: string }[];
  return {
    listIds: items.map((i) => i.id),
    total: headers[0].props.count as number,
    treeNodes: findTreeNodes(tree) ?? [],
    // No search query is typed, so OrganizationList must emit one row per item with nothing hidden.
    html: lists.length ? renderToStaticMarkup(createElement(OrganizationList, lists[0].props)) : '',
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

    const { listIds, total, treeNodes, html } = await renderScreen();

    expect(listIds.sort()).toEqual(Object.values(ids).sort());
    expect(total).toBe(listIds.length);
    expect(total).toBe(6);
    // The Group Structure count uses the same number, so the tree must cover the same set.
    expect(treeNodes.map((n) => n.id).sort()).toEqual(listIds.slice().sort());
    // …and all six are actually IN THE MARKUP. The names are fixture data, not catalog strings, so a
    // match here cannot come from an i18n bundle the way a label match can.
    for (const name of Object.keys(ids)) expect(html, name).toContain(name);
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

    // In the markup too — including the parent picker inside each panel, which must not offer a
    // company this admin cannot re-parent into.
    expect(html).toContain('Beta Sdn Bhd');
    expect(html).toContain('Beta East Sdn Bhd');
    expect(html).not.toContain('Gamma Sdn Bhd');
    expect(html).not.toContain('Acme Sdn Bhd');
  });

  it('a subsidiary whose PARENT is out of reach is re-rooted, so the tree still draws every row it counts', async () => {
    // Admin scoped to the SUBSIDIARY only: Beta East is reachable, its parent Beta is not.
    scope.s = await scopedAdminCtx(ids['Beta East Sdn Bhd']);
    scope.scopeIds = [];

    const { listIds, total, treeNodes } = await renderScreen();

    expect(listIds).toEqual([ids['Beta East Sdn Bhd']]);
    expect(total).toBe(1);
    expect(treeNodes).toHaveLength(1);
    // Left as Beta's id, CompanyTree (which descends from parentId === null) would render NOTHING
    // while the card still said 1 — the exact list/total drift this item is about.
    expect(treeNodes[0].parentId).toBeNull();
  });
});
