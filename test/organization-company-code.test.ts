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
import { eq, sql } from 'drizzle-orm';
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
// 7d2df42a — the two components whose PROPS carry the duplicate-code warning's data. Asserted as
// elements, not as markup: the warning is invisible until somebody types, so the only thing a server
// render can prove is that each screen was handed the right list (§8, "pin it across both files").
import { CompanyCodeField } from '../components/company-code-field';
import { CompanyPanel } from '../components/company-panel';
import type { CompanyCodeHolder } from '../lib/company-code';

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
    /**
     * …and it is NOT required. The column is nullable and the edit form can clear it; see the header.
     *
     * ⚠️ REWRITTEN BY ITEM 7d2df42a BECAUSE IT HAD GONE VACUOUS, WHICH IS WORSE THAN ABSENT. It read
     * `expect(html).toMatch(/name="companyLabel"(?![^>]*\brequired\b)/)` — a lookahead that only sees
     * attributes printed AFTER `name`. React's server renderer does not print them in JSX order: with
     * `required` on the input it emits `<input required="" class="…" placeholder="…" name="companyLabel"
     * value=""/>`, so `name="companyLabel"` is followed by `value=""/>` and the old line matched happily
     * while the field WAS required. Verified by adding `required` and watching this case stay green.
     *
     * The tag is extracted and checked whole instead, which no attribute order can defeat.
     */
    const codeInputTag = /<input\b[^>]*name="companyLabel"[^>]*>/.exec(html)?.[0] ?? '';
    expect(codeInputTag, 'the Company Code input is in the markup').not.toBe('');
    expect(codeInputTag, 'the code stays OPTIONAL — 7 of the 13 production companies have none').not.toMatch(
      /\brequired\b/,
    );
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

/**
 * ── ITEM 7d2df42a — "Company Code: should it be required, and must it be unique?" ─────────────────
 *
 * The reporter asked for a COMPULSORY field and an ENFORCED unique rule. We recommended against both
 * and they approved that recommendation. What ships is a WARNING that names the other company; the two
 * refusals stay unbuilt. The three `describe`s above already pin "not required" and "not unique" from
 * the CREATE ACTION's side and are unchanged by this item — the block below pins the same two
 * decisions from the two places a later round would actually break them:
 *
 *   · the DATABASE, so a migration that adds a unique index or a CHECK on `company_label` has to come
 *     past a test that names the decision, rather than a customer finding it on a save;
 *   · the two SCREENS' data, so the warning keeps being fed from a read that is scoped to what this
 *     admin can already see by name, and that leaves archived companies out.
 *
 * ⚠️ THE WARNING ITSELF IS NOT ASSERTED HERE, AND DELIBERATELY SO. It only exists once somebody has
 * TYPED into the field, so it is unreachable from a server render and from a GET of either screen.
 * test/7d2df42a-company-code-duplicate.dom.test.tsx drives it, in all six catalogues.
 */
/** Walk a rendered-but-not-yet-committed element tree for the first element of a given component. */
type AnyEl = { type?: unknown; props?: Record<string, unknown> };
function findElement(node: unknown, type: unknown): AnyEl | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElement(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const el = node as AnyEl;
  if (el.type === type) return el;
  return findElement(el.props?.children, type);
}

const codesOnCreateForm = async (): Promise<CompanyCodeHolder[]> => {
  const tree = await NewCompanyPage({ searchParams: Promise.resolve({}) });
  const field = findElement(tree, CompanyCodeField);
  expect(field, 'the create form renders components/company-code-field.tsx').not.toBeNull();
  return field!.props!.codesInUse as CompanyCodeHolder[];
};

describe('7d2df42a — a duplicate Company Code is a WARNING, and the database still says so', () => {
  it('there is NO unique index and NO CHECK on company_label — the decision, asserted against the live schema', async () => {
    const res = await owner.db.execute(sql`
      select 'unique index ' || i.indexrelid::regclass::text || ' — ' || pg_get_indexdef(i.indexrelid) as rule
        from pg_index i
       where i.indrelid = 'company'::regclass
         and i.indisunique
         and pg_get_indexdef(i.indexrelid) ilike '%company_label%'
      union all
      select 'constraint ' || conname || ' — ' || pg_get_constraintdef(oid)
        from pg_constraint
       where conrelid = 'company'::regclass
         and contype in ('c', 'u', 'x')
         and pg_get_constraintdef(oid) ilike '%company_label%'`);
    const rows = (res as unknown as { rows?: { rule: string }[] }).rows ?? (res as unknown as { rule: string }[]);
    expect(
      rows.map((r) => r.rule),
      'A rule on company_label appeared. That is the change item 7d2df42a explicitly declined: of the 13 ' +
        'production companies 7 hold no code and two of the six that do hold something that is not one ' +
        '("PRIVATE CO." and a full legal name), so a unique rule rejects real rows the next time anybody ' +
        'edits them, and a NOT NULL blocks seven companies from being saved at all. If this is now wanted, ' +
        'it is a DATA decision for the reporter to take — ask, then change this test with the answer.',
    ).toEqual([]);
  });

  it('the column is still NULLABLE — "not required" is a database fact, not only a missing attribute', async () => {
    const res = await owner.db.execute(sql`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'company' and column_name = 'company_label'`);
    const rows = (res as unknown as { rows?: { is_nullable: string }[] }).rows ??
      (res as unknown as { is_nullable: string }[]);
    expect(rows, 'company.company_label exists').toHaveLength(1);
    expect(rows[0].is_nullable, 'a NOT NULL here would block the 7 production companies that have no code').toBe('YES');
  });

  it('SAVING a duplicate still SUCCEEDS and stores it — a duplicate never travels the failure redirect', async () => {
    await create({ legalName: 'Chin Hin Construction Engineering Sdn Bhd', companyLabel: 'ASG' });
    // Typed differently on purpose: the warning treats these as the same code, and the SAVE still must
    // not care. `failCompany` / `fail` land on `?error=`; landing on the bare listing is the proof that
    // this went through `ok()`, i.e. that nothing turned the warning into a refusal.
    const to = await create({ legalName: 'Second Mover Sdn Bhd', companyLabel: ' asg ' });
    expect(to, 'a duplicate is NOT a failure and must not redirect through ?error=').toBe('/admin/organization');
    expect(to).not.toContain('error=');
    expect(await codeOf('Second Mover Sdn Bhd'), 'and it stores what was typed, trimmed — not rewritten to ASG').toBe('asg');
    expect(await codeOf('Chin Hin Construction Engineering Sdn Bhd'), 'the first row is untouched').toBe('ASG');

    // And the EXACT duplicate too, because a case-SENSITIVE unique rule would let the line above pass:
    // ' asg ' normalises to 'asg', which `=` does not match against 'ASG'. Both shapes have to be here or
    // half the rule could be added without either of them noticing.
    const exact = await create({ legalName: 'Third Mover Sdn Bhd', companyLabel: 'ASG' });
    expect(exact, 'an exact duplicate is not a failure either').toBe('/admin/organization');
    expect(await codeOf('Third Mover Sdn Bhd')).toBe('ASG');
  });
});

describe('7d2df42a — the codes the warning may name: administrable, and never archived', () => {
  it('the CREATE form is fed the codes in use, and the warning can name the company that holds one', async () => {
    await create({ legalName: 'Chin Hin Construction Engineering Sdn Bhd', companyLabel: 'ASG' });
    const codes = await codesOnCreateForm();
    expect(
      codes.find((h) => h.code === 'ASG')?.name,
      'the create form can name the holder — "already in use" without a name is not this feature',
    ).toBe('Chin Hin Construction Engineering Sdn Bhd');
  });

  it('a company with NO code is not in that list — there is nothing to collide with', async () => {
    await create({ legalName: 'Nameless Sdn Bhd' });
    const codes = await codesOnCreateForm();
    expect(codes.some((h) => h.name === 'Nameless Sdn Bhd'), 'blank is not a code').toBe(false);
  });

  it('an ARCHIVED company is not in it either — a code recycled from a retired company is not a collision', async () => {
    await create({ legalName: 'Retired Holdings Bhd', companyLabel: 'OLD' });
    await create({ legalName: 'Still Trading Sdn Bhd', companyLabel: 'LIVE' });
    await owner.db
      .update(schema.company)
      .set({ archivedAt: new Date() })
      .where(eq(schema.company.legalName, 'Retired Holdings Bhd'));

    const codes = await codesOnCreateForm();
    expect(codes.some((h) => h.code === 'LIVE'), 'a live company still warns').toBe(true);
    expect(
      codes.map((h) => h.name),
      'and the archived one is not merely un-warned — its NAME never reaches the browser for this feature',
    ).not.toContain('Retired Holdings Bhd');
  });

  it('the COMPANY DETAIL form is fed the same list, from the same administrable read', async () => {
    await create({ legalName: 'Chin Hin Construction Engineering Sdn Bhd', companyLabel: 'ASG' });
    const companies = await listCompanies(ADMIN, { includeArchived: true, adminOnly: true });
    const self = companies.find((c) => c.name === 'Chin Hin Construction Engineering Sdn Bhd')!;

    const tree = await CompanyMaintenancePage({
      params: Promise.resolve({ companyId: self.id }),
      searchParams: Promise.resolve({}),
    });
    const panel = findElement(tree, CompanyPanel);
    expect(panel, 'the detail screen renders CompanyPanel').not.toBeNull();
    const codes = panel!.props!.codesInUse as CompanyCodeHolder[];
    expect(
      codes.find((h) => h.id === self.id)?.code,
      'the company being edited IS in the list — it is `excludeId` on the field, not a hole in the data, ' +
        'that stops the tab warning about its own stored code (pinned in the .dom test)',
    ).toBe('ASG');
  });

  it('it never names a company this admin cannot administer — the warning does not widen what they can see', async () => {
    // A second company, then the session narrowed to the FIRST one only. `app.is_admin_for` is the
    // database's own predicate and the same one the Organization listing filters by; the warning must not
    // reach past it, because naming a company is exactly the disclosure feedback ab77dc1f was raised over.
    await create({ legalName: 'Out Of Scope Sdn Bhd', companyLabel: 'OOS' });
    const before = await codesOnCreateForm();
    expect(before.some((h) => h.code === 'OOS'), 'precondition: a group-wide admin does see it').toBe(true);

    ADMIN = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    const codes = await codesOnCreateForm();
    expect(
      codes.map((h) => h.name),
      'a company-scoped admin is not told the name of a company outside their scope',
    ).not.toContain('Out Of Scope Sdn Bhd');
  });
});
