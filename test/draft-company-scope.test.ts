/**
 * b1b1879d — "Draft employees must follow the selected company".
 *
 * THE REPORT. Choosing Stradaverse in the company selector at the top of the screen still listed Demo's, CHIN
 * HIN's and XYZ's Draft employees on Personnel Management. Production on the day: five drafts (CHIN HIN 2,
 * Demo 2, XYZ 1), none for Stradaverse, so all five showed where none should.
 *
 * THE CAUSE, VERIFIED BEFORE BUILDING. The Filter panel's Company field already narrowed drafts
 * (`draftMatchesQuery`, pinned by test/employee-list-columns.test.ts). The TOP-BAR scope did not: the page,
 * the Draft card and the Excel export read `listEmployeeDrafts(session)` with no scope at all while the
 * employees beside them were read under `scopeIds`. And underneath it, the RLS policy (0337) admitted any
 * administrator of ANY company to every draft, so an hr_admin scoped to one company could open, change or
 * discard another company's draft — IC number, bank account and salary included. Latent on production (no
 * company-scoped admin exists there), fixed here by migration 0510.
 *
 * WHAT IS RUN, NOT SCANNED. §2 renders the real Personnel page and §3 calls the real export route, both under
 * a mocked `company_scope` cookie; §4 drives the services and raw SQL as a company-scoped administrator
 * against the migrated policy. Each section names the defect its assertions fail on when the fix is reverted.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { cloneElement, createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { SessionContext } from '../db/client';

let SESSION: SessionContext;
/** The top-bar company selection, as the `company_scope` cookie carries it. `undefined` = never narrowed. */
let SCOPE_COOKIE: string | undefined;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => SESSION,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new RedirectError(p);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/personnel',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'company_scope' && SCOPE_COOKIE !== undefined ? { value: SCOPE_COOKIE } : undefined),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync: read } = await import('node:fs');
  const { fileURLToPath: toPath } = await import('node:url');
  const messages = JSON.parse(read(toPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e: unknown) => {
          throw e;
        },
      }),
  };
});

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  createEmployeeDraftWithReservedCode,
  discardEmployeeDraft,
  getEmployeeDraft,
  listEmployeeDrafts,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { draftListScope } from '../app/admin/personnel/list-query';
import PeoplePage from '../app/admin/personnel/page';
import { GET as exportPersonnel } from '../app/admin/personnel/export/route';

const en = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));

let b: Base;
/** Company A is the seeded one; B is a second company of the same tenant. */
let A: string;
let B: string;
let draftA: string;
let draftB: string;
let draftNone: string;

/** A group-wide administrator: the only kind production has today. */
const groupAdmin = (): SessionContext => ({ ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] });
/** An hr_admin whose grant covers company A only — the case the 0510 policy is for. */
const adminOfA = (personId?: string, userId = b.adminUserId): SessionContext => ({
  tenantId: b.tenantId,
  userId,
  ...(personId ? { personId } : {}),
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: A }],
  entitlements: adminCtx(b).entitlements,
});

async function insertDraft(companyId: string | null, label: string, extra: Partial<typeof schema.employeeDraft.$inferInsert> = {}) {
  const [row] = await owner.db
    .insert(schema.employeeDraft)
    .values({ tenantId: b.tenantId, companyId, label, data: {}, currentStep: 1, ...extra })
    .returning({ id: schema.employeeDraft.id });
  return row.id;
}

const draftRow = async (id: string) =>
  (await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id)))[0];

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  A = b.companyId;
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Bravo Holdings Sdn Bhd' })
    .returning({ id: schema.company.id });
  B = c2.id;
  draftA = await insertDraft(A, 'Alpha Candidate', { reservedEmployeeCode: 'ALPHA001' });
  draftB = await insertDraft(B, 'Bravo Candidate', { reservedEmployeeCode: 'BRAVO001' });
  draftNone = await insertDraft(null, 'Unplaced Candidate');
  SESSION = groupAdmin();
  SCOPE_COOKIE = undefined;
});

const labels = (rows: { label: string }[]) => rows.map((r) => r.label).sort();

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 listEmployeeDrafts follows the selected companies', () => {
  it('scope [A] hides company B drafts and the draft with no company', async () => {
    const rows = await listEmployeeDrafts(groupAdmin(), draftListScope([A], 2));
    expect(labels(rows)).toEqual(['Alpha Candidate']);
  });

  it('the every-company view shows all three, the unplaced draft included', async () => {
    const rows = await listEmployeeDrafts(groupAdmin(), draftListScope([A, B], 2));
    expect(labels(rows)).toEqual(['Alpha Candidate', 'Bravo Candidate', 'Unplaced Candidate']);
  });

  it('an empty selection selects nothing', async () => {
    expect(await listEmployeeDrafts(groupAdmin(), { companyIds: [], includeWithoutCompany: true })).toEqual([]);
  });

  it('decides "narrowed" from distinct companies, against what the reader may reach', () => {
    expect(draftListScope([A], 2).includeWithoutCompany).toBe(false);
    expect(draftListScope([A, B], 2).includeWithoutCompany).toBe(true);
    expect(draftListScope([A, A], 2).includeWithoutCompany, 'A twice is still one company').toBe(false);
    expect(draftListScope([], 0).includeWithoutCompany, 'no company at all is not "every company"').toBe(false);
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
const isAsync = (f: unknown) =>
  typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !isValidElement(v) && Object.getPrototypeOf(v) === Object.prototype;
}
/** Await every async server component in the tree (the r301 helper), props included. */
async function settle(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const next: Record<string, unknown> = {};
    let touched = false;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === 'children' || isValidElement(v) || Array.isArray(v) || isPlainRecord(v)) {
        next[k] = await settle(v);
        touched = true;
      }
    }
    return touched ? cloneElement(el, next) : el;
  }
  if (isPlainRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await settle(v);
    return out;
  }
  return node;
}
/** Every element in a settled tree whose props carry `prop`. */
function findByProp(node: unknown, prop: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => findByProp(n, prop, out));
  else if (isValidElement(node)) {
    const props = (node as ReactElement<Record<string, unknown>>).props ?? {};
    if (prop in props) out.push(props);
    for (const v of Object.values(props)) if (isValidElement(v) || Array.isArray(v)) findByProp(v, prop, out);
  }
  return out;
}

async function renderPersonnel(sp: Record<string, string> = {}) {
  const tree = await settle(await PeoplePage({ searchParams: Promise.resolve(sp) }));
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: en } as never, tree as never),
  ).replace(/<script[\s\S]*?<\/script>/g, '');
  // The Draft card: <a … data-headcount="draft"…><div>Draft</div><div …tabular-nums">N</div>
  const card = html.match(/data-headcount="draft"[^>]*>[\s\S]*?tabular-nums">(\d+)</);
  expect(card, 'the Draft card rendered').not.toBeNull();
  const draftRows = [...html.matchAll(/data-draft-id="([0-9a-f-]{36})"/g)].map((m) => m[1]);
  const companyField = (findByProp(tree, 'fields')[0]?.fields as { name: string; options?: { value: string }[] }[] | undefined)?.find(
    (f) => f.name === 'company',
  );
  return { html, draftCard: Number(card![1]), draftRows, companyOptions: (companyField?.options ?? []).map((o) => o.value) };
}

describe('§2 the Personnel screen: list, Draft card and Filter options follow the top-bar company', () => {
  it('with company A selected, only A\'s draft is listed and the Draft card counts exactly it', async () => {
    SCOPE_COOKIE = A;
    const r = await renderPersonnel({ bucket: 'draft' });
    expect(r.draftRows).toEqual([draftA]);
    expect(r.html).not.toContain('Bravo Candidate');
    expect(r.html).not.toContain('Unplaced Candidate');
    expect(r.draftCard, 'the Draft card equals the rows shown').toBe(r.draftRows.length);
  });

  it('the Draft card under another bucket still previews the scoped drafts only', async () => {
    SCOPE_COOKIE = A;
    const r = await renderPersonnel({});
    expect(r.draftCard).toBe(1);
    expect(r.draftRows).toEqual([draftA]);
  });

  it('the Filter panel offers only the companies being viewed', async () => {
    SCOPE_COOKIE = A;
    const r = await renderPersonnel({ bucket: 'draft' });
    expect(r.companyOptions).toEqual([A]);
  });

  it('un-narrowed, every draft is listed, the unplaced one included, and both companies are offered', async () => {
    const r = await renderPersonnel({ bucket: 'draft' });
    expect([...r.draftRows].sort()).toEqual([draftA, draftB, draftNone].sort());
    expect(r.draftCard).toBe(3);
    expect([...r.companyOptions].sort()).toEqual([A, B].sort());
  });

  it('the Filter panel company still narrows inside the scope (draftMatchesQuery kept)', async () => {
    const r = await renderPersonnel({ bucket: 'draft', company: B });
    expect(r.draftRows).toEqual([draftB]);
    expect(r.draftCard).toBe(1);
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 the Excel export carries the same drafts as the screen', () => {
  const exportCsv = async (q: string) => {
    const res = await exportPersonnel(new Request(`http://x/admin/personnel/export?${q}&format=csv`));
    expect(res.status).toBe(200);
    return new TextDecoder().decode(await res.arrayBuffer());
  };

  it('under bucket=draft with company A selected, the file has no row from company B', async () => {
    SCOPE_COOKIE = A;
    const csv = await exportCsv('bucket=draft&cols=code,name,company,status');
    expect(csv).toContain('ALPHA001');
    expect(csv).not.toContain('BRAVO001');
    expect(csv).not.toContain('Bravo Candidate');
    expect(csv).not.toContain('Unplaced Candidate');
  });

  it('un-narrowed, the file carries every draft', async () => {
    const csv = await exportCsv('bucket=draft&cols=code,name,company,status');
    for (const s of ['ALPHA001', 'BRAVO001', 'Unplaced Candidate']) expect(csv).toContain(s);
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§4 the database fences drafts by company (migration 0510)', () => {
  it('an hr_admin scoped to A cannot SELECT company B\'s draft, and can select A\'s', async () => {
    expect(await getEmployeeDraft(adminOfA(), draftB)).toBeNull();
    expect((await getEmployeeDraft(adminOfA(), draftA))?.id).toBe(draftA);
    const every = await listEmployeeDrafts(adminOfA(), { companyIds: [A, B], includeWithoutCompany: true });
    expect(labels(every), 'neither B\'s draft nor the unplaced one, which is not theirs').toEqual(['Alpha Candidate']);
  });

  it('an hr_admin scoped to A cannot UPDATE company B\'s draft, and can update A\'s', async () => {
    await expect(
      saveEmployeeDraft(adminOfA(), { id: draftB, data: { profile: { fullName: 'Tampered' } }, currentStep: 2 }),
    ).rejects.toThrow(/not found \(or not visible\)/);
    expect((await draftRow(draftB)).label).toBe('Bravo Candidate');
    // Raw SQL too: the policy, not the service, is what refuses.
    const raw = await withTenant(adminOfA(), (tx) =>
      tx.execute(sql`update employee_draft set label = 'Tampered' where id = ${draftB}::uuid returning id`),
    );
    expect(raw).toHaveLength(0);
    expect((await draftRow(draftB)).label).toBe('Bravo Candidate');

    await saveEmployeeDraft(adminOfA(), {
      id: draftA,
      data: { profile: { fullName: 'Alpha Renamed' }, employment: { companyId: A } },
      currentStep: 2,
    });
    expect((await draftRow(draftA)).label).toBe('Alpha Renamed');
  });

  it('an hr_admin scoped to A cannot DELETE company B\'s draft, and can discard A\'s', async () => {
    await expect(discardEmployeeDraft(adminOfA(), draftB)).rejects.toThrow(/not found \(or not visible\)/);
    const raw = await withTenant(adminOfA(), (tx) =>
      tx.execute(sql`delete from employee_draft where id = ${draftB}::uuid returning id`),
    );
    expect(raw).toHaveLength(0);
    expect(await draftRow(draftB)).toBeDefined();

    await discardEmployeeDraft(adminOfA(), draftA);
    expect(await draftRow(draftA)).toBeUndefined();
  });

  it('an hr_admin scoped to A cannot write a draft INTO company B, as its author or otherwise', async () => {
    // Moving a draft from A to B. Unreserved, because a reserved draft's company is pinned by the service
    // (06f0cb8f) and would never reach the policy.
    const movable = await insertDraft(A, 'Movable Candidate');
    await expect(
      saveEmployeeDraft(adminOfA(), {
        id: movable,
        data: { profile: { fullName: 'Moved' }, employment: { companyId: B } },
        currentStep: 2,
      }),
    ).rejects.toThrow();
    expect((await draftRow(movable)).companyId).toBe(A);
    // Creating one in B outright.
    await expect(
      createEmployeeDraftWithReservedCode(adminOfA(), {
        companyId: B,
        fullName: 'Cross Company',
        primaryEmail: `x_${randomUUID().slice(0, 6)}@t.local`,
        employeeIdMode: 'manual',
        employeeCode: 'CROSS001',
      }),
    ).rejects.toThrow();
    const crossed = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.companyId, B));
    expect(crossed.map((d) => d.id)).toEqual([draftB]);
  });

  it('the author keeps sight of their own draft wherever it sits', async () => {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Author Person', primaryEmail: `a_${randomUUID().slice(0, 6)}@t.local` })
      .returning({ id: schema.person.id });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id })
      .returning({ id: schema.appUser.id });
    const own = await insertDraft(B, 'Authored In B', { createdByPersonId: p.id });
    const ownNone = await insertDraft(null, 'Authored Unplaced', { createdByPersonId: p.id });
    const author = adminOfA(p.id, u.id);
    expect((await getEmployeeDraft(author, own))?.id).toBe(own);
    expect((await getEmployeeDraft(author, ownNone))?.id).toBe(ownNone);
    // …and still not anybody else's B draft.
    expect(await getEmployeeDraft(author, draftB)).toBeNull();
  });

  it('a tenant-wide administrator sees and works on every company\'s drafts', async () => {
    for (const id of [draftA, draftB, draftNone]) expect((await getEmployeeDraft(groupAdmin(), id))?.id).toBe(id);
    await discardEmployeeDraft(groupAdmin(), draftB);
    expect(await draftRow(draftB)).toBeUndefined();
  });
});
