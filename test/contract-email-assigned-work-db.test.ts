/** Actual native Manual email/Form + Personnel journey; all identities are fictional. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {migrateTestDb,closeAll,owner,createAppUser,setModule,entitledCtx} from './harness';
import {contractPostingFixture,finishContractPostingJob} from './helpers/contract-posting-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {startContractSharedManualWorkflow,contractSharedContext,contractSharedWorkPage,contractSharedLetterActions,readContractSharedLetter,readContractSharedForm,saveContractSharedForm,actContractSharedLetter,bindContractSharedEmployee,previewContractSharedDecision,submitContractSharedDecision,readContractSharedApproval,actContractSharedApproval,listContractSharedPostings,approveContractSharedPosting} from '../packs/contracts/service';
import {historicalEmailPostingFixture} from './helpers/contract-email-work-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
it('discovers the exact historical pinned Form after actual posting and links only the uniquely verified employee',async()=>{
 const f=await historicalEmailPostingFixture(),email=f.email;
 const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');const employee:SessionContext={...f.employeeActor,userId};
 // The archived account A and verified account B have the same immutable Personnel identity.
 expect((await contractSharedWorkPage(f.employeeActor,{category:'tasks',limit:1})).total).toBe(0);
 await expect(readContractSharedLetter(f.employeeActor,email.id)).rejects.toThrow();
 const [unverified]=await owner.withTenant(f.employeeActor,tx=>tx.execute<{available:boolean}>(sql`select app.contract_shared_email_self_binding_available(${email.id}::uuid) as available`));expect(unverified.available).toBe(false);
 const unscoped=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id','',true),set_config('app.user_id','',true)`;const [result]=await tx<{explicit:boolean;scoped:boolean}[]>`select app.contract_shared_email_document_current(${f.b.tenantId}::uuid,${email.id}::uuid) as explicit,app.contract_shared_email_document_current(${email.id}::uuid) as scoped`;return result;});expect(unscoped).toEqual({explicit:true,scoped:false});
 const tasks=await contractSharedWorkPage(employee,{category:'tasks',limit:1,offset:0});expect(tasks.total).toBe(1);expect(tasks.taskTotal).toBe(1);expect(tasks.items).toEqual([expect.objectContaining({id:email.id,action:'bindEmployee',linkPath:'/lifecycle/contracts/letters/'+email.id})]);
 expect((await contractSharedWorkPage(employee,{category:'approvals',limit:1,offset:0})).total).toBe(0);
 expect((await contractSharedWorkPage(employee,{category:'tasks',limit:1,offset:1})).items).toEqual([]);
 await expect(contractSharedContext(employee,f.caseId)).rejects.toThrow();expect(await readContractSharedForm(employee,email.id)).toEqual({letterId:email.id,kind:'Form',visible:false});expect((await readContractSharedLetter(employee,email.id)).body).toBeNull();
 expect(await contractSharedLetterActions(employee,email.id)).toMatchObject({canBindEmployee:true,canSelfBind:true,companyActionsAvailable:true,pendingRole:null,purpose:'email',contractDeclineGuidance:false});
 const [otherCompany]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional independently enabled company') returning id`);
 await setModule(f.b.tenantId,'lifecycle','disabled');await setModule(f.b.tenantId,'lifecycle','active',otherCompany.id);
 const limited={...employee,entitlements:(await entitledCtx(f.b)).entitlements};
 expect((await contractSharedWorkPage(limited,{category:'tasks',limit:1,offset:0})).total).toBe(0);
 await expect(bindContractSharedEmployee(limited,email.id)).rejects.toThrow();
 await setModule(f.b.tenantId,'lifecycle','active');await setModule(f.b.tenantId,'lifecycle',null,otherCompany.id);
 await bindContractSharedEmployee(employee,email.id);
 const bound=await readContractSharedLetter(employee,email.id),answers=await readContractSharedForm(employee,email.id);expect(bound.pendingAction?.kind).toBe('sign');if(!answers?.visible)throw new Error('Bound employee Form body is unavailable');
 expect((await contractSharedWorkPage(employee,{category:'tasks',limit:1,offset:0})).items).toEqual([expect.objectContaining({id:email.id,action:'sign'})]);
 const saved=await saveContractSharedForm(employee,{id:email.id,contentRevision:bound.contentRevision,contentHash:bound.contentHash!,responseRevision:answers.responseRevision,responseHash:answers.responseHash,values:{ack:'true'}});expect(saved?.visible).toBe(true);if(!saved?.visible)throw new Error('Saved employee response is unavailable');
 const latest=await readContractSharedLetter(employee,email.id);await actContractSharedLetter(employee,{id:email.id,actionId:randomUUID(),stepId:latest.pendingAction!.stepId,revision:latest.contentRevision,hash:latest.contentHash!,responseRevision:saved.responseRevision,responseHash:saved.responseHash,action:'signed',method:'typed',value:'Fictional employee',consent:true});
 expect((await contractSharedWorkPage(employee,{category:'tasks',limit:1,offset:0})).total).toBe(0);
},120_000);
