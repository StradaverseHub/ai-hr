import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {correctHireDetails} from '../core/hire-correction';
import {informationCorrectionHistory} from '../core/information-correction';
import {createMovementEvent,movementDetail,movementHistory} from '../core/movement';
import {recordHistoryMovementTx} from '../core/movement-history';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Correction Reader',primaryEmail:'correction-reader@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;});
afterAll(closeAll);
const correct=(hireInformation:Parameters<typeof correctHireDetails>[1]['hireInformation'])=>correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation,reason:'Correct original fictional hire facts'});

describe('saved hire corrections agree across readers',()=>{
 it('shows earlier and later corrected Group Join Dates on the Hired row and resolves old audit labels',async()=>{
  await correct({hiredOn:'2025-12-01',joinDate:'2025-12-01'});
  let hire=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='hired')!;
  expect(hire.effectiveDate).toBe('2025-12-01');
  expect(hire.informationCorrections?.every(item=>!item.needsReview)).toBe(true);
  expect((await movementDetail(adminCtx(b),id,hire.id))?.after.informationEvidence?.joinDate.value).toBe('2025-12-01');
  await correct({hiredOn:'2026-01-01',joinDate:'2026-01-01'});
  hire=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='hired')!;
  expect(hire.effectiveDate).toBe('2026-01-01');
  const audit=await informationCorrectionHistory(adminCtx(b),id);
  expect(audit).toHaveLength(2);
  expect(audit[0].payload).toMatchObject({beforeLabels:{hiredOn:'2025-12-01',joinDate:'2025-12-01'},afterLabels:{hiredOn:'2026-01-01',joinDate:'2026-01-01'}});
 });
 it('does not overlay an old company correction onto a subsequently recorded historical employer',async()=>{
  const [corrected]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Corrected Employer'}).returning();
  const [historical]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Historical Employer'}).returning();
  await owner.withTenant(adminCtx(b),tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
  await correct({companyId:corrected.id});
  await withTenant(adminCtx(b),tx=>recordHistoryMovementTx(tx,adminCtx(b),{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',after:{companyId:corrected.id},before:{companyId:historical.id}}));
  const rows=await movementHistory(adminCtx(b),id),hire=rows.find(row=>row.kind==='hired')!;
  expect(hire.company).toBe(historical.legalName);
  expect(rows.find(row=>row.history)?.company).toBe(corrected.legalName);
  expect((await movementDetail(adminCtx(b),id,hire.id))?.after.company).toBe(historical.legalName);
  const audit=await informationCorrectionHistory(adminCtx(b),id);
  expect(audit[0].payload).toMatchObject({afterLabels:{companyId:corrected.legalName}});
 });
 it('displays a corrected hire grade while retaining the later deliberate grade',async()=>{
  const [original,later]=await owner.db.insert(s.jobGrade).values([{tenantId:b.tenantId,code:'FIX-FIRST',name:'Fictional Original Grade'},{tenantId:b.tenantId,code:'FIX-LATER',name:'Fictional Later Grade'}]).returning();
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',gradeId:later.id});
  await correct({gradeId:original.id});
  const rows=await movementHistory(adminCtx(b),id),hire=rows.find(row=>row.kind==='hired')!,promotion=rows.find(row=>row.kind==='promotion')!;
  expect((await movementDetail(adminCtx(b),id,hire.id))?.after.grade).toBe(original.name);
  expect((await movementDetail(adminCtx(b),id,promotion.id))?.after.grade).toBe(later.name);
  expect((await informationCorrectionHistory(adminCtx(b),id))[0].payload).toMatchObject({afterLabels:{gradeId:original.name}});
 });
 it('retains original contract type and end date without replacing the later type',async()=>{
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:'2026-03-01',employmentType:'part_time'});
  await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{employmentType:'contract'},endDates:{contractEndDate:'2026-02-28'},reason:'Correct fictional original contract'});
  const rows=await movementHistory(adminCtx(b),id),hire=rows.find(row=>row.kind==='hired')!,later=rows.find(row=>row.kind==='transfer')!;
  const detail=await movementDetail(adminCtx(b),id,hire.id);
  expect(detail?.after.employmentType).toBe('contract');
  expect(detail?.after.informationEvidence?.contractEndDate.value).toBe('2026-02-28');
  expect((await movementDetail(adminCtx(b),id,later.id))?.after.employmentType).toBe('part_time');
 });
});
