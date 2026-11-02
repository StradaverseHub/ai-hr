/** Native Attendance timing only: real writes, unchanged security/locking/audit owners. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as tenantDb from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as events from '../db/events';
import * as punchOwner from '../core/attendance-punch-change';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {verifyTenantChain} from '../core/audit-chain';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED;
beforeAll(async()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';await migrateTestDb();});
afterAll(async()=>{await closeAll();if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;});
it('profiles the native callback after the first observed service audit append across12 distinct final approvals',async()=>{
 await resetDb();const bases=[await seedBase(),await seedBase()];
 const today=todayInKualaLumpur(),prior=new Date(today+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-7);prior.setUTCDate(prior.getUTCDate()+3-prior.getUTCDay());const on=prior.toISOString().slice(0,10);
 async function actor(b:Base,role:'employee'|'hr_admin'){
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional audit span '+role,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const ctx:SessionContext={...adminCtx(b),userId:await createAppUser(b.tenantId,hired.personId,role),personId:hired.personId,roles:[role],grants:[{role,companyId:b.companyId}]};return{...hired,ctx};
 }
 const cases=[];
 for(let i=0;i<6;i++)for(const b of bases){
  const root=adminCtx(b),worker=await actor(b,'employee'),hr=await actor(b,'hr_admin');
  await saveAttendanceWorkflow(root,{companyId:b.companyId,applicationType:'irregularity',routingVersion:4,code:'SPAN'+i,name:'Fictional audit span '+i,priority:100+i,active:true,criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Real final HR',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[hr.employmentId]}],hrAlternative:false}],cc:[]});
  await setAttendanceWorkflowEnabled(root,b.companyId,'irregularity',true);
  await checkIn(root,{employmentId:worker.employmentId,date:on,time:'08:00',manual:true});await checkOut(root,{employmentId:worker.employmentId,date:on,time:'17:00',manual:true});
  const request=await requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:on,checkIn:'09:00',checkOut:'18:00',reason:'Fictional real audit span probe'});
  cases.push({b,worker,hr,id:request.correctionId});
 }
 const role=await tenantDb.withTenant(cases[0].hr.ctx,tx=>tx.execute(sql`select current_user as role`));expect(role[0].role).toBe('ai_hr_app');
 type Trace={start:number;callbackStart:number;callbackEnd:number;commitEnd:number;firstBefore?:number;firstAfter?:number;firstType?:string;punchStart?:number;punchEnd?:number;events:number;failed:boolean};
 const traces:Trace[]=[],byTx=new WeakMap<Tx,Trace>(),realTenant=tenantDb.withTenant,realAppend=events.appendEvent,realBatch=events.appendEvents,realPunch=punchOwner.applyClockChangesTx;
 const observe:typeof realTenant=async<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>{
  const t:Trace={start:performance.now(),callbackStart:0,callbackEnd:0,commitEnd:0,events:0,failed:false};
  try{return await realTenant(ctx,async tx=>{t.callbackStart=performance.now();byTx.set(tx,t);try{return await read(tx);}finally{t.callbackEnd=performance.now();}},options);}
  catch(error){t.failed=true;throw error;}
  finally{t.commitEnd=performance.now();traces.push(t);}
 };
 const tenantSpy=vi.spyOn(tenantDb,'withTenant').mockImplementation(observe);
 const appendSpy=vi.spyOn(events,'appendEvent').mockImplementation((async(tx:Tx,event:events.AppendEventArgs,options?:{returnId:boolean})=>{
  const t=byTx.get(tx),first=t?.firstBefore===undefined;
  if(t){t.events++;if(first){t.firstBefore=performance.now();t.firstType=event.eventType;}}
  const result=options?await realAppend(tx,event,options):await realAppend(tx,event);
  if(t&&first)t.firstAfter=performance.now();return result;
 })as typeof realAppend);
 const batchSpy=vi.spyOn(events,'appendEvents').mockImplementation(async(tx,items)=>{
  const t=byTx.get(tx),first=t?.firstBefore===undefined;
  if(t&&items.length){t.events+=items.length;if(first){t.firstBefore=performance.now();t.firstType=items[0].eventType;}}
  const result=await realBatch(tx,items);if(t&&first&&items.length)t.firstAfter=performance.now();return result;
 });
 const punchSpy=vi.spyOn(punchOwner,'applyClockChangesTx').mockImplementation(async(...args)=>{
  const t=byTx.get(args[0]);if(t)t.punchStart=performance.now();
  try{return await realPunch(...args);}finally{if(t)t.punchEnd=performance.now();}
 });
 let settled:PromiseSettledResult<unknown>[];
 try{settled=await Promise.allSettled(cases.map(c=>decideAttendanceCorrection(c.hr.ctx,{correctionId:c.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'})));}
 finally{punchSpy.mockRestore();batchSpy.mockRestore();appendSpy.mockRestore();tenantSpy.mockRestore();}
 const failures=settled.filter(x=>x.status==='rejected').map(x=>String((x as PromiseRejectedResult).reason));
 const spans=traces.map(t=>({admissionMs:t.callbackStart-t.start,callbackMs:t.callbackEnd-t.callbackStart,settlementMs:t.commitEnd-t.callbackEnd,firstObservedServiceAppendWaitAndSqlMs:t.firstAfter===undefined||t.firstBefore===undefined?null:t.firstAfter-t.firstBefore,postFirstObservedServiceAppendCallbackMs:t.firstAfter===undefined?null:t.callbackEnd-t.firstAfter,punchOwnerMs:t.punchEnd===undefined||t.punchStart===undefined?null:t.punchEnd-t.punchStart,postFirstAppendToPunchOwnerExitMs:t.punchEnd===undefined||t.firstAfter===undefined?null:t.punchEnd-t.firstAfter,postPunchOwnerCallbackMs:t.punchEnd===undefined?null:t.callbackEnd-t.punchEnd,firstEventType:t.firstType??null,events:t.events,failed:t.failed}));
 const audit=[];for(const b of bases)audit.push(await verifyTenantChain(adminCtx(b)));
 const report={kind:'NATIVE_AUDIT_SPAN_DIAGNOSTIC_NOT_CAPACITY_OR_PURE_LOCK_TIME',cases:cases.length,tenants:2,failures,spans,audit,limitations:'First service append can follow earlier native audit writes. Admission includes BEGIN; append includes wait+SQL; post-append callback includes SQL/client work; settlement includes commit and response. No deliberate delay or changed control.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/attendance-audit-spans.json',JSON.stringify(report));
 expect(failures).toEqual([]);expect(spans.filter(t=>t.firstEventType!==null)).toHaveLength(cases.length);expect(spans.filter(t=>t.punchOwnerMs!==null)).toHaveLength(cases.length);
 for(const c of cases){
  const [cor]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,c.id));expect(cor.status).toBe('approved');
  const [day]=await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId,c.worker.employmentId),eq(s.attendance.attendanceDate,on)));expect(day).toMatchObject({checkInAt:'09:00:00',checkOutAt:'18:00:00'});
  const effect=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,c.id),eq(s.domainEvent.eventType,'attendance-correction.effect.recorded')));expect(effect).toHaveLength(1);expect(effect[0].chainSeq).not.toBeNull();
 }
 expect(audit.every(a=>a.valid)).toBe(true);
},240000);
