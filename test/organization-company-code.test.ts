/**
 * Item 3783fd87 — THE COMPANY CODE, ON THE FORM THAT CREATES THE COMPANY.
 *
 * ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────────────────────────────────────────
 * Nothing was missing from the DATABASE. `company.company_label` has existed since bc5d4891
 * (db/schema.ts, commented "short name / abbreviation / internal code"); the listing has headed it
 * "Code" since defd4644 (app/admin/organization/company-rows.tsx maps `code: c.companyLabel`); the
 * company's own General tab reads and writes it. The ONE screen it was absent from was
 * /admin/organization/new — so a company was created, and only then could somebody go and find it again
 * on another screen to give it a code.
 *
 * That is not a theoretical cost. Measured on PRODUCTION 2026-09-24, of 13 companies: 7 hold no code at
 * all, and of the 6 that hold something, one holds the entire legal name ("ISEDECOR BINA SDN BHD") and
 * one reads "PRIVATE CO.". A field reachable only after the fact gets filled in badly or not at all.
 *
 * ── WHY THIS FILE RUNS THE ACTION INSTEAD OF SCANNING FOR THE INPUT ───────────────────────────────
 * A `name="companyLabel"` in the markup proves the operator can TYPE a code. It proves nothing about
 * whether the code is STORED: an input the create action does not read is exactly the fault the
 * existing exact-set guard in test/organization-list-detail.test.ts was written to catch, and it would
 * pass a markup-only check while silently discarding every code anybody ever typed. So each case here
 * posts through `createCompanyAction` and then reads `company.company_label` back out of the database.
 *
 * ── THE THREE DECISIONS THIS FILE PINS (all three were decisions, not omissions) ──────────────────
 *   1. NOT REQUIRED. The column is nullable and the General tab lets you clear it; a create form that
 *      refused a blank would contradict the edit form and block every company whose code is not settled
 *      yet. `creates a company with NO code at all` is that decision, asserted.
 *   2. NOT UNIQUE. Uniqueness is a DATA decision about what a code IS — one the reporter has not made,
 *      and one two live production rows would immediately make contentious. `does not enforce
 *      uniqueness` is deliberately a GREEN test today: if a later round adds a constraint without
 *      asking, this is the line that says so instead of a customer discovering it on a save.
 *   3. ONE SOURCE. The create form, the listing and the detail screen all resolve to the same column
 *      through the same normaliser. `one column, three screens` is that, asserted end to end.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContext } from '../db/client';

let ADMIN: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => ADMIN,
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => ({ s: ADMIN, scopeIds: [] })) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
// The redirect CARRIES the outcome: ok() lands on /admin/organization, fail() on the same path with
// ?error=. Throwing rather than returning undefined is what stops a refused create from reading as a
// silent success — the test below asserts WHICH path it landed on, not merely that it finished.
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '', number: () => '' }),
}));

import { adminCtx, closeAll, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { createCompanyAction } from '../app/admin/actions';
import { listCompanies } from '../core/read';
import { selectCompanyRows } from '../app/admin/organization/company-rows';
import NewCompanyPage from '../app/admin/organization/new/page';
import CompanyMaintenancePage from '../app/admin/organization/[companyId]/page';

let b: Base;

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // A GROUP-WIDE hr_admin: `seedBase` already writes the `role_assignment` row (companyId null), and the
  // matching grant has to be on the SESSION too, because `listCompanies(..., { adminOnly: true })` — the
  // listing's own read — resolves scope through the database's `app.is_admin_for`, which reads the
  // app.grants GUC. Without it the listing assertion below would pass on an empty array.
  ADMIN = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
});
afterAll(async () => {
  await closeAll();
});

/** Post the create form. Returns the redirect target, which is how the action reports its outcome. */
async function create(fields: Record<string, string>): Promise<string> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await createCompanyAction(fd);
  } catch (e) {
    const m = /^NEXT_REDIRECT:([\s\S]*)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error('createCompanyAction returned without redirecting');
}

const codeOf = async (legalName: string): Promise<string | null> => {
  const rows = await owner.db
    .select({ id: schema.company.id, label: schema.company.companyLabel })
    .from(schema.company)
    .where(eq(schema.company.legalName, legalName));
  expect(rows, `exactly one company named ${legalName}`).toHaveLength(1);
  return rows[0].label;
};

describe('3783fd87 — the create form carries the Company Code, and the code is actually stored', () => {
  it('renders an input for it, bound to the SAME field name the General tab posts', async () => {
    const html = renderToStaticMarkup((await NewCompanyPage({ searchParams: Promise.resolve({}) })) as never);
    expect(html, 'the create form offers the code').toContain('name="companyLabel"');
    // …and it is NOT required. The column is nullable and the edit form can clear it; see the header.
    expect(html).toMatch(/name="companyLabel"(?![^>]*\brequired\b)/);
  });

  it('stores what was typed — the markup is not the assertion, the row is', async () => {
    const to = await create({
      legalName: 'Coded Sdn Bhd',
      companyLabel: 'ABC001',
      country: 'MY',
      currency: 'MYR',
      defaultPayrollCycle: 'Monthly',
    });
    expect(to, 'a successful create lands on the listing, not on ?error=').toBe('/admin/organization');
    expect(await codeOf('Coded Sdn Bhd')).toBe('ABC001');
  });

  it('trims it the way the General tab does, so one column cannot hold two shapes of the same code', async () => {
    await create({ legalName: 'Padded Sdn Bhd', companyLabel: '  ABC002  ' });
    expect(await codeOf('Padded Sdn Bhd')).toBe('ABC002');
  });

  it('creates a company with NO code at all — blank stays NULL, never an empty string', async () => {
    // Absent field and whitespace-only field are the same outcome: NULL. An empty string would be a
    // second way to spell "no code", and every reader would then have to handle both.
    const to = await create({ legalName: 'Nameless Sdn Bhd' });
    expect(to, 'creating without a code is not a failure').toBe('/admin/organization');
    expect(await codeOf('Nameless Sdn Bhd')).toBeNull();

    await create({ legalName: 'Blankish Sdn Bhd', companyLabel: '   ' });
    expect(await codeOf('Blankish Sdn Bhd')).toBeNull();
  });

  it('does not enforce uniqueness — that is a DATA decision the reporter has not been asked for', async () => {
    // GREEN ON PURPOSE. The reporter's request text asks for duplicate validation; the approved plan
    // does not carry it, and two production rows already hold values that are not codes. Shipping a
    // constraint quietly would be a rule change behind a UI round. If a later round adds one, this line
    // fails and names the decision instead of letting a customer find it on a save.
    await create({ legalName: 'Twin One Sdn Bhd', companyLabel: 'DUP' });
    const to = await create({ legalName: 'Twin Two Sdn Bhd', companyLabel: 'DUP' });
    expect(to).toBe('/admin/organization');
    expect(await codeOf('Twin One Sdn Bhd')).toBe('DUP');
    expect(await codeOf('Twin Two Sdn Bhd')).toBe('DUP');
  });
});

describe('3783fd87 — one column, three screens: create, listing, detail', () => {
  it('the listing and the detail screen read the SAME value the create form wrote', async () => {
    await create({ legalName: 'Threeway Sdn Bhd', companyLabel: 'TW-01' });

    // (1) the LISTING. `selectCompanyRows` is what the Code column renders, fed by listCompanies —
    // no second read, no second column.
    const companies = await listCompanies(ADMIN, { includeArchived: true, adminOnly: true });
    const created = companies.find((c) => c.name === 'Threeway Sdn Bhd')!;
    expect(created, 'the new company is in the administrable set').toBeTruthy();
    const row = selectCompanyRows(companies, new Map()).find((r) => r.id === created.id)!;
    expect(row.code, 'the listing Code column').toBe('TW-01');

    // (2) the DETAIL screen, through the real page: the panel prop and the rendered input both carry it.
    const tree = await CompanyMaintenancePage({
      params: Promise.resolve({ companyId: created.id }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(tree as never);
    expect(html).toContain('name="companyLabel"');
    expect(html, 'the detail screen shows the code the create form stored').toContain('value="TW-01"');

    // (3) and it is ONE column. Read straight from the table and compare — if a second source ever
    // appeared, the listing or the detail screen would drift from this and these would stop agreeing.
    expect(await codeOf('Threeway Sdn Bhd')).toBe(row.code);
  });
});
