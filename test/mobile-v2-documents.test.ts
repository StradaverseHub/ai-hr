/**
 * M09 — the v2 payslip index, payslip detail, payslip/EA PDFs and the audited share events, through the REAL route
 * handlers, the web's own document owners, real generated and closed payroll and RLS. Only bearer/web session
 * resolution and next-intl's request binding are injected (next-intl resolves the real catalogues).
 *
 * Pinned: the index lists every own released payslip across employments, current and past (D1), with no amount; an
 * unclosed run and a closed run whose release instant is ahead are withheld from the index, the detail and the PDF;
 * another employee's, another company's and another tenant's payslip and a guessed id all read `not_found`; a blocked
 * login gets nothing (401); an administrator in Mine sees only their own; amounts are the owner's own two-place
 * decimal strings; the phone's PDFs are the web routes' bytes; a share is acknowledged before anything leaves, closes
 * once, replays, and its audit carries identifiers and no figure.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompensation } from '../core/comp';
import { closeBatch, createBatch, generatePayslips, payslipDetail, setPayrollConfig } from '../packs/payroll/service';
import { myEaSources } from '../core/reporting';
import { requirePackFor } from '../localization/registry';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { moneyText } from '../lib/mobile-api/pay-routes';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({
  ...(await original<typeof import('../lib/session')>()),
  getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; },
  getSession: async () => caller,
}));
// The real catalogues through next-intl's own translator; the request binding (cookies) is what is replaced.
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const fs = await import('node:fs');
  const messages = (locale: string) => JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8'));
  return {
    getLocale: async () => 'en',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTranslations: async (arg: any) => {
      const locale = typeof arg === 'string' ? 'en' : arg.locale ?? 'en';
      return createTranslator({ locale, messages: messages(locale), namespace: typeof arg === 'string' ? arg : arg.namespace });
    },
  };
});
const index = await import('../app/api/mobile/v2/payslips/route');
const one = await import('../app/api/mobile/v2/payslips/[id]/route');
const pdf = await import('../app/api/mobile/v2/payslips/[id]/pdf/route');
const eaList = await import('../app/api/mobile/v2/ea/route');
const eaPdf = await import('../app/api/mobile/v2/ea/pdf/route');
const shares = await import('../app/api/mobile/v2/documents/share-events/route');
const webPayslip = await import('../app/(app)/me/payslip/[payslipId]/pdf/route');
const webEa = await import('../app/(app)/me/ea/[employmentId]/pdf/route');

type Role = 'employee' | 'hr_admin';
let base: Base;
let ic = 0;
const TODAY = todayInKualaLumpur();
/** A month `n` months before this one (derived from the clock, as test/my-payroll-documents-owner.test.ts does). */
const monthsAgo = (n: number) => { const d = new Date(`${TODAY.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
const P1 = monthsAgo(1), P2 = monthsAgo(2);
const HIRED = `${Number(P2.slice(0, 4)) - 1}-01-01`;
const ORIGIN = 'https://hr.example.com';
const V2 = `${ORIGIN}/api/mobile/v2`;

async function hire(name: string, o: { role?: Role; b?: Base; companyId?: string; departmentId?: string; basic?: number } = {}) {
  const b = o.b ?? base, root = adminCtx(b), role = o.role ?? 'employee', companyId = o.companyId ?? b.companyId;
  const e = await hireEmployee(root, { person: { fullName: name, primaryEmail: `${randomUUID()}@m09.example.invalid` }, companyId, departmentId: o.departmentId ?? b.deptA, employmentType: 'full_time', hiredOn: HIRED });
  await setCompensation(root, { employmentId: e.employmentId, basicSalary: o.basic ?? 5432.1, effectiveFrom: HIRED });
  await requirePackFor('MY').statutory.set(root, { personId: e.personId, icNumber: `90010110${String(++ic).padStart(4, '0')}`, taxCategory: 1, numChildren: 0 });
  const userId = await createAppUser(b.tenantId, e.personId, role);
  const ctx: SessionContext = { ...root, userId, personId: e.personId, roles: [role], grants: [{ role, companyId }] };
  return { ...e, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
async function run(period: string, o: { b?: Base; companyId?: string; close?: boolean } = {}) {
  const b = o.b ?? base, root = adminCtx(b);
  const batch = await createBatch(root, { companyId: o.companyId ?? b.companyId, payPeriod: period });
  await generatePayslips(root, { batchId: batch.batchId });
  if (o.close !== false) await closeBatch(root, { batchId: batch.batchId });
  return batch.batchId;
}
async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  expect(row, 'the run produced this employee’s payslip').toBeTruthy();
  return row;
}

const as = (who: Person | SessionContext) => { caller = 'ctx' in who ? who.ctx : who; };
async function get(handler: (r: Request) => Promise<Response>, path: string) {
  const r = await handler(new Request(V2 + path));
  return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null, bytes: r.headers.get('content-type')?.includes('json') ? null : new Uint8Array(await r.arrayBuffer()) };
}
const listed = (who: Person | SessionContext, query = '') => { as(who); return get(index.GET, `/payslips${query}`); };
const detail = (who: Person | SessionContext, id: string) => { as(who); return get(one.GET, `/payslips/${id}`); };
const file = (who: Person | SessionContext, id: string) => { as(who); return get(pdf.GET, `/payslips/${id}/pdf`); };
async function share(who: Person | SessionContext, body: Record<string, unknown>) {
  as(who);
  const r = await shares.POST(new Request(`${V2}/documents/share-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
const shareEvents = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateType, 'mobile-document-share')).orderBy(asc(schema.domainEvent.sequence));
const receipts = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded')).orderBy(asc(schema.domainEvent.sequence));
const NOT_FOUND = { outcome: 'refused', code: 'not_found' };

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); blocked = false; });

describe('the payslip index', () => {
  it('lists every own released payslip, current and past employment, in grouped order and without an amount', async () => {
    const employee = await hire('Aisyah Employee'), colleague = await hire('Badrul Colleague', { basic: 7654.32 });
    const older = await run(P2), newer = await run(P1);
    const mine = [await slipOf(newer, employee.employmentId), await slipOf(older, employee.employmentId)];
    const theirs = [await slipOf(newer, colleague.employmentId), await slipOf(older, colleague.employmentId)];

    const all = await listed(employee);
    expect(all.status).toBe(200);
    expect(all.headers.get('cache-control')).toBe('no-store');
    expect(all.body.enabled).toBe(true);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual(mine.map((s) => s.id));
    const [code] = await owner.db.select({ value: schema.employment.employeeCode }).from(schema.employment).where(eq(schema.employment.id, employee.employmentId));
    expect(all.body.items[0]).toMatchObject({
      id: mine[0].id, employmentId: employee.employmentId, employeeCode: code.value, companyId: base.companyId, company: 'Acme Sdn Bhd',
      period: P1, runType: 'regular', runSeq: 1,
    });
    expect(all.body.items[1]).toMatchObject({ id: mine[1].id, period: P2 });
    for (const item of all.body.items) expect(Object.keys(item).sort()).toEqual(['company', 'companyId', 'cycleName', 'employeeCode', 'employmentId', 'id', 'period', 'runSeq', 'runType']);
    // No amount travels in the index: neither the caller's own figures nor anyone else's id.
    const text = JSON.stringify(all.body);
    for (const s of mine) for (const figure of [s.grossPay, s.netPay, s.totalDeductions, s.basicSalary]) expect(text).not.toContain(figure);
    for (const s of theirs) expect(text).not.toContain(s.id);

    // Keyset pages neither repeat nor skip.
    const first = await listed(employee, '?limit=1');
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([mine[0].id]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await listed(employee, `?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual([mine[1].id]);
    expect(second.body.nextCursor).toBeNull();
    expect((await listed(employee, '?cursor=garbage!')).status).toBe(400);

    // D1: a past employment's documents stay the person's own.
    await terminateEmployment(adminCtx(base), { employmentId: employee.employmentId, terminationDate: TODAY, terminationReason: 'Fictional historical-document retention' });
    expect((await listed(employee)).body.items.map((i: { id: string }) => i.id)).toEqual(mine.map((s) => s.id));
    expect((await detail(employee, mine[1].id)).body.outcome).toBe('found');

    // D1: nothing once the login is blocked — every route, binary and command included.
    blocked = true;
    expect((await listed(employee)).status).toBe(401);
    expect((await detail(employee, mine[0].id)).status).toBe(401);
    expect((await file(employee, mine[0].id)).status).toBe(401);
    expect((await get(eaList.GET, '/ea')).status).toBe(401);
    expect((await share(employee, { requestId: randomUUID(), shareId: randomUUID(), document: { kind: 'payslip', id: mine[0].id }, stage: 'confirmed' })).status).toBe(401);
    expect(await shareEvents()).toEqual([]);
  });

  it('withholds an unclosed run and a closed run whose release instant is ahead — index, detail and PDF alike', async () => {
    const employee = await hire('Chitra Employee');
    const withheld = async (id: string) => {
      expect((await listed(employee)).body.items.map((i: { id: string }) => i.id)).not.toContain(id);
      expect((await detail(employee, id)).body).toEqual(NOT_FOUND);
      const f = await file(employee, id);
      expect(f.status).toBe(200); expect(f.body).toEqual(NOT_FOUND); expect(f.headers.get('cache-control')).toBe('no-store');
      expect((await share(employee, { requestId: randomUUID(), shareId: randomUUID(), document: { kind: 'payslip', id }, stage: 'confirmed' })).body).toEqual(NOT_FOUND);
    };
    // Generated but unclosed: withheld; closed (immediate release, the default): listed, shown and sent.
    const open = await run(P2, { close: false });
    const early = await slipOf(open, employee.employmentId);
    await withheld(early.id);
    await closeBatch(adminCtx(base), { batchId: open });
    expect((await listed(employee)).body.items.map((i: { id: string }) => i.id)).toEqual([early.id]);
    expect((await detail(employee, early.id)).body.outcome).toBe('found');
    expect((await file(employee, early.id)).headers.get('content-type')).toBe('application/pdf');
    // Closed with a release instant still ahead (the company's scheduled release): withheld though closed.
    await setPayrollConfig(adminCtx(base), { companyId: base.companyId, payslipRelease: { mode: 'relative', offsetDays: 7 } });
    const scheduled = await run(P1);
    const late = await slipOf(scheduled, employee.employmentId);
    const [batch] = await owner.db.select({ status: schema.payrollBatch.status, releasedAt: schema.payrollBatch.releasedAt }).from(schema.payrollBatch).where(eq(schema.payrollBatch.id, scheduled));
    expect(batch.status).toBe('closed');
    expect(batch.releasedAt!.getTime(), 'non-vacuity: the run is closed and its release is ahead').toBeGreaterThan(Date.now());
    await withheld(late.id);
    expect((await listed(employee)).body.items.map((i: { id: string }) => i.id)).toEqual([early.id]);
    expect(await shareEvents()).toEqual([]);
  });

  it('answers another employee’s, another company’s, another tenant’s and a guessed id the same way; a malformed id is a 400', async () => {
    const employee = await hire('Dina Employee'), colleague = await hire('Ehsan Colleague');
    const [company] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Second Sdn Bhd' }).returning({ id: schema.company.id });
    const [dept] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: company.id, name: 'Logistics' }).returning({ id: schema.department.id });
    const outsider = await hire('Omar Outside', { companyId: company.id, departmentId: dept.id });
    const other = await seedBase();
    const foreigner = await hire('Farah Foreign', { b: other });
    const here = await run(P1), there = await run(P1, { companyId: company.id }), abroad = await run(P1, { b: other });
    const foreign = [await slipOf(here, colleague.employmentId), await slipOf(there, outsider.employmentId), await slipOf(abroad, foreigner.employmentId)];
    for (const slip of [...foreign.map((s) => s.id), randomUUID()]) {
      expect((await detail(employee, slip)).body).toEqual(NOT_FOUND);
      expect((await file(employee, slip)).body).toEqual(NOT_FOUND);
      expect((await share(employee, { requestId: randomUUID(), shareId: randomUUID(), document: { kind: 'payslip', id: slip }, stage: 'confirmed' })).body).toEqual(NOT_FOUND);
    }
    // Non-vacuity: each of those payslips is its own employee's to open.
    expect((await detail(colleague, foreign[0].id)).body.outcome).toBe('found');
    expect((await detail(outsider, foreign[1].id)).body.outcome).toBe('found');
    expect((await detail(foreigner, foreign[2].id)).body.outcome).toBe('found');
    expect((await listed(employee)).body.items.map((i: { id: string }) => i.id)).toEqual([(await slipOf(here, employee.employmentId)).id]);
    expect((await detail(employee, 'not-a-uuid')).status).toBe(400);
    expect((await file(employee, 'not-a-uuid')).status).toBe(400);
    expect(await shareEvents()).toEqual([]);
  });

  it('an administrator acting in Mine sees only their own payslips, though the admin read reaches the others', async () => {
    const hr = await hire('Hana HR', { role: 'hr_admin' }), employee = await hire('Ismail Employee');
    const batchId = await run(P1);
    const own = await slipOf(batchId, hr.employmentId), theirs = await slipOf(batchId, employee.employmentId);
    expect(await payslipDetail(hr.ctx, theirs.id), 'the admin read reaches the employee: the refusal below is the Mine fence').toMatchObject({ id: theirs.id });
    expect((await listed(hr)).body.items.map((i: { id: string }) => i.id)).toEqual([own.id]);
    expect((await detail(hr, theirs.id)).body).toEqual(NOT_FOUND);
    expect((await file(hr, theirs.id)).body).toEqual(NOT_FOUND);
    expect((await share(hr, { requestId: randomUUID(), shareId: randomUUID(), document: { kind: 'payslip', id: theirs.id }, stage: 'confirmed' })).body).toEqual(NOT_FOUND);
  });

  // Re-pinned 29 October 2026 (integration with alpha): a Mobile service reads modules strictly (test/module-catalog-drift),
  // so an unreadable entitlements snapshot is an availability fault — 503 `unavailable` ("retry") — never a plan answer
  // ("Payroll is off", which would tell an employee they have no payslips during an incident). Nothing is read either way.
  it('an unreadable entitlements snapshot is unavailable, never Payroll off, and reads nothing', async () => {
    const employee = await hire('Jamal Employee');
    const slip = await slipOf(await run(P1), employee.employmentId);
    const off: SessionContext = { ...employee.ctx, entitlements: undefined, entitlementsError: 'test: no snapshot' };
    const UNAVAILABLE = { status: 503, body: { error: 'unavailable' } };
    expect(await listed(off)).toMatchObject(UNAVAILABLE);
    expect(await detail(off, slip.id)).toMatchObject(UNAVAILABLE);
    expect(await file(off, slip.id)).toMatchObject(UNAVAILABLE);
    as(off);
    expect(await get(eaList.GET, '/ea')).toMatchObject(UNAVAILABLE);
    expect(await share(off, { requestId: randomUUID(), shareId: randomUUID(), document: { kind: 'payslip', id: slip.id }, stage: 'confirmed' })).toMatchObject(UNAVAILABLE);
    expect(await shareEvents()).toEqual([]);
  });
});

describe('the payslip detail', () => {
  it('carries the document owner’s own amounts as exact two-place decimal strings, with the company’s currency', async () => {
    const employee = await hire('Kamala Employee', { basic: 5432.1 });
    const slip = await slipOf(await run(P1), employee.employmentId);
    const [company] = await owner.db.select({ currency: schema.company.currency }).from(schema.company).where(eq(schema.company.id, base.companyId));
    const seen = await detail(employee, slip.id);
    expect(seen.status).toBe(200);
    expect(seen.headers.get('cache-control')).toBe('no-store');
    const p = seen.body.payslip;
    expect(p).toMatchObject({ id: slip.id, employmentId: employee.employmentId, company: 'Acme Sdn Bhd', period: P1, currency: company.currency ?? null });
    expect(slip.basicSalary).toBe('5432.10');
    // The stored numerics, exactly — a trailing zero kept, nothing recomputed.
    expect(p.sections[0].total.amount).toBe(slip.grossPay);
    expect(p.sections[1].total.amount).toBe(slip.totalDeductions);
    expect(p.net.amount).toBe(slip.netPay);
    expect(p.sections[0].rows[0]).toMatchObject({ amount: slip.basicSalary, text: null });
    for (const section of p.sections) for (const row of section.rows) {
      if (row.amount === null) expect(row.text).toEqual(expect.any(String));
      else { expect(row.amount).toMatch(/^-?\d+\.\d{2}$/); expect(row.text).toBeNull(); }
    }
    expect(p.periodLabel).toEqual(expect.any(String));
  });

  it('formats an owner amount as the web statement does, without arithmetic of its own', () => {
    expect(moneyText('1234.5')).toBe('1234.50');
    expect(moneyText(1234.5)).toBe('1234.50');
    expect(moneyText('-12.5')).toBe('-12.50');
    expect(moneyText(0)).toBe('0.00');
    expect(moneyText(-0.001)).toBe('0.00');
    for (const absent of [null, undefined, '', 'x', Number.NaN, {}]) expect(moneyText(absent)).toBeNull();
    expect(moneyText('12.3400')).toBe('12.34');
    expect(moneyText('007.1')).toBe('7.10');
    expect(moneyText('12.345')).toBeNull();
    expect(moneyText('-0.00')).toBe('0.00');
  });
});

describe('the PDFs', () => {
  it('the phone receives the web routes’ own payslip and EA PDF, byte for byte, under the same name', async () => {
    const employee = await hire('Lim Employee');
    const slip = await slipOf(await run(P1), employee.employmentId);
    as(employee);
    const sources = (await get(eaList.GET, '/ea')).body;
    const source = sources.items.find((s: { employmentId: string; year: string; available: boolean }) => s.employmentId === employee.employmentId && s.year === P1.slice(0, 4) && s.available);
    expect(source, 'the released year has an available EA source').toBeTruthy();
    expect(sources.items).toEqual((await myEaSources(employee.ctx)).map((r) => ({ employmentId: r.employmentId, employeeCode: r.employeeCode, companyId: r.companyId, company: r.company, year: r.year, available: r.available, isCurrent: r.isCurrent })));
    // One instant for both renders: the PDF's creation date is the only input that is not the payslip's.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    let phone: Response, web: Response, phoneEa: Response, webEaRes: Response;
    try {
      phone = await pdf.GET(new Request(`${V2}/payslips/${slip.id}/pdf`));
      web = await webPayslip.GET(new Request(`${ORIGIN}/me/payslip/${slip.id}/pdf`), { params: Promise.resolve({ payslipId: slip.id }) });
      const q = `year=${source.year}&company=${source.companyId}&lang=en`;
      phoneEa = await eaPdf.GET(new Request(`${V2}/ea/pdf?employmentId=${employee.employmentId}&${q}`));
      webEaRes = await webEa.GET(new Request(`${ORIGIN}/me/ea/${employee.employmentId}/pdf?${q}`), { params: Promise.resolve({ employmentId: employee.employmentId }) });
    } finally { vi.useRealTimers(); }
    for (const [mobile, browser] of [[phone, web], [phoneEa, webEaRes]] as const) {
      expect(mobile.status).toBe(200); expect(browser.status).toBe(200);
      expect(mobile.headers.get('content-type')).toBe('application/pdf');
      expect(mobile.headers.get('cache-control')).toBe('private, no-store');
      expect(mobile.headers.get('content-disposition')).toBe(browser.headers.get('content-disposition'));
      expect(mobile.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/);
      const a = new Uint8Array(await mobile.arrayBuffer()), b = new Uint8Array(await browser.arrayBuffer());
      expect(new TextDecoder().decode(a.subarray(0, 5))).toBe('%PDF-');
      expect(a.byteLength).toBeGreaterThan(1000);
      expect(Buffer.from(a).equals(Buffer.from(b)), 'the phone’s copy is the web’s copy').toBe(true);
    }
    // Refused, never another form: a foreign or unavailable selection, and malformed input.
    const refused = await get(eaPdf.GET, `/ea/pdf?employmentId=${randomUUID()}&year=${source.year}&company=${source.companyId}&lang=en`);
    expect(refused.body).toEqual(NOT_FOUND);
    for (const q of [`year=${source.year}&company=${source.companyId}`, `employmentId=${employee.employmentId}&year=20xx&company=${source.companyId}`,
      `employmentId=${employee.employmentId}&year=${source.year}`, `employmentId=${employee.employmentId}&year=${source.year}&company=${source.companyId}&lang=zh`,
      `employmentId=${employee.employmentId}&employmentId=${employee.employmentId}&year=${source.year}&company=${source.companyId}`]) {
      expect((await get(eaPdf.GET, `/ea/pdf?${q}`)).status, q).toBe(400);
    }
  });
});

describe('share events', () => {
  it('a share is acknowledged first, closes once, replays, and its audit carries identifiers and no figure', async () => {
    const employee = await hire('Mei Employee'), colleague = await hire('Nabil Colleague');
    const batchId = await run(P1);
    const slip = await slipOf(batchId, employee.employmentId), theirs = await slipOf(batchId, colleague.employmentId);
    const shareId = randomUUID(), document = { kind: 'payslip', id: slip.id };

    // A closing stage with nothing acknowledged is refused and records nothing.
    expect((await share(employee, { requestId: randomUUID(), shareId, document, stage: 'completed' })).body).toEqual({ outcome: 'refused', code: 'not_confirmed' });
    expect(await shareEvents()).toEqual([]);

    const confirm = { requestId: randomUUID(), shareId, document, stage: 'confirmed' };
    const ack = await share(employee, confirm);
    expect(ack).toEqual({ status: 200, body: { outcome: 'recorded', shareId, stage: 'confirmed' } });
    expect((await share(employee, confirm)).body, 'a lost answer is replayed').toEqual(ack.body);
    expect((await share(employee, { ...confirm, stage: 'completed' })).body, 'one requestId, one command').toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await share(employee, { ...confirm, requestId: randomUUID() })).body, 'one shareId, one share').toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await share(employee, { requestId: randomUUID(), shareId, document: { kind: 'payslip', id: theirs.id }, stage: 'cancelled' })).body, 'another document under this share').toEqual({ outcome: 'refused', code: 'not_confirmed' });
    expect((await share(colleague, { requestId: randomUUID(), shareId, document, stage: 'completed' })).body, 'another person under this share').toEqual({ outcome: 'refused', code: 'not_confirmed' });

    const done = { requestId: randomUUID(), shareId, document, stage: 'completed' };
    expect((await share(employee, done)).body).toEqual({ outcome: 'recorded', shareId, stage: 'completed' });
    expect((await share(employee, done)).body).toEqual({ outcome: 'recorded', shareId, stage: 'completed' });
    for (const stage of ['completed', 'cancelled']) expect((await share(employee, { requestId: randomUUID(), shareId, document, stage })).body).toEqual({ outcome: 'refused', code: 'already_settled' });

    const events = await shareEvents();
    expect(events.map((e) => e.eventType)).toEqual(['document.share.confirmed', 'document.share.completed']);
    for (const [e, stage] of [[events[0], 'confirmed'], [events[1], 'completed']] as const) {
      expect(e).toMatchObject({ tenantId: base.tenantId, aggregateId: shareId, actorType: 'user', actorId: employee.ctx.userId, subjectEmploymentId: employee.employmentId });
      expect(e.payload).toEqual({ channel: 'mobile', shareId, stage, document: { kind: 'payslip', payslipId: slip.id } });
    }
    // No figure anywhere in the share's audit, the receipts included.
    const audit = JSON.stringify([...events, ...await receipts()].map((e) => e.payload));
    for (const figure of [slip.grossPay, slip.netPay, slip.totalDeductions, slip.basicSalary]) expect(audit).not.toContain(figure);
    expect(audit).not.toMatch(/gross|net|amount|salary|deduction|currency/i);
    expect((await receipts()).every((r) => r.subjectEmploymentId === employee.employmentId && r.actorId === employee.ctx.userId)).toBe(true);

    // Malformed commands are a 400 and record nothing.
    const before = (await shareEvents()).length;
    for (const body of [{ requestId: randomUUID(), document, stage: 'confirmed' }, { requestId: randomUUID(), shareId: randomUUID(), document, stage: 'viewed' },
      { requestId: randomUUID(), shareId: randomUUID(), document: { ...document, amount: '1.00' }, stage: 'confirmed' }]) {
      expect((await share(employee, body)).status).toBe(400);
    }
    expect((await shareEvents()).length).toBe(before);
  });

  it('an EA share is acknowledged only for the caller’s own available form, and a cancel closes it', async () => {
    const employee = await hire('Nurul Employee'), colleague = await hire('Ong Colleague');
    await run(P1);
    const [source] = (await myEaSources(employee.ctx)).filter((r) => r.available && r.year === P1.slice(0, 4));
    expect(source).toBeTruthy();
    const document = { kind: 'ea', employmentId: source.employmentId, year: source.year, companyId: source.companyId };
    for (const foreign of [{ ...document, employmentId: colleague.employmentId }, { ...document, year: String(Number(source.year) - 30) }, { ...document, companyId: randomUUID() }]) {
      expect((await share(employee, { requestId: randomUUID(), shareId: randomUUID(), document: foreign, stage: 'confirmed' })).body).toEqual(NOT_FOUND);
    }
    const shareId = randomUUID();
    expect((await share(employee, { requestId: randomUUID(), shareId, document, stage: 'confirmed' })).body).toEqual({ outcome: 'recorded', shareId, stage: 'confirmed' });
    expect((await share(employee, { requestId: randomUUID(), shareId, document, stage: 'cancelled' })).body).toEqual({ outcome: 'recorded', shareId, stage: 'cancelled' });
    const events = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, shareId), inArray(schema.domainEvent.eventType, ['document.share.confirmed', 'document.share.cancelled']))).orderBy(asc(schema.domainEvent.sequence));
    expect(events.map((e) => [e.eventType, e.subjectEmploymentId])).toEqual([['document.share.confirmed', employee.employmentId], ['document.share.cancelled', employee.employmentId]]);
    expect(events[0].payload).toEqual({ channel: 'mobile', shareId, stage: 'confirmed', document: { kind: 'ea', employmentId: source.employmentId, companyId: source.companyId, year: source.year } });
  });
});
