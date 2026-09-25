/**
 * 2a57a007 (r340) — THE EXPORT'S CELLS, IN THE FILE HR ACTUALLY FORWARDS.
 *
 * ⚠️ WHY THIS FILE EXISTS. The first cut of this item pinned the export's behaviour with a SOURCE GREP
 * (`expect(src).toContain('pooledEntitlementCaption(r)')`), and a grep cannot tell a cell that prints the
 * pooled sentence from a cell that merely mentions the function. It also could not reach the shape that makes
 * the column dangerous at all: a borrower inherits the POOL's entitlement status, so while the pool has a real
 * table the borrower resolves `granted` and the status cell reads "Generated". The r209 instruction — "No
 * entitlement table", which in this catalogue is the SAME sentence as `statusNotConfigured` — only lands on a
 * borrower's row when THE POOL ITSELF has no table. Both shapes are exercised below through the real route
 * handler, and the CSV it returns is parsed.
 *
 * WHAT IS MOCKED AND WHY THAT IS HONEST. Two things the route cannot have in vitest: the request-scoped
 * session (`scopedSession`) and next-intl's request-scoped catalogues (`getTranslations` / `getLocale`). The
 * catalogue mock reads the SHIPPING messages/*.json off disk and THROWS on a missing key, so a cell rendered
 * from a key that does not exist fails here rather than shipping as MISSING_MESSAGE. Everything else — the two
 * reads, `employeeBalanceRows`, the pooled decision, `toCsvReport` — is the production path, on a real database.
 * The same pattern as test/2a1a6f42-ea-preview.test.ts, for the same reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { parseCsv } from '../lib/csv';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');

/** The mocked answer from `scopedSession`, set per test in `beforeEach`. */
let scope: { s: SessionContext; scopeIds: string[]; allowedCount: number };
vi.mock('@/lib/scope', () => ({ scopedSession: vi.fn(async () => scope) }));

// The SHIPPING catalogues, resolved without a request, and STRICT: a missing key throws here.
vi.mock('next-intl/server', () => {
  const cache = new Map<string, unknown>();
  const cat = (locale: string) => {
    const hit = cache.get(locale);
    if (hit) return hit;
    const parsed = JSON.parse(readFileSync(join(ROOT, `messages/${locale}.json`), 'utf8'));
    cache.set(locale, parsed);
    return parsed;
  };
  const dig = (o: unknown, dotted: string) =>
    dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
  return {
    getLocale: async () => 'en',
    // The route calls it BOTH ways — `getTranslations('leave')` and `getTranslations({ namespace })` are
    // both real next-intl signatures, so the mock has to accept a bare string as well as the object form.
    getTranslations: async (arg: string | { namespace?: string; locale?: string }) => {
      const namespace = typeof arg === 'string' ? arg : (arg?.namespace ?? '');
      const base = dig(cat('en'), namespace);
      return (key: string, vars?: Record<string, string | number>) => {
        const v = dig(base, key);
        if (typeof v !== 'string') throw new Error(`messages/en.json is missing ${namespace}.${key}`);
        return vars ? v.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : v;
      };
    },
  };
});

import { GET } from '../app/leave/employee-balances/export/route';

const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8')) as {
  leave: { colType: string; inquiry: Record<string, string> };
  me: { leaveBalanceTable: Record<string, string> };
};
const BAL = en.me.leaveBalanceTable;
const COL_TYPE = en.leave.colType;
const COL_FULL = BAL.colFullEntitlement;
const COL_EARNED = BAL.colYtdEntitled;
const COL_STATUS = en.leave.inquiry.colEntitlementStatus;

const AS_OF = '2026-12-31';
let b: Base;

const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; code?: string; balanceSourceTypeId?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code ?? `P${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Pool Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function table(leaveTypeId: string, days: number, name: string) {
  const tpl = await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId,
    name,
    serviceBands: [{ fromYears: 0, toYears: null, days }],
    validFrom: '2026-01-01',
  });
  await createEligibilityRule(adminCtx(b), {
    name: `${name} — eligibility`,
    templateLineageId: tpl.lineageId,
    criteria: {} as never,
    validFrom: '2026-01-01',
  });
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Pooled Export', primaryEmail: `pex_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

/** The route, invoked, and its CSV turned into one record per row keyed by the header the reader sees. */
async function exportRows(employmentId: string) {
  const res = await GET(
    new Request(`http://t.local/leave/employee-balances/export?emp=${employmentId}&asOf=${AS_OF}&format=csv`),
  );
  expect(res.status, 'the export must have been produced').toBe(200);
  const grid = parseCsv(await res.text()).filter((r) => r.some((c) => c !== ''));
  const headers = grid[0]!;
  // The heading a reader reads, not an index — a column added or moved must not silently re-point a cell.
  for (const h of [COL_TYPE, COL_FULL, COL_EARNED, COL_STATUS]) {
    expect(headers, `the export must carry a "${h}" column`).toContain(h);
  }
  const byType = new Map<string, Record<string, string>>();
  for (const row of grid.slice(1)) {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = row[i] ?? ''));
    byType.set(rec[COL_TYPE]!, rec);
  }
  return byType;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  scope = { s: adminCtx(b), scopeIds: [b.companyId], allowedCount: 1 };
});

describe('2a57a007 (r340) · the downloaded file’s own cells', () => {
  it('a borrower’s Entitlement and Earned to Date cells are 0.00 and its status names the pool, while the pool keeps everything', async () => {
    const poolName = uniq('Pool Annual');
    const elName = uniq('Pool Emergency');
    const pool = await leaveTypeRow({ name: poolName });
    await leaveTypeRow({ name: elName, balanceSourceTypeId: pool });
    await table(pool, 7, 'Executive Annual Leave');
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await exportRows(employmentId);
    const borrower = rows.get(elName)!;
    const poolRow = rows.get(poolName)!;
    expect(borrower, 'the borrower must be in the file at all').toBeTruthy();

    // THE REPORTER'S TWO CELLS, in the file rather than in the row builder's return value.
    expect(borrower[COL_FULL], 'Emergency Leave printed the pool’s 7.00 here').toBe('0.00');
    expect(borrower[COL_EARNED], 'and the pool’s Earned to Date here').toBe('0.00');
    // …and the pool's are untouched, or this test proves nothing.
    expect(poolRow[COL_FULL], 'the pool must really hold days').toBe('7.00');
    expect(poolRow[COL_EARNED]).toBe('7.00');

    // The status column, which is where the pooled sentence replaces the raw status map.
    expect(borrower[COL_STATUS]).toBe(BAL.statusPooledEntitlement.replace('{pool}', poolName));
    expect(borrower[COL_STATUS]).toContain(poolName);
    expect(poolRow[COL_STATUS], 'every other row still reads the shared status map').toBe(BAL.statusGenerated);
  });

  /**
   * THE DANGEROUS SHAPE. With no table on the pool the borrower's raw status is `no_entitlement_table`, whose
   * sentence is the r209 instruction — and `statusNotConfigured` is byte-identical to it in all six locales, so
   * neither of the two states a borrower can inherit was safe to print here. The POOL's own row keeps it: its
   * missing table is a real misconfiguration, and suppressing that would be the r209 incident in reverse.
   */
  it('a borrower whose POOL has no table never prints “No entitlement table” in a file HR forwards', async () => {
    const poolName = uniq('Unconfigured Pool');
    const elName = uniq('Pool Emergency');
    const pool = await leaveTypeRow({ name: poolName });
    await leaveTypeRow({ name: elName, balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await exportRows(employmentId);
    const borrower = rows.get(elName)!;
    const poolRow = rows.get(poolName)!;

    expect(BAL.statusNotConfigured, 'the collision that makes this column dangerous').toBe(BAL.statusNoEntitlementTable);
    expect(borrower[COL_STATUS], 'the borrower says where its days come from').toBe(
      BAL.statusPooledEntitlement.replace('{pool}', poolName),
    );
    expect(borrower[COL_STATUS], 'and never the one instruction that would stop it borrowing').not.toBe(
      BAL.statusNoEntitlementTable,
    );
    expect(poolRow[COL_STATUS], 'the POOL’s missing table is a real defect and is still reported').toBe(
      BAL.statusNoEntitlementTable,
    );
    expect(borrower[COL_FULL]).toBe('0.00');
    expect(borrower[COL_EARNED]).toBe('0.00');
  });

  it('an unpooled type with no table still prints “No entitlement table” — the suppression did not widen', async () => {
    const orphanName = uniq('Unpooled Study');
    await leaveTypeRow({ name: orphanName });
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await exportRows(employmentId);
    expect(rows.get(orphanName)![COL_STATUS]).toBe(BAL.statusNoEntitlementTable);
  });
});
