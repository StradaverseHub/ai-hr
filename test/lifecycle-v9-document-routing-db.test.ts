import {beforeEach,afterAll,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9DocumentSigningWorkspace,v9ReadDocumentSigningWork,v9DocumentRouteAct,v9DocumentRouteEdit,v9Sweep,v9OwnWork} from '../packs/lifecycle/service';
import {v9SigningCanonicalText,v9DocumentSigningContent,recordV9DocumentRouteAction} from '../lib/lifecycle-v9-document-routing';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
let base: Base, admin: SessionContext, employee: SessionContext, other: SessionContext, employmentId: string;
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'V9 subject', primaryEmail: 'subject@test.invalid', phone: '+60123456789' } });
  employmentId = subject.employmentId;
  employee = { ...admin, userId: await createAppUser(base.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: undefined };
  const stranger = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Unrelated employee', primaryEmail: 'stranger@test.invalid' } });
  other = { ...employee, userId: await createAppUser(base.tenantId, stranger.personId, 'employee'), personId: stranger.personId };
  await v9Setup(admin);
});
afterAll(closeAll);

async function prepared(){
 const config=(await v9Workspace(admin)).config!;
 config.checklists=[{id:'route-checklist',name:'Signing tasks',module:'off',rules:{},tasks:['signed','completed','sent'].map(documentAction=>({id:documentAction,name:documentAction,by:'employee' as const,group:null,mode:'manual' as const,opens:null,due:0,required:true,documentTemplate:'route-form',documentAction:documentAction as 'signed'|'completed'|'sent'}))}];
 config.templates=[{id:'route-form',name:'Frozen handover',module:'off',type:'Form',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:[{id:'answer',label:'Employee answer',type:'text',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'',when:null}],blocks:[{id:'wording',type:'text',text:'Handover record',section:''},{id:'hr-block',type:'signature',text:'',section:'',role:'step:hr-sign'},{id:'employee-block',type:'signature',text:'',section:'',role:'step:employee-sign'}],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[admin.userId!]},owner:true},{id:'hr-sign',order:2,action:'sign',who:{kind:'people',userIds:[admin.userId!]},owner:false},{id:'employee-sign',order:3,action:'sign',who:{kind:'employee'},owner:false}]}]}];
 config.workflows=[{id:'route-release',name:'Generate and release',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'generate',type:'doc',template:'route-form',release:true},{id:'wait',type:'waitSign',template:'route-form',by:'employee'}],description:''},{id:'route-completed',name:'Signature recorded',module:'off',status:'published',trigger:{event:'docSigned',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',subject:'Handover signed',body:'The saved handover is signed.',to:['employee'],cc:[]}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay:'2026-12-01'});await v9Command(admin,id,1,{type:'submit'});
 const c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;return {id,docId:c.documents[0].id};
}
async function act(ctx:SessionContext,id:string,docId:string,stepId:string,action:'reviewed'|'signed'|'returned'|'resent',comment=''){
 const item=await v9ReadDocumentSigningWork(ctx,id,docId);return v9DocumentRouteAct(ctx,{caseId:id,caseRevision:item.caseRevision,documentId:docId,stepId,action,contentHash:item.signing.contentHash,contentRevision:item.signing.contentRevision,comment,...(action==='signed'?{signature:{method:'typed' as const,value:ctx.userId!,consent:true as const}}:{})});
}
it('uses one saved document for private participant preparation, locks exact content, and synchronizes linked tasks and source workflows once',async()=>{
 const {id,docId}=await prepared();const initial=await v9ReadDocumentSigningWork(employee,id,docId);expect(initial.document?.sentAt).toBeNull();expect(initial.document?.fields).toHaveLength(1);
 expect((await v9DocumentSigningWorkspace(other)).items).toEqual([]);await expect(v9ReadDocumentSigningWork(other,id,docId)).rejects.toThrow();
 expect(await withTenant(employee,tx=>tx.execute(sql`select id from lc_v9_case where id=${id}::uuid`))).toEqual([]);
 await expect(act(employee,id,docId,'employee-sign','signed')).rejects.toThrow();
 await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:initial.caseRevision,documentId:docId,values:{answer:'All handover complete'}});
 let item=await act(admin,id,docId,'review','reviewed');const sqlHash=await withTenant(admin,tx=>tx.execute<{hash:string}>(sql`select app.v9_document_content_hash(${JSON.stringify(item.document)}::jsonb) as hash`));expect(sqlHash[0].hash).toBe(createHash('sha256').update(v9SigningCanonicalText(v9DocumentSigningContent(item.document!))).digest('hex'));
 item=await act(admin,id,docId,'hr-sign','signed');await expect(v9DocumentRouteEdit(admin,{caseId:id,caseRevision:item.caseRevision,documentId:docId,edits:{wording:'Changed after signing'}})).rejects.toThrow();
 item=await act(employee,id,docId,'employee-sign','signed');expect(item.document?.status).toBe('signed');expect(item.signing.actions).toHaveLength(3);
 let c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;expect(c.tasks.filter(t=>t.id==='signed'||t.id==='completed').every(t=>t.status==='done')).toBe(true);expect(c.tasks.find(t=>t.id==='sent')?.status).toBe('todo');
 await v9Sweep({...admin,userId:undefined},owner,new Date('2026-11-18T01:00:00Z'));await v9Sweep({...admin,userId:undefined},owner,new Date('2026-11-18T01:00:00Z'));
 c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;expect(c.documents).toHaveLength(1);expect(c.documents[0].id).toBe(docId);expect(c.runs.filter(r=>r.sourceEvent?.sourceId===docId)).toHaveLength(1);expect(c.mails.filter(m=>m.workflowId==='route-completed')).toHaveLength(1);
});
it('independently rejects forged actor or immutable history through the existing scoped case writer, and send-back immediately invalidates signatures',async()=>{
 const {id,docId}=await prepared();let item=await v9ReadDocumentSigningWork(employee,id,docId);await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:item.caseRevision,documentId:docId,values:{answer:'Complete'}});await act(admin,id,docId,'review','reviewed');item=await act(admin,id,docId,'hr-sign','signed');
 const c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!,forged=structuredClone(c);recordV9DocumentRouteAction(forged.documents[0],{id:randomUUID(),stepId:'employee-sign',revision:item.signing.contentRevision,hash:item.signing.contentHash,action:'signed',signature:{method:'typed',value:'Forged employee',consent:true}},{id:employee.userId!,personId:employee.personId!,name:'V9 subject'},new Date().toISOString());
 await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_case set data=${JSON.stringify(forged)}::jsonb where id=${id}::uuid`))).rejects.toThrow();
 item=await act(admin,id,docId,'hr-sign','returned','Please review the answers.');expect(item.document?.stepSignatures).toEqual({});expect(item.signing.actions).toHaveLength(3);
 await expect(act(employee,id,docId,'employee-sign','resent')).rejects.toThrow();item=await act(admin,id,docId,'review','resent');expect(item.signing.actions).toHaveLength(4);expect(item.document?.status).toBe('draft');
});
