/**
 * r389 (23bd49d9) — Payslip Information Setup: the saved ORDER reaches every payslip read, and Copy to
 * Companies copies a company's SAVED setting to others, all-or-nothing, inside what the caller may manage.
 *
 * Against a real database under RLS. The pure selector claims (stored order, unknown/duplicate keys, a
 * catalogue-order row unchanged byte for byte) are in test/r389-payslip-information-order.test.ts, and the
 * PDF placement (row-major pairing, a blank field moving up) in test/payslip-pdf.test.ts.
 *
 * The action block resolves `getTranslations` against the real catalogues (the r352 instrument), so a
 * refusal that names the company is proven to reach the reader in their language with the name in it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const { session } = vi.hoisted(() => ({ session: { s: null as unknown } }));
const { locale } = vi.hoisted(() => ({ locale: { value: 'en' } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn(async () => locale.value),
  getTranslations: vi.fn(async (ns: string) => {
    const dict = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${locale.value}.json`), 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = ns.split('.').reduce<any>((o, k) => o?.[k], dict);
    return (key: string, params?: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = key.split('.').reduce<any>((o, k) => o?.[k], node);
      if (typeof raw !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key} (${locale.value})`);
      return raw.replace(/\{(\w+)\}/g, (_m, p) => {
        if (params == null || !(p in params)) throw new Error(`MISSING_PARAM: ${ns}.${key}.${p}`);
        return String(params[p]);
      });
    };
  }),
}));
vi.mock('@/lib/authz', async (orig) => {
  const actual = await orig<typeof import('../lib/authz')>();
  return { ...actual, requirePayrollAccess: vi.fn(async () => session.s) };
});

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, closeBatch, payslipDetail } from '../core/payroll';
import { payslipForReview } from '../core/payroll-view';
import {
  copyPayslipInformationSettings,
  getPayslipInformationSettings,
  setPayslipInformationSettings,
} from '../core/payslip-information-settings';
import { DEFAULT_PAYSLIP_INFORMATION_FIELDS, PAYSLIP_INFORMATION_FIELDS, selectPayslipInformation, type PayslipInformationField } from '../core/payslip-information';
import { buildPayslipPdfData, renderPayslipPdf } from '../lib/payslip-pdf';
import { labels as pdfLabels } from './fixtures/payslip-pdf-fixture';
import { copyPayslipInformation } from '../app/payroll/payslip-information/actions';
import { adminCtx, owner, migrateTestDb, resetDb, seedBase, closeAll, createAppUser, harnessSnapshot, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); locale.value = 'en'; });
afterAll(closeAll);

const grantsFor = (role: string, ...companyIds: string[]): SessionContext =>
  ({ ...adminCtx(base), roles: [role], grants: companyIds.map(companyId => ({ role, companyId })) });
const addCompany = async (legalName: string, tenantId = base.tenantId) =>
  (await owner.db.insert(schema.company).values({ tenantId, legalName }).returning())[0];

/** Everything a copy could have written, read as the owner (no RLS), in a stable order. */
async function snapshot(tenantIds: string[] = [base.tenantId]) {
  const settings = await owner.db.select().from(schema.payslipInformationSetting)
    .where(inArray(schema.payslipInformationSetting.tenantId, tenantIds)).orderBy(asc(schema.payslipInformationSetting.companyId));
  const events = await owner.db.select({ type: schema.domainEvent.eventType, aggregateId: schema.domainEvent.aggregateId, payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(and(inArray(schema.domainEvent.tenantId, tenantIds), inArray(schema.domainEvent.eventType, ['payslip-information.changed', 'payslip-information.copied'])))
    .orderBy(asc(schema.domainEvent.aggregateId), asc(schema.domainEvent.eventType));
  return { settings, events };
}

const names = Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, `L.${k}`])) as Record<PayslipInformationField, string>;
/** Everything on a read except one key — what must NOT move when only the display order changes. */
const without = <T extends object>(o: T, key: keyof T) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** One closed (issued) payslip for one employee of the base company, readable by that employee. */
async function issuedPayslip() {
  const a = adminCtx(base);
  const e = await hireEmployee(a, { person: { fullName: 'Synthetic Ordered Employee', primaryEmail: 'r389-order@example.test' },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4321.5, monthlyAllowance: 250, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  const userId = await createAppUser(base.tenantId, e.personId, 'employee');
  const ess: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
  await generatePayslips(a, { batchId });
  await closeBatch(a, { batchId });
  const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return { slipId: slip.id, ess };
}

/** The words the renderer drew, in order (pdf-lib writes WinAnsi hex operands; see test/payslip-pdf.test.ts). */
function drawnText(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  for (let i = 0; ;) {
    const s = buf.indexOf('stream', i); if (s < 0) break;
    const e = buf.indexOf('endstream', s); if (e < 0) break;
    let b = s + 6; if (buf[b] === 0x0d) b++; if (buf[b] === 0x0a) b++;
    let body: Buffer; try { body = zlib.inflateSync(buf.subarray(b, e)); } catch { body = buf.subarray(b, e); }
    for (const m of body.toString('latin1').matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) out.push(Buffer.from(m[1].replace(/\s+/g, ''), 'hex').toString('latin1'));
    i = e + 9;
  }
  return out;
}

/** The employee's own PDF, built the way app/me/payslip/[payslipId]/pdf/route.ts builds it. */
async function essDocument(ess: SessionContext, slipId: string) {
  const p = (await payslipDetail(ess, slipId))!;
  const informationRows = selectPayslipInformation({ ...p, employee: p.employee }, p.informationFields, names);
  const borne = new Proxy({}, { get: (_t, k) => String(k) }) as never;
  const data = buildPayslipPdfData(p, borne, { informationRows, currency: 'MYR' });
  return { p, informationRows, data, text: drawnText(await renderPayslipPdf(data, pdfLabels)) };
}

describe('r389 saving an order', () => {
  it('refuses a list that names a field twice and writes nothing', async () => {
    const ctx = grantsFor('hr_admin', base.companyId);
    await setPayslipInformationSettings(ctx, base.companyId, ['employeeCode', 'employee']);
    const before = await snapshot();
    await expect(setPayslipInformationSettings(ctx, base.companyId, ['employee', 'branch', 'employee'])).rejects.toThrow('Duplicate payslip field');
    expect(await snapshot()).toEqual(before);
    expect(await getPayslipInformationSettings(ctx, base.companyId)).toEqual(['employeeCode', 'employee']);
  });

  it('both payslip reads return the stored order, and no money moves when the order changes', async () => {
    const { slipId, ess } = await issuedPayslip();
    const a = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    const review = () => payslipForReview(a, { companyIds: [base.companyId], payslipId: slipId });
    const reviewBefore = (await review())!, detailBefore = (await payslipDetail(ess, slipId))!;
    expect(reviewBefore.informationFields).toBeNull(); // no row yet ⇒ defaults downstream
    await setPayslipInformationSettings(a, base.companyId, ['employeeCode', 'employee', 'daysWorked', 'department']);
    const reviewAfter = (await review())!, detailAfter = (await payslipDetail(ess, slipId))!;
    expect(reviewAfter.informationFields).toEqual(['employeeCode', 'employee', 'daysWorked', 'department']);
    expect(detailAfter.informationFields).toEqual(['employeeCode', 'employee', 'daysWorked', 'department']);
    // Every other field of both reads — every amount, the statutory snapshot, YTD inputs — is unchanged.
    expect(without(reviewAfter, 'informationFields')).toEqual(without(reviewBefore, 'informationFields'));
    expect(without(detailAfter, 'informationFields')).toEqual(without(detailBefore, 'informationFields'));
    expect(Number(detailAfter.net)).toBeGreaterThan(0);
  });

  it('live contract: reordering re-renders an ISSUED payslip in the new order, with the same figures', async () => {
    const { slipId, ess } = await issuedPayslip();
    const a = grantsFor('hr_admin', base.companyId);
    await setPayslipInformationSettings(a, base.companyId, ['employee', 'employeeCode', 'daysWorked']);
    const first = await essDocument(ess, slipId);
    await setPayslipInformationSettings(a, base.companyId, ['daysWorked', 'employeeCode', 'employee']);
    const second = await essDocument(ess, slipId);
    expect(first.informationRows.map(r => r.key)).toEqual(['employee', 'employeeCode', 'daysWorked']);
    expect(second.informationRows.map(r => r.key)).toEqual(['daysWorked', 'employeeCode', 'employee']);
    const order = (text: string[]) => text.filter(w => [names.employee, names.employeeCode, names.daysWorked].includes(w));
    expect(order(first.text)).toEqual([names.employee, names.employeeCode, names.daysWorked]);
    expect(order(second.text)).toEqual([names.daysWorked, names.employeeCode, names.employee]);
    // Same document otherwise: the PDF data apart from the profile rows, and every drawn word, as a multiset.
    expect(without(second.data, 'informationRows')).toEqual(without(first.data, 'informationRows'));
    expect([...second.text].sort()).toEqual([...first.text].sort());
  });
});

describe('r389 Copy to Companies', () => {
  it('gives every target the source’s SAVED fields and order; afterwards each company is independent', async () => {
    const b = await addCompany('Synthetic Copy B'), c = await addCompany('Synthetic Copy C');
    const ctx = grantsFor('hr_admin', base.companyId, b.id, c.id);
    await setPayslipInformationSettings(ctx, base.companyId, ['employeeCode', 'employee', 'branch']);
    await setPayslipInformationSettings(ctx, b.id, ['currency']);
    const result = await copyPayslipInformationSettings(ctx, base.companyId, [b.id, c.id]);
    expect(result).toEqual({ fields: ['employeeCode', 'employee', 'branch'], targetCompanyIds: [b.id, c.id] });
    for (const id of [base.companyId, b.id, c.id]) expect(await getPayslipInformationSettings(ctx, id)).toEqual(['employeeCode', 'employee', 'branch']);
    // No lasting link, in either direction.
    await setPayslipInformationSettings(ctx, base.companyId, ['employee']);
    expect(await getPayslipInformationSettings(ctx, b.id)).toEqual(['employeeCode', 'employee', 'branch']);
    await setPayslipInformationSettings(ctx, c.id, ['daysWorked']);
    expect(await getPayslipInformationSettings(ctx, base.companyId)).toEqual(['employee']);
    expect(await getPayslipInformationSettings(ctx, b.id)).toEqual(['employeeCode', 'employee', 'branch']);
  });

  it('copies the defaults explicitly when the source never saved, so targets match what the source prints', async () => {
    const b = await addCompany('Synthetic Copy B');
    const ctx = grantsFor('payroll_partner', base.companyId, b.id);
    await setPayslipInformationSettings(ctx, b.id, ['branch']);
    await copyPayslipInformationSettings(ctx, base.companyId, [b.id]);
    expect(await getPayslipInformationSettings(ctx, b.id)).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
    const [row] = await owner.db.select().from(schema.payslipInformationSetting).where(eq(schema.payslipInformationSetting.companyId, b.id));
    expect(row.fields).toEqual([...DEFAULT_PAYSLIP_INFORMATION_FIELDS]);
  });

  it('de-duplicates targets and drops the source; an empty or source-only list is refused and writes nothing', async () => {
    const b = await addCompany('Synthetic Copy B');
    const ctx = grantsFor('hr_admin', base.companyId, b.id);
    await setPayslipInformationSettings(ctx, base.companyId, ['team', 'employee']);
    const before = await snapshot();
    for (const targets of [[], [base.companyId], [base.companyId, base.companyId]]) {
      await expect(copyPayslipInformationSettings(ctx, base.companyId, targets)).rejects.toMatchObject({ code: 'payslipCopyNoTargets' });
    }
    expect(await snapshot()).toEqual(before);
    const result = await copyPayslipInformationSettings(ctx, base.companyId, [b.id, base.companyId, b.id]);
    expect(result.targetCompanyIds).toEqual([b.id]);
    const changed = (await snapshot()).events.filter(e => e.type === 'payslip-information.changed' && e.aggregateId === b.id);
    expect(changed).toHaveLength(1);
  });

  it('writes one changed event per target (fields, before, copiedFromCompanyId) and one copied event on the source', async () => {
    const b = await addCompany('Synthetic Copy B'), c = await addCompany('Synthetic Copy C');
    const ctx = grantsFor('hr_admin', base.companyId, b.id, c.id);
    await setPayslipInformationSettings(ctx, base.companyId, ['employeeCode', 'employee']);
    await setPayslipInformationSettings(ctx, b.id, ['branch', 'team']);
    const before = (await snapshot()).events;
    await copyPayslipInformationSettings(ctx, base.companyId, [c.id, b.id]);
    const added = (await snapshot()).events.filter(e => !before.some(x => JSON.stringify(x) === JSON.stringify(e)));
    expect(added).toHaveLength(3);
    const byTarget = (id: string) => added.filter(e => e.aggregateId === id);
    expect(byTarget(b.id)).toEqual([{ type: 'payslip-information.changed', aggregateId: b.id,
      payload: { fields: ['employeeCode', 'employee'], before: ['branch', 'team'], copiedFromCompanyId: base.companyId } }]);
    expect(byTarget(c.id)).toEqual([{ type: 'payslip-information.changed', aggregateId: c.id,
      payload: { fields: ['employeeCode', 'employee'], before: [...DEFAULT_PAYSLIP_INFORMATION_FIELDS], copiedFromCompanyId: base.companyId } }]);
    expect(byTarget(base.companyId)).toEqual([{ type: 'payslip-information.copied', aggregateId: base.companyId,
      payload: { fields: ['employeeCode', 'employee'], targetCompanyIds: [c.id, b.id] } }]);
  });

  describe('refusals write nothing', () => {
    it('a payroll partner of A cannot copy to B: the whole copy is refused, naming B, even with a permitted target first', async () => {
      const b = await addCompany('Synthetic Unmanaged B'), c = await addCompany('Synthetic Managed C');
      const partner = grantsFor('payroll_partner', base.companyId, c.id);
      await setPayslipInformationSettings(partner, base.companyId, ['employeeCode', 'employee']);
      const before = await snapshot();
      await expect(copyPayslipInformationSettings(partner, base.companyId, [c.id, b.id]))
        .rejects.toMatchObject({ code: 'payslipCopyTargetForbidden', companyName: 'Synthetic Unmanaged B' });
      expect(await snapshot()).toEqual(before);
      // The first out-of-scope target in the order given is the one named.
      const d = await addCompany('Synthetic Unmanaged D');
      await expect(copyPayslipInformationSettings(partner, base.companyId, [d.id, b.id]))
        .rejects.toMatchObject({ companyName: 'Synthetic Unmanaged D' });
      expect(await snapshot()).toEqual(before);
    });

    it('a company of another tenant, an unknown id or a malformed id is refused without revealing a name', async () => {
      const [foreignTenant] = await owner.db.insert(schema.tenant).values({ name: 'Synthetic foreign tenant', workosOrgId: randomUUID() }).returning();
      const foreign = await addCompany('Synthetic Foreign Company', foreignTenant.id);
      // Even a session that CLAIMS a grant on the foreign company: the company is not this tenant's.
      const ctx = grantsFor('hr_admin', base.companyId, foreign.id);
      await setPayslipInformationSettings(ctx, base.companyId, ['employee']);
      const before = await snapshot([base.tenantId, foreignTenant.id]);
      for (const target of [foreign.id, randomUUID(), 'not-a-uuid']) {
        const refusal = await copyPayslipInformationSettings(ctx, base.companyId, [target]).catch(e => e);
        expect(refusal).toMatchObject({ code: 'payslipCopyTargetForbidden', companyName: null });
        expect(String(refusal.message)).not.toContain('Synthetic Foreign Company');
      }
      expect(await snapshot([base.tenantId, foreignTenant.id])).toEqual(before);
    });

    it('an employee (ESS) session cannot copy at all', async () => {
      const b = await addCompany('Synthetic Copy B');
      await setPayslipInformationSettings(grantsFor('hr_admin', base.companyId), base.companyId, ['employee']);
      const before = await snapshot();
      const ess: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'], grants: [], entitlements: harnessSnapshot(base.tenantId) };
      await expect(copyPayslipInformationSettings(ess, base.companyId, [b.id])).rejects.toThrow('Forbidden');
      expect(await snapshot()).toEqual(before);
    });

    it('RLS refuses the same write on its own: a partner of A cannot upsert B’s row directly', async () => {
      const b = await addCompany('Synthetic Copy B');
      const partner = grantsFor('payroll_partner', base.companyId);
      await expect(withTenant(partner, tx => tx.insert(schema.payslipInformationSetting)
        .values({ tenantId: base.tenantId, companyId: b.id, fields: ['employee'] }))).rejects.toThrow();
      expect((await snapshot()).settings).toEqual([]);
    });
  });

  describe('the action', () => {
    const form = (companyId: string, targets: string[]) => {
      const f = new FormData();
      f.set('companyId', companyId);
      for (const t of targets) f.append('targetCompanyIds', t);
      return f;
    };
    it('copies and reports the targets; a refusal names the company in the reader’s language and writes nothing', async () => {
      const b = await addCompany('Synthetic Managed B'), x = await addCompany('Synthetic Outside X');
      session.s = grantsFor('payroll_partner', base.companyId, b.id);
      await setPayslipInformationSettings(session.s as SessionContext, base.companyId, ['employeeCode', 'employee']);
      expect(await copyPayslipInformation({ error: '', copiedTo: [] }, form(base.companyId, [b.id])))
        .toEqual({ error: '', copiedTo: [b.id] });
      const before = await snapshot();
      for (const [loc, expected] of [
        ['en', 'You cannot manage payroll for Synthetic Outside X, so nothing was copied.'],
        ['zh', '您无权管理 Synthetic Outside X 的薪资，因此未复制任何内容。'],
      ] as const) {
        locale.value = loc;
        expect(await copyPayslipInformation({ error: '', copiedTo: [] }, form(base.companyId, [b.id, x.id])))
          .toEqual({ error: expected, copiedTo: [] });
      }
      locale.value = 'en';
      expect(await copyPayslipInformation({ error: '', copiedTo: [] }, form(base.companyId, [])))
        .toEqual({ error: 'Choose at least one other company to copy to.', copiedTo: [] });
      expect(await snapshot()).toEqual(before);
    });
  });
});
