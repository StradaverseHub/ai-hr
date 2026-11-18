import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,updatePersonProfilePartial} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {Document,Field,Workflow,Run,Case} from '../lib/lifecycle-v9-model';
import {addDays} from '../lib/lifecycle-v9-model';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {personnelCompletionRecoveryPage,requestPersonnelCompletionRecoveryPreview,readPersonnelCompletionRecoveryPreview,requestPersonnelCompletionRecovery,lifecyclePersonnelCompletionPreviewHandler,lifecyclePersonnelCompletionRecoveryHandler,type PersonnelCompletionRecoveryCandidate,type PersonnelCompletionRecoveryReview} from '../core/lifecycle-personnel-completion-recovery';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {owner,resetDb,seedBase,setModule,entitledCtx,closeAll,createAppUser,type Base} from './harness';
import {fictionalV9Case} from './fixtures/lifecycle-v9/case';
let b:Base,hr:SessionContext,employee:SessionContext,employmentId:string,personId:string;
const today=()=>todayInKualaLumpur();
const personal:Field={id:'F51',label:'Address',type:'textarea',owner:'pmLocked',pmKey:'address',required:true,sensitive:false,options:[],section:'main',when:null};
const fields=(extra:Field[]=[])=>[personal,...extra];
const workflow=(id='frozen'):Workflow=>({id,name:'Fictional frozen release',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],description:'',steps:[{id:'release',type:'doc',template:'recovery-form',release:true},{id:'later',type:'waitFile',slot:'independent',label:'Separate hold'}]});
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');hr=await entitledCtx(b);const subject=await hireEmployee(hr,{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional confidential recovery subject',primaryEmail:'fictional-subject@fixture.invalid',phone:'+60123456789'}});employmentId=subject.employmentId;personId=subject.personId;employee={...hr,userId:await createAppUser(b.tenantId,personId,'employee'),personId,roles:['employee'],grants:undefined};await v9Setup(hr);});
afterAll(closeAll);
async function fixture(options:{extraFields?:Field[];values?:Record<string,string>;runs?:Partial<Run>[];document?:Partial<Document>;module?:'onb'|'off'}={}){
 const config=(await v9Workspace(hr)).config!,f=fields(options.extraFields),blocks:Document['blocks']=[{id:'body',type:'text',text:'Fictional confidential frozen body',section:'main'}];
 config.templates=[{id:'recovery-form',name:'Fictional recovery form',type:'Form',module:options.module??'off',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:f,blocks}]}];config.workflows=[];await v9SaveConfig(hr,config.revision,config);
 const published=(await v9Workspace(hr)).config!.templates.find(t=>t.id==='recovery-form')!.versions[0];
 const id=randomUUID(),doc:Document={id:randomUUID(),templateId:'recovery-form',version:1,name:'Fictional legacy form',status:'draft',fields:published.fields,blocks:published.blocks,values:{F51:'',...options.values},edits:{},hrSignature:null,employeeSignature:null,createdAt:new Date().toISOString(),sentAt:null,hrStep:'before',employeeAck:false,templateType:'Form',...options.document};
 const runs=(options.runs??[{}]).map((over,index):Run=>({id:'frozen:'+index,workflowId:'frozen',revision:1,date:today(),status:'waiting',cursor:0,reason:'A legacy human-readable reason that recovery never matches.',at:new Date().toISOString(),definition:workflow(),...over}));
 const base=fictionalV9Case(),c:Case={...base,id,number:'FX-'+id,revision:1,state:'submitted',module:'off',facts:{...base.facts,company:b.companyId,employmentId,personId,name:'Fictional confidential recovery subject',employeeNo:'F-RECOVERY',joinDate:'2026-01-01',lastDay:today()},documents:[doc],runs,mails:[],sourceRevision:'frozen-source-1'};
 // Owner fixture recreates a saved pre-upgrade legacy draft. It carries no new completion policy.
 await owner.withTenant(hr,tx=>tx.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,revision,data) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,'off',${c.number},1,${JSON.stringify(c)}::jsonb)`));
 return{id,doc,c};
}
async function page(as=hr){return await personnelCompletionRecoveryPage(as) as {items:PersonnelCompletionRecoveryCandidate[];total:number;after:{caseId:string;documentId:string}|null};}
async function review(candidate:PersonnelCompletionRecoveryCandidate,as=hr){const [row]=await withTenant(as,tx=>tx.execute<{result:PersonnelCompletionRecoveryReview}>(sql`select app.personnel_completion_recovery_review(${JSON.stringify(candidate)}::jsonb) result`));return row.result;}
async function adopt(value:PersonnelCompletionRecoveryReview,as=hr){const [row]=await withTenant(as,tx=>tx.execute<{revision:number}>(sql`select app.personnel_completion_recovery_adopt(${JSON.stringify(value)}::jsonb) revision`));return row.revision;}
async function saved(id:string){const [row]=await owner.client<{revision:number;data:Case;text:string}[]>`select revision,data,(data->'documents'->0)::text as text from lc_v9_case where id=${id}::uuid`;return row;}
async function drain(id:string){for(let n=0;n<80;n++){const [job]=await owner.client<{state:string}[]>`select state from bulk_job where id=${id}::uuid`;if(['completed','failed','cancelled'].includes(job.state))return job.state;await runBulkJobTick(owner.client,{handlers:[lifecyclePersonnelCompletionPreviewHandler,lifecyclePersonnelCompletionRecoveryHandler]});}throw Error('Recovery fixture job did not finish');}
it('pages only exact hashes and reviews without any case/source values or writes, then directly adopts once under current HR authority',async()=>{
 const f=await fixture(),before=await saved(f.id),p=await page();expect(p.total).toBe(1);expect(p.items).toHaveLength(1);expect(p.items[0].documentHash).toBe(createHash('sha256').update(before.text).digest('hex'));
 const r=await review(p.items[0]);expect(r).toMatchObject({outcome:'eligible',runs:[{id:'frozen:0',stepId:'release',dueOn:today()}]});expect(r.reviewHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify({p,r})).not.toContain('confidential');expect(JSON.stringify({p,r})).not.toContain('F51');expect(await saved(f.id)).toEqual(before);
 const revision=await adopt(r);expect(revision).toBe(2);const after=await saved(f.id);expect(after.data.documents[0]).toMatchObject({personnelCompletion:{version:1,fields:{F51:{key:'address',group:'personal',sourceValue:''}},preparation:{by:{id:hr.userId}}},sentAt:null,status:'draft'});
 expect(after.data.documents[0].fields).toEqual(before.data.documents[0].fields);expect(after.data.documents[0].blocks).toEqual(before.data.documents[0].blocks);expect(after.data.runs).toEqual(before.data.runs);expect(after.data.mails).toEqual([]);expect((await review(p.items[0])).outcome).toBe('alreadyAdopted');await expect(adopt(r)).rejects.toThrow();
});
it('binds all frozen per-run due dates; adoption preserves future/late holds and never releases or sends',async()=>{
 const yesterday=addDays(today(),-1),tomorrow=addDays(today(),1),f=await fixture({runs:[{id:'late',date:yesterday},{id:'future',date:tomorrow}]});
 const r=await review((await page()).items[0]);expect(r.outcome).toBe('late');expect(r.runs).toEqual([{id:'late',stepId:'release',dueOn:yesterday},{id:'future',stepId:'release',dueOn:tomorrow}]);await adopt(r);const after=await saved(f.id);expect(after.data.documents[0].sentAt).toBeNull();expect(after.data.mails).toEqual([]);expect(after.data.runs.map(run=>run.status)).toEqual(['waiting','waiting']);
});
it.each([['checkbox','false'],['table','[]']] as const)('refuses a required HR %s answer %s without case changes',async(type,value)=>{
 const hrField:Field={...personal,id:'hr-answer',label:'HR verified',owner:'hr',pmKey:null,type,columns:type==='table'?['Checked']:undefined};
 const f=await fixture({extraFields:[hrField],values:{'hr-answer':value}}),before=await saved(f.id);expect((await review((await page()).items[0])).outcome).toBe('manualReview');expect(await saved(f.id)).toEqual(before);
});
it('rejects stale official-source and document hashes and employee/cross-tenant scope',async()=>{
 const f=await fixture(),candidate=(await page()).items[0],r=await review(candidate);await expect(review(candidate,employee)).rejects.toThrow();
 await updatePersonProfilePartial(hr,{personId,permanentAddressLine1:'A newly available official address'});await expect(adopt(r)).rejects.toThrow();expect((await saved(f.id)).revision).toBe(1);
 const changed={...candidate,documentHash:'0'.repeat(64)};expect((await review(changed)).outcome).toBe('changed');
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');await expect(review(candidate,await entitledCtx(foreign))).rejects.toThrow();
});
it('uses the real bulk handler/kernel: metadata preview makes no case write and only explicit sealed selection adopts and continues the reviewed run',async()=>{
 const f=await fixture(),candidate=(await page()).items[0],before=await saved(f.id),job=await requestPersonnelCompletionRecoveryPreview(hr,[candidate]);expect(await drain(job.row.id)).toBe('completed');expect(await saved(f.id)).toEqual(before);
 const preview=await readPersonnelCompletionRecoveryPreview(hr,job.row.id),r=preview.items[0].result as PersonnelCompletionRecoveryReview;expect(r.outcome).toBe('eligible');
 const apply=await requestPersonnelCompletionRecovery(hr,{previewJobId:job.row.id,reviewHashes:[r.reviewHash!],confirmed:true});expect(await drain(apply.row.id)).toBe('completed');const after=await saved(f.id);expect(after.data.documents[0].personnelCompletion?.preparation).toBeTruthy();expect(after.data.documents[0].sentAt).toBeNull();expect(after.data.mails).toEqual([]);expect(after.data.runs[0].status).toBe('waiting');
});
it('holds an ambiguous legacy answer rather than overwriting it',async()=>{
 const f=await fixture({values:{F51:'A saved answer with no official source'}}),before=await saved(f.id);expect((await review((await page()).items[0])).outcome).toBe('manualReview');expect(await saved(f.id)).toEqual(before);
});
it('holds a missing employment field rather than delegating it to the employee',async()=>{
 const employment:Field={...personal,id:'missing-employment',pmKey:'unsupportedEmploymentKey'};await fixture({extraFields:[employment]});expect((await review((await page()).items[0])).outcome).toBe('manualReview');
});
it('refuses captured signatures and delivery references without changing a legacy document',async()=>{
 const f=await fixture({document:{hrSignature:{by:{id:hr.userId!,name:'Fictional HR'},at:new Date().toISOString(),method:'typed',value:'Fictional HR',consent:true}}});expect((await review((await page()).items[0])).outcome).toBe('manualReview');expect((await saved(f.id)).revision).toBe(1);
});
it('treats even a failed captured delivery reference as manual review rather than replaying it',async()=>{
 const f=await fixture();await owner.client`insert into lc_v9_email_delivery(tenant_id,company_id,case_id,mail_id,payload,status) values(${b.tenantId}::uuid,${b.companyId}::uuid,${f.id}::uuid,'fictional-failed',${JSON.stringify({version:1,mail:{id:'fictional-failed',documentIds:[f.doc.id]}})}::jsonb,'failed')`;
 expect((await review((await page()).items[0])).outcome).toBe('manualReview');expect((await saved(f.id)).revision).toBe(1);
});
it('uses the captured completion-hold date and rejects a changed run after preview',async()=>{
 const future=addDays(today(),7),f=await fixture();await owner.client`update lc_v9_case set data=jsonb_set(data,'{runs,0,completionHold}',${JSON.stringify({documentId:f.doc.id,stepId:'release',dueOn:future,at:new Date().toISOString()})}::jsonb) where id=${f.id}::uuid`;
 const r=await review((await page()).items[0]);expect(r).toMatchObject({outcome:'future',runs:[{dueOn:future}]});await owner.client`update lc_v9_case set data=jsonb_set(data,'{runs,0,reason}','"Another saved context"'::jsonb) where id=${f.id}::uuid`;await expect(adopt(r)).rejects.toThrow();expect((await saved(f.id)).revision).toBe(1);
});
it('proves legacy native date anchors from matched public/private retained snapshots, never from a corrected current join date',async()=>{
 const f=await fixture({module:'onb'}),id=randomUUID(),original=addDays(today(),-3),corrected=addDays(today(),30),definition={...workflow(),module:'onb' as const,trigger:{...workflow().trigger,event:'afterJoin' as const,days:1}};
 const run:Run={...f.c.runs[0],definition,date:addDays(today(),-20)},native={version:1,id,number:'ONB-FICTIONAL',revision:2,state:'submitted',sourceVersion:'changed',employmentId,personId,source:{joinDate:corrected,company:b.companyId,fullName:'Fictional native subject'},local:{joinDate:'1999-01-01'},hiring:'new_hire',tasks:[],items:[],requests:[],log:[]},state={documents:[f.doc],runs:[run],mails:[],files:[],pmChanges:[],log:[]},privateData={source:{ic:'FICTIONAL-PRIVATE'},local:{},lifecycleV9:state,lifecycleV9Subject:{personId,employmentId}};
 await owner.withTenant(hr,async tx=>{
  await tx.execute(sql`insert into lc_onboarding_case(id,tenant_id,company_id,employment_id,revision,data) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,2,${JSON.stringify(native)}::jsonb)`);
  await tx.execute(sql`insert into lc_onboarding_private(case_id,tenant_id,company_id,data) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${JSON.stringify(privateData)}::jsonb)`);
  await tx.execute(sql`insert into lc_onboarding_case_revision(case_id,tenant_id,company_id,revision,data) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,1,${JSON.stringify({...native,revision:1,source:{...native.source,joinDate:original}})}::jsonb)`);
  await tx.execute(sql`insert into lc_onboarding_private_revision(case_id,tenant_id,company_id,revision,data) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,1,${JSON.stringify(privateData)}::jsonb)`);
 });
 const candidate=(await page()).items.find(c=>c.caseId===id)!;expect(candidate).toBeTruthy();const r=await review(candidate);expect(r).toMatchObject({outcome:'late',runs:[{dueOn:addDays(original,1)}]});expect(JSON.stringify(r)).not.toContain(original);expect(JSON.stringify(r)).not.toContain('FICTIONAL-PRIVATE');
});
it('rechecks creator authority in the real worker after an admitted preview is queued',async()=>{
 const f=await fixture(),job=await requestPersonnelCompletionRecoveryPreview(hr,[(await page()).items[0]]);await owner.client`update role_assignment set role='employee' where tenant_id=${b.tenantId}::uuid and app_user_id=${hr.userId}::uuid and role in ('hr_admin','super_admin','group_admin')`;expect(await drain(job.row.id)).toBe('failed');expect((await saved(f.id)).revision).toBe(1);
});
it('pages a large saved population in stable case/document order with a bounded metadata-only result',async()=>{
 const f=await fixture();
 // One set-based fixture load; ten legacy documents per case exercises context hashing once per case.
 await owner.withTenant(hr,tx=>tx.execute(sql`with ids as(select gen_random_uuid() id from generate_series(1,125)), copies as(select id,${JSON.stringify(f.c)}::jsonb||jsonb_build_object('id',id,'number','FX-'||id::text,'documents',(select jsonb_agg(${JSON.stringify(f.doc)}::jsonb||jsonb_build_object('id','doc-'||n::text)) from generate_series(1,10) n)) data from ids) insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,revision,data) select id,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,'off',data->>'number',1,data from copies`));
 const first=await personnelCompletionRecoveryPage(hr,null,100) as Awaited<ReturnType<typeof page>>;expect(first.total).toBe(1251);expect(first.items).toHaveLength(100);expect(JSON.stringify(first)).not.toContain('confidential');expect(JSON.stringify(first)).not.toContain('F51');
 const next=await personnelCompletionRecoveryPage(hr,first.after,100) as Awaited<ReturnType<typeof page>>;expect(next.total).toBe(1251);expect(next.items).toHaveLength(100);const keys=[...first.items,...next.items].map(c=>c.caseId+'|'+c.documentId);expect(new Set(keys).size).toBe(200);expect(keys).toEqual([...keys].sort());
 await expect(withTenant(hr,tx=>tx.execute(sql`select app.personnel_completion_recovery_candidates(null,null,null)`))).rejects.toThrow();
});
it('allows an unchanged future review to adopt policy while preserving its original future wait',async()=>{
 const future=addDays(today(),10),f=await fixture({runs:[{date:future}]}),r=await review((await page()).items[0]);expect(r.outcome).toBe('future');expect(await adopt(r)).toBe(2);const after=await saved(f.id);expect(after.data.runs[0]).toMatchObject({status:'waiting',date:future,cursor:0});expect(after.data.documents[0].sentAt).toBeNull();expect(after.data.mails).toEqual([]);
});
