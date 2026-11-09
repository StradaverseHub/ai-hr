/** Real native readers, populated facts and independent expectations; no provider or delivery calls. */
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import * as letters from '../core/letters';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {sweepLetterAutomationFromSweep} from '../core/letter-automation';
import {listPresentationWorkforcePickPageTx,readPresentationWorkforcePickRowsTx,listReadOnlyWorkforcePickPageTx} from '../core/read';
import {assertWorkforcePresentationEmploymentTx} from '../core/workforce-access';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import type {LetterDocument,LetterField,LetterValue} from '../lib/letter-model';
import type {LetterPolicy} from '../lib/letter-workflow';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext,reviewer:SessionContext,signer:SessionContext,self:SessionContext;
let employees:Awaited<ReturnType<typeof hireEmployee>>[],templateId:string,versionId:string,policyId:string,ruleId:string,headId:string;
let fields:{id:string;definition:LetterField}[],draftId:string,pendingId:string,issuedId:string,issuedHash:string;
const effectiveDate='2030-01-15';
const customValues:Record<string,LetterValue>={effectiveDate:{kind:'date',value:effectiveDate},bonus:{kind:'currency',value:'125.50',currency:'MYR'}};
const definitions:LetterField[]=[
 ['employeeName','employee.name','text'],['employeeCode','employee.code','text'],['hiredOn','employment.hiredOn','date'],
 ['department','employment.department','text'],['jobTitle','employment.jobTitle','text'],['companyName','company.name','text'],
 ['salary','compensation.basicSalary','currency'],['effectiveDate','custom.date','date'],['bonus','custom.currency','currency'],
].map(([key,source,kind])=>({key,label:key,description:'Fictional snapshot fixture '+key,source:source as LetterField['source'],kind:kind as LetterField['kind'],required:true,editable:source.startsWith('custom.'),sensitive:kind==='currency'}));
const document:LetterDocument={version:1,language:'en',blocks:definitions.map(field=>({type:'paragraph',content:[{type:'field',key:field.key}]}))};
// This serializer encodes the published hash contract. Expected facts and rendered text below are
// fixed independently; neither a presentation result nor a second call supplies the expected data.
function fingerprint(value:unknown):string{
 const ordered=(item:unknown):unknown=>Array.isArray(item)?item.map(ordered):item!==null&&typeof item==='object'?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,ordered(child)])):item;
 return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
function expectedValues(index:number,name='Fictional snapshot subject '+(index+1),salary=index===0?'7654.32':'4321.09'){
 return {employeeName:{kind:'text',value:name},employeeCode:{kind:'text',value:'SNAP-'+(index+1)},hiredOn:{kind:'date',value:'2020-02-03'},department:{kind:'text',value:'Finance'},jobTitle:{kind:'text',value:'Executive'},companyName:{kind:'text',value:'Acme Sdn Bhd'},salary:{kind:'currency',value:salary,currency:'MYR'},...customValues};
}
function expectedDocument(index:number,name='Fictional snapshot subject '+(index+1),salary=index===0?'MYR 7,654.32':'MYR 4,321.09'){
 return {version:1,language:'en',blocks:[name,'SNAP-'+(index+1),'3 February 2020','Finance','Executive','Acme Sdn Bhd',salary,'15 January 2030','MYR 125.50'].map(text=>({type:'paragraph',content:[{type:'text',text}]}))};
}
function expectedSourceHash(index:number,name?:string,salary?:string){return fingerprint({employmentId:employees[index].employmentId,companyId:b.companyId,templateVersionId:versionId,policyVersionId:policyId,referenceDate:todayInKualaLumpur(),values:expectedValues(index,name,salary),fields:[...fields].sort((a,b)=>a.definition.key<b.definition.key?-1:1)});}
function selection(ids:string[]){return {companyId:b.companyId,templateVersionId:versionId,employmentIds:ids,customValues:Object.fromEntries(ids.map(id=>[id,customValues])),operationKey:randomUUID()};}
async function nativeActor(name:string){const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@example.invalid'}).returning();return {...ctx,userId:await createAppUser(b.tenantId,person.id,'hr_admin'),personId:person.id};}

beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');
 await resetDb();b=await seedBase();ctx=await entitledCtx(b);reviewer=await nativeActor('Fictional snapshot officer');signer=await nativeActor('Fictional snapshot signatory');
 employees=[];for(const index of [0,1]){
  const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2020-02-03',employeeCode:'SNAP-'+(index+1),person:{fullName:'Fictional snapshot subject '+(index+1),primaryEmail:'snapshot-subject-'+index+'@example.invalid'}});employees.push(hired);
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:index===0?7654.32:4321.09,currency:'MYR',effectiveFrom:'2020-02-03'});
 }
 self={...ctx,userId:await createAppUser(b.tenantId,employees[0].personId,'employee'),personId:employees[0].personId,roles:['employee']};
 fields=[];for(const definition of definitions){const saved=await letters.saveLetterField(ctx,{companyId:b.companyId,definition,active:true});fields.push({id:saved.id,definition});}
 const template=await letters.saveLetterTemplate(ctx,{companyId:b.companyId,code:'SNAPSHOT',name:'Fictional salary confirmation',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:fields.map(field=>field.id)});templateId=template.templateId;versionId=template.versionId;
 await letters.decideLetterTemplate(ctx,{versionId,expectedStatus:'draft',action:'submit'});await letters.decideLetterTemplate(signer,{versionId,expectedStatus:'submitted',action:'approve'});
 const policy:LetterPolicy={version:1,stages:[{key:'officer',label:'HR officer',userIds:[reviewer.userId!],allowDelegation:true},{key:'signatory',label:'Authorised signatory',userIds:[signer.userId!],allowDelegation:false}],signatoryUserId:signer.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};
 policyId=(await letters.saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',policy,enabled:true})).id;
 await letters.saveLetterPermission(ctx,{companyId:b.companyId,role:'employee',capability:'settings',allowed:false});
 headId=(await letters.addLetterAsset(ctx,{companyId:b.companyId,kind:'letterhead',name:'Fictional snapshot header',content:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh2kAAAAASUVORK5CYII=','base64')})).id;
 draftId=(await letters.createLetterDraftBatch(ctx,selection(employees.map(row=>row.employmentId)))).batchId;
 const issuedBatch=(await letters.createLetterDraftBatch(ctx,selection([employees[0].employmentId]))).batchId;
 await letters.submitLetterBatch(ctx,issuedBatch);
 const issued=(await letters.getLetterGenerationBatch(ctx,issuedBatch))!.rows[0];issuedId=issued.record.id;
 await letters.decideLetter(reviewer,{letterId:issuedId,expectedRevisionId:issued.revision!.id,expectedLockVersion:issued.record.lockVersion,decision:{action:'approve',comment:'Independent source review',confirmSignature:false}});
 await letters.decideLetter(signer,{letterId:issuedId,expectedRevisionId:issued.revision!.id,expectedLockVersion:issued.record.lockVersion+1,decision:{action:'approve',comment:'Sign exact fixture',confirmSignature:true}});
 await letters.issueLetter(ctx,{letterId:issuedId,expectedRevisionId:issued.revision!.id,expectedLockVersion:issued.record.lockVersion+2});issuedHash=(await letters.getMyLetter(self,issuedId)).artifact.contentHash;
 const pending=(await letters.createLetterDraftBatch(ctx,selection([employees[1].employmentId]))).batchId;await letters.submitLetterBatch(ctx,pending);pendingId=(await letters.getLetterGenerationBatch(ctx,pending))!.rows[0].record.id;
 ruleId=(await letters.saveLetterAutomationRule(ctx,{companyId:b.companyId,templateId,trigger:'probation_due',expectedOrdinal:0,enabled:true,customValues})).id;
 await setEmploymentInfo(ctx,{employmentId:employees[1].employmentId,confirmationDate:todayInKualaLumpur()});
 expect(await sweepLetterAutomationFromSweep({tenantId:b.tenantId,roles:[]},owner)).toMatchObject({registered:1,created:1,failed:0});
});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});

function displayRoots(){const co={companyId:b.companyId},fieldId=fields[0].id;return [
 {name:'company access',run:()=>letters.letterCompanyAccess(ctx),expected:[{id:b.companyId,read:true,generate:true,settings:true}]},
 {name:'template heads',run:()=>letters.listLetterTemplateHeads(ctx,co),expected:{rows:[{id:headId,name:'Fictional snapshot header'}]}},
 {name:'employee choices',run:()=>letters.listLetterEmployeeChoices(ctx,co),expected:{rows:[{employmentId:employees[0].employmentId,name:'Fictional snapshot subject 1'},{employmentId:employees[1].employmentId,name:'Fictional snapshot subject 2'}]}},
 {name:'signatories',run:()=>letters.listLetterSignatories(ctx,{...co,search:'snapshot signatory'}),expected:{rows:[{id:signer.userId,name:'Fictional snapshot signatory'}]}},
 {name:'asset choices',run:()=>letters.letterAssetChoices(ctx,b.companyId),expected:[{id:headId,name:'Fictional snapshot header'}]},
 {name:'setting asset metadata',run:()=>letters.listLetterSettingAssets(ctx,{...co,kind:'letterhead'}),expected:{rows:[{id:headId,name:'Fictional snapshot header'}]}},
 {name:'policies',run:()=>letters.listLetterPolicies(ctx,co),expected:{rows:[{id:policyId,category:'confirmation'}]}},
 {name:'policy detail',run:()=>letters.getLetterPolicy(ctx,{...co,category:'confirmation'}),expected:{id:policyId,people:expect.arrayContaining([{id:signer.userId,name:'Fictional snapshot signatory'}])}},
 {name:'settings readiness',run:()=>letters.readLetterSettingsReadiness(ctx,b.companyId),expected:{publicOrigin:true,notifications:false,email:false}},
 {name:'permissions',run:()=>letters.readLetterPermissions(ctx,b.companyId),expected:[{role:'employee',capability:'settings',allowed:false}]},
 {name:'fields',run:()=>letters.listLetterFields(ctx,co),expected:{items:expect.arrayContaining([expect.objectContaining({id:fields[6].id,definition:definitions[6],active:true,ordinal:1})])}},
 {name:'automation rules',run:()=>letters.listLetterAutomationRules(ctx,co),expected:{rows:[{id:ruleId,enabled:true}]}},
 {name:'automation rule detail',run:()=>letters.getLetterAutomationRule(ctx,{...co,templateId,trigger:'probation_due'}),expected:{id:ruleId,enabled:true}},
 {name:'automation rule info',run:()=>letters.letterAutomationRuleInfo(ctx,{...co,ruleIds:[ruleId]}),expected:{canEnable:true,rows:[{id:ruleId,eligible:true,templateCode:'SNAPSHOT'}]}},
 {name:'automation jobs',run:()=>letters.listLetterAutomationJobs(ctx,co),expected:{rows:[{ruleId,status:'completed',sourceDate:todayInKualaLumpur()}]}},
 {name:'generation batch',run:()=>letters.getLetterGenerationBatch(ctx,draftId),expected:{total:2,ready:2,needsCorrection:0,rows:expect.arrayContaining([expect.objectContaining({employee:expect.objectContaining({name:'Fictional snapshot subject 1'}),sourceChanged:false,revision:expect.objectContaining({values:expectedValues(0),document:expectedDocument(0),sourceHash:expectedSourceHash(0),contentHash:fingerprint({document:expectedDocument(0),sourceHash:expectedSourceHash(0)})})}),expect.objectContaining({employee:expect.objectContaining({name:'Fictional snapshot subject 2'}),sourceChanged:false,revision:expect.objectContaining({values:expectedValues(1),document:expectedDocument(1),sourceHash:expectedSourceHash(1)})})])}},
 {name:'generation batches',run:()=>letters.listLetterGenerationBatches(ctx,co),expected:{rows:expect.arrayContaining([expect.objectContaining({id:draftId,total:2,drafts:2})])}},
 {name:'my letters',run:()=>letters.listMyLetters(self),expected:{rows:[{id:issuedId,state:'issued',viewed:false,confirmed:null}]}},
 {name:'my letter',run:()=>letters.getMyLetter(self,issuedId),expected:{record:{id:issuedId,state:'issued'},artifact:{contentHash:issuedHash},acknowledgement:'acknowledge',events:[]}},
 {name:'register',run:()=>letters.listLetterRegister(ctx,co),expected:{rows:[{id:issuedId,state:'issued',employeeName:'Fictional snapshot subject 1'}]}},
 {name:'approval queue',run:()=>letters.listLetterApprovalQueue(reviewer,co),expected:{rows:[{record:{id:pendingId,state:'submitted'},employeeName:'Fictional snapshot subject 2',stageLabel:'HR officer'}]}},
 {name:'staff detail',run:()=>letters.getStaffLetter(ctx,issuedId),expected:{record:{id:issuedId,state:'issued'},employee:{name:'Fictional snapshot subject 1'},revision:{values:expectedValues(0)},decisions:[{action:'approve'},{action:'approve'}]}},
 {name:'delegates',run:()=>letters.listLetterDelegates(reviewer,{letterId:pendingId,search:'snapshot signatory'}),expected:{rows:[{id:signer.userId,name:'Fictional snapshot signatory'}]}},
 {name:'audit',run:()=>letters.letterAudit(ctx,{letterId:issuedId}),expected:{rows:expect.arrayContaining([expect.objectContaining({type:'letter.issued'})])}},
 {name:'templates',run:()=>letters.listLetterTemplates(ctx,co),expected:{rows:[{root:{id:templateId},version:{id:versionId,status:'approved'}}]}},
 {name:'template detail',run:()=>letters.getLetterTemplate(ctx,versionId,{forGeneration:true}),expected:{root:{id:templateId},version:{id:versionId},fields:expect.arrayContaining([expect.objectContaining({id:fieldId})])}},
 {name:'template versions',run:()=>letters.listLetterTemplateVersions(ctx,{templateId}),expected:{rows:[{id:versionId,status:'approved'}]}},
 {name:'preview',run:()=>letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues}),expected:{document:expectedDocument(0),usedFields:definitions.map(field=>field.key).sort()}},
 {name:'field dependencies',run:()=>letters.letterFieldDependencies(ctx,{fieldVersionId:fieldId}),expected:{rows:[{versionId,templateId,code:'SNAPSHOT'}]}},
 {name:'field access',run:()=>letters.letterFieldAccess(ctx,b.companyId),expected:{canEdit:true,canUseSensitive:true}},
 {name:'field detail',run:()=>letters.getLetterField(ctx,fieldId),expected:{field:{id:fieldId,definition:definitions[0]},isLatest:true,inUse:true}},
 {name:'field history',run:()=>letters.letterFieldHistory(ctx,{...co,key:'employeeName'}),expected:{rows:[{id:fieldId,ordinal:1}]}},
 {name:'policy history',run:()=>letters.letterPolicyHistory(ctx,{...co,category:'confirmation'}),expected:{rows:[{id:policyId,ordinal:1}]}},
 {name:'report departments',run:()=>letters.letterReportDepartments(ctx,b.companyId),expected:expect.arrayContaining([expect.objectContaining({id:b.deptA,name:'Finance'})])},
 {name:'report',run:()=>letters.readLetterReport(ctx,{...co,from:todayInKualaLumpur(),to:todayInKualaLumpur()}),expected:{summary:{total:5,issued:1,pendingApproval:1,pendingAcknowledgement:1},rows:expect.arrayContaining([expect.objectContaining({id:issuedId,employee_name:'Fictional snapshot subject 1',state:'issued'})]),period:{from:todayInKualaLumpur(),to:todayInKualaLumpur()},timezone:'Asia/Kuala_Lumpur'}},
];}

it.each(['access-configuration:','payroll-history:'])('completes all 35 populated display roots while actual exclusive %s writer is held',async namespace=>{
 const roots=displayRoots();expect(roots).toHaveLength(35);expect(new Set(roots.map(root=>root.name)).size).toBe(35);
 const before=await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).orderBy(s.domainEvent.id),modes:{isolation:string;readOnly:string}[]=[];
 const actual=database.withTenant;
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock(hashtextextended(${namespace+b.tenantId},0))`;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);
   const [mode]=await tx.execute<{isolation:string;readOnly:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as "readOnly"`);modes.push(mode);
   return read(tx);
  },options));
  try{
   for(const root of roots)expect(await root.run(),root.name).toMatchObject(root.expected);
  }
  finally{spy.mockRestore();}
 });
 expect(modes).toHaveLength(35);expect(modes.every(mode=>mode.isolation==='repeatable read'&&mode.readOnly==='on')).toBe(true);
 expect(await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).orderBy(s.domainEvent.id)).toEqual(before);
});

it('requires genuine RR/RO carriers for every borrowed presentation seam and PostgreSQL rejects an actual write',async()=>{
 const actions:((tx:Tx)=>Promise<unknown>)[]=[(tx:Tx)=>listPresentationWorkforcePickPageTx(ctx,tx,{companyIds:[b.companyId],limit:25}),(tx:Tx)=>readPresentationWorkforcePickRowsTx(ctx,tx,[employees[0].employmentId]),(tx:Tx)=>assertWorkforcePresentationEmploymentTx(tx,ctx,employees[0].employmentId)];
 for(const read of actions){
  await expect(database.withTenant(ctx,read)).rejects.toThrow();
  await expect(database.withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);return read(tx);})).rejects.toThrow();
  await database.withTenant(ctx,read,{readOnlySnapshot:true});
 }
 const result=await database.withTenant(ctx,async tx=>{
  await actions[0](tx);await actions[1](tx);await actions[2](tx);
  await tx.update(s.company).set({legalName:'Forbidden snapshot mutation'}).where(eq(s.company.id,b.companyId));
 },{readOnlySnapshot:true}).then(()=>null,error=>pgSqlState(error));
 expect(result).toBe('25006');expect((await owner.db.select().from(s.company).where(eq(s.company.id,b.companyId)))[0].legalName).toBe('Acme Sdn Bhd');
 // The older API still rejects a mutable carrier and keeps its shared Access barrier.
 await expect(database.withTenant(ctx,tx=>listReadOnlyWorkforcePickPageTx(ctx,tx,{companyIds:[b.companyId],limit:25}))).rejects.toThrow('read-only transaction');
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  expect(await database.withTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set transaction read only`);return listReadOnlyWorkforcePickPageTx(ctx,tx,{companyIds:[b.companyId],limit:25});}).then(()=>null,error=>pgSqlState(error))).toBe('55P03');
 });
});

it('rejects every display root after actual login archival, then rejects fresh forged grants and Person substitutions',async()=>{
 const originals=[ctx,reviewer,self];
 for(const actor of originals)await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,actor.userId!));
 for(const root of displayRoots())await expect(root.run(),root.name).rejects.toMatchObject({code:'permission'});
 for(const actor of originals)await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,actor.userId!));
 for(const actor of [
  {...ctx,userId:randomUUID()},
  {...ctx,personId:employees[0].personId},
  {...ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},
  {...ctx,entitlementsExempt:'seeding'},
  {...ctx,statutoryOverride:'Fictional forbidden display override'},
 ] as SessionContext[]){await expect(letters.letterCompanyAccess(actor)).rejects.toMatchObject({code:'permission'});await expect(letters.getLetterGenerationBatch(actor,draftId)).rejects.toMatchObject({code:'permission'});}
 await expect(letters.getMyLetter({...self,personId:employees[1].personId},issuedId)).rejects.toMatchObject({code:'permission'});
 const [otherPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional relink target',primaryEmail:'fictional-relink-target@example.invalid'}).returning();
 await owner.db.update(s.appUser).set({personId:otherPerson.id}).where(eq(s.appUser.id,self.userId!));
 await expect(letters.listMyLetters(self)).rejects.toMatchObject({code:'permission'});
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,ctx.userId!));
 await expect(letters.letterCompanyAccess(ctx)).rejects.toMatchObject({code:'permission'});
});

it('retains company, tenant, subject, sensitive-field and specific Letters-capability denials',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated company'}).returning();
 const scoped=await nativeActor('Fictional scoped reader');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,scoped.userId!));
 const narrowed={...scoped,grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await letters.getLetterTemplate(narrowed,versionId)).toMatchObject({version:{id:versionId}});
 await expect(letters.listLetterPolicies(narrowed,{companyId:other.id})).rejects.toMatchObject({code:'permission'});
 expect(await letters.letterCompanyAccess(narrowed)).not.toContainEqual(expect.objectContaining({id:other.id}));
 await expect(letters.letterCompanyAccess({...narrowed,grants:[{role:'hr_admin',companyId:null}]})).rejects.toMatchObject({code:'permission'});
 const foreign=await seedBase();
 await expect(letters.letterCompanyAccess({...ctx,tenantId:foreign.tenantId,entitlements:{...ctx.entitlements!,tenantId:foreign.tenantId}})).rejects.toMatchObject({code:'permission'});
 await expect(letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:randomUUID(),customValues})).rejects.toThrow();
 const foreignSubject=await hireEmployee(await entitledCtx(foreign),{companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:'Fictional foreign subject',primaryEmail:randomUUID()+'@example.invalid'}});
 await expect(letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:foreignSubject.employmentId,customValues})).rejects.toThrow();
 const colleague={...ctx,userId:await createAppUser(b.tenantId,employees[1].personId,'employee'),personId:employees[1].personId,roles:['employee']};
 expect(await letters.listMyLetters(colleague)).toMatchObject({rows:[]});await expect(letters.getMyLetter(colleague,issuedId)).rejects.toMatchObject({code:'permission'});
 for(const capability of ['read','template','generate'] as const)await letters.saveLetterPermission(ctx,{companyId:b.companyId,role:'employee',capability,allowed:true});
 expect((await letters.listLetterFields(colleague,{companyId:b.companyId})).items.some(field=>field.definition.sensitive)).toBe(false);
 expect(await letters.getLetterField(colleague,fields[6].id)).toBeNull();await expect(letters.getLetterTemplate(colleague,versionId)).rejects.toMatchObject({code:'permission'});
 await expect(letters.previewLetterTemplate(colleague,{templateVersionId:versionId,employmentId:employees[1].employmentId,customValues})).rejects.toThrow();
 for(const capability of ['template','generate'] as const)await letters.saveLetterPermission(ctx,{companyId:b.companyId,role:'hr_admin',capability,allowed:false});
 await expect(letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues})).rejects.toMatchObject({code:'permission'});
 await letters.saveLetterPermission(ctx,{companyId:b.companyId,role:'hr_admin',capability:'report',allowed:false});
 await expect(letters.readLetterReport(ctx,{companyId:b.companyId,from:todayInKualaLumpur(),to:todayInKualaLumpur()})).rejects.toMatchObject({code:'permission'});
});

it('reads old committed source rows behind a real row writer, then detects the commit and commands recapture the new facts',async()=>{
 const before=(await letters.getLetterGenerationBatch(ctx,draftId))!.rows.find(row=>row.record.employmentId===employees[0].employmentId)!;
 await owner.client.begin(async writer=>{
  await writer`update person set full_name='Fictional corrected source' where id=${employees[0].personId}`;
  await writer`update compensation set basic_salary='8765.43' where employment_id=${employees[0].employmentId}`;
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);return read(tx);},options));
  try{
   expect(await letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues})).toMatchObject({document:expectedDocument(0)});
   const row=(await letters.getLetterGenerationBatch(ctx,draftId))!.rows.find(row=>row.record.employmentId===employees[0].employmentId)!;
   expect(row).toMatchObject({ready:true,sourceChanged:false,issue:null,revision:{values:expectedValues(0),sourceHash:expectedSourceHash(0)}});
  }finally{spy.mockRestore();}
 });
 expect(await letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues})).toMatchObject({document:expectedDocument(0,'Fictional corrected source','MYR 8,765.43')});
 const stale=(await letters.getLetterGenerationBatch(ctx,draftId))!.rows.find(row=>row.record.id===before.record.id)!;expect(stale).toMatchObject({sourceChanged:true,ready:false,revision:{values:expectedValues(0)}});
 await expect(letters.submitLetterBatch(ctx,draftId)).rejects.toMatchObject({code:'stale'});
 const refreshed=await letters.refreshLetterDraft(ctx,{letterId:before.record.id,expectedLockVersion:before.record.lockVersion});
 expect(refreshed).toMatchObject({ordinal:2,values:expectedValues(0,'Fictional corrected source','8765.43'),document:expectedDocument(0,'Fictional corrected source','MYR 8,765.43'),sourceHash:expectedSourceHash(0,'Fictional corrected source','8765.43')});
 const recaptured=(await letters.createLetterDraftBatch(ctx,selection([employees[0].employmentId]))).batchId;
 expect((await letters.getLetterGenerationBatch(ctx,recaptured))!.rows[0].revision).toMatchObject({values:expectedValues(0,'Fictional corrected source','8765.43'),sourceHash:refreshed.sourceHash,contentHash:refreshed.contentHash});
 expect((await owner.db.select().from(s.letterRevision).where(eq(s.letterRevision.id,before.revision!.id)))[0]).toEqual(before.revision);
});

it('pins authority and source before a concurrent committed revocation, and denies the next snapshot',async()=>{
 const actual=database.withTenant;let observed=false;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  if(!observed){observed=true;
   // Bootstrap has already pinned RR's database snapshot. Commit both authority and source changes
   // before the business callback; old permission cannot be combined with the new private field.
   await owner.client.begin(async writer=>{
    await writer`update person set full_name='Fictional post-admission name' where id=${employees[0].personId}`;
    await writer`update role_assignment set role='employee' where app_user_id=${ctx.userId!}`;
   });
  }
  return read(tx);
 },options));
 try{expect(await letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues})).toMatchObject({document:expectedDocument(0)});}
 finally{spy.mockRestore();}
 expect(observed).toBe(true);await expect(letters.previewLetterTemplate(ctx,{templateVersionId:versionId,employmentId:employees[0].employmentId,customValues})).rejects.toMatchObject({code:'permission'});
});

it('captures nested caller input and principal values before the asynchronous transaction starts',async()=>{
 const actual=database.withTenant,context=structuredClone(ctx),input={templateVersionId:versionId,employmentId:employees[0].employmentId,customValues:structuredClone(customValues)};
 let proceed!:()=>void;const barrier=new Promise<void>(resolve=>{proceed=resolve;});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(bound:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(bound,async tx=>{await barrier;return read(tx);},options));
 let reading:ReturnType<typeof letters.previewLetterTemplate>|undefined;
 try{
  reading=letters.previewLetterTemplate(context,input);
  context.userId=randomUUID();context.roles!.push('super_admin');context.personId=employees[1].personId;
  input.employmentId=employees[1].employmentId;input.customValues.effectiveDate={kind:'date',value:'2099-12-31'};
  proceed();expect(await reading).toMatchObject({document:expectedDocument(0)});
 }finally{proceed();await Promise.allSettled(reading?[reading]:[]);spy.mockRestore();}
});

it.each(['access-configuration:','payroll-history:'])('keeps actual draft commands waiting behind %s and rechecks a committed capability revocation',async namespace=>{
 let ready!:()=>void,release!:()=>void,fail!:(error:unknown)=>void;
 const entered=new Promise<void>((resolve,reject)=>{ready=resolve;fail=reject;}),finish=new Promise<void>(resolve=>{release=resolve;});
 const watchdog=setTimeout(()=>{fail(Error('Letters command writer handshake timed out'));release();},5000);
 const writing=owner.withTenant(ctx,async writer=>{
  await writer.execute(sql`select pg_advisory_xact_lock(hashtextextended(${namespace+b.tenantId},0))`);
  ready();await finish;
  await writer.insert(s.letterCapabilityGrant).values({tenantId:b.tenantId,companyId:b.companyId,role:'hr_admin',capability:'generate',allowed:false}).onConflictDoUpdate({target:[s.letterCapabilityGrant.tenantId,s.letterCapabilityGrant.companyId,s.letterCapabilityGrant.capability,s.letterCapabilityGrant.role],set:{allowed:false}});
 });void writing.catch(fail);
 let command:ReturnType<typeof letters.createLetterDraftBatch>|undefined;
 try{
  await entered;command=letters.createLetterDraftBatch(ctx,selection([employees[0].employmentId]));void command.catch(()=>{});
  const deadline=Date.now()+4000;let waiting=false;
  while(Date.now()<deadline){
   const [row]=await owner.client<{waiting:boolean}[]>`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=1 and l.database=(select oid from pg_database where datname=current_database()) and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${namespace+b.tenantId},0)) as waiting`;
   if(row.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting,'actual createLetterDraftBatch must retain its native write/history barrier').toBe(true);
 }finally{release();clearTimeout(watchdog);await writing;await Promise.allSettled(command?[command]:[]);}
 expect(command).toBeDefined();await expect(command!).rejects.toMatchObject({code:'permission'});
 expect(await owner.db.select().from(s.letterGenerationBatch)).toHaveLength(4);
});
