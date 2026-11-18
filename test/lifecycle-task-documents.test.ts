import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9OwnDocument,lifecycleTaskDocuments,openOwnLifecycleDocument} from '../packs/lifecycle/service';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {currentTaskDocument} from '../lib/lifecycle-task-documents';
let b:Base,admin:SessionContext,employee:SessionContext,other:SessionContext,employmentId:string;
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const subject=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Document owner',primaryEmail:'document-owner@test.invalid'}});employmentId=subject.employmentId;
 employee={...admin,userId:await createAppUser(b.tenantId,subject.personId,'employee'),personId:subject.personId,roles:['employee'],grants:undefined};
 const stranger=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Other employee',primaryEmail:'document-other@test.invalid'}});
 other={...employee,userId:await createAppUser(b.tenantId,stranger.personId,'employee'),personId:stranger.personId};await v9Setup(admin);
});
afterAll(closeAll);
async function prepared(release=true){
 const config=(await v9Workspace(admin)).config!;
 config.templates.push({id:'document-task-form',name:'Saved acceptance',type:'Form',module:'off',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'body',type:'text',text:'Saved form',section:''}],fields:[]}]});
 config.checklists=[...config.checklists.filter(c=>c.module==='onb'),{id:'doc-checklist',name:'Exit document checklist',module:'off',rules:{},tasks:[{id:'acceptance-task',name:'Accept saved form',by:'employee',group:null,mode:'manual',opens:null,due:0,required:true,documentTemplate:'document-task-form',documentAction:'signed'}]}];
 config.workflows=[{id:'release-document',name:'Release saved document',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'doc',type:'doc',template:'document-task-form',release}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay:'2027-12-01'});await v9Command(admin,id,1,{type:'submit'});
 return (await v9Workspace(admin)).cases.find(c=>c.id===id)!;
}
it('opens the exact released instance, retains answers, progresses only unfinished tasks and is idempotent',async()=>{
 const c=await prepared(),doc=c.documents[0],before=structuredClone(doc);
 const page=await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]});
 expect(page.total).toBe(1);expect(page.items[0]).toMatchObject({documentId:doc.id,state:'released',sourceName:'Exit document checklist',sourceKind:'checklist',taskStatus:'todo',documentStatus:'sent'});
 expect(JSON.stringify(page)).not.toContain('mergeValues');expect(JSON.stringify(page)).not.toContain('fields');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision});
 const opened=(await v9Workspace(admin)).cases.find(x=>x.id===c.id)!;
 expect(opened.documents).toHaveLength(1);expect(opened.documents[0]).toEqual({...before,status:'opened'});expect(opened.tasks[0].status).toBe('progress');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision});
 expect((await v9Workspace(admin)).cases.find(x=>x.id===c.id)!.revision).toBe(opened.revision);
 await v9OwnDocument(employee,{caseId:c.id,documentId:doc.id,revision:opened.revision,values:{},signature:{method:'typed',value:'Document owner',consent:true}});
 const completed=(await v9Workspace(admin)).cases.find(x=>x.id===c.id)!;expect(completed.tasks[0].status).toBe('done');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:1});
 expect((await v9Workspace(admin)).cases.find(x=>x.id===c.id)!.revision).toBe(completed.revision);
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).items[0]).toMatchObject({taskStatus:'done',documentStatus:'signed'});
});
it('shows an unreleased task without identity and refuses draft, stranger, company and tenant access',async()=>{
 const c=await prepared(false),doc=c.documents[0];
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).items[0]).toMatchObject({state:'unreleased',documentId:null});
 expect((await lifecycleTaskDocuments(employee,{companyIds:[]})).total).toBe(0);
 expect((await lifecycleTaskDocuments(other,{companyIds:[b.companyId]})).total).toBe(0);
 await expect(openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 await expect(openOwnLifecycleDocument(other,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 const foreign=await seedBase();expect((await lifecycleTaskDocuments({...employee,tenantId:foreign.tenantId},{companyIds:[b.companyId]})).total).toBe(0);
});
it('holds duplicate live instances and replacement links never carry over a superseded identity',async()=>{
 const c=await prepared(),doc=c.documents[0],replacement={...doc,id:randomUUID(),version:2,createdAt:'2026-11-18T12:00:00Z'};
 await owner.client`update lc_v9_case set data=jsonb_set(data,'{documents}',${JSON.stringify([doc,replacement])}::jsonb) where id=${c.id}::uuid`;
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).items[0]).toMatchObject({state:'review',documentId:null});
 await expect(openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 await owner.client`update lc_v9_case set data=jsonb_set(data,'{documents}',${JSON.stringify([{...doc,status:'superseded',supersededBy:replacement.id},replacement])}::jsonb) where id=${c.id}::uuid`;
 const page=await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]});expect(page.items[0].documentId).toBe(replacement.id);
 await expect(openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 expect(currentTaskDocument([doc,replacement],doc.templateId).state).toBe('review');
 const [sqlChoice]=await withTenant(employee,tx=>tx.execute<{choice:{state:string;documentId:string}}>(sql`select app.lifecycle_task_document(${JSON.stringify([{...doc,status:'superseded'},replacement])}::jsonb,${doc.templateId}) as choice`));
 expect(sqlChoice.choice.documentId).toBe(currentTaskDocument([{...doc,status:'superseded'},replacement],doc.templateId).document!.id);
});
