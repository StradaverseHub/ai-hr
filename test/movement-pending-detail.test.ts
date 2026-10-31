import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {asc, eq} from 'drizzle-orm';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {assignment, compensation, domainEvent, employment} from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent, movementDetail, movementHistory, movementPendingEditInput, editMovementEvent, reverseMovementEvent, applyDueMovementsTx} from '../core/movement';
import {previewMovementImport, commitMovementImport} from '../core/movement-import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {await resetDb(); b = await seedBase();});
afterAll(closeAll);
const day = (offset: number) => new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function hire() {
  const {employmentId} = await hireEmployee(adminCtx(b), {
    person: {fullName: 'Fictional pending View', primaryEmail: `${randomUUID()}@fixture.test`},
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: day(-60), employeeCode: 'EMP-0004',
  });
  await setCompensation(adminCtx(b), {employmentId, basicSalary: 3000, effectiveFrom: day(-40)});
  return employmentId;
}
async function snapshot(id: string) {
  return {
    employment: await owner.db.select().from(employment).where(eq(employment.id,id)),
    assignment: await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
    compensation: await owner.db.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)),
    events: await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
  };
}

describe('pending Movement View shows saved intent separately from applied history', () => {
  it('prefills canonical saved targets and retains omitted targets in a date/remarks-only pending correction', async () => {
    const id=await hire(),ctx=adminCtx(b);
    await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:day(7),departmentId:b.deptB,basicSalary:3500,positionId:null,remarks:'Fictional original'});
    const original=(await movementHistory(ctx,id)).find(r=>r.status==='pending')!;
    const before=await snapshot(id);
    expect(await movementPendingEditInput(ctx,id,original.id)).toEqual({values:{departmentId:b.deptB,basicSalary:'3500',positionId:null},unavailable:false});
    expect(await snapshot(id)).toEqual(before); // Prefill is a scoped owner read, never a write.
    await editMovementEvent(ctx,{employmentId:id,movementId:original.id,kind:'promotion',effectiveDate:day(8),remarks:'Fictional revised remarks',reason:'Fictional date-only correction',departmentId:undefined,basicSalary:undefined});
    const revised=(await movementHistory(ctx,id)).find(r=>r.status==='pending')!;
    expect(revised).toMatchObject({effectiveDate:day(8),remarks:'Fictional revised remarks'});
    expect(await movementPendingEditInput(ctx,id,revised.id)).toEqual({values:{departmentId:b.deptB,basicSalary:'3500',positionId:null},unavailable:false});
    expect(await movementPendingEditInput(ctx,id,original.id)).toBeNull();
    const recorded=(await snapshot(id)).events.find(e=>e.id===revised.id)!;
    expect((recorded.payload as {input:unknown}).input).toEqual({departmentId:b.deptB,basicSalary:3500,positionId:null});
    await editMovementEvent(ctx,{employmentId:id,movementId:revised.id,kind:'promotion',effectiveDate:day(9),basicSalary:3600,positionId:null,reason:'Fictional explicit target correction'});
    const explicit=(await movementHistory(ctx,id)).find(r=>r.status==='pending')!;
    expect(await movementPendingEditInput(ctx,id,explicit.id)).toEqual({values:{departmentId:b.deptB,basicSalary:'3600',positionId:null},unavailable:false});
    const foreign=await seedBase();
    await expect(movementPendingEditInput(adminCtx(foreign),id,explicit.id)).rejects.toThrow();
  });
  it('shows a manually scheduled target without changing actual snapshots or writing during View', async () => {
    const id = await hire(), ctx = adminCtx(b);
    await createMovementEvent(ctx, {employmentId:id, kind:'promotion', effectiveDate:day(7), departmentId:b.deptB, basicSalary:3500});
    const [pending] = (await movementHistory(ctx,id)).filter(row => row.status === 'pending');
    const before = await snapshot(id), detail = await movementDetail(ctx,id,pending.id);
    expect(detail?.row).toMatchObject({kind:'promotion', status:'pending'});
    expect(detail?.before?.salaryAmount).toBe('3000.00');
    expect(detail?.after.salaryAmount).toBe('3000.00'); // Reports/ESS still receive actual as-of facts.
    expect(detail?.after.department).toBe(detail?.before?.department);
    expect(detail?.pendingIntent?.values).toEqual([
      {field:'department', value:'Operations'}, {field:'basicSalary', value:'3500'},
    ]);
    expect(detail?.pendingIntent?.values.some(row => row.field === 'currency' || row.field === 'grade')).toBe(false);
    expect(await snapshot(id)).toEqual(before);
  });

  it('reads both imported future targets, including the return to current salary, without fabricating a historical Before', async () => {
    const id = await hire(), ctx = adminCtx(b);
    const csv = toCsv([
      ['employee_code','event_type','effective_date','department_id','basic_salary'],
      ['EMP-0004','promotion',day(7),b.deptB,3500],
      ['EMP-0004','promotion',day(14),b.deptA,3000],
    ]);
    const preview = await previewMovementImport(ctx,{companyId:b.companyId,csv});
    expect(preview.valid).toBe(2);
    const result = await commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,
      fingerprints:Object.fromEntries(preview.employees.filter(row=>row.fingerprint).map(row=>[row.employeeCode,row.fingerprint!])),acknowledgeExcluded:true});
    expect(result).toMatchObject({imported:2,failed:0});
    const pending = (await movementHistory(ctx,id)).filter(row=>row.status==='pending').sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));
    expect(pending).toHaveLength(2);
    const before = await snapshot(id), first = await movementDetail(ctx,id,pending[0].id), second = await movementDetail(ctx,id,pending[1].id);
    expect(first?.pendingIntent?.values).toEqual(expect.arrayContaining([{field:'basicSalary',value:'3500'},{field:'department',value:'Operations'}]));
    expect(second?.pendingIntent?.values).toEqual(expect.arrayContaining([{field:'basicSalary',value:'3000'},{field:'department',value:'Finance'}]));
    expect(first?.before?.salaryAmount).toBe('3000.00');
    expect(second?.before?.salaryAmount).toBe('3000.00'); // Not a persisted admission-baseline snapshot.
    expect(second?.after.salaryAmount).toBe('3000.00');
    expect(await snapshot(id)).toEqual(before);
  });

  it('does not present cancelled, superseded or already applied movements as pending proposals', async () => {
    const id = await hire(), ctx = adminCtx(b);
    await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:day(7),basicSalary:3300});
    const [cancelled] = (await movementHistory(ctx,id)).filter(row=>row.status==='pending');
    await reverseMovementEvent(ctx,{employmentId:id,movementId:cancelled.id,reason:'Fictional cancellation'});
    expect((await movementDetail(ctx,id,cancelled.id))?.pendingIntent).toBeNull();
    await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:day(7),basicSalary:3400});
    await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:day(7),basicSalary:3500});
    await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,id,day(7)));
    const history = await movementHistory(ctx,id);
    expect(history.map(row=>row.status)).toEqual(expect.arrayContaining(['reversed','superseded','applied']));
    const before = await snapshot(id);
    for (const row of history) expect((await movementDetail(ctx,id,row.id))?.pendingIntent).toBeNull();
    const applied = history.find(row=>row.kind==='promotion'&&row.status==='applied')!;
    expect((await movementDetail(ctx,id,applied.id))?.after.salaryAmount).toBe('3500.00');
    expect(await snapshot(id)).toEqual(before);
  });

  it('wires the distinct scheduled-values section and its explanation in all six locales', () => {
    const source = readFileSync(resolve('app/(app)/admin/personnel/[employmentId]/page.tsx'),'utf8');
    const start = source.indexOf('{movementDetailData.pendingIntent ? (');
    const end = source.indexOf('      ) : (',start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const pending = source.slice(start,end);
    expect(pending).toContain('movementDetailData.pendingIntent.values.map');
    expect(pending).toContain("t('movement.detail.scheduledValues')");
    expect(pending).toContain("t('movement.detail.scheduledValuesNote')");
    expect(pending).not.toContain('movement.detail.beforeChanges');
    for (const locale of ['en','ms','zh','ta','th','vi']) {
      const copy = JSON.parse(readFileSync(resolve(`messages/${locale}.json`),'utf8')).people.detail.movement;
      expect(copy.detail.scheduledValues.trim().length).toBeGreaterThan(0);
      expect(copy.detail.scheduledValuesNote.trim().length).toBeGreaterThan(0);
      expect(copy.field.location.trim().length).toBeGreaterThan(0);
    }
  });
});
