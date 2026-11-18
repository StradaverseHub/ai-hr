import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {saveEmployeeDraft,completeEmployeeDraft} from '../core/employee-draft';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9OwnDocument,v9OwnWork,v9CaseDetail,onboardingList,onboardingCommand,lifecycleTaskDocuments,lifecycleTaskCardDocuments,openOwnLifecycleDocument} from '../packs/lifecycle/service';
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
async function prepared(release=true,action:'completed'|'signed'|'sent'='signed'){
 const config=(await v9Workspace(admin)).config!;
 config.templates.push({id:'document-task-form',name:'Saved acceptance',type:'Form',module:'off',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'body',type:'text',text:'Saved form',section:''}],fields:[{id:'answer',label:'Saved answer',type:'text',owner:'employee',pmKey:null,required:false,sensitive:false,options:[],section:'main',when:null}]}]});
 config.checklists=[...config.checklists.filter(c=>c.module==='onb'),{id:'doc-checklist',name:'Exit document checklist',module:'off',rules:{},tasks:[{id:'acceptance-task',name:'Accept saved form',by:'employee',group:null,mode:'manual',opens:null,due:0,required:true,documentTemplate:'document-task-form',documentAction:action}]}];
 config.workflows=[{id:'release-document',name:'Release saved document',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'doc',type:'doc',template:'document-task-form',release}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay:'2027-12-01'});await v9Command(admin,id,1,{type:'submit'});
 return (await v9Workspace(admin)).cases.find(c=>c.id===id)!;
}
it('opens the exact released instance, retains answers, progresses only unfinished tasks and is idempotent',async()=>{
 let c=await prepared();await v9OwnDocument(employee,{caseId:c.id,documentId:c.documents[0].id,revision:c.revision,values:{answer:'Answers from the emailed saved instance'}});c=(await v9Workspace(admin)).cases.find(row=>row.id===c.id)!;
 const doc=c.documents[0],before=structuredClone(doc);expect(before.values.answer).toBe('Answers from the emailed saved instance');
 const page=await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]});
 expect(page.total).toBe(1);expect(page.items[0]).toMatchObject({documentId:doc.id,state:'released',sourceName:'Exit document checklist',sourceKind:'checklist',taskId:null,action:null,linkedTasks:[{taskId:c.tasks[0].id,taskStatus:'todo',action:'signed'}],documentStatus:'sent'});
 expect(JSON.stringify(page)).not.toContain('mergeValues');expect(JSON.stringify(page)).not.toContain('fields');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision});
 const opened=(await v9Workspace(admin)).cases.find(x=>x.id===c.id)!;
 expect(opened.documents).toHaveLength(1);expect(opened.documents[0]).toEqual({...before,status:'opened'});expect(opened.tasks[0].status).toBe('progress');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision});
 expect((await v9Workspace(admin)).cases.find(x=>x.id===c.id)!.revision).toBe(opened.revision);
 const events=await owner.client`select actor_id,payload from domain_event where aggregate_id=${c.id}::uuid and event_type='lifecycle-v9.employeeDocumentOpened'`;
 expect(events).toHaveLength(1);expect(events[0].actor_id).toBe(employee.userId);expect(events[0].payload.documentId).toBe(doc.id);
 await v9OwnDocument(employee,{caseId:c.id,documentId:doc.id,revision:opened.revision,values:{},signature:{method:'typed',value:'Document owner',consent:true}});
 const completed=(await v9Workspace(admin)).cases.find(x=>x.id===c.id)!;expect(completed.tasks[0].status).toBe('done');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:1});
 expect((await v9Workspace(admin)).cases.find(x=>x.id===c.id)!.revision).toBe(completed.revision);
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).items[0]).toMatchObject({taskId:null,action:null,linkedTasks:[{taskStatus:'done'}],documentStatus:'signed'});
});
it('shows an unreleased task without identity and refuses draft, stranger, company and tenant access',async()=>{
 const c=await prepared(false),doc=c.documents[0];
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).items[0]).toMatchObject({state:'unreleased',documentId:null});
 expect((await lifecycleTaskDocuments(employee,{companyIds:[]})).total).toBe(0);
 expect((await lifecycleTaskDocuments(other,{companyIds:[b.companyId]})).total).toBe(0);
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId],caseId:randomUUID()})).total).toBe(0);
 await expect(openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 await expect(openOwnLifecycleDocument(other,{caseId:c.id,documentId:doc.id,revision:c.revision})).rejects.toThrow();
 const foreign=await seedBase();expect((await lifecycleTaskDocuments(await entitledCtx(foreign),{companyIds:[b.companyId]})).total).toBe(0);
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

it('opens a linked activated native joiner document and preserves the native private owner and completed history',async()=>{
 const config=(await v9Workspace(admin)).config!;
 config.templates.push({id:'native-doc',name:'Native acceptance',type:'Form',module:'onb',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'body',type:'text',text:'Native saved answers',section:''}],fields:[]}]});
 config.checklists=[...config.checklists.filter(c=>c.module==='off'),{id:'native-checklist',name:'Native checklist source',module:'onb',rules:{},tasks:[{id:'native-task',name:'Accept native document',by:'employee',group:null,mode:'manual',opens:null,due:1,required:true,documentTemplate:'native-doc',documentAction:'signed'}]}];
 config.workflows=[{id:'native-release',name:'Native release workflow',module:'onb',status:'published',trigger:{event:'beforeJoin',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'release',type:'doc',template:'native-doc',release:true}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const draft=await saveEmployeeDraft(admin,{currentStep:5,data:{profile:{fullName:'Native document owner',employeeCode:'NATIVE-DOC',primaryEmail:'native-owner@test.invalid'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,reportingManagerEmploymentId:employmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5000'}}});
 expect((await lifecycleTaskDocuments(employee,{companyIds:[b.companyId]})).total).toBe(0);
 const pending=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;
 expect((await v9OwnWork(employee)).some(row=>row.id===pending.case.id)).toBe(false);
 const active=await completeEmployeeDraft(admin,draft.id);
 const [subject]=await owner.client<{person_id:string}[]>`select person_id from employment where id=${active.employmentId}::uuid`;
 const joiner={...employee,personId:subject.person_id,userId:await createAppUser(b.tenantId,subject.person_id,'employee')};
 const native=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;
 await onboardingCommand(admin,native.case.id,native.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:employmentId}}});
 const before=(await v9CaseDetail(admin,native.case.id)).case;
 const item=(await lifecycleTaskDocuments(joiner,{companyIds:[b.companyId]})).items.find(item=>item.caseId===before.id)!;
 expect(item).toMatchObject({state:'released',module:'onb',sourceName:'Native checklist source',documentId:before.documents[0].id});
 await openOwnLifecycleDocument(joiner,{caseId:item.caseId,documentId:item.documentId!,revision:item.revision});
 const opened=(await v9CaseDetail(admin,before.id)).case;expect(opened.documents[0]).toEqual({...before.documents[0],status:'opened'});expect(opened.tasks[0].status).toBe('progress');
 const n=(await onboardingList(admin)).find(row=>row.case.id===before.id)!;expect(n.case.history.at(-1)).toMatchObject({action:'document.opened',by:joiner.userId});
 expect((await owner.client`select id from lc_v9_case where id=${before.id}::uuid`)).toHaveLength(0);
 await v9OwnDocument(joiner,{caseId:before.id,documentId:item.documentId!,revision:opened.revision,values:{},signature:{method:'typed',value:'Native document owner',consent:true}});
 expect((await onboardingList(admin)).find(row=>row.case.id===before.id)!.case.tasks[0].status).toBe('done');
});

// The group-shape fixture verifies SQL page/count/order against independently ordered saved checklist facts.
it('keeps ordered page/count parity across 70 companies and 1000 employments without broadening ownership',async()=>{
 const c=await prepared();
 const companies=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Task documents group company '||n from generate_series(1,69) n returning id`;
 const companyIds=[b.companyId,...companies.map(c=>c.id)];
 await owner.client`with people as (insert into person(tenant_id,full_name) select ${b.tenantId}::uuid,'Other document person '||n from generate_series(1,1000) n returning id), ranked as(select id,row_number() over(order by id) as n from people)
 insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${b.tenantId}::uuid,id,(${companyIds}::uuid[])[1+((n-1)%70)::int],'OTHER-DOC-'||n,'2026-01-01'::date from ranked`;
 const tasks=Array.from({length:101},(_,n)=>({...c.tasks[0],id:'task-'+String(n).padStart(3,'0'),dueOn:'2027-12-'+String(1+n%20).padStart(2,'0'),documentAction:n%2?'completed':'signed'}));
 await owner.client`update lc_v9_case set data=jsonb_set(data,'{tasks}',${JSON.stringify(tasks)}::jsonb) where id=${c.id}::uuid`;
 const old=(await v9OwnWork(employee)).find(row=>row.id===c.id)!;expect(old.tasks.map(t=>t.id)).toEqual(tasks.map(t=>t.id));
 const expected=[...tasks].sort((a,b)=>a.dueOn.localeCompare(b.dueOn)||a.id.localeCompare(b.id)).map(t=>t.id);
 const all=await lifecycleTaskDocuments(employee,{companyIds,limit:100}),single=await lifecycleTaskDocuments(employee,{companyIds:[b.companyId],limit:100}),next=await lifecycleTaskDocuments(employee,{companyIds,offset:100,limit:100});
 expect(all.total).toBe(1);expect(all.items).toHaveLength(1);expect(all.items[0]).toMatchObject({taskId:null,action:null,documentId:c.documents[0].id});expect(all.items[0].linkedTasks?.map(task=>task.taskId)).toEqual(expected);expect(all.items[0].linkedTasks?.map(task=>task.action)).toEqual(expected.map(id=>tasks.find(task=>task.id===id)!.documentAction));expect(single).toEqual(all);expect(next.items).toEqual([]);expect(next.total).toBe(1);
 expect((await lifecycleTaskDocuments(other,{companyIds,limit:100})).total).toBe(0);expect((await lifecycleTaskDocuments(admin,{companyIds,limit:100})).total).toBe(0);
},90000);

it('retains the sent-only completion policy and denies document access to an unrelated task assignee',async()=>{
 const c=await prepared(true,'sent'),doc=c.documents[0];expect(c.tasks[0].status).toBe('done');
 await openOwnLifecycleDocument(employee,{caseId:c.id,documentId:doc.id,revision:c.revision});
 expect((await v9Workspace(admin)).cases.find(row=>row.id===c.id)!.tasks[0].status).toBe('done');
 const current=(await v9Workspace(admin)).cases.find(row=>row.id===c.id)!;
 const tasks=current.tasks.map(task=>({...task,by:'group',assignee:other.userId,status:'todo'}));
 await owner.client`update lc_v9_case set data=jsonb_set(data,'{tasks}',${JSON.stringify(tasks)}::jsonb) where id=${c.id}::uuid`;
 expect((await v9OwnWork(other)).find(row=>row.id===c.id)!.tasks).toHaveLength(1);
 expect((await lifecycleTaskDocuments(other,{companyIds:[b.companyId]})).total).toBe(0);
 await expect(openOwnLifecycleDocument(other,{caseId:c.id,documentId:doc.id,revision:current.revision})).rejects.toThrow();
});


it('resolves exact native task-card references beyond the document page without leaking team-assignee metadata',async()=>{
 const config=(await v9Workspace(admin)).config!;
 config.templates.push({id:'card-native-doc',name:'Card saved form',type:'Form',module:'onb',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'private-body',type:'text',text:'Private saved document body',section:''}],fields:[]}]});
 config.checklists=[...config.checklists.filter(c=>c.module==='off'),{id:'card-native-checklist',name:'Card checklist provenance',module:'onb',rules:{},tasks:[{id:'card-native-task',name:'Accept saved form',by:'employee',group:null,mode:'manual',opens:null,due:1,required:true,documentTemplate:'card-native-doc',documentAction:'signed'}]}];
 config.workflows=[{id:'card-native-release',name:'Card release',module:'onb',status:'published',trigger:{event:'beforeJoin',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'release',type:'doc',template:'card-native-doc',release:true}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const draft=await saveEmployeeDraft(admin,{currentStep:5,data:{profile:{fullName:'Card document owner',employeeCode:'CARD-NATIVE',primaryEmail:'card-native@test.invalid'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,reportingManagerEmploymentId:employmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5000'}}});
 const active=await completeEmployeeDraft(admin,draft.id),[subject]=await owner.client<{person_id:string}[]>`select person_id from employment where id=${active.employmentId}::uuid`;
 const joiner={...employee,personId:subject.person_id,userId:await createAppUser(b.tenantId,subject.person_id,'employee')};
 const native=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;
 await onboardingCommand(admin,native.case.id,native.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:employmentId}}});
 const saved=(await v9CaseDetail(admin,native.case.id)).case;
 const submittedNative=(await onboardingList(admin)).find(row=>row.case.id===saved.id)!;
 const docs=Array.from({length:61},(_,index)=>({...saved.documents[0],id:'card-document-'+index,templateId:'card-template-'+index,name:'Card saved form '+index,status:index===60?'draft':'sent',values:{privateAnswer:'Never exposed to task cards'}}));
 const tasks=Array.from({length:61},(_,index)=>({...submittedNative.case.tasks[0],id:'card-task-'+String(index).padStart(3,'0'),name:'Card task '+index,by:'joiner',assignee:joiner.userId,documentTemplate:'card-template-'+index,status:'todo'}));
 tasks.push({...tasks[0],id:'card-task-shared',name:'Submit the same saved form',documentAction:'completed'});
 await owner.client`update lc_onboarding_case set data=jsonb_set(data,'{tasks}',${JSON.stringify(tasks)}::jsonb) where id=${saved.id}::uuid`;
 await owner.client`update lc_onboarding_private set data=jsonb_set(data,'{lifecycleV9,documents}',${JSON.stringify(docs)}::jsonb) where case_id=${saved.id}::uuid`;
 const refs=tasks.map(task=>({caseId:saved.id,taskId:task.id}));
 const first=await lifecycleTaskDocuments(joiner,{companyIds:[b.companyId],limit:50}),cards=await lifecycleTaskCardDocuments(joiner,{companyIds:[b.companyId],refs:[...refs,refs[0]]});
 expect(first.items).toHaveLength(50);expect(cards).toHaveLength(62);expect(new Set(cards.map(item=>item.taskId)).size).toBe(62);expect(first.total).toBe(61);expect(first.items.some(item=>item.documentId==='card-document-59')).toBe(false);expect(first.items.find(item=>item.documentId==='card-document-0')?.linkedTasks).toHaveLength(2);
 expect(cards.every(item=>item.sourceFallback===null)).toBe(true);
 expect(cards.find(item=>item.taskId==='card-task-059')).toMatchObject({state:'released',documentId:'card-document-59',sourceName:'Card checklist provenance'});
 expect(cards.find(item=>item.taskId==='card-task-060')).toMatchObject({state:'unreleased',documentId:null});
 const next=await lifecycleTaskDocuments(joiner,{companyIds:[b.companyId],offset:50,limit:50});expect(next.items).toHaveLength(11);expect(next.total).toBe(61);expect(new Set([...first.items,...next.items].filter(item=>item.documentId).map(item=>item.documentId)).size).toBe(60);
 expect(await lifecycleTaskCardDocuments(joiner,{companyIds:[b.companyId],refs})).toEqual(cards);
 expect(JSON.stringify(cards)).not.toContain('privateAnswer');expect(JSON.stringify(cards)).not.toContain('Private saved document body');
 expect(await lifecycleTaskCardDocuments(joiner,{companyIds:[],refs})).toEqual([]);expect(await lifecycleTaskCardDocuments(joiner,{companyIds:[b.companyId],refs:[{caseId:saved.id,taskId:'not-a-saved-task'}]})).toEqual([]);
 const teamTask={...tasks[0],by:'group',assignee:other.userId};
 await owner.client`update lc_onboarding_case set data=jsonb_set(data,'{tasks}',${JSON.stringify([teamTask,...tasks.slice(1)])}::jsonb) where id=${saved.id}::uuid`;
 expect(await lifecycleTaskCardDocuments(other,{companyIds:[b.companyId],refs:[refs[0]]})).toEqual([]);
 expect(await lifecycleTaskCardDocuments(joiner,{companyIds:[b.companyId],refs:[refs[0]]})).toEqual([]);
 expect(await lifecycleTaskCardDocuments(admin,{companyIds:[b.companyId],refs})).toEqual([]);
 await owner.client`update lc_onboarding_case set data=data-'confirmedChecklist' where id=${saved.id}::uuid`;
 expect((await lifecycleTaskCardDocuments(joiner,{companyIds:[b.companyId],refs:[refs[1]]}))[0]).toMatchObject({sourceName:'Onboarding checklist',sourceFallback:'onboardingChecklist'});
 expect((await lifecycleTaskDocuments(joiner,{companyIds:[b.companyId],limit:1})).items[0]).toMatchObject({sourceFallback:'onboardingChecklist'});
 const foreign=await seedBase();expect(await lifecycleTaskCardDocuments(await entitledCtx(foreign),{companyIds:[b.companyId],refs})).toEqual([]);
});
