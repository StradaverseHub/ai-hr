import {beforeEach,afterAll,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Grant} from '../db/client';
import {saveEmployeeDraft} from '../core/employee-draft';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee,updatePersonProfilePartial,terminateEmployment} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9DocumentSigningWorkspace,v9ReadDocumentSigningWork,v9DocumentRouteAct,v9DocumentRouteEdit,v9Sweep,v9OwnWork,onboardingList,onboardingCommand,v9CaseDetail} from '../packs/lifecycle/service';
import {v9SigningCanonicalText,v9DocumentSigningContent,recordV9DocumentRouteAction} from '../lib/lifecycle-v9-document-routing';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
let base: Base, admin: SessionContext, employee: SessionContext, other: SessionContext, employmentId: string;
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  const hr = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional signing HR', primaryEmail: 'signing-hr@test.invalid' } });
  await owner.withTenant(admin, tx => tx.execute(sql`update app_user set person_id=${hr.personId}::uuid where id=${admin.userId!}::uuid and tenant_id=${base.tenantId}::uuid`));
  admin = { ...admin, personId: hr.personId };
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'V9 subject', primaryEmail: 'subject@test.invalid', phone: '+60123456789' } });
  employmentId = subject.employmentId;
  employee = { ...admin, userId: await createAppUser(base.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: undefined };
  const stranger = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Unrelated employee', primaryEmail: 'stranger@test.invalid' } });
  other = { ...employee, userId: await createAppUser(base.tenantId, stranger.personId, 'employee'), personId: stranger.personId };
  await v9Setup(admin);
});
afterAll(closeAll);

async function prepared(two=false,lastDay='2026-12-01'){
 const config=(await v9Workspace(admin)).config!;
 // This isolated route fixture replaces the document catalogue; remove unrelated seeded email links too.
 config.emails=[];
 config.checklists=[{id:'route-checklist',name:'Signing tasks',module:'off',rules:{},tasks:['signed','completed','sent'].map(documentAction=>({id:documentAction,name:documentAction,by:'employee' as const,group:null,mode:'manual' as const,opens:null,due:0,required:true,documentTemplate:'route-form',documentAction:documentAction as 'signed'|'completed'|'sent'}))}];
 config.templates=[{id:'route-form',name:'Frozen handover',module:'off',type:'Form',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:[{id:'answer',label:'Employee answer',type:'text',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null},{id:'contact',label:'Mobile phone',type:'phone',owner:'employee',pmKey:'mobile',required:false,sensitive:false,options:[],section:'main',when:null},{id:'official-name',label:'Official name',type:'text',owner:'pmLocked',pmKey:'employee.name',required:true,sensitive:false,options:[],section:'main',when:null}],blocks:[{id:'wording',type:'text',text:'Handover record',section:''},{id:'hr-block',type:'signature',text:'',section:'',role:'step:hr-sign'},{id:'employee-block',type:'signature',text:'',section:'',role:'step:employee-sign'}],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[admin.userId!]},owner:true},{id:'hr-sign',order:2,action:'sign',who:{kind:'people',userIds:[admin.userId!]},owner:false},{id:'employee-sign',order:3,action:'sign',who:{kind:'employee'},owner:false},{id:'superior-review',order:3,action:'approve',who:{kind:'directSuperior'},owner:false,required:false}]}]}];
 config.workflows=[{id:'route-release',name:'Generate and release',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'generate',type:'doc',template:'route-form',release:true},{id:'wait',type:'waitSign',template:'route-form',by:'employee'}],description:''},{id:'route-completed',name:'Signature recorded',module:'off',status:'published',trigger:{event:'docSigned',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',subject:'Handover signed',body:'The saved handover is signed.',to:['employee'],cc:[]}],description:''}];
 if(two){config.templates.push({...structuredClone(config.templates[0]),id:'route-form-two',name:'Second frozen handover'});config.workflows.find(w=>w.id==='route-completed')!.steps=[{id:'notify',type:'notify',subject:'Missing recipient',body:'Saved handover signed',to:['supervisor'],cc:[]}];}
 await v9SaveConfig(admin,config.revision,config);
 const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay});await v9Command(admin,id,1,{type:'submit'});
 const c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;return {id,docId:c.documents[0].id};
}
async function act(ctx:SessionContext,id:string,docId:string,stepId:string,action:'reviewed'|'signed'|'returned'|'resent',comment=''){
 const item=await v9ReadDocumentSigningWork(ctx,id,docId);return v9DocumentRouteAct(ctx,{caseId:id,caseRevision:item.caseRevision,documentId:docId,stepId,action,contentHash:item.signing.contentHash,contentRevision:item.signing.contentRevision,comment,...(action==='signed'?{signature:{method:'typed' as const,value:ctx.userId!,consent:true as const}}:{})});
}
it('uses one saved document for private participant preparation, locks exact content, and synchronizes linked tasks and source workflows once',async()=>{
 const {id,docId}=await prepared();const initial=await v9ReadDocumentSigningWork(employee,id,docId);expect(initial.document?.sentAt).toBeNull();expect(initial.document?.fields).toHaveLength(3);
 expect((await v9DocumentSigningWorkspace(other)).items).toEqual([]);await expect(v9ReadDocumentSigningWork(other,id,docId)).rejects.toThrow();
 expect(await withTenant(employee,tx=>tx.execute(sql`select id from lc_v9_case where id=${id}::uuid`))).toEqual([]);
 await expect(act(employee,id,docId,'employee-sign','signed')).rejects.toThrow();
 await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:initial.caseRevision,documentId:docId,values:{answer:'All handover complete',contact:'+60129876543'}});
 let item=await act(admin,id,docId,'review','reviewed');const sqlHash=await withTenant(admin,tx=>tx.execute<{hash:string}>(sql`select app.v9_document_content_hash(${JSON.stringify(item.document)}::jsonb) as hash`));expect(sqlHash[0].hash).toBe(createHash('sha256').update(v9SigningCanonicalText(v9DocumentSigningContent(item.document!))).digest('hex'));
 item=await act(admin,id,docId,'hr-sign','signed');await expect(v9DocumentRouteEdit(admin,{caseId:id,caseRevision:item.caseRevision,documentId:docId,edits:{wording:'Changed after signing'}})).rejects.toThrow();
 item=await act(employee,id,docId,'employee-sign','signed');expect(item.document?.status).toBe('signed');expect(item.signing.actions).toHaveLength(3);
 let c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;expect(c.pmChanges).toEqual([expect.objectContaining({documentId:docId,field:'mobile',before:'+60123456789',after:'+60129876543',status:'proposed',sourceRevision:c.sourceRevision})]);expect(c.tasks.filter(t=>t.id==='signed'||t.id==='completed').every(t=>t.status==='done')).toBe(true);expect(c.tasks.find(t=>t.id==='sent')?.status).toBe('todo');
 await v9Sweep({...admin,userId:undefined},owner,new Date('2026-11-18T01:00:00Z'));await v9Sweep({...admin,userId:undefined},owner,new Date('2026-11-18T01:00:00Z'));
 c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;expect(c.documents).toHaveLength(1);expect(c.documents[0].id).toBe(docId);expect(c.documents[0].sentAt).not.toBeNull();expect(c.documents[0].status).toBe('signed');expect(c.tasks.find(t=>t.id==='sent')?.status).toBe('done');expect(c.runs.filter(r=>r.sourceEvent?.sourceId===docId)).toHaveLength(1);expect(c.mails.filter(m=>m.workflowId==='route-completed')).toHaveLength(1);
});
it('independently rejects forged actor or immutable history through the existing scoped case writer, and send-back immediately invalidates signatures',async()=>{
 const {id,docId}=await prepared();let item=await v9ReadDocumentSigningWork(employee,id,docId);await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:item.caseRevision,documentId:docId,values:{answer:'Complete'}});await act(admin,id,docId,'review','reviewed');item=await act(admin,id,docId,'hr-sign','signed');
 const c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!,forged=structuredClone(c);recordV9DocumentRouteAction(forged.documents[0],{id:randomUUID(),stepId:'employee-sign',revision:item.signing.contentRevision,hash:item.signing.contentHash,action:'signed',signature:{method:'typed',value:'Forged employee',consent:true}},{id:employee.userId!,personId:employee.personId!,name:'V9 subject'},new Date().toISOString());
 await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_case set data=${JSON.stringify(forged)}::jsonb where id=${id}::uuid`))).rejects.toThrow();
 item=await act(admin,id,docId,'hr-sign','returned','Please review the answers.');expect(item.document?.stepSignatures).toEqual({});expect(item.signing.actions).toHaveLength(3);
 await expect(act(employee,id,docId,'employee-sign','resent')).rejects.toThrow();item=await v9DocumentRouteEdit(admin,{caseId:id,caseRevision:item.caseRevision,documentId:docId,edits:{wording:'Corrected wording'}});expect((await withTenant(admin,tx=>tx.execute<{held:boolean}>(sql`select app.document_signing_returned(${JSON.stringify(item.signing)}::jsonb) as held`)))[0].held).toBe(true);item=await act(admin,id,docId,'review','resent');expect(item.signing.actions).toHaveLength(4);expect(item.document?.status).toBe('draft');
});

it('rejects changed published field structure and arbitrary active recipients when fixed employee/superior accounts are missing',async()=>{
 const {id}=await prepared(),c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;
 function forged(){const copy=structuredClone(c),d=copy.documents[0];d.id=randomUUID();d.signing!.subjectId=d.id;return copy;}
 async function reject(copy:typeof c){const d=copy.documents[0];d.signing!.contentHash=createHash('sha256').update(v9SigningCanonicalText(v9DocumentSigningContent(d))).digest('hex');await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_case set data=${JSON.stringify(copy)}::jsonb where id=${id}::uuid`))).rejects.toThrow();}
 let copy=forged();copy.documents[0].fields=[];await reject(copy);copy=forged();copy.documents[0].fields[0].owner='hr';await reject(copy);copy=forged();copy.documents[0].values['official-name']='Invented official name';await reject(copy);copy=forged();copy.documents[0].mergeValues!['employee.name']='Invented official name';copy.documents[0].values['official-name']='Invented official name';await reject(copy);copy=forged();copy.documents[0].mergeValues!['private.unused']='Unrelated private facts';await reject(copy);
 const [{name}]=await owner.db.execute<{name:string}>(sql`select full_name as name from person where id=${other.personId!}::uuid`);
 await owner.db.execute(sql`update app_user set archived_at=now() where id=${employee.userId!}::uuid`);
 for(const stepId of ['employee-sign','superior-review']){copy=forged();const step=copy.documents[0].signing!.route.steps.find(s=>s.id===stepId)!;step.holderId=other.userId!;step.holderPersonId=other.personId!;step.label=name;await reject(copy);}
 expect((await v9Workspace(admin)).cases.find(c=>c.id===id)!.documents[0].id).toBe(c.documents[0].id);
});

it('captures a second completed saved document while the first source notification is held, preserving both sources and one outbox per admitted source',async()=>{
 const {id,docId}=await prepared(true);let c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;await v9Command(admin,id,c.revision,{type:'generate',template:'route-form-two'});c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;const second=c.documents.find(d=>d.templateId==='route-form-two')!.id;
 for(const target of [docId,second]){const item=await v9ReadDocumentSigningWork(employee,id,target);await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:item.caseRevision,documentId:target,values:{answer:'Complete'}});await act(admin,id,target,'review','reviewed');await act(admin,id,target,'hr-sign','signed');await act(employee,id,target,'employee-sign','signed');await v9Sweep({...admin,userId:undefined,personId:null},owner,new Date('2026-11-18T01:00:00Z'));}
 c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;const runs=c.runs.filter(r=>r.workflowId==='route-completed');expect(runs).toHaveLength(2);expect(runs.map(r=>r.sourceEvent?.sourceId).sort()).toEqual([docId,second].sort());expect(runs.every(r=>r.actor?.id===employee.userId)).toBe(true);expect(runs.some(r=>!!r.hold)).toBe(true);expect(c.mails.filter(m=>m.workflowId==='route-completed')).toEqual([]);
});
it('signs a native pre-employment document on its original private owner without inventing employment and rejects forged history through the existing writer',async()=>{
 await prepared();const config=(await v9Workspace(admin)).config!;config.checklists.push({id:'native-route',name:'Native route',module:'onb',rules:{},tasks:[]});config.templates.push({id:'route-native',name:'Native draft letter',module:'onb',type:'Letter',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:[],blocks:[{id:'native-signature',type:'signature',text:'',section:'',role:'step:native-sign'}],routing:[{id:'native-sign',order:1,action:'sign',who:{kind:'people',userIds:[admin.userId!]},owner:true}]}]});config.workflows.push({id:'route-native-generate',name:'Native frozen letter',module:'onb',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'doc',type:'doc',template:'route-native',release:false},{id:'wait',type:'waitSign',template:'route-native',by:'employee'}],description:''});await v9SaveConfig(admin,config.revision,config);
 const draft=await saveEmployeeDraft(admin,{currentStep:1,data:{profile:{fullName:'Fictional routed pre-employment',primaryEmail:'native-route@test.invalid'},employment:{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,reportingManagerEmploymentId:employmentId,hiredOn:todayInKualaLumpur()}}});const row=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;expect(row.case.employmentId).toBeNull();await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:employmentId}}});
 const detail=(await v9CaseDetail(admin,row.case.id)).case,doc=detail.documents.find(d=>d.templateId==='route-native')!;expect(doc.signing).toBeDefined();const signed=await act(admin,detail.id,doc.id,'native-sign','signed');expect(signed.document?.status).toBe('signed');
 const [stored]=await owner.db.execute<{copies:number;employment:string|null;data:Record<string,unknown>}>(sql`select (select count(*)::int from lc_v9_case where id=c.id) as copies,c.employment_id as employment,p.data from lc_onboarding_case c join lc_onboarding_private p on p.case_id=c.id where c.id=${detail.id}::uuid`);expect(stored.copies).toBe(0);expect(stored.employment).toBeNull();
 const forged=structuredClone(stored.data) as {lifecycleV9:{documents:typeof detail.documents}};forged.lifecycleV9.documents.find(d=>d.id===doc.id)!.signing!.actions[0].actorId=other.userId!;
 await expect(withTenant(admin,tx=>tx.execute(sql`update lc_onboarding_private set data=${JSON.stringify(forged)}::jsonb where case_id=${detail.id}::uuid`))).rejects.toThrow();
});
it('pages one set-based signing projection across 70 companies and 1,000 employments with exact count and stable boundaries',async()=>{
 const {id}=await prepared(),original=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;
 const companies=Array.from({length:70},(_,index)=>({id:randomUUID(),name:'Signing scale '+index}));
 const records=Array.from({length:1000},(_,index)=>{const company=companies[index%70].id,person=randomUUID(),employment=randomUUID(),caseId=randomUUID(),data=structuredClone(original),d=data.documents[0];data.id=caseId;data.revision=1;data.number='SIGN-SCALE-'+String(index).padStart(4,'0');data.facts={...data.facts,company,personId:person,employmentId:employment,starterUserId:admin.userId!,employeeUserId:null};d.id=randomUUID();d.signing!.subjectId=d.id;d.signing!.companyId=company;d.signing!.route.steps.find(s=>s.role==='employee')!.holderId=null;delete d.signing!.route.steps.find(s=>s.role==='employee')!.holderPersonId;d.signing!.route.steps.find(s=>s.role==='employee')!.label='Unassigned';d.mergeValues!.mobile='';d.values.contact='';d.mergeValues!['employee.name']='Signing scale person';d.values['official-name']='Signing scale person';if(d.personnelCompletion){const official=Object.fromEntries(d.fields.filter(field=>field.owner==='pmLocked').map(field=>[field.id,d.values[field.id]??''])),fingerprint=createHash('sha256').update(v9SigningCanonicalText({country:d.personnelCompletion.country,values:official})).digest('hex');d.personnelCompletion.sourceFingerprint=fingerprint;d.personnelCompletion.adoptedAt=new Date().toISOString();for(const field of d.fields)if(d.personnelCompletion.fields[field.id]){d.personnelCompletion.fields[field.id].sourceValue=official[field.id]??'';d.personnelCompletion.fields[field.id].sourceFingerprint=fingerprint;}}d.signing!.contentHash=createHash('sha256').update(v9SigningCanonicalText(v9DocumentSigningContent(d))).digest('hex');return {person,employment,company,caseId,data};});
 // The cloned policy is authored by this actual HR actor; keep the source guard enabled during scale setup.
 await owner.withTenant(admin,async tx=>{
  await tx.execute(sql`insert into company(id,tenant_id,legal_name) select x.id::uuid,${base.tenantId}::uuid,x.name from jsonb_to_recordset(${JSON.stringify(companies)}::jsonb) x(id text,name text)`);
  await tx.execute(sql`insert into person(id,tenant_id,full_name,primary_email) select x.person::uuid,${base.tenantId}::uuid,'Signing scale person',x.person||'@scale.invalid' from jsonb_to_recordset(${JSON.stringify(records.map(({person})=>({person})))}::jsonb) x(person text)`);
  await tx.execute(sql`insert into employment(id,tenant_id,person_id,company_id,hired_on) select x.employment::uuid,${base.tenantId}::uuid,x.person::uuid,x.company::uuid,'2026-01-01'::date from jsonb_to_recordset(${JSON.stringify(records.map(({employment,person,company})=>({employment,person,company})))}::jsonb) x(employment text,person text,company text)`);
  await tx.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,revision,data) select x."caseId"::uuid,${base.tenantId}::uuid,x.company::uuid,x.employment::uuid,'off',x.data->>'number',1,jsonb_set(x.data,'{documents}','[]'::jsonb) from jsonb_to_recordset(${JSON.stringify(records.map(({caseId,company,employment,data})=>({caseId,company,employment,data})))}::jsonb) x("caseId" text,company text,employment text,data jsonb)`);
  await tx.execute(sql`update lc_v9_case c set data=x.data from jsonb_to_recordset(${JSON.stringify(records.map(({caseId,data})=>({caseId,data})))}::jsonb) x("caseId" text,data jsonb) where c.id=x."caseId"::uuid and c.tenant_id=${base.tenantId}::uuid`);
 });
 const first=await v9DocumentSigningWorkspace(admin,{search:'SIGN-SCALE-',offset:0}),second=await v9DocumentSigningWorkspace(admin,{search:'SIGN-SCALE-',offset:50}),last=await v9DocumentSigningWorkspace(admin,{search:'SIGN-SCALE-',offset:950}),expected=records.map(r=>r.caseId).sort();
 const scoped=await owner.withTenant(admin,tx=>tx.execute<{case_id:string;document:{id:string}}>(sql`select case_id,document from app.v9_document_route_sources(${expected[0]}::uuid)`));expect(scoped).toHaveLength(1);expect(scoped.every(row=>row.case_id===expected[0])).toBe(true);const detail=await v9ReadDocumentSigningWork(admin,expected[0],scoped[0].document.id);expect(detail.caseId).toBe(expected[0]);expect(detail.document?.values['official-name']).toBe('Signing scale person');
 expect(first.total).toBe(1000);expect(second.total).toBe(1000);expect(first.items.map(r=>r.caseId)).toEqual(expected.slice(0,50));expect(second.items.map(r=>r.caseId)).toEqual(expected.slice(50,100));expect(last.items.map(r=>r.caseId)).toEqual(expected.slice(950));expect((await v9DocumentSigningWorkspace(other,{search:'SIGN-SCALE-'})).total).toBe(0);
 const companyId=companies[0].id,companyRecords=records.filter(record=>record.company===companyId),companyIds=companyRecords.map(record=>record.caseId).sort(),outside=records.find(record=>record.company!==companyId)!;expect(companyIds).toHaveLength(15);
 const {resolveDevPrincipal}=await import('../lib/session');
 const refreshedContext=async()=>{
  const principal=await resolveDevPrincipal(async userId=>owner.db.execute<{tenant_id:string;person_id:string|null;grants:Grant[]|null}>(sql`select tenant_id,person_id,grants from app.principal(${userId}::uuid) where tenant_id=${base.tenantId}::uuid`),admin.userId!,undefined,async userId=>{const [row]=await owner.db.execute<{blocked:boolean}>(sql`select app.login_blocked(${userId}::uuid) as blocked`);return row.blocked;});
  return {...principal,entitlements:(await entitledCtx(base)).entitlements};
 };
 const narrowed=await owner.db.execute<{id:string}>(sql`update role_assignment set company_id=${companyId}::uuid where tenant_id=${base.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='hr_admin' and company_id is null returning id`);
 try{
  expect(narrowed).toHaveLength(1);const companyContext=await refreshedContext();expect(companyContext.grants).toEqual([{role:'hr_admin',companyId}]);expect(companyContext.personId).toBe(admin.personId);
  // Whole-case HR visibility follows the current real company grant, independently of frozen document participation.
  const workspace=await v9Workspace(companyContext);expect(workspace.cases.map(row=>row.id)).toEqual([...companyIds].reverse());expect(workspace.cases.every(row=>row.facts.company===companyId)).toBe(true);
  const page=await withTenant(companyContext,tx=>tx.execute<{id:string;total:number}>(sql`select id,count(*) over()::int as total from lc_v9_case where tenant_id=${base.tenantId}::uuid order by created_at desc,id desc limit 7 offset 7`));expect(page.map(row=>row.id)).toEqual([...companyIds].reverse().slice(7,14));expect(page.every(row=>row.total===15)).toBe(true);
  expect((await v9CaseDetail(companyContext,companyIds[0])).case.id).toBe(companyIds[0]);await expect(v9CaseDetail(companyContext,outside.caseId)).rejects.toThrow();expect(await withTenant(companyContext,tx=>tx.execute(sql`select id from lc_v9_case where id=${outside.caseId}::uuid and tenant_id=${base.tenantId}::uuid`))).toEqual([]);
  // The same named participant retains document-only access to all 1,000 already frozen routes while licenses remain active.
  const participant=await v9DocumentSigningWorkspace(companyContext,{search:'SIGN-SCALE-'});expect(participant.total).toBe(1000);expect(participant.items.map(row=>row.caseId)).toEqual(expected.slice(0,50));
  const outsideDocument=await v9ReadDocumentSigningWork(companyContext,outside.caseId,outside.data.documents[0].id);expect(outsideDocument.caseId).toBe(outside.caseId);expect(outsideDocument).not.toHaveProperty('case');
  // A company-only lifecycle entitlement is a separate boundary; it is not a reassignment of the frozen route.
  await setModule(base.tenantId,'lifecycle',null);await setModule(base.tenantId,'lifecycle','active',companyId);const licensedContext=await refreshedContext();
  // Legacy public onb/off services still require the global module gate; do not widen it in this fixture.
  await expect(v9DocumentSigningWorkspace(licensedContext,{search:'SIGN-SCALE-'})).rejects.toMatchObject({name:'ModuleNotEnabledError',moduleCode:'lifecycle'});
  await expect(v9ReadDocumentSigningWork(licensedContext,companyIds[0],companyRecords.find(row=>row.caseId===companyIds[0])!.data.documents[0].id)).rejects.toMatchObject({name:'ModuleNotEnabledError',moduleCode:'lifecycle'});
  // The independently authorized SQL custody seam enforces the target-company entitlement floor.
  const [licensed]=await withTenant(licensedContext,tx=>tx.execute<{page:{total:number;items:{caseId:string}[]};inside:{caseId:string}|null;outside:unknown}>(sql`select app.v9_document_signing_work('SIGN-SCALE-',0,50) as page,app.v9_document_route_read(${companyIds[0]}::uuid,${companyRecords.find(row=>row.caseId===companyIds[0])!.data.documents[0].id}) as inside,app.v9_document_route_read(${outside.caseId}::uuid,${outside.data.documents[0].id}) as outside`));
  expect(licensed.page.total).toBe(15);expect(licensed.page.items.map(row=>row.caseId)).toEqual(companyIds);expect(licensed.inside?.caseId).toBe(companyIds[0]);expect(licensed.outside).toBeNull();
 }finally{
  await owner.db.execute(sql`update role_assignment set company_id=null where tenant_id=${base.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='hr_admin' and company_id=${companyId}::uuid`);
  await setModule(base.tenantId,'lifecycle',null,companyId);await setModule(base.tenantId,'lifecycle','active');
 }
 // R4 measured the initial 70/1,000 shape at 19.3s; allow threefold headroom for added scope/detail checks.
},90000);

it('preserves the existing identity reveal permission at the direct scoped source RPC and denies the private source owner',async()=>{
 const {payrollPermissionGrant}=await import('../db/schema');const {id}=await prepared(),mailbox='protected@fictional.invalid';await updatePersonProfilePartial(admin,{personId:employee.personId!,personalEmail:mailbox});
 const source=()=>withTenant(admin,tx=>tx.execute<{value:Record<string,string>}>(sql`select app.v9_document_personnel_values(${id}::uuid) as value`));expect((await source())[0].value.personalEmail).toBe(mailbox);
 await owner.db.insert(payrollPermissionGrant).values({tenantId:base.tenantId,companyId:null,role:'hr_admin',permissionKey:'report.read.identity',allowed:false});
 const hidden=(await source())[0].value;expect(JSON.stringify(hidden)).not.toContain(mailbox);expect(hidden).not.toHaveProperty('personalEmail');expect(hidden).not.toHaveProperty('employee.icNo');expect(hidden._identityFieldsWithheld).toBe('true');
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.v9_document_personnel_source_unchecked(${id}::uuid)`))).rejects.toThrow();
 const config=(await v9Workspace(admin)).config!,template={...structuredClone(config.templates[0]),id:'identity-guarded',name:'Protected identity document'};template.versions[0].fields.push({id:'personal',label:'Personal email',type:'email',owner:'pmLocked',pmKey:'personalEmail',required:false,sensitive:true,options:[],section:'main',when:null});config.templates.push(template);await v9SaveConfig(admin,config.revision,config);const c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;await expect(v9Command(admin,id,c.revision,{type:'generate',template:template.id})).rejects.toThrow('protected Personnel identity');
});

it('does not emit an HR signature source event for review-only HR followed by the employee signature',async()=>{
 const {id}=await prepared(),config=(await v9Workspace(admin)).config!,template={...structuredClone(config.templates[0]),id:'review-only-hr',name:'Review then employee sign'};template.versions[0].routing=template.versions[0].routing!.filter(step=>step.id!=='hr-sign');template.versions[0].blocks=template.versions[0].blocks.filter(block=>block.role!=='step:hr-sign');config.templates.push(template);config.workflows.push({id:'actual-hr-signed',name:'Only actual HR signature',module:'off',status:'published',trigger:{event:'hrSigned',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',subject:'HR signed',body:'Actual signature',to:['employee'],cc:[]}],description:''});await v9SaveConfig(admin,config.revision,config);let c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;await v9Command(admin,id,c.revision,{type:'generate',template:template.id});c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;const d=c.documents.find(d=>d.templateId===template.id)!,item=await v9ReadDocumentSigningWork(employee,id,d.id);await v9DocumentRouteEdit(employee,{caseId:id,caseRevision:item.caseRevision,documentId:d.id,values:{answer:'Reviewed'}});await act(admin,id,d.id,'review','reviewed');await act(employee,id,d.id,'employee-sign','signed');c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;
 expect(c.runs.filter(run=>run.sourceEvent?.kind==='hrSigned')).toEqual([]);expect(c.runs.some(run=>run.sourceEvent?.kind==='docSigned'&&run.sourceEvent.sourceId===d.id)).toBe(true);
});
it('uses the verified assignment closed by the actual exit for after-LWD linked organisation fields',async()=>{
 const exit='2026-11-17';const {id}=await prepared(false,exit),config=(await v9Workspace(admin)).config!,template={...structuredClone(config.templates[0]),id:'after-exit',name:'After exit record'};template.versions[0].fields=[{id:'dept',label:'Department',type:'text',owner:'pmLocked',pmKey:'employee.department',required:true,sensitive:false,options:[],section:'main',when:null},{id:'position',label:'Position',type:'text',owner:'pmLocked',pmKey:'employee.position',required:true,sensitive:false,options:[],section:'main',when:null}];template.versions[0].routing=[{id:'hr-sign',order:1,action:'sign',who:{kind:'people',userIds:[admin.userId!]},owner:true}];template.versions[0].blocks=[{id:'dept-field',type:'field',fieldId:'dept',text:'',section:''},{id:'position-field',type:'field',fieldId:'position',text:'',section:''},{id:'signature',type:'signature',role:'step:hr-sign',text:'',section:''}];config.templates.push(template);await v9SaveConfig(admin,config.revision,config);
 await terminateEmployment(admin,{employmentId,terminationDate:exit,terminationReason:'Fictional actual exit'});const [boundary]=await owner.db.execute<{id:string}>(sql`select id from assignment where employment_id=${employmentId}::uuid and tenant_id=${base.tenantId}::uuid and superseded_at is null and valid_to=${exit}::date`);expect(boundary).toBeDefined();let c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;const retained=structuredClone(c.documents[0]);
 // Exact retained bytes remain readable/writable by case HR after the employee login becomes inactive.
 const unchanged=await withTenant(admin,tx=>tx.execute(sql`update lc_v9_case set data=data where id=${id}::uuid and tenant_id=${base.tenantId}::uuid returning id`));expect(unchanged).toHaveLength(1);
 await expect(act(employee,id,retained.id,'employee-sign','signed')).rejects.toThrow();
 const forged=structuredClone(c);forged.documents[0].signing!.actions.push({id:'forged-after-exit',stepId:'review',contentRevision:retained.signing!.contentRevision,contentHash:retained.signing!.contentHash,actorId:admin.userId!,actorPersonId:admin.personId!,actorName:'Fictional signing HR',representedId:admin.userId!,role:'people',at:new Date().toISOString(),action:'reviewed',comment:'',signature:null});
 await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_case set data=${JSON.stringify(forged)}::jsonb where id=${id}::uuid and tenant_id=${base.tenantId}::uuid`))).rejects.toThrow();
 await v9Command(admin,id,c.revision,{type:'generate',template:template.id});c=(await v9Workspace(admin)).cases.find(c=>c.id===id)!;const d=c.documents.find(d=>d.templateId===template.id)!;expect(c.documents.find(d=>d.id===retained.id)).toEqual(retained);expect(d.values).toMatchObject({dept:'Finance',position:'Executive'});expect(d.personnelSourceReference).toMatchObject({basis:'exit-boundary',asOf:exit,assignmentId:boundary.id});expect(d.mergeValues).not.toHaveProperty('_assignmentId');expect(d.mergeValues).not.toHaveProperty('personalEmail');
});


it('requires real Person custody only for document holders, including fixed, named and group choices',async()=>{
 const {id}=await prepared();
 let config=(await v9Workspace(admin)).config!;
 const mixedGroup='document-person-mixed',emptyGroup='document-person-missing';
 config.groups.push({id:mixedGroup,name:'Fictional signing candidates',members:[employee.userId!,admin.userId!],limit:0},{id:emptyGroup,name:'Fictional missing signing Person',members:[employee.userId!],limit:0});
 // Publish shared groups first: Offboarding route references validate against their current canonical owner.
 await v9SaveConfig(admin,config.revision,config);config=(await v9Workspace(admin)).config!;
 const template=structuredClone(config.templates[0]);template.id='person-custody-check';template.name='Person custody check';
 template.versions[0].routing=[
  {id:'hr-sign',order:1,action:'sign',owner:true,who:{kind:'people',userIds:[admin.userId!]}},
  {id:'employee-sign',order:2,action:'sign',owner:false,who:{kind:'employee'}},
  {id:'named-missing',order:2,action:'review',owner:false,who:{kind:'people',userIds:[employee.userId!]}},
  {id:'group-any',order:2,action:'review',owner:false,who:{kind:'group',groupId:mixedGroup},pick:'any'},
  {id:'group-round-robin',order:2,action:'review',owner:false,who:{kind:'group',groupId:mixedGroup},pick:'roundRobin'},
  {id:'group-missing',order:2,action:'review',owner:false,who:{kind:'group',groupId:emptyGroup}},
 ];
 config.templates.push(template);await v9SaveConfig(admin,config.revision,config);
 // The saved routing was valid; the account subsequently lost its Personnel binding.
 await owner.withTenant(admin,tx=>tx.execute(sql`update app_user set person_id=null where id=${employee.userId!}::uuid and tenant_id=${base.tenantId}::uuid`));
 let current=(await v9CaseDetail(admin,id)).case;
 await v9Command(admin,id,current.revision,{type:'generate',template:template.id});
 current=(await v9CaseDetail(admin,id)).case;
 const document=current.documents.find(document=>document.templateId===template.id)!;
 expect(document.signing!.route.steps.map(step=>({id:step.id,holderId:step.holderId,holderPersonId:step.holderPersonId??null}))).toEqual([
  {id:'hr-sign',holderId:admin.userId,holderPersonId:admin.personId},
  {id:'employee-sign',holderId:null,holderPersonId:null},
  {id:'named-missing',holderId:null,holderPersonId:null},
  {id:'group-any',holderId:admin.userId,holderPersonId:admin.personId},
  {id:'group-round-robin',holderId:admin.userId,holderPersonId:admin.personId},
  {id:'group-missing',holderId:null,holderPersonId:null},
 ]);
 expect(document.signing!.actions).toEqual([]);
 expect(document.routingUnresolved?.map(item=>item.stepId)).toEqual(['employee-sign','named-missing','group-missing']);
 expect((await owner.client`select person_id,archived_at from app_user where id=${employee.userId!}::uuid`)[0]).toEqual({person_id:null,archived_at:null});
});
