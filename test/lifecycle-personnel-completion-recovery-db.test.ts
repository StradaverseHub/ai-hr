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
 config.templates.push({id:'recovery-form',name:'Fictional recovery form',type:'Form',module:options.module??'off',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:f,blocks}]});config.checklists=[];config.workflows=[];config.emails=[];await v9SaveConfig(hr,config.revision,config);
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
it('matches independent ordered counts for 1,000 employments across 70 companies under all-company, scoped-HR and employee authority',async()=>{
 const f=await fixture(),companies=[b.companyId,...Array.from({length:69},()=>randomUUID())];
 const subjects=Array.from({length:999},(_,index)=>({n:index+1,companyId:companies[(index+1)%70],personId:randomUUID(),employmentId:randomUUID(),caseId:randomUUID()}));
 await owner.withTenant(hr,async tx=>{
  await tx.execute(sql`insert into company(id,tenant_id,legal_name) select c.id::uuid,${b.tenantId}::uuid,'Fictional scale company '||c.ordinality from jsonb_array_elements_text(${JSON.stringify(companies.slice(1))}::jsonb) with ordinality c(id,ordinality)`);
  await tx.execute(sql`insert into person(id,tenant_id,full_name,primary_email) select "personId",${b.tenantId}::uuid,'Fictional scale person '||n,'scale-'||n||'@fixture.invalid' from jsonb_to_recordset(${JSON.stringify(subjects)}::jsonb) s(n integer,"personId" uuid)`);
  await tx.execute(sql`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) select "employmentId",${b.tenantId}::uuid,"personId","companyId",'RECOVERY-'||n,'2026-01-01'::date from jsonb_to_recordset(${JSON.stringify(subjects)}::jsonb) s(n integer,"personId" uuid,"employmentId" uuid,"companyId" uuid)`);
  await tx.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,revision,data) select "caseId",${b.tenantId}::uuid,"companyId","employmentId",'off','FX-'||"caseId"::text,1,${JSON.stringify(f.c)}::jsonb||jsonb_build_object('id',"caseId",'number','FX-'||"caseId"::text,'revision',1,'facts',${JSON.stringify(f.c.facts)}::jsonb||jsonb_build_object('company',"companyId",'employmentId',"employmentId",'personId',"personId")) from jsonb_to_recordset(${JSON.stringify(subjects)}::jsonb) s("personId" uuid,"employmentId" uuid,"companyId" uuid,"caseId" uuid)`);
 });
 const [population]=await owner.client<{companies:number;employments:number;validRevisions:boolean}[]>`select count(distinct company_id)::integer companies,count(distinct employment_id)::integer employments,bool_and(revision=1 and data->>'revision'='1') as "validRevisions" from lc_v9_case where tenant_id=${b.tenantId}::uuid`;
 expect(population).toEqual({companies:70,employments:1000,validRevisions:true});
 const expected=[{caseId:f.id,companyId:b.companyId,documentId:f.doc.id},...subjects.map(s=>({caseId:s.caseId,companyId:s.companyId,documentId:f.doc.id}))].sort((a,b)=>a.caseId<b.caseId?-1:a.caseId>b.caseId?1:a.documentId<b.documentId?-1:1);
 async function collect(as:SessionContext){let cursor:Awaited<ReturnType<typeof page>>['after']=null;const items:PersonnelCompletionRecoveryCandidate[]=[];let total=-1;for(let p=0;p<12;p++){const result=await personnelCompletionRecoveryPage(as,cursor,100) as Awaited<ReturnType<typeof page>>;if(total<0)total=result.total;expect(result.total).toBe(total);expect(result.items.length).toBeLessThanOrEqual(100);items.push(...result.items);if(!result.items.length)return{total,items};cursor=result.after;}throw Error('Scale page cursor did not finish');}
 const visible=(items:PersonnelCompletionRecoveryCandidate[])=>items.map(({caseId,companyId,documentId})=>({caseId,companyId,documentId}));
 const all=await collect(hr);expect(all.total).toBe(1000);expect(visible(all.items)).toEqual(expected);expect(JSON.stringify(all)).not.toContain('confidential');expect(await collect(employee)).toEqual({total:0,items:[]});
 const target=companies[1];await owner.client`update role_assignment set company_id=${target}::uuid where tenant_id=${b.tenantId}::uuid and app_user_id=${hr.userId}::uuid and role='hr_admin'`;
 const scoped:SessionContext={...hr,grants:[{role:'hr_admin',companyId:target}]},one=await collect(scoped),expectedOne=expected.filter(c=>c.companyId===target);expect(one.total).toBe(expectedOne.length);expect(visible(one.items)).toEqual(expectedOne);expect(visible(one.items)).toEqual(visible(all.items).filter(c=>c.companyId===target));
});
async function forgedRecovery(as:SessionContext,manifest:unknown){
 const content=Buffer.from(JSON.stringify(manifest)),token=createHash('sha256').update(content).digest('hex');
 const [row]=await withTenant(as,tx=>tx.execute<{admitted:{id:string}}>(sql`select app.bulk_job_enqueue('lifecycle_personnel_completion_recovery',${randomUUID()}::uuid,ARRAY[${b.companyId}::uuid],'fictional-forged-recovery.json',${content}::bytea,${JSON.stringify({token})}::jsonb) as admitted`));
 expect(row.admitted.id).toBeTruthy();await drain(row.admitted.id);return row.admitted.id;
}
async function expectNoAppliedRecovery(jobId:string,caseId:string){
 const [job]=await owner.client<{state:string;error:string|null;errors:unknown[]}[]>`select state,error,errors from bulk_job where id=${jobId}::uuid`;
 const [steps]=await owner.client<{applied:number}[]>`select count(*) filter(where state='applied')::integer applied from bulk_job_step where job_id=${jobId}::uuid`;
 expect(['completed','failed']).toContain(job.state);expect(job.error!==null||job.errors.length>0).toBe(true);expect(steps.applied).toBe(0);expect((await saved(caseId)).revision).toBe(1);expect((await saved(caseId)).data.mails).toEqual([]);
}
it('refuses direct public bulk admission with a valid review but no completed preview envelope or with a nonexistent preview',async()=>{
 const f=await fixture(),r=await review((await page()).items[0]);expect(r.outcome).toBe('eligible');
 await expectNoAppliedRecovery(await forgedRecovery(hr,[r]),f.id);
 await expectNoAppliedRecovery(await forgedRecovery(hr,{previewJobId:randomUUID(),reviews:[r]}),f.id);
});
it('rejects a directly admitted envelope whose result differs from its creator’s completed sealed preview',async()=>{
 const f=await fixture(),job=await requestPersonnelCompletionRecoveryPreview(hr,[(await page()).items[0]]);expect(await drain(job.row.id)).toBe('completed');
 const r=(await readPersonnelCompletionRecoveryPreview(hr,job.row.id)).items[0].result as PersonnelCompletionRecoveryReview;
 const forged={...r,reason:'A forged reason with the original unchanged review hash'};expect(forged.reviewHash).toBe(r.reviewHash);
 const id=await forgedRecovery(hr,{previewJobId:job.row.id,reviews:[forged]});await expectNoAppliedRecovery(id,f.id);
 const [step]=await owner.client<{error:string}[]>`select error from bulk_job_step where job_id=${id}::uuid order by seq limit 1`;expect(step.error).toContain('no longer matches the completed preview');
});
it('refuses another HR creator’s completed preview even when the direct envelope uses a valid current-actor review',async()=>{
 const f=await fixture(),candidate=(await page()).items[0],r=await review(candidate),p=randomUUID();await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${p}::uuid,${b.tenantId}::uuid,'Fictional second HR','second-hr@fixture.invalid')`;
 const userId=await createAppUser(b.tenantId,p,'hr_admin'),other:SessionContext={...hr,userId,personId:p,grants:[{role:'hr_admin',companyId:null}]};
 await owner.client`update lc_onboarding_config set data=jsonb_set(data,'{access,offboarding}',coalesce(data->'access'->'offboarding','[]'::jsonb)||jsonb_build_array(${userId}::text)) where tenant_id=${b.tenantId}::uuid`;
 const preview=await requestPersonnelCompletionRecoveryPreview(other,[candidate]);expect(await drain(preview.row.id)).toBe('completed');expect((await readPersonnelCompletionRecoveryPreview(other,preview.row.id)).items[0].result).toMatchObject({outcome:'eligible'});
 await expect(requestPersonnelCompletionRecovery(hr,{previewJobId:preview.row.id,reviewHashes:[r.reviewHash!],confirmed:true})).rejects.toThrow();
 await expectNoAppliedRecovery(await forgedRecovery(hr,{previewJobId:preview.row.id,reviews:[r]}),f.id);
});
