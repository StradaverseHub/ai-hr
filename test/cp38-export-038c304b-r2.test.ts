/**
 * Board 038c304b revision 2 (the same plan as card 5084d02e revision 2) — Payroll > Transaction Entry > CP38 Deduction
 * "Export to Excel", against the real database, through the real route (app/payroll/transactions/cp38/export/route.ts;
 * session, company switcher cookie and translations mocked at the Next.js edge only, translations from the real en.json):
 *  - every current record of the companies the administrator administers, ALL of them (more than a list page and more
 *    than one export batch), in the list's order, the same set an independent owner query selects;
 *  - leavers' records included; deleted (superseded) records excluded;
 *  - columns in the approved order; amounts numbers shown with two decimals; Start Date and End Date (Last Date to Pay)
 *    real Excel dates (End Date = the last month deducted, empty when open-ended); Status Active / Upcoming / Ended by
 *    the list's rule;
 *  - the page's filters: Company, Status and the chosen employee narrow; a company or employee outside the scope is
 *    ignored and never widens — a company-scoped administrator never receives another company's record, and the
 *    company switcher is honoured;
 *  - one `cp38.exported` event per export with actor, company ids, filters and row count, and no row values;
 *  - the reader is set-based: its statements do not grow with the number of rows (keyset batches of CP38_EXPORT_BATCH).
 * All names are invented.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: undefined as unknown, cookies: {} as Record<string, string> }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/payroll/transactions/cp38/export' }),
  cookies: async () => ({
    get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined),
    getAll: () => Object.entries(state.cookies).map(([name, value]) => ({ name, value })),
    has: (name: string) => name in state.cookies,
  }),
}));
vi.mock('next-intl/server', async () => {
  const messages = (await import('../messages/en.json')).default as Record<string, unknown>;
  const at = (path: string) => path.split('.').filter(Boolean).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages);
  const translator = (namespace = '') => {
    const t = (key: string) => {
      const v = at(namespace ? `${namespace}.${key}` : key);
      return typeof v === 'string' ? v : key;
    };
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true });
  };
  return {
    getLocale: async () => 'en',
    getTranslations: async (arg?: string | { namespace?: string }) => translator(typeof arg === 'string' ? arg : arg?.namespace),
  };
});
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;replace;${url}` });
  }),
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => state.session,
  getBrowserCommandSession: async () => state.session,
}));

import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import messages from '../messages/en.json';
import { GET } from '../app/payroll/transactions/cp38/export/route';
import { CP38_EXPORTED_EVENT, CP38_EXPORT_BATCH, readCp38Export } from '../packs/payroll/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { observeStatements } from './helpers/statement-observer';

const c = messages.payroll.transactions.cp38;
const COLUMNS = [
  'Employee ID', 'Employee Name', 'Company', 'CP38 Reference No.', 'Deduction Amount (RM)', 'Start Date',
  'End Date (Last Date to Pay)', 'Last Month Amount (RM)', 'Status', 'Remarks',
];
const STATUS_LABEL = { active: c.statusActive, upcoming: c.statusUpcoming, ended: c.statusEnded } as const;

let b: Base;
let a: SessionContext;
let betaAdmin: SessionContext;
let betaId: string;
let leaverRef: string;
let deletedRef: string;
let chosen: { employmentId: string; refs: string[] };
let betaEmployment: string;

/** `n` fictional employees of a company, inserted directly (codes sort in insertion order). */
async function staff(companyId: string, prefix: string, n: number, terminatedOn: string | null = null) {
  const people = await owner.db.insert(schema.person).values(Array.from({ length: n }, (_, i) => ({
    tenantId: b.tenantId, fullName: `Fictional ${prefix} ${String(i).padStart(3, '0')}`, primaryEmail: `${prefix.toLowerCase()}-${i}-${randomUUID().slice(0, 8)}@cp38x.test`,
  }))).returning({ id: schema.person.id });
  return (await owner.db.insert(schema.employment).values(people.map((p, i) => ({
    tenantId: b.tenantId, personId: p.id, companyId, employeeCode: `${prefix}-${String(i).padStart(3, '0')}`, hiredOn: '2024-01-01',
    ...(terminatedOn ? { terminatedOn } : {}),
  }))).returning({ id: schema.employment.id })).map((r) => r.id);
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  a = adminCtx(b);
  // A second company with an administrator of that company only.
  const [beta] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional Beta Sdn Bhd' }).returning({ id: schema.company.id });
  betaId = beta.id;
  const [bp] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional Beta Admin', primaryEmail: `${randomUUID()}@cp38x.test` }).returning({ id: schema.person.id });
  const [bu] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: bp.id }).returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: bu.id, companyId: betaId, role: 'hr_admin' });
  betaAdmin = { ...(await entitledCtx(b)), userId: bu.id, personId: bp.id, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: betaId }] } as SessionContext;

  // Acme: 56 employees with ten one-month records each in 2025 (ended), the first with the last one carrying a
  // last-month amount — 560 records, more than a list page (25) and more than one export batch.
  const acme = await staff(b.companyId, 'ACME', 56);
  const rows: (typeof schema.employeeCp38.$inferInsert)[] = [];
  acme.forEach((employmentId, i) => {
    for (let m = 1; m <= 10; m++) {
      rows.push({
        tenantId: b.tenantId, employmentId, cp38Ref: `CP38/A/${String(i).padStart(3, '0')}/${String(m).padStart(2, '0')}`,
        amount: (100 + i + m / 100).toFixed(2), validFrom: `2025-${String(m).padStart(2, '0')}-01`, validTo: `2025-${String(m + 1).padStart(2, '0')}-01`,
        lastMonthAmount: i === 0 && m === 10 ? '12.34' : null, remarks: m === 1 ? 'Fictional LHDN letter' : null,
      });
    }
  });
  // An open-ended active record and an upcoming one (separate employees), a leaver's record and a deleted one.
  const [active, upcoming, deletedOwner] = await staff(b.companyId, 'ACMF', 3);
  const [leaver] = await staff(b.companyId, 'ACML', 1, '2026-03-31');
  rows.push(
    { tenantId: b.tenantId, employmentId: active, cp38Ref: 'CP38/A/ACTIVE', amount: '250.00', validFrom: '2026-01-01', validTo: null, lastMonthAmount: null, remarks: null },
    { tenantId: b.tenantId, employmentId: upcoming, cp38Ref: 'CP38/A/UPCOMING', amount: '75.50', validFrom: '2030-01-01', validTo: '2030-07-01', lastMonthAmount: null, remarks: null },
    { tenantId: b.tenantId, employmentId: leaver, cp38Ref: 'CP38/A/LEAVER', amount: '40.00', validFrom: '2026-01-01', validTo: '2026-04-01', lastMonthAmount: null, remarks: 'Leaver' },
  );
  leaverRef = 'CP38/A/LEAVER';
  deletedRef = 'CP38/A/DELETED';
  await owner.db.insert(schema.employeeCp38).values({ tenantId: b.tenantId, employmentId: deletedOwner, cp38Ref: deletedRef, amount: '9.99', validFrom: '2026-01-01', supersededAt: new Date() });
  // Beta: three records on three employees.
  const beta3 = await staff(betaId, 'BETA', 3);
  betaEmployment = beta3[0];
  beta3.forEach((employmentId, i) => rows.push({ tenantId: b.tenantId, employmentId, cp38Ref: `CP38/B/${i}`, amount: '10.00', validFrom: '2026-01-01', validTo: null, lastMonthAmount: null, remarks: null }));
  for (let i = 0; i < rows.length; i += 500) await owner.db.insert(schema.employeeCp38).values(rows.slice(i, i + 500));
  chosen = { employmentId: acme[0], refs: rows.filter((r) => r.employmentId === acme[0]).map((r) => r.cp38Ref) };
  await owner.db.execute(sql`analyze public.employee_cp38, public.employment, public.person, public.company`);
}, 300_000);
afterAll(async () => {
  await closeAll();
});

type Expected = { code: string | null; ref: string; status: 'active' | 'upcoming' | 'ended' };
/** The export's population, independently: current records of non-voided employments of the companies, list order. */
async function expected(companyIds: readonly string[], where = sql``): Promise<Expected[]> {
  const thisMonth = `${todayInKualaLumpur().slice(0, 7)}-01`;
  return Array.from(await owner.db.execute<Expected>(sql`select e.employee_code as code, r.cp38_ref as ref,
      case when r.valid_from > ${thisMonth}::date then 'upcoming' when r.valid_to is not null and r.valid_to <= ${thisMonth}::date then 'ended' else 'active' end as status
    from employee_cp38 r join employment e on e.id = r.employment_id join company co on co.id = e.company_id
    where r.tenant_id = ${b.tenantId}::uuid and r.superseded_at is null and e.voided_at is null
      and e.company_id = any(${'{' + companyIds.join(',') + '}'}::uuid[]) ${where}
    order by co.legal_name, coalesce(e.employee_code, ''), r.valid_from, r.id`));
}

/** Call the route as the browser does; parse the workbook. */
async function download(session: SessionContext, query: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  state.session = session;
  state.cookies = cookies;
  const res = await GET(new Request(`http://localhost/payroll/transactions/cp38/export?${new URLSearchParams(query)}`));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="cp38-deductions_\d{4}-\d{2}-\d{2}\.xlsx"$/);
  const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer', cellDates: true, cellNF: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  return { book, sheet, header: grid[0] as string[], body: grid.slice(1) };
}
const refsOf = (body: unknown[][]) => body.map((r) => r[3] as string);
const exportEvents = async () =>
  Array.from(await owner.db.select().from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, CP38_EXPORTED_EVENT)))
    .orderBy(schema.domainEvent.sequence));

describe('038c304b rev 2 — CP38 Deduction Export to Excel', () => {
  it('exports every record of the companies administered, in the list order, with the approved columns and types', async () => {
    const all = await expected([b.companyId, betaId]);
    expect(all.length).toBeGreaterThan(CP38_EXPORT_BATCH);
    const { book, sheet, header, body } = await download(a);
    expect(book.SheetNames[0]).toBe(`${c.exportSheet} 1`);
    expect(header).toEqual(COLUMNS);
    expect(refsOf(body)).toEqual(all.map((r) => r.ref));
    expect(body.map((r) => r[0])).toEqual(all.map((r) => r.code));
    expect(body.map((r) => r[8])).toEqual(all.map((r) => STATUS_LABEL[r.status]));
    // Leaver included, deleted excluded.
    expect(refsOf(body)).toContain(leaverRef);
    expect(refsOf(body)).not.toContain(deletedRef);
    // Types: the first Acme record (row 2) — amounts are numbers with two decimals, dates real dates.
    const first = all.findIndex((r) => r.ref === 'CP38/A/000/01') + 2;
    expect(sheet[`B${first}`]).toMatchObject({ t: 's', v: 'Fictional ACME 000' });
    expect(sheet[`C${first}`]).toMatchObject({ t: 's', v: 'Acme Sdn Bhd' });
    expect(sheet[`E${first}`]).toMatchObject({ t: 'n', v: 100.01, z: '#,##0.00' });
    expect(sheet[`F${first}`]).toMatchObject({ t: 'd', v: new Date('2025-01-01T00:00:00Z') });
    // End Date is the LAST month deducted (stored exclusive end 2025-02-01 → January 2025).
    expect(sheet[`G${first}`]).toMatchObject({ t: 'd', v: new Date('2025-01-01T00:00:00Z') });
    expect(sheet[`H${first}`]).toBeUndefined();
    expect(sheet[`J${first}`]).toMatchObject({ t: 's', v: 'Fictional LHDN letter' });
    const lastMonth = all.findIndex((r) => r.ref === 'CP38/A/000/10') + 2;
    expect(sheet[`H${lastMonth}`]).toMatchObject({ t: 'n', v: 12.34, z: '#,##0.00' });
    const open = all.findIndex((r) => r.ref === 'CP38/A/ACTIVE') + 2;
    expect(sheet[`G${open}`]).toBeUndefined();
    expect(sheet[`I${open}`]).toMatchObject({ v: c.statusActive });
    expect(sheet[`I${all.findIndex((r) => r.ref === 'CP38/A/UPCOMING') + 2}`]).toMatchObject({ v: c.statusUpcoming });

    // One audit event: actor, companies, filters, row count — and no row values.
    const events = await exportEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: b.adminUserId, aggregateType: 'payroll-report' });
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ report: 'cp38-deductions', rowCount: all.length, filters: { company: null, status: null, employmentId: null } });
    expect([...(payload.companyIds as string[])].sort()).toEqual([b.companyId, betaId].sort());
    const text = JSON.stringify(payload);
    for (const leak of ['CP38/A/', '100.01', 'Fictional ACME', 'LHDN']) expect(text).not.toContain(leak);
  }, 120_000);

  it('follows the Company, Status and employee filters, and ignores a value outside the scope', async () => {
    const before = (await exportEvents()).length;
    // Company.
    const beta = await download(a, { company: betaId });
    expect(refsOf(beta.body)).toEqual((await expected([betaId])).map((r) => r.ref));
    // Status (with the company).
    const upcoming = await download(a, { company: b.companyId, status: 'upcoming' });
    expect(refsOf(upcoming.body)).toEqual(['CP38/A/UPCOMING']);
    const active = await download(a, { status: 'active' });
    expect(refsOf(active.body)).toEqual((await expected([b.companyId, betaId])).filter((r) => r.status === 'active').map((r) => r.ref));
    // The chosen employee.
    const one = await download(a, { employmentId: chosen.employmentId });
    expect(refsOf(one.body)).toEqual(chosen.refs);
    // Malformed values are ignored: everyone.
    const junk = await download(a, { company: 'not-a-company', status: 'closed', employmentId: 'x' });
    expect(junk.body.length).toBe((await expected([b.companyId, betaId])).length);

    // Beta's administrator: Acme is not theirs. ?company=Acme is ignored (their own records, never Acme's), and
    // an Acme employee is ignored too.
    const betaOnly = (await expected([betaId])).map((r) => r.ref);
    expect(refsOf((await download(betaAdmin)).body)).toEqual(betaOnly);
    expect(refsOf((await download(betaAdmin, { company: b.companyId })).body)).toEqual(betaOnly);
    expect(refsOf((await download(betaAdmin, { employmentId: chosen.employmentId })).body)).toEqual(betaOnly);
    // The company switcher: the group administrator scoped to Beta cannot reach Acme by ?company or ?employmentId.
    expect(refsOf((await download(a, { company: b.companyId }, { company_scope: betaId })).body)).toEqual(betaOnly);
    expect(refsOf((await download(a, { employmentId: chosen.employmentId }, { company_scope: betaId })).body)).toEqual(betaOnly);
    expect(refsOf((await download(a, { employmentId: betaEmployment }, { company_scope: betaId })).body)).toEqual(['CP38/B/0']);

    // Each export appended exactly one event with its own filters.
    const events = (await exportEvents()).slice(before);
    expect(events).toHaveLength(11);
    expect(events[0].payload).toMatchObject({ companyIds: [betaId], filters: { company: betaId, status: null, employmentId: null }, rowCount: betaOnly.length });
    expect(events[1].payload).toMatchObject({ companyIds: [b.companyId], filters: { company: b.companyId, status: 'upcoming', employmentId: null }, rowCount: 1 });
    expect(events[3].payload).toMatchObject({ filters: { employmentId: chosen.employmentId }, rowCount: chosen.refs.length });
    expect(events[6].payload).toMatchObject({ companyIds: [betaId], filters: { company: null }, rowCount: betaOnly.length });
    expect(events[6].actorId).toBe(betaAdmin.userId);
  }, 120_000);

  it('reads in keyset batches: the statements do not grow with the rows, and none is per row or per company', async () => {
    const count = (companyIds: string[]) => observeStatements(() => readCp38Export(a, { companyIds }, async (total, rows) => {
      let n = 0;
      for await (const row of rows) if (row.cp38Ref) n++;
      expect(n).toBe(total);
      return n;
    }));
    const big = await count([b.companyId, betaId]);
    const small = await count([betaId]);
    expect(big.result).toBeGreaterThan(CP38_EXPORT_BATCH);
    expect(small.result).toBe(3);
    const reads = (o: typeof big) => o.statements.filter((s) => /from employee_cp38 r/.test(s.sql)).length;
    // Count + ceil(rows / batch) batch reads, under one transaction.
    expect(big.transactions).toBe(1);
    expect(reads(big)).toBe(1 + Math.ceil(big.result / CP38_EXPORT_BATCH));
    expect(reads(small)).toBe(2);
    expect(big.statements.length - reads(big)).toBe(small.statements.length - reads(small));
  }, 120_000);
});
