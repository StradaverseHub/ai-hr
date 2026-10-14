import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {sql} from 'drizzle-orm';
import {createBatch,generatePayslips} from '../packs/payroll/service';
import {setCompensation} from '../core/comp';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {checkIn,checkOut,requestOwnClockRemoval,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {captureEmployeeClock,clockCaptureEvidence} from '../core/attendance-clock';
import {ownClockToday} from '../core/attendance-clock-read';
import {clockFingerprint} from '../core/attendance-punch-change';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {listAttendanceApplicationHistory,attendanceApplicationDetail} from '../core/attendance-application-history';
import {decideAttendanceHistorySelection} from '../packs/attendance/history-decisions';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
let b:Base;
const day=()=>todayInKualaLumpur(new Date(Date.now()-86400000));
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(name='Board attendance worker'){
  const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@board.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,e.personId,'employee');
  const self:SessionContext={...adminCtx(b),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await owner.db.update(s.employment).set({attendancePhotoSetting:'not_required',geofencingEnabled:false}).where(eq(s.employment.id,e.employmentId));
  return {e,self};
}
async function punches(employmentId:string){return owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,employmentId)).orderBy(s.attendancePunch.punchAt,s.attendancePunch.id);}
async function fixture(){
  const {e,self}=await worker(),a=adminCtx(b),date=day();
  await checkIn(a,{employmentId:e.employmentId,date,time:'08:00',manual:true});
  await checkOut(a,{employmentId:e.employmentId,date,time:'17:00',manual:true});
  const rows=await punches(e.employmentId);
  for(const row of rows){
    const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:date,direction:row.direction,requestId:randomUUID(),serverRecordedAt:new Date(`${date}T${row.punchAt}+08:00`),commandDigest:'a'.repeat(64)}).returning();
    await owner.db.update(s.attendancePunch).set({method:'web',clockCaptureId:capture.id}).where(eq(s.attendancePunch.id,row.id));
  }
  const input={punchId:rows.find(r=>r.direction==='out')!.id,requestId:randomUUID(),baseline:clockFingerprint(await punches(e.employmentId)),reason:'Accidental clock out',clockContext:clockCommandContext(b.tenantId,self.userId,e.employmentId)};
  return {e,self,a,date,input};
}
const record=async(id:string)=>(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,id)))[0];
describe('Own Web Clocking removal uses the existing approval owner',()=>{
  it('keeps pending punches active, deduplicates retries, then voids only the target with true actor history',async()=>{
    const {e,self,a,input}=await fixture(),before=await punches(e.employmentId);
    const first=await requestOwnClockRemoval(self,input);
    expect(await requestOwnClockRemoval(self,input)).toEqual(first);
    expect(await punches(e.employmentId)).toEqual(before);
    expect((await record(first.correctionId)).status).toBe('pending');
    await expect(decideAttendanceCorrection(self,{correctionId:first.correctionId,decision:'approved'})).rejects.toThrow(/own/);
    await decideAttendanceCorrection(a,{correctionId:first.correctionId,decision:'approved'});
    const after=await punches(e.employmentId);expect(after.filter(p=>p.voidedAt).map(p=>p.id)).toEqual([input.punchId]);
    expect(after.find(p=>p.id===input.punchId)?.voidedBy).toBe(a.userId);
    expect(await owner.db.select().from(s.attendanceClockCapture).where(eq(s.attendanceClockCapture.employmentId,e.employmentId))).toHaveLength(2);
    const detail=await attendanceApplicationDetail(a,[b.companyId],first.correctionId);
    expect(detail?.events.find(ev=>ev.eventType==='attendance-correction.requested')?.actorId).toBe(self.userId);
    expect(detail?.events.find(ev=>ev.eventType==='attendance.punch.voided')?.actorId).toBe(a.userId);
    expect(await requestOwnClockRemoval(self,input)).toEqual(first);
  });
  it('keeps evidence and calculations on rejection; requires a remark and refuses another pending request',async()=>{
    const {e,self,a,input}=await fixture(),before=await punches(e.employmentId);
    await expect(requestOwnClockRemoval(self,{...input,reason:' '})).rejects.toThrow(/remark/);
    const first=await requestOwnClockRemoval(self,input);
    await expect(requestOwnClockRemoval(self,{...input,requestId:randomUUID()})).rejects.toThrow();
    await decideAttendanceCorrection(a,{correctionId:first.correctionId,decision:'rejected',rejectReason:'Clock out was correct'});
    expect(await punches(e.employmentId)).toEqual(before);
  });
  it('refuses foreign employees, another tenant, account switches, altered retry and stale snapshots',async()=>{
    const {self,input}=await fixture(),other=await worker('Other person');
    await expect(requestOwnClockRemoval(other.self,{...input,clockContext:clockCommandContext(b.tenantId,other.self.userId,other.e.employmentId)})).rejects.toThrow();
    await expect(requestOwnClockRemoval(self,{...input,clockContext:'0'.repeat(64)})).rejects.toThrow(/account/);
    await expect(requestOwnClockRemoval(self,{...input,baseline:'0'.repeat(64)})).rejects.toThrow(/changed/);
    const foreign=await seedBase();await expect(requestOwnClockRemoval({...self,tenantId:foreign.tenantId},input)).rejects.toThrow();
    await requestOwnClockRemoval(self,input);await expect(requestOwnClockRemoval(self,{...input,reason:'Different intent'})).rejects.toThrow(/identity/);
  });
  it('refuses removing a paired in and preserves the administrator-only arbitrary clock-set guard',async()=>{
    const {e,self,date,input}=await fixture(),rows=await punches(e.employmentId);
    await expect(requestOwnClockRemoval(self,{...input,punchId:rows.find(r=>r.direction==='in')!.id})).rejects.toThrow(/matching entry/);
    await expect(requestAttendanceCorrection(self,{employmentId:e.employmentId,date,reason:'Arbitrary self edit',clockChanges:{version:1,baseline:input.baseline,entries:[]}})).rejects.toThrow(/administrator/);
  });
  it('serializes concurrent submissions and refuses another change after final correction ownership',async()=>{
    const {self,a,input}=await fixture();
    const attempts=await Promise.allSettled([requestOwnClockRemoval(self,input),requestOwnClockRemoval(self,{...input,requestId:randomUUID()})]);
    expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(r=>r.status==='rejected')).toHaveLength(1);
    const winner=attempts.find(r=>r.status==='fulfilled')!;
    if(winner.status!=='fulfilled')throw Error('No successful request');
    await decideAttendanceCorrection(a,{correctionId:winner.value.correctionId,decision:'approved'});
    const original=await punches((await record(winner.value.correctionId)).employmentId);
    await expect(requestOwnClockRemoval(self,{...input,requestId:randomUUID(),punchId:original.find(p=>!p.voidedAt)!.id,baseline:clockFingerprint(original)})).rejects.toThrow(/owns this day/);
  });
  it('protects closed payroll on submission and approval without widening payroll visibility',async()=>{
    const {self,a,e,input}=await fixture();
    await setCompensation(a,{employmentId:e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
    const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:day().slice(0,7)});await generatePayslips(a,{batchId});
    const r=await requestOwnClockRemoval(self,input);
    await owner.db.update(s.payrollBatch).set({status:'closed'}).where(eq(s.payrollBatch.id,batchId));
    await expect(decideAttendanceCorrection(a,{correctionId:r.correctionId,decision:'approved'})).rejects.toThrow(/closed payroll/);
    await decideAttendanceCorrection(a,{correctionId:r.correctionId,decision:'rejected',rejectReason:'Payroll closed'});
    await expect(requestOwnClockRemoval(self,{...input,requestId:randomUUID()})).rejects.toThrow(/closed payroll/);
    await expect(withTenant(self,tx=>tx.execute(sql`select * from app.attendance_payroll_protection(${e.employmentId}::uuid)`))).rejects.toThrow();
    await expect(withTenant(self,tx=>tx.execute(sql`select * from app.attendance_payroll_protection_rows(${e.employmentId}::uuid)`))).rejects.toThrow();
    const other=await worker('Payroll other');await expect(withTenant(self,tx=>tx.execute(sql`select * from app.own_attendance_removal_payroll_protection(${other.e.employmentId}::uuid)`))).rejects.toThrow();
  });
  it('refuses a changed punch set at approval without a partial effect',async()=>{
    const {self,a,e,input}=await fixture();const r=await requestOwnClockRemoval(self,input);
    await owner.db.update(s.attendancePunch).set({punchAt:'17:10'}).where(eq(s.attendancePunch.id,input.punchId));
    await expect(decideAttendanceCorrection(a,{correctionId:r.correctionId,decision:'approved'})).rejects.toThrow(/changed/);
    expect((await record(r.correctionId)).status).toBe('pending');expect((await punches(e.employmentId)).every(p=>!p.voidedAt)).toBe(true);
  });
});
describe('Persisted clock location evidence',()=>{
  it.each(['denied','unavailable','timeout','unsupported'] as const)('retains %s independently of disabled geofencing and on retry',async locationStatus=>{
    const {e,self}=await worker(),input={action:'in' as const,requestId:randomUUID(),lat:null,lng:null,accuracy:null,locationStatus};
    const r=await captureEmployeeClock(self,input);expect(await captureEmployeeClock(self,input)).toEqual(r);
    const today=await ownClockToday(self);expect(today.captures[0]).toMatchObject({locationStatus,geofencingRequired:false,lat:null,lng:null});
    expect((await clockCaptureEvidence(adminCtx(b),[r.id])).get(r.id)?.locationStatus).toBe(locationStatus);
    await expect(captureEmployeeClock(self,{...input,locationStatus:locationStatus==='denied'?'timeout':'denied'})).rejects.toThrow(/different/);
  });
  it('refuses contradictory status and preserves actual coordinates',async()=>{
    const {self}=await worker(),input={action:'in' as const,requestId:randomUUID(),lat:3.12,lng:101.6,accuracy:6};
    await expect(captureEmployeeClock(self,{...input,locationStatus:'denied'})).rejects.toThrow(/agree/);
    await captureEmployeeClock(self,{...input,locationStatus:'recorded'});
    expect((await ownClockToday(self)).captures[0]).toMatchObject({lat:3.12,lng:101.6,accuracyM:6,locationStatus:'recorded',geofencingRequired:false});
  });
});
describe('History filters and independent current-stage decisions',()=>{
  it('uses stored historical subtype and separate attendance and submission dates',async()=>{
    const {e,self}=await worker(),date=day();
    const r=await requestAttendanceCorrection(self,{employmentId:e.employmentId,date,checkIn:'08:00',checkOut:'17:00',reason:'Missing entry',requestKind:'incomplete_entry'});
    const filter={employmentId:e.employmentId,requestKind:'incomplete_entry' as const,attendanceFrom:date,attendanceTo:date,submittedFrom:todayInKualaLumpur(),submittedTo:todayInKualaLumpur()};
    const result=await listAttendanceApplicationHistory(adminCtx(b),[b.companyId],filter);expect(result.total).toBe(1);expect(result.rows[0]).toMatchObject({id:r.correctionId,requestKind:'incomplete_entry'});
    expect((await listAttendanceApplicationHistory(adminCtx(b),[b.companyId],{...filter,requestKind:'absent'})).total).toBe(0);
    expect((await listAttendanceApplicationHistory(adminCtx(b),[b.companyId],{...filter,attendanceFrom:todayInKualaLumpur(),attendanceTo:todayInKualaLumpur()})).total).toBe(0);
    await owner.db.update(s.attendanceCorrection).set({requestKind:null}).where(eq(s.attendanceCorrection.id,r.correctionId));
    expect((await listAttendanceApplicationHistory(adminCtx(b),[b.companyId],{requestKind:'unknown'})).rows[0].requestKind).toBeNull();
  });
  it('advances each selected stage once, reports mixed outcomes and never treats a duplicate or retry as the next stage',async()=>{
    const {e,self}=await worker(),a=adminCtx(b);
    await saveAttendanceWorkflow(a,{companyId:b.companyId,code:'BOARD',name:'Two reviews',description:'',applicationType:'irregularity',priority:100,criteria:{},stages:[0,1].map(i=>({name:`Review ${i+1}`,level:{kind:'hr_admin',employmentId:null,alternates:[]}})),active:true});
    await setAttendanceWorkflowEnabled(a,b.companyId,'irregularity',true);
    const r=await requestAttendanceCorrection(self,{employmentId:e.employmentId,date:day(),checkIn:'08:00',checkOut:'17:00',reason:'Review entry'});
    const p={items:[{id:r.correctionId,stage:0},{id:r.correctionId,stage:0},{id:randomUUID(),stage:null}],decision:'approved' as const,reason:'Verified'};
    expect((await decideAttendanceHistorySelection(a,[b.companyId],p)).map(r=>r.status)).toEqual(['pending','failed','failed']);
    expect((await decideAttendanceHistorySelection(a,[b.companyId],{...p,items:[p.items[0]]}))[0].status).toBe('failed');
    expect((await record(r.correctionId)).status).toBe('pending');
    const detail=await attendanceApplicationDetail(a,[b.companyId],r.correctionId);expect(detail?.workflow?.decisions).toHaveLength(1);expect(detail?.workflow?.decisions[0].actualUserId).toBe(a.userId);
    expect((await decideAttendanceHistorySelection(a,[b.companyId],{items:[{id:r.correctionId,stage:1}],decision:'rejected',reason:'Needs correction'}))[0].status).toBe('rejected');
  });
  it('requires rejection remarks before processing any item and excludes self/unauthorized scope',async()=>{
    const {e,self}=await worker(),a=adminCtx(b),r=await requestAttendanceCorrection(self,{employmentId:e.employmentId,date:day(),checkIn:'08:00',reason:'Missing out'}),items=[{id:r.correctionId,stage:null}];
    await expect(decideAttendanceHistorySelection(a,[b.companyId],{items,decision:'rejected',reason:' '})).rejects.toThrow(/remarks/);
    expect((await decideAttendanceHistorySelection({...a,personId:e.personId},[b.companyId],{items,decision:'approved',reason:''}))[0].status).toBe('failed');
    expect((await decideAttendanceHistorySelection(a,[],{items,decision:'approved',reason:''}))[0].status).toBe('failed');expect((await record(r.correctionId)).status).toBe('pending');
  });
});
