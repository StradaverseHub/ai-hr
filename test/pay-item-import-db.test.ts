import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import { createPayComponentsFromImport, createPayComponent, listPayComponents, PayComponentCodeExistsError,
  setEmploymentPayComponent, setPayrollBatchComponent, upsertPayComponent, PayRuleInvalidError,
  type PayComponentInput } from '../core/pay-components';
import { PayComponentCalculationPendingError } from '../lib/pay-component-contract';
import { payItemVocabulary, previewPayItemImport, commitPayItemImport } from '../core/pay-component-import';
import { PAY_ITEM_COLUMNS } from '../lib/pay-component-import';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import en from '../messages/en.json';
import * as XLSX from 'xlsx';

const input = (code: string, overrides: Partial<PayComponentInput> = {}): PayComponentInput => ({ code, name: code, label: code,
  description: 'Fictional import contract', kind: 'allowance', isNonPayable: false, prorates: false,
  includedInEpf: false, includedInSocsoEis: false, includedInPcb: false, includedInHrdfBase: false,
  epfBonus2012: false, pcbRemunerationType: null, pcbExemptionCode: null, ...overrides });
const catalog = (tenantId: string) => owner.db.select().from(s.payComponent).where(eq(s.payComponent.tenantId, tenantId)).orderBy(s.payComponent.code);
const events = (tenantId: string) => owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId, tenantId), eq(s.domainEvent.aggregateType, 'pay-component'))).orderBy(s.domainEvent.sequence);

describe('Pay Items create-only atomic import and pending calculation boundaries', () => {
  let base: Base, ctx: SessionContext;
  const day = todayInKualaLumpur(), period = day.slice(0, 7), first = `${period}-01`;
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => { await resetDb(); base = await seedBase(); ctx = await entitledCtx(base); });
  afterAll(async () => { await closeAll(); });

  it('creates inactive rows in the same transaction and records importer/time/sanitized filename without descriptions', async () => {
    const result = await createPayComponentsFromImport(ctx, [{ input: input(' new-one '), archived: true }, { input: input('NEW_TWO'), archived: false }], '../folder\\fictional\n.xlsx');
    expect(result.created).toBe(2);
    const rows = await catalog(base.tenantId); expect(rows.map(r => r.code)).toEqual(['NEW-ONE', 'NEW_TWO']);
    expect(rows.find(r => r.code === 'NEW-ONE')!.archivedAt).not.toBeNull();
    expect(rows.find(r => r.code === 'NEW_TWO')!.archivedAt).toBeNull();
    const audit = await events(base.tenantId); expect(audit).toHaveLength(2);
    for (const event of audit) {
      expect(event.actorType).toBe('user'); expect(event.actorId).toBe(base.adminUserId);
      expect(event.occurredAt).toBeInstanceOf(Date);
      expect(event.payload).toMatchObject({ source: 'Excel import', fileName: 'fictional_.xlsx' });
      expect(JSON.stringify(event.payload)).not.toContain('Fictional import contract');
    }
  });
  it('refuses active/inactive duplicate codes, including normalization, without updating or partially creating', async () => {
    await createPayComponentsFromImport(ctx, [{ input: input('TAKEN'), archived: true }], 'first.xlsx');
    const before = await catalog(base.tenantId), beforeAudit = await events(base.tenantId);
    await expect(createPayComponentsFromImport(ctx, [{ input: input('FRESH'), archived: false }, { input: input(' taken '), archived: false }], 'second.xlsx')).rejects.toBeInstanceOf(PayComponentCodeExistsError);
    expect(await catalog(base.tenantId)).toEqual(before); expect(await events(base.tenantId)).toEqual(beforeAudit);
  });
  it('rolls back all rows and audit events on an actual second-row write fault', async () => {
    await owner.db.execute(sql`create function public.pay_item_import_test_failure() returns trigger language plpgsql as $$begin if NEW.code='FAIL_SECOND' then raise exception 'fictional write fault'; end if; return NEW; end$$`);
    await owner.db.execute(sql`create trigger pay_item_import_test_failure before insert on pay_component for each row execute function public.pay_item_import_test_failure()`);
    try {
      await expect(createPayComponentsFromImport(ctx, [{ input: input('FIRST_VALID'), archived: false }, { input: input('FAIL_SECOND'), archived: false }], 'fault.xlsx')).rejects.toThrow();
      expect(await catalog(base.tenantId)).toEqual([]); expect(await events(base.tenantId)).toEqual([]);
    } finally {
      await owner.db.execute(sql`drop trigger pay_item_import_test_failure on pay_component`);
      await owner.db.execute(sql`drop function public.pay_item_import_test_failure()`);
    }
  });
  it('serializes competing create-only imports; the losing file leaves no unrelated rows or audit', async () => {
    const outcomes = await Promise.allSettled([
      createPayComponentsFromImport(ctx, [{ input: input('A_ONLY'), archived: false }, { input: input('SHARED'), archived: false }], 'a.xlsx'),
      createPayComponentsFromImport(ctx, [{ input: input('B_ONLY'), archived: false }, { input: input('SHARED'), archived: false }], 'b.xlsx'),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const rows = await catalog(base.tenantId); expect(rows).toHaveLength(2); expect(rows.filter(r => r.code === 'SHARED')).toHaveLength(1);
    expect(rows.filter(r => r.code === 'A_ONLY' || r.code === 'B_ONLY')).toHaveLength(1);
    expect(await events(base.tenantId)).toHaveLength(2);
  });
  it('refuses non-admin and cross-tenant work without creating rows', async () => {
    await expect(createPayComponentsFromImport({ ...ctx, roles: ['employee'] }, [{ input: input('NO_ACCESS'), archived: false }], 'no.xlsx')).rejects.toThrow();
    expect(await catalog(base.tenantId)).toEqual([]);
    const other = await seedBase();
    await createPayComponentsFromImport(ctx, [{ input: input('PRIVATE'), archived: false }], 'ours.xlsx');
    expect(await listPayComponents(await entitledCtx(other), { includeArchived: true })).toEqual([]);
    expect(await catalog(other.tenantId)).toEqual([]);
  });
  async function employee() {
    const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional pending employee', primaryEmail: 'pending@fictional.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: first });
    await setCompensation(ctx, { employmentId: hired.employmentId, basicSalary: 3500, monthlyAllowance: 0, effectiveFrom: first });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101011234' });
    return hired;
  }
  it('persists the requested calculation with no fake rule and refuses all transaction assignment owners', async () => {
    const hired = await employee(), pending = input('PENDING_FORMULA', { pendingInputKind: 'formula' });
    const { id } = await createPayComponent(ctx, pending), { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    expect((await catalog(base.tenantId))[0]).toMatchObject({ pendingInputKind: 'formula', rule: null });
    await expect(setEmploymentPayComponent(ctx, { employmentId: hired.employmentId, componentId: id, amount: 50, effectiveFrom: first })).rejects.toBeInstanceOf(PayComponentCalculationPendingError);
    await expect(setPayrollBatchComponent(ctx, { batchId, employmentId: hired.employmentId, componentId: id, amount: 50 })).rejects.toBeInstanceOf(PayComponentCalculationPendingError);
    await expect(createIndividualTxn(ctx, { batchId, employmentId: hired.employmentId, componentId: id, kind: 'earning', txnDate: day, amount: 50 })).rejects.toBeInstanceOf(PayComponentCalculationPendingError);
    expect(await listPayComponents(ctx, { readyOnly: true })).toEqual([]);
    await expect(upsertPayComponent(ctx, { ...pending, pendingInputKind: undefined, rule: { kind: 'per_day', rate: 2 }, prorates: true })).rejects.toBeInstanceOf(PayRuleInvalidError);
    expect((await catalog(base.tenantId))[0].pendingInputKind).toBe('formula');
    await upsertPayComponent(ctx, { ...pending, pendingInputKind: undefined, rule: { kind: 'formula', start: { ref: 'number', value: 25 }, terms: [] } });
    expect((await catalog(base.tenantId))[0].pendingInputKind).toBeNull();
    await expect(setPayrollBatchComponent(ctx, { batchId, employmentId: hired.employmentId, componentId: id, amount: 50 })).resolves.toHaveProperty('id');
  });
  it.each([false, true])('refuses a bypassed pending assignment at process time with typed components enabled=%s', async typed => {
    await setModule(base.tenantId, 'typed_pay_components', typed ? 'active' : null); ctx = await entitledCtx(base);
    const hired = await employee(), { id } = await createPayComponent(ctx, input('PENDING', { pendingInputKind: 'formula' }));
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    // Deliberately bypass the canonical assignment guard to model a stale/external row. Never product code.
    await owner.db.insert(s.employmentPayComponent).values({ tenantId: base.tenantId, employmentId: hired.employmentId, componentId: id, amount: '50.00', validFrom: first });
    await expect(generatePayslips(ctx, { batchId })).rejects.toBeInstanceOf(PayComponentCalculationPendingError);
    expect(await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId, batchId))).toEqual([]);
    expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id, batchId)).orderBy(s.payrollBatch.id))[0].status).toBe('draft');
  });
  it('refuses pending at selective reprocess and preserves genuine existing payslip bytes', async () => {
    const hired = await employee(), { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(ctx, { batchId });
    const before = await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId, batchId)).orderBy(s.payslip.id);
    expect(before).toHaveLength(1);
    const { id } = await createPayComponent(ctx, input('PENDING_REPROCESS', { pendingInputKind: 'formula' }));
    await owner.db.insert(s.payrollBatchComponent).values({ tenantId: base.tenantId, batchId, employmentId: hired.employmentId, componentId: id, amount: '25.00' });
    await expect(generatePayslips(ctx, { batchId, reprocessSubset: { employmentIds: [hired.employmentId] } })).rejects.toBeInstanceOf(PayComponentCalculationPendingError);
    expect(await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId, batchId)).orderBy(s.payslip.id)).toEqual(before);
  });
  it('validates all rows against today’s catalog and refuses a changed-file confirmation or re-upload', async () => {
    const vocabulary = payItemVocabulary(key => (en.payComponents as Record<string, string>)[key], key => (en.payComponents as Record<string, string>)[key]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[], PAY_ITEM_COLUMNS.map(([, header]) => header), ['X1', 'Fictional import', '', 'Earning', '', '', '', '', '', '', '', '', '', 'N']]), 'Pay Items');
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const preview = await previewPayItemImport(ctx, bytes, vocabulary); expect(preview.errors).toBe(0);
    await expect(commitPayItemImport(ctx, bytes, 'x.xlsx', '0'.repeat(64), vocabulary)).rejects.toThrow();
    expect(await catalog(base.tenantId)).toEqual([]);
    expect(await commitPayItemImport(ctx, bytes, 'x.xlsx', preview.fileSha256, vocabulary)).toMatchObject({ created: 1 });
    const repeat = await previewPayItemImport(ctx, bytes, vocabulary);
    expect(repeat.rows[0].errors).toContainEqual({ field: 'code', code: 'existingCode' });
    await expect(commitPayItemImport(ctx, bytes, 'x.xlsx', repeat.fileSha256, vocabulary)).rejects.toThrow();
    expect(await catalog(base.tenantId)).toHaveLength(1);
  });
  it('validates a real 1000-row workbook within the requested ten-second ceiling', async () => {
    const vocabulary = payItemVocabulary(key => (en.payComponents as Record<string, string>)[key], key => (en.payComponents as Record<string, string>)[key]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[], PAY_ITEM_COLUMNS.map(([, header]) => header),
      ...Array.from({ length: 1000 }, (_, index) => [`PERF_${index}`, `Fictional ${index}`, '', 'Earning', '', '', '', '', '', '', '', '', '', 'N'])]), 'Pay Items');
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    const started = performance.now(), preview = await previewPayItemImport(ctx, bytes, vocabulary), elapsedMs = performance.now() - started;
    expect(preview).toMatchObject({ total: 1000, valid: 1000, errors: 0 });
    console.info(`Pay Items 1000-row validation: ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeLessThan(10000);
    expect(await catalog(base.tenantId)).toEqual([]);
  });
});
