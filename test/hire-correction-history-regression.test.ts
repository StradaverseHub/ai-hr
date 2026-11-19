import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {correctHireDetails,hireCorrectionView} from '../core/hire-correction';
import {informationCorrectionHistory} from '../core/information-correction';
import {createMovementEvent,movementDetail,movementHistory} from '../core/movement';
import {correctionAuditLabelsTx} from '../core/information-correction-audit';
import {recordHistoryMovementTx} from '../core/movement-history';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Correction Reader',primaryEmail:'correction-reader@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;});
afterAll(closeAll);
const correct=(hireInformation:Parameters<typeof correctHireDetails>[1]['hireInformation'])=>correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation,reason:'Correct original fictional hire facts'});

describe('saved hire corrections agree across readers',()=>{
 it('resolves a full audit page in sets while preserving captured labels and explicit nulls',async()=>{
  const companies=await owner.db.insert(s.company).values(Array.from({length:70},(_,n)=>({tenantId:b.tenantId,legalName:'Fictional Audit Employer '+n}))).returning();
  const records=Array.from({length:100},(_,n)=>({payload:{fields:['companyId','gradeId','probationValue'],before:{companyId:companies[n%70].id,gradeId:null,probationValue:3},after:{companyId:companies[(n+1)%70].id,gradeId:null,probationValue:4},...(n===0?{beforeLabels:{companyId:'Captured former name',gradeId:null},afterLabels:{companyId:null}}:{})}}));
  const rows=await withTenant(adminCtx(b),tx=>correctionAuditLabelsTx(tx,b.tenantId,records));
  expect(rows).toHaveLength(100);
  expect(rows[0].payload).toMatchObject({beforeLabels:{companyId:'Captured former name',gradeId:null,probationValue:'3'},afterLabels:{companyId:null,gradeId:null,probationValue:'4'}});
  for(let n=1;n<100;n++)expect(rows[n].payload).toMatchObject({beforeLabels:{companyId:companies[n%70].legalName},afterLabels:{companyId:companies[(n+1)%70].legalName}});
  expect(records[1].payload).not.toHaveProperty('beforeLabels');
 });
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
 it('reads the corrected hire assignment when Company and Group Join Date are corrected together',async()=>{
  const [corrected,later]=await owner.db.insert(s.company).values([
   {tenantId:b.tenantId,legalName:'Corrected Hire Employer'},
   {tenantId:b.tenantId,legalName:'Later Transfer Employer'},
  ]).returning();
  await owner.withTenant(adminCtx(b),tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',companyId:later.id});
  await correct({companyId:corrected.id,hiredOn:'2026-02-01'});

  const rows=await movementHistory(adminCtx(b),id);
  const hire=rows.find(row=>row.kind==='hired')!;
  expect(hire).toMatchObject({company:corrected.legalName,effectiveDate:'2026-02-01'});
  expect((await movementDetail(adminCtx(b),id,hire.id))?.after.company).toBe(corrected.legalName);
  expect(await hireCorrectionView(adminCtx(b),id)).toMatchObject({companyId:corrected.id,hiredOn:'2026-02-01'});
  expect(rows.find(row=>row.kind==='entityTransfer')?.company).toBe(later.legalName);
  const [current]=await owner.db.select({companyId:s.employment.companyId}).from(s.employment).where(eq(s.employment.id,id));
  expect(current.companyId).toBe(later.id);
  expect((await informationCorrectionHistory(adminCtx(b),id))[0].payload).toMatchObject({
   before:{companyId:b.companyId},after:{companyId:corrected.id},
  });
 });
 it('displays a corrected hire grade while retaining the later deliberate grade',async()=>{
  const [original,later]=await owner.db.insert(s.jobGrade).values([{tenantId:b.tenantId,code:'FIX-FIRST',name:'Fictional Original Grade'},{tenantId:b.tenantId,code:'FIX-LATER',name:'Fictional Later Grade'}]).returning();
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',gradeId:later.id});
  await correct({gradeId:original.id});
  const rows=await movementHistory(adminCtx(b),id),hire=rows.find(row=>row.kind==='hired')!,promotion=rows.find(row=>row.kind==='promotion')!;
  expect((await movementDetail(adminCtx(b),id,hire.id))?.after.grade).toBe(original.name);
  const promotionDetail=await movementDetail(adminCtx(b),id,promotion.id);
  expect(promotionDetail?.after.grade).toBe(later.name);
  expect(promotionDetail?.before?.grade).toBe(original.name);
  expect((await informationCorrectionHistory(adminCtx(b),id))[0].payload).toMatchObject({afterLabels:{gradeId:original.name}});
 });
 it('retains original contract type and end date without replacing the later type',async()=>{
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:'2026-03-01',employmentType:'part_time'});
  await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{employmentType:'contract'},endDates:{contractEndDate:'2026-02-28'},reason:'Correct fictional original contract'});
  const rows=await movementHistory(adminCtx(b),id),hire=rows.find(row=>row.kind==='hired')!,later=rows.find(row=>row.kind==='transfer')!;
  const detail=await movementDetail(adminCtx(b),id,hire.id);
  expect(detail?.after.employmentType).toBe('contract');
  expect(detail?.after.informationEvidence?.contractEndDate.value).toBe('2026-02-28');
  const laterDetail=await movementDetail(adminCtx(b),id,later.id);
  expect(laterDetail?.after.employmentType).toBe('part_time');
  expect(laterDetail?.before?.employmentType).toBe('contract');
 });
});
