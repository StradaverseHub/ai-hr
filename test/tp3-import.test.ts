/**
 * Board 5084d02e — the Form TP3 Excel import on the shared bulk-job kernel, against the real database and its row
 * security. Fictional people and companies only.
 *
 * It proves, with the kind's real handler ticked by the kernel:
 *  - CHECK saves nothing: every row is checked (Employee ID within the importer's companies, year, duplicates, the
 *    form's own limits, the statutory profile) and only row outcomes are kept, never an amount;
 *  - CONFIRM saves the ready rows through `saveImportedTp3Tx`: the same upsert (one row per person and year), the
 *    same projection, an event naming the import and the row, and a refused row never stops the others;
 *  - a corrected re-import REPLACES the year's TP3 with one row and a before/after event, and the same figures again
 *    write nothing;
 *  - the same operation key returns the same job, a different file under it is refused, and Confirm twice returns one
 *    save job and writes once;
 *  - a row for a year older than the one holding the payroll figures saves the form only and says so;
 *  - file limits and admission scope;
 *  - the Import Log lists imports by the companies the viewer administers, whoever ran them.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { saveTp3 } from '../core/tp3';
import {
  TP3_IMPORT_KIND, confirmTp3Import, listTp3Imports, queueTp3ImportCheck, readTp3Import, tp3ImportJobHandler, tp3ImportSaveKey,
} from '../core/tp3-import-job';
import { bulkJobActive } from '../lib/bulk-job';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const HEADER = ['Employee ID *', 'Assessment Year *', 'Deduction Month', 'Employer 1 Name', 'Employer 1 Tax No.',
  'C1 · Total gross remuneration', 'C2(i)', 'C3', 'C5', 'D1(c)', 'D2', 'Remarks'];
type Row = { id: string; year?: string; month?: string; employer?: string; tin?: string; c1?: string; c2i?: string; c3?: string; c5?: string; d1c?: string; d2?: string; remarks?: string };
const line = (r: Row) => [r.id, r.year ?? '2026', r.month ?? '', r.employer ?? '', r.tin ?? '', r.c1 ?? '', r.c2i ?? '', r.c3 ?? '', r.c5 ?? '', r.d1c ?? '', r.d2 ?? '', r.remarks ?? ''].join(',');
const csvOf = (rows: Row[], header = HEADER) => [header.join(','), ...rows.map(line)].join('\n') + '\n';

let b: Base, a: SessionContext, betaId: string, scope: string[];
const people: Record<string, string> = {};

async function hire(code: string, companyId: string, departmentId: string, statutory = true) {
  const e = await hireEmployee(a, {
    person: { fullName: `Fictional ${code}`, primaryEmail: `${code.toLowerCase()}-${randomUUID().slice(0, 8)}@fixture.test` },
    companyId, departmentId, employmentType: 'full_time', hiredOn: '2026-01-05', employeeCode: code,
  });
  if (statutory) await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9001010${String(Object.keys(people).length).padStart(5, '0')}` });
  people[code] = e.personId;
  return e;
}
async function settle(ctx: SessionContext, id: string, scopeIds = scope) {
  let job = await readTp3Import(ctx, id, scopeIds);
  for (let tick = 0; tick < 60 && bulkJobActive(job.state); tick++) {
    await runBulkJobTick(owner.client, { handlers: [tp3ImportJobHandler] });
    job = await readTp3Import(ctx, id, scopeIds);
  }
  return job;
}
async function check(csv: string, fileName = 'tp3-new-joiners.xlsx', ctx = a, scopeIds = scope) {
  const id = await queueTp3ImportCheck(ctx, { csv, fileName, operationKey: randomUUID(), companyIds: scopeIds });
  return settle(ctx, id, scopeIds);
}
async function checkAndSave(csv: string, fileName = 'tp3-new-joiners.xlsx') {
  const checked = await check(csv, fileName);
  expect(checked.state).toBe('completed');
  const saveId = await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName, companyIds: scope });
  return { checked, saved: await settle(a, saveId) };
}
const forms = (personId: string) => owner.db.select().from(schema.employeeTp3).where(eq(schema.employeeTp3.personId, personId));
const formEvents = (personId: string) => owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
  .where(and(eq(schema.domainEvent.eventType, 'employee.tp3form.updated'), sql`${schema.domainEvent.payload}->>'personId' = ${personId}`))
  .orderBy(schema.domainEvent.occurredAt);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
  const [beta] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Beta Fictional Bhd', registrationNo: '202001000088' }).returning();
  betaId = beta.id;
  const [betaDept] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: betaId, name: 'Beta Finance' }).returning();
  for (const key of Object.keys(people)) delete people[key];
  await hire('C0101', b.companyId, b.deptA);
  await hire('C0102', b.companyId, b.deptA);
  await hire('C0103', b.companyId, b.deptA);
  await hire('C0104', b.companyId, b.deptA, false); // no bank and statutory details yet
  await hire('B0201', betaId, betaDept.id); // outside the importer's companies below
  scope = [b.companyId];
});

describe('5084d02e Form TP3 import: check, then confirm', () => {
  it('checks every row without saving anything, then saves only the ready rows', async () => {
    const csv = csvOf([
      { id: 'C0101', month: '4', employer: 'Example Trading Sdn Bhd', tin: 'C 1234567890', c1: '24000.00', c2i: '1200', c3: '2640.00', c5: '310.00', d2: '1500' },
      { id: 'C0102', c1: '12000', d2: '7000' }, // above D2's annual limit
      { id: 'C9999', c1: '1000' }, // not an Employee ID in the importer's companies
      { id: 'B0201', c1: '1000' }, // a real employee, in a company outside the importer's scope
      { id: 'C0103', c1: '5000' }, { id: 'c0103', c1: '5100' }, // the same person and year twice (codes match case-insensitively)
      { id: 'C0104', c1: '3000' }, // no statutory profile for the money to land on
      { id: 'C0101', year: '2025', c1: 'abc' }, // not an amount
      { id: '', c1: '1' }, // no Employee ID
      { id: 'C0102', year: '2025', d1c: '1500' }, // above D1(c)'s own limit
    ]);
    const checked = await check(csv);
    expect(checked).toMatchObject({ mode: 'check', state: 'completed', status: 'checked', total: 10, ready: 1, failed: 9, saved: 0 });
    expect(checked.rows.map(({ rowNum, employeeId, state, reason, field, detail }) => ({ rowNum, employeeId, state, reason, field, detail }))).toEqual([
      { rowNum: 2, employeeId: 'C0101', state: 'ready', reason: undefined, field: undefined, detail: undefined },
      { rowNum: 3, employeeId: 'C0102', state: 'problem', reason: 'overAnnualLimit', field: 'D2', detail: { limit: '6,000.00' } },
      { rowNum: 4, employeeId: 'C9999', state: 'problem', reason: 'employeeNotFound', field: 'employeeId', detail: undefined },
      { rowNum: 5, employeeId: 'B0201', state: 'problem', reason: 'employeeNotFound', field: 'employeeId', detail: undefined },
      { rowNum: 6, employeeId: 'C0103', state: 'problem', reason: 'duplicateInFile', field: undefined, detail: { rows: '6, 7' } },
      { rowNum: 7, employeeId: 'c0103', state: 'problem', reason: 'duplicateInFile', field: undefined, detail: { rows: '6, 7' } },
      { rowNum: 8, employeeId: 'C0104', state: 'problem', reason: 'noStatutoryProfile', field: undefined, detail: undefined },
      { rowNum: 9, employeeId: 'C0101', state: 'problem', reason: 'amountNotNumber', field: 'C1', detail: undefined },
      { rowNum: 10, employeeId: '', state: 'problem', reason: 'employeeIdRequired', field: 'employeeId', detail: undefined },
      { rowNum: 11, employeeId: 'C0102', state: 'problem', reason: 'overLimit', field: 'D1(c)', detail: { limit: '1,000.00' } },
    ]);
    // Nothing was written, and the job keeps no amount.
    for (const personId of Object.values(people)) expect(await forms(personId)).toEqual([]);
    const [stored] = await owner.client<{ plan: unknown; source_content: Buffer | null; input: unknown }[]>`select plan,source_content,input from bulk_job where id=${checked.id}::uuid`;
    expect(stored.source_content).toBeNull();
    expect(stored.input).toBeNull();
    expect(JSON.stringify(stored.plan)).not.toMatch(/24000|2640|1200|7000/);

    const saveId = await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName: 'tp3-new-joiners.xlsx', companyIds: scope });
    const saved = await settle(a, saveId);
    expect(saved).toMatchObject({ mode: 'save', state: 'completed', status: 'completedWithProblems', total: 10, saved: 1, failed: 9 });
    expect(saved.rows.find((row) => row.rowNum === 2)).toMatchObject({ state: 'saved' });
    expect(saved.rows.filter((row) => row.state === 'notSaved')).toHaveLength(9);
    const [form] = await forms(people.C0101);
    expect(form).toMatchObject({ assessmentYear: 2026, deductionMonth: 4, previousEmployers: [{ name: 'Example Trading Sdn Bhd', tin: 'C 1234567890' }], declaredAt: null });
    expect(form.payload).toMatchObject({ sectionC: { c1: { amount: 24000 }, c2: { amount: 1200, subItems: { i: 1200 } }, c3: { amount: 2640 }, c5: { amount: 310 } }, sectionD: { c2: { amount: 1500 } } });
    const events = await formEvents(people.C0101);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ source: 'tp3-import', importJobId: saveId, rowNumber: 2, before: null, after: { deductionMonth: 4 } });
    // The projection the hand save makes reached the payroll figures.
    const [stat] = await owner.db.select({ year: schema.employeeStatutoryMy.tp3Year, pcb: schema.employeeStatutoryMy.tp3PcbPaid })
      .from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, people.C0101));
    expect(stat).toEqual({ year: 2026, pcb: '310.00' });
    // The log shows the save, not the confirmed check; the check itself still opens and points at its save.
    expect((await listTp3Imports(a, scope)).map((job) => job.id)).toEqual([saveId]);
    expect(await readTp3Import(a, checked.id, scope)).toMatchObject({ savedAs: saveId, status: 'checked' });
  });

  it('replaces the year\'s TP3 on a corrected re-import with one row and a before/after event, and writes nothing for the same figures', async () => {
    const first = csvOf([{ id: 'C0101', employer: 'Example Trading Sdn Bhd', c1: '24000', c3: '2640', c5: '310' }]);
    await checkAndSave(first, 'tp3-first.xlsx');
    const corrected = csvOf([{ id: 'C0101', employer: 'Example Trading Sdn Bhd', c1: '30000', c3: '3300', c5: '500' }]);
    const { saved } = await checkAndSave(corrected, 'tp3-corrections.xlsx');
    expect(saved).toMatchObject({ status: 'completed', saved: 1, failed: 0 });
    const rows = await forms(people.C0101);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ sectionC: { c1: { amount: 30000 }, c3: { amount: 3300 }, c5: { amount: 500 } } });
    const events = await formEvents(people.C0101);
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({ source: 'tp3-import', importJobId: saved.id,
      before: { payload: { sectionC: { c1: { amount: 24000 } } } }, after: { payload: { sectionC: { c1: { amount: 30000 } } } } });
    // The same corrected file again: nothing changes and nothing is recorded twice.
    const { saved: again } = await checkAndSave(corrected, 'tp3-corrections-again.xlsx');
    expect(again).toMatchObject({ status: 'completed', saved: 0, unchanged: 1, failed: 0 });
    expect(again.rows[0]).toMatchObject({ state: 'unchanged' });
    expect(await formEvents(people.C0101)).toHaveLength(2);
    expect(await forms(people.C0101)).toHaveLength(1);
  });

  it('keeps an existing Section E declaration: the file has no declaration column', async () => {
    await saveTp3(a, { personId: people.C0101, assessmentYear: 2026, sectionC: { c1: { amount: 1000 } }, declarationAccepted: true });
    const [before] = await forms(people.C0101);
    expect(before.declaredAt).not.toBeNull();
    await checkAndSave(csvOf([{ id: 'C0101', c1: '2000' }]));
    const [after] = await forms(people.C0101);
    expect(after.declaredAt?.toISOString()).toBe(before.declaredAt?.toISOString());
    expect(after.payload).toMatchObject({ sectionC: { c1: { amount: 2000 } } });
  });

  it('returns the same job for the same operation key, refuses a changed file under it, and saves once on a double Confirm', async () => {
    const csv = csvOf([{ id: 'C0101', c1: '24000', c5: '310' }]);
    const input = { csv, fileName: 'tp3.xlsx', operationKey: randomUUID(), companyIds: scope };
    const id = await queueTp3ImportCheck(a, input);
    expect(await queueTp3ImportCheck(a, input)).toBe(id);
    await expect(queueTp3ImportCheck(a, { ...input, csv: csv.replace('24000', '25000') })).rejects.toThrow('operationChanged');
    await expect(queueTp3ImportCheck(a, { ...input, fileName: 'other.xlsx' })).rejects.toThrow('operationChanged');
    const checked = await settle(a, id);
    // Confirm needs the same file the check read.
    await expect(confirmTp3Import(a, { checkJobId: id, csv: csv.replace('24000', '25000'), fileName: 'tp3.xlsx', companyIds: scope })).rejects.toThrow('checkChanged');
    const first = await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName: 'tp3.xlsx', companyIds: scope });
    const second = await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName: 'tp3.xlsx', companyIds: scope });
    expect(second).toBe(first);
    expect(first).toBe((await owner.client<{ id: string }[]>`select id from bulk_job where operation_key=${tp3ImportSaveKey(checked.id)}::uuid`)[0].id);
    await settle(a, first);
    // Confirm after the save finished still returns the same job and writes nothing more.
    expect(await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName: 'tp3.xlsx', companyIds: scope })).toBe(first);
    await settle(a, first);
    expect(await formEvents(people.C0101)).toHaveLength(1);
    const [{ count }] = await owner.client<{ count: number }[]>`select count(*)::int as count from bulk_job where kind=${TP3_IMPORT_KIND}`;
    expect(count).toBe(2);
  });

  it('saves the form only when a later year holds the payroll figures, and says which year', async () => {
    await saveTp3(a, { personId: people.C0101, assessmentYear: 2026, sectionC: { c1: { amount: 1000 }, c5: { amount: 50 } } });
    const { saved } = await checkAndSave(csvOf([{ id: 'C0101', year: '2025', c1: '8000', c5: '400' }]));
    expect(saved).toMatchObject({ status: 'completed', saved: 1, failed: 0 });
    expect(saved.rows[0]).toMatchObject({ state: 'formOnly', heldBy: 2026, year: 2025 });
    expect((await forms(people.C0101)).map((row) => row.assessmentYear).sort()).toEqual([2025, 2026]);
    const [stat] = await owner.db.select({ year: schema.employeeStatutoryMy.tp3Year, pcb: schema.employeeStatutoryMy.tp3PcbPaid })
      .from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, people.C0101));
    expect(stat).toEqual({ year: 2026, pcb: '50.00' });
  });

  it('reports a row that became a problem after the check as not saved, without stopping the others', async () => {
    const csv = csvOf([{ id: 'C0101', c1: '24000' }, { id: 'C0102', c1: '12000' }]);
    const checked = await check(csv);
    expect(checked.ready).toBe(2);
    // C0102's statutory profile disappears between the check and the save.
    await owner.db.delete(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, people.C0102));
    const saved = await settle(a, await confirmTp3Import(a, { checkJobId: checked.id, csv, fileName: 'tp3-new-joiners.xlsx', companyIds: scope }));
    expect(saved).toMatchObject({ status: 'completedWithProblems', saved: 1, failed: 1 });
    expect(saved.rows.map((row) => [row.rowNum, row.state, row.reason])).toEqual([[2, 'saved', undefined], [3, 'notSaved', 'noStatutoryProfile']]);
    expect(await forms(people.C0102)).toEqual([]);
  });
});

describe('5084d02e Form TP3 import: file limits and scope', () => {
  it('refuses a file over the row limit, an unknown or missing column, and a duplicated column', async () => {
    const many = csvOf(Array.from({ length: 2001 }, () => ({ id: 'C0101', c1: '1' })));
    expect(await check(many)).toMatchObject({ state: 'failed', status: 'failed', error: 'tooManyRows', fileDetail: { max: 2000 }, rows: [] });
    expect(await check(csvOf([{ id: 'C0101' }], [...HEADER.slice(0, -1), 'C9 Unknown box']))).toMatchObject({ state: 'failed', error: 'unknownColumn', fileDetail: { column: 'C9 Unknown box' } });
    expect(await check('Assessment Year,C1\n2026,100\n')).toMatchObject({ state: 'failed', error: 'missingColumn', fileDetail: { column: 'Employee ID' } });
    expect(await check('Employee ID,Assessment Year,C1,C1 · again\nC0101,2026,1,2\n')).toMatchObject({ state: 'failed', error: 'duplicateColumn', fileDetail: { column: 'C1' } });
    for (const personId of Object.values(people)) expect(await forms(personId)).toEqual([]);
  });

  it('admits only an administrator of every company of the import, and only an .xlsx file name', async () => {
    const csv = csvOf([{ id: 'C0101', c1: '1' }]);
    await expect(queueTp3ImportCheck(a, { csv, fileName: 'tp3.csv', operationKey: randomUUID(), companyIds: scope })).rejects.toThrow('invalidFormat');
    await expect(queueTp3ImportCheck(a, { csv: '', fileName: 'tp3.xlsx', operationKey: randomUUID(), companyIds: scope })).rejects.toThrow('fileTooLarge');
    await expect(queueTp3ImportCheck({ ...a, roles: ['employee'] }, { csv, fileName: 'tp3.xlsx', operationKey: randomUUID(), companyIds: scope })).rejects.toThrow();
    // A company-scoped administrator of Beta cannot import for ACME.
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional Beta Admin', primaryEmail: `beta-admin-${randomUUID().slice(0, 8)}@fixture.test` }).returning();
    const user = await createAppUser(b.tenantId, p.id, 'hr_admin');
    await owner.db.update(schema.roleAssignment).set({ companyId: betaId }).where(eq(schema.roleAssignment.appUserId, user));
    const betaAdmin = { ...a, userId: user, personId: p.id, grants: [{ role: 'hr_admin', companyId: betaId }] } as SessionContext;
    await expect(queueTp3ImportCheck(betaAdmin, { csv, fileName: 'tp3.xlsx', operationKey: randomUUID(), companyIds: [b.companyId] })).rejects.toThrow('importAccessDenied');
    // "All companies" for a Beta administrator who is also employed elsewhere: the import belongs to Beta only, and
    // within Beta an ACME Employee ID is simply not found.
    const id = await queueTp3ImportCheck(betaAdmin, { csv, fileName: 'tp3-beta.xlsx', operationKey: randomUUID(), companyIds: [b.companyId, betaId] });
    const [job] = await owner.client<{ company_ids: string[] }[]>`select company_ids from bulk_job where id=${id}::uuid`;
    expect(job.company_ids).toEqual([betaId]);
    const checked = await settle(betaAdmin, id, [betaId]);
    expect(checked.rows[0]).toMatchObject({ reason: 'employeeNotFound' });
  });

  it('lists imports for the companies the viewer administers, whoever ran them, and hides the others', async () => {
    const acmeJob = await check(csvOf([{ id: 'C0101', c1: '1' }]), 'acme.xlsx');
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional Beta Admin', primaryEmail: `beta-admin-${randomUUID().slice(0, 8)}@fixture.test` }).returning();
    const user = await createAppUser(b.tenantId, p.id, 'hr_admin');
    await owner.db.update(schema.roleAssignment).set({ companyId: betaId }).where(eq(schema.roleAssignment.appUserId, user));
    const betaAdmin = { ...a, userId: user, personId: p.id, grants: [{ role: 'hr_admin', companyId: betaId }] } as SessionContext;
    const betaJob = await check(csvOf([{ id: 'B0201', c1: '1' }]), 'beta.xlsx', betaAdmin, [betaId]);
    // The group administrator sees both, newest first, and who uploaded each.
    const all = await listTp3Imports(a, [b.companyId, betaId]);
    expect(all.map((job) => [job.id, job.sourceName, job.uploadedBy, job.mine])).toEqual([
      [betaJob.id, 'beta.xlsx', 'Fictional Beta Admin', false], [acmeJob.id, 'acme.xlsx', null, true]]);
    // The Beta administrator sees Beta's only, even when asking for ACME too, and cannot open ACME's.
    expect((await listTp3Imports(betaAdmin, [b.companyId, betaId])).map((job) => job.id)).toEqual([betaJob.id]);
    await expect(readTp3Import(betaAdmin, acmeJob.id, [b.companyId, betaId])).rejects.toThrow('Job unavailable.');
    // A company outside the scope asked for hides the job even from the group administrator.
    expect((await listTp3Imports(a, [betaId])).map((job) => job.id)).toEqual([betaJob.id]);
    // Paging by key: the older page starts after the cursor.
    expect(all[0].cursorAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect((await listTp3Imports(a, [b.companyId, betaId], { at: all[0].cursorAt, id: all[0].id })).map((job) => job.id)).toEqual([acmeJob.id]);
  });
});
