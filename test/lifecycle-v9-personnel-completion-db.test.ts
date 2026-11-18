import {afterAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {hireEmployee,updatePersonProfilePartial} from '../core/org';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9OwnWork,v9OwnDocument,v9SubmitOwnDocumentCompletion,v9RefreshOwnDocumentCompletion,v9DownloadDocument,v9ReadPersonnelCompletion,v9ReadDocumentSigningWork,v9DocumentRouteEdit,v9DocumentRouteAct} from '../packs/lifecycle/service';
import {effectivePersonnelCompletion,personnelCompletionClassification} from '../lib/lifecycle-v9-personnel-completion';
import type {Document,Field} from '../lib/lifecycle-v9-model';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
let b:Base,hr:SessionContext,employee:SessionContext,outsider:SessionContext,employmentId:string;
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');hr=await entitledCtx(b);
 const actualHR=await hireEmployee(hr,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Synthetic completion HR',primaryEmail:'completion-hr@example.invalid'}});
 await owner.withTenant(hr,tx=>tx.execute(sql`update app_user set person_id=${actualHR.personId}::uuid where id=${hr.userId!}::uuid and tenant_id=${b.tenantId}::uuid`));hr={...hr,personId:actualHR.personId};
 const subject=await hireEmployee(hr,{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Synthetic completion subject',primaryEmail:'completion-subject@example.invalid'}});employmentId=subject.employmentId;
 employee={...hr,userId:await createAppUser(b.tenantId,subject.personId,'employee'),personId:subject.personId,roles:['employee'],grants:undefined};
 const other=await hireEmployee(hr,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Unrelated completion subject',primaryEmail:'unrelated-completion@example.invalid'}});outsider={...employee,userId:await createAppUser(b.tenantId,other.personId,'employee'),personId:other.personId};await v9Setup(hr);
});afterAll(closeAll);
async function prepared(all=false,routed=false){
 const config=(await v9Workspace(hr)).config!,keys=all?[...Object.keys(personnelCompletionClassification),'unknown.future']:['address','employee.name'];
 const fields:Field[]=keys.map((key,index)=>({id:'F'+index,label:key,type:key==='homePhone'||key==='mobile'?'phone':key==='personalEmail'||key==='email'?'email':['joiner.joinDate','leaver.lastDay'].includes(key)?'date':'text',owner:'pmLocked',pmKey:key,required:key==='address',sensitive:false,options:[],section:'main',when:null}));
 config.templates=[{id:'completion-form',name:'Synthetic completion form',module:'off',type:'Form',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields,blocks:[{id:'private-wording',type:'text',text:'Private unreleased wording: {employee.name}. Address: {address}',section:'main'},{id:'answers',type:'fields',text:'',section:'main'}]}]}];
 if(routed){config.templates[0].versions[0].routing=[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[hr.userId!]},owner:true},{id:'employee-sign',order:2,action:'sign',who:{kind:'employee'},owner:false}];config.templates[0].versions[0].blocks.push({id:'employee-signature',type:'signature',role:'step:employee-sign',text:'',section:'main'});}
 config.companies=[{companyId:b.companyId,signatoryUserId:hr.userId!,signatoryTitle:'Synthetic HR'}];
 config.workflows=[{id:'completion-release',name:'Synthetic completion release',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],description:'',steps:[{id:'form',type:'doc',template:'completion-form',release:true}]}];
 config.checklists=[{id:'completion-tasks',name:'Completion tasks',module:'off',rules:{},tasks:[{id:'sent',name:'Document sent',by:'employee',group:null,mode:'manual',opens:null,due:0,required:true,documentTemplate:'completion-form',documentAction:'sent'}]}];
 await v9SaveConfig(hr,config.revision,config);const id=await v9CreateOffboarding(hr,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay:'2026-12-01'});await v9Command(hr,id,1,{type:'submit'});const c=(await v9Workspace(hr)).cases.find(c=>c.id===id)!;return {id,document:c.documents[0],fields};
}
async function current(id:string){return (await v9Workspace(hr)).cases.find(c=>c.id===id)!;}
it('applies all20 classifications, keeps unknown fields with HR, and exposes field-only unsigned preparation without task/PDF/private-wording authority',async()=>{
 const {id,document,fields}=await prepared(true);expect(document.personnelCompletion?.classification).toBe('2026-11-18');expect(Object.keys(document.personnelCompletion!.fields)).toHaveLength(21);
 expect(document.fields.every(field=>field.owner==='pmLocked')).toBe(true);expect(document.sentAt).toBeNull();expect((await current(id)).tasks[0].status).toBe('todo');
 const own=(await v9OwnWork(employee)).find(c=>c.id===id)!,projected=own.documents[0];expect(projected.blocks.every(block=>['field','fields'].includes(block.type))).toBe(true);expect(JSON.stringify(projected)).not.toContain('Private unreleased wording');expect(projected.mergeValues).toEqual({});
 expect(projected.fields.every(field=>effectivePersonnelCompletion(projected,field)==='employee'||document.personnelCompletion!.fields[field.id].group==='personal')).toBe(true);
 expect(await v9ReadPersonnelCompletion(outsider,{caseId:id,documentId:document.id})).toBeNull();await expect(v9DownloadDocument(employee,id,document.id)).rejects.toThrow();
 const unknown=fields.find(field=>field.pmKey==='unknown.future')!;await expect(v9Command(hr,id,(await current(id)).revision,{type:'documentCompletionOverride',id:document.id,fieldId:unknown.id,owner:'employee',reason:'Unknown key remains held'})).rejects.toThrow();
});
it('keeps the official source locked, reconciles a PM arrival before employee submission, and preserves the conflicting draft without proposing it',async()=>{
 const {id,document}=await prepared();await v9OwnDocument(employee,{caseId:id,revision:(await current(id)).revision,documentId:document.id,values:{F0:'Saved employee draft'}});
 // Use the canonical structured-address writer; the document source must agree with Personnel’s existing fallback owner.
 await updatePersonProfilePartial(hr,{personId:employee.personId!,permanentAddressLine1:'Official source arrived'});
 await v9SubmitOwnDocumentCompletion(employee,{caseId:id,revision:(await current(id)).revision,documentId:document.id,values:{}});
 const c=await current(id),d=c.documents[0];expect(d.values.F0).toBe('Official source arrived');expect(d.personnelCompletion!.fields.F0.conflict?.draft).toBe('Saved employee draft');expect(c.pmChanges).toEqual([]);
 await expect(v9OwnDocument(employee,{caseId:id,revision:c.revision,documentId:document.id,values:{F0:'Forged overwrite'}})).rejects.toThrow();
});
it('supersedes a stale employee proposal on edit or HR takeover and never attributes the HR replacement to the preserved draft',async()=>{
 const {id,document}=await prepared();const submit=async(value:string)=>v9SubmitOwnDocumentCompletion(employee,{caseId:id,revision:(await current(id)).revision,documentId:document.id,values:{F0:value}});
 await submit('Employee answer A');await submit('Employee answer B');let c=await current(id);expect(c.pmChanges.filter(change=>change.status==='proposed').map(change=>change.after)).toEqual(['Employee answer B']);expect(c.pmChanges.find(change=>change.after==='Employee answer A')?.status).toBe('rejected');
 await v9Command(hr,id,c.revision,{type:'documentCompletionOverride',id:document.id,fieldId:'F0',owner:'hr',reason:'HR verified a replacement'});c=await current(id);expect(c.pmChanges.every(change=>change.status==='rejected')).toBe(true);
 await v9Command(hr,id,c.revision,{type:'documentSave',id:document.id,values:{F0:'HR replacement'}});c=await current(id);expect(c.documents[0].personnelCompletion!.fields.F0.answer).toMatchObject({owner:'hr',by:{id:hr.userId}});expect(c.documents[0].personnelCompletion!.fields.F0.draft?.by.id).toBe(employee.userId);expect(c.pmChanges.every(change=>change.status==='rejected')).toBe(true);
});
it('rejects direct SQL forged policies, required ownership changes, missing audit timestamps, signed-history deletion and signature downgrades',async()=>{
 const {id,document}=await prepared();let c=await current(id);
 const forge=async(next:typeof c)=>withTenant(hr,tx=>tx.execute(sql`update lc_v9_case set data=${JSON.stringify(next)}::jsonb where id=${id}::uuid and tenant_id=${b.tenantId}::uuid`));
 for(const mutation of [(d:Document)=>{d.hrSignature={method:'typed',value:'Synthetic completion HR',consent:true,by:{id:hr.userId!,name:'Synthetic completion HR'},at:new Date().toISOString()};d.status='hrsigned';},(d:Document)=>{d.personnelCompletion!.fields.F0.sourceValue='Forged official';},(d:Document)=>{d.fields[0].required=false;},(d:Document)=>{d.personnelCompletion!.fields.F0.override={owner:'hr',by:{id:hr.userId!,name:'Synthetic completion HR'},at:new Date().toISOString(),reason:'Forged direct command'};}]){const next=structuredClone(c);mutation(next.documents[0]);await expect(forge(next)).rejects.toThrow();}
 const missingTimestamp=structuredClone(c),forgedInitial=structuredClone(document);forgedInitial.id='forged-initial-document';delete (forgedInitial.personnelCompletion as unknown as Record<string,unknown>).adoptedAt;missingTimestamp.documents.push(forgedInitial);await expect(forge(missingTimestamp)).rejects.toThrow();
 await v9SubmitOwnDocumentCompletion(employee,{caseId:id,revision:c.revision,documentId:document.id,values:{F0:'Submitted address'}});c=await current(id);
 await v9Command(hr,id,c.revision,{type:'documentSign',id:document.id,signature:{method:'typed',value:'Synthetic completion HR',consent:true}});c=await current(id);
 for(const mutation of [(next:typeof c)=>{next.documents=[];},(next:typeof c)=>{next.documents[0].hrSignature=null;next.documents[0].status='draft';},(next:typeof c)=>{next.documents[0].values.F0='Changed after signing';}]){const next=structuredClone(c);mutation(next);await expect(forge(next)).rejects.toThrow();}
});
it('enforces lifecycle entitlement at direct SQL read/update boundaries and rejects malformed override owners',async()=>{
 const {id,document}=await prepared();const c=await current(id);
 await expect(withTenant(hr,tx=>tx.execute(sql`select app.v9_personnel_completion_update(${id}::uuid,${c.revision},${document.id},'{}'::jsonb,'override',${JSON.stringify({fieldId:'F0',reason:'Malformed owner'})}::jsonb)`))).rejects.toThrow();
 await setModule(b.tenantId,'lifecycle','suspended');const [row]=await withTenant(employee,tx=>tx.execute<{document:unknown}>(sql`select app.v9_personnel_completion_read(${id}::uuid,${document.id}) as document`));expect(row.document).toBeNull();
 await expect(withTenant(employee,tx=>tx.execute(sql`select app.v9_personnel_completion_update(${id}::uuid,${c.revision},${document.id},'{}'::jsonb,'refresh',NULL)`))).rejects.toThrow();
});

it('uses the same protected completion command and content hash through an explicitly routed document',async()=>{
 const {id,document}=await prepared(false,true);let work=await v9ReadDocumentSigningWork(employee,id,document.id);
 await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:work.caseRevision,documentId:document.id,values:{F0:'Routed employee answer'}});
 await v9SubmitOwnDocumentCompletion(employee,{caseId:id,revision:(await current(id)).revision,documentId:document.id,values:{}});
 work=await v9ReadDocumentSigningWork(hr,id,document.id);
 await v9DocumentRouteAct(hr,{caseId:id,caseRevision:work.caseRevision,documentId:document.id,contentHash:work.signing.contentHash,contentRevision:work.signing.contentRevision,stepId:'review',action:'reviewed'});
 work=await v9ReadDocumentSigningWork(employee,id,document.id);
 await v9DocumentRouteAct(employee,{caseId:id,caseRevision:work.caseRevision,documentId:document.id,contentHash:work.signing.contentHash,contentRevision:work.signing.contentRevision,stepId:'employee-sign',action:'signed',signature:{method:'typed',value:'Synthetic completion subject',consent:true}});
 const c=await current(id);expect(c.documents[0].status).toBe('signed');expect(c.documents[0].values.F0).toBe('Routed employee answer');expect(c.pmChanges.filter(change=>change.status==='proposed')).toMatchObject([{field:'address',after:'Routed employee answer',provenance:{by:{id:employee.userId}}}]);
 await expect(v9DocumentRouteEdit(employee,{caseId:id,caseRevision:c.revision,documentId:document.id,values:{F0:'Changed after signing'}})).rejects.toThrow();
});
