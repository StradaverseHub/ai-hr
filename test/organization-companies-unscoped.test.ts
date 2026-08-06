/**
 * Organization → Companies card (feedback 0f1802bf "Display All Companies").
 *
 * BUG: the editable Companies management card rendered from `scoped` (companies filtered by the
 * company-switcher's company_scope cookie via scopedAdmin/getScopeIds), so when the switcher held a
 * single company the card collapsed to just that one entity — the parent + subsidiaries were hidden.
 *
 * FIX: the Companies card is a tenant-wide master and now renders from the FULL `companies` list
 * (listCompanies, includeArchived) regardless of scope. The switcher still scopes operational screens
 * (lib/scope unchanged); this is a per-screen opt-out.
 *
 * This test renders the OrganizationPage server component with scopedAdmin stubbed to a scope of ONLY
 * company A, seeds a SECOND company B in the same tenant, and asserts the listing covers BOTH
 * companies (proving the card ignores scope).
 *
 * UPDATED for item defd4644 (list-and-detail redesign), NOT weakened. The screen no longer renders
 * `OrganizationList` + `CompaniesCardHeader` — the create form moved to /admin/organization/new and
 * each company's panel moved to /admin/organization/[companyId], so the browse surface is a plain
 * server-rendered table. The rows now come from `CompanyRows`, and the assertion is the same one:
 * both companies appear even though the switcher holds one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin holder — mutated per test so we control s + scopeIds. next/cache + next/navigation are
// stubbed inert because the page imports server actions that pull them at module load. `useRouter` is
// part of the stub because the shared <Pager> pulls in the page-size selector, a client component.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => undefined),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/organization',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
// getTranslations → identity: t('companies') returns 'companies', so we can assert on keys without the
// full next-intl runtime config.
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { SectionHeader } from '../components/ui';
import { CompanyRows } from '../app/admin/organization/company-rows';
import OrganizationPage from '../app/admin/organization/page';

// Depth-first walk of a rendered React element tree collecting every node whose `type` identity matches.
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

describe('Organization Companies card — displays ALL companies regardless of switcher scope', () => {
  let base: Base;
  let companyB: string;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    companyB = c.id;
    // Real admin session for the page's un-mocked reads; scope narrowed to ONLY company A.
    scope.s = adminCtx(base);
    scope.scopeIds = [base.companyId];
  });
  afterAll(async () => {
    await closeAll();
  });

  it('renders both companies in the management list + header count even when scope is a single company', async () => {
    const tree = await OrganizationPage({ searchParams: Promise.resolve({}) });

    const lists = findByType(tree, CompanyRows);
    expect(lists).toHaveLength(1);
    const ids = lists[0].props.rows.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([base.companyId, companyB].sort());

    // The Companies card's bracketed count, found by its (identity-mocked) title key so the OTHER
    // SectionHeader on the screen — the statutory-gap card — cannot be mistaken for it.
    const headers = findByType(tree, SectionHeader).filter((h) => h.props.title === 'companies');
    expect(headers).toHaveLength(1);
    expect(headers[0].props.count).toBe(2);

    // Guard against a regression back to scope-filtering: the card must NOT collapse to the single
    // scoped company even though scopeIds holds only company A.
    expect(scope.scopeIds).toEqual([base.companyId]);
    expect(ids).toContain(companyB);
  });
});
