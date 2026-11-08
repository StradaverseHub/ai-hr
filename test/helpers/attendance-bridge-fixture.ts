/** Canonical fictional fixture shared by native controls and the isolated owner worker. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {checkIn,checkOut,requestAttendanceCorrection} from '../../core/attendance';
import {prepareAttendanceWorkflowSnapshotTx,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../core/attendance-workflow';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,createAppUser,owner,type Base} from '../harness';
export type BridgeStep=<T>(action:()=>PromiseLike<T>)=>Promise<T>;
export async function attendanceBridgeFixture(b:Base,step:BridgeStep=action=>Promise.resolve(action())){
 const root=adminCtx(b);
 async function actor(name:string){const hired=await step(()=>hireEmployee(root,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));const userId=await step(()=>createAppUser(b.tenantId,hired.personId,'employee'));return{...hired,ctx:{...root,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]}satisfies SessionContext};}
 const worker=await actor('Fictional shared submission'),reviewer=await actor('Fictional frozen reviewer');
 const [other]=await step(()=>owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second workflow company'}).returning());
 const template=await step(()=>saveAttendanceWorkflow(root,{companyId:b.companyId,companyIds:[b.companyId,other.id],applicationType:'irregularity',routingVersion:4,code:'BRIDGE_SHARED',name:'Immutable shared route',priority:1,active:true,criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}],cc:[]}));
 const ids:string[]=[];
 for(let index=0;index<2;index++){
  const date=new Date(todayInKualaLumpur()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-index);const on=date.toISOString().slice(0,10);
  await step(()=>checkIn(root,{employmentId:worker.employmentId,date:on,time:'08:00',manual:true}));await step(()=>checkOut(root,{employmentId:worker.employmentId,date:on,time:'17:00',manual:true}));
  ids.push((await step(()=>requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:on,checkIn:'09:00',checkOut:'18:00',reason:'Fictional native trigger proof'}))).correctionId);
 }
 await step(()=>setAttendanceWorkflowEnabled(root,b.companyId,'irregularity',true));
 const prepared=await step(()=>withTenant(worker.ctx,tx=>prepareAttendanceWorkflowSnapshotTx(tx,worker.ctx,worker.employmentId,'irregularity')));
 if(!prepared)throw Error('Nonempty actual canonical workflow snapshot required');
 assert.equal(prepared.selected.id,template.id);
 assert.deepEqual(await step(()=>owner.db.select({id:s.attendanceWorkflowRequest.id}).from(s.attendanceWorkflowRequest).where(inArray(s.attendanceWorkflowRequest.correctionId,ids))),[]);
 const values=(id:string)=>({tenantId:b.tenantId,correctionId:id,employmentId:worker.employmentId,companyId:b.companyId,templateId:prepared.selected.id,templateCode:prepared.selected.code,templateName:prepared.selected.name,templateVersion:prepared.selected.version,applicationType:'irregularity' as const,routingVersion:prepared.validated.routingVersion,stages:prepared.stages,cc:prepared.cc});
 return{root,worker,reviewer,template,other,ids,values,key:b.tenantId+':attendance-workflow:'+b.companyId+':irregularity'};
}
