/** Actual native ports, raw app-role refusals, and storage-owner publication. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import * as s from '../db/schema';
import {appendEvent} from '../db/events';
import {hireEmployee} from '../core/org';
import {cancelClaim,createClaimType,markReimbursementsPaid,listReimbursementsDue,saveClaimDraft,deleteClaimDraft,submitDraftClaims,addClaimAttachment,getClaimAttachment} from '../core/claims';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext,subject:{personId:string;employmentId:string},own:SessionContext,typeId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 subject=await hireEmployee(admin,{person:{fullName:'Fictional claim port owner',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');
 own={...admin,userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 typeId=(await createClaimType(admin,{code:'NATIVE',name:'Fictional native claim',requiresReceipt:false,defaultTaxable:false})).id;
});
async function claim(status:'pending'|'approved'='pending'){
 const [row]=await owner.db.insert(s.claimRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,claimTypeId:typeId,amount:'25.00',incurredOn:todayInKualaLumpur(),taxable:false,status}).returning();return row;
}
async function refusal(run:Promise<unknown>,message:string){
 let failure:unknown;try{await run;}catch(error){failure=error;}
 let denied=false;for(let error=failure;error&&typeof error==='object';error=(error as {cause?:unknown}).cause){
  if((error as {code?:string}).code==='42501'&&(error as {message?:string}).message===message)denied=true;
 }expect(denied).toBe(true);
}
it('cancels only the actual own pending claim and records the actual actor once',async()=>{
 const row=await claim();await cancelClaim(own,row.id,subject.employmentId);
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('cancelled');
 const events=await owner.client`select actor_id,subject_employment_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${row.id}::uuid and event_type='claim-request.cancelled'`;
 expect(events).toEqual([{actor_id:own.userId,subject_employment_id:subject.employmentId}]);
 await expect(cancelClaim(own,row.id,subject.employmentId)).rejects.toThrow('Only a pending claim can be cancelled');
});
it('cannot forge a cancellation receipt with an audit, owner GUC or nested savepoint',async()=>{
 const row=await claim(),before=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(own,async tx=>{
  await tx.execute(sql`select set_config('app.owner','true',true)`);
  await tx.transaction(async nested=>{
   await nested.update(s.claimRequest).set({status:'cancelled'}).where(eq(s.claimRequest.id,row.id));
   await appendEvent(nested,{tenantId:b.tenantId,aggregateType:'claim-request',aggregateId:row.id,eventType:'claim-request.cancelled',actor:{type:'user',id:own.userId},subjectEmploymentId:subject.employmentId});
  });
 }),'Claim payment or cancellation source unavailable');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('pending');
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(before);
 await expect(withTenant(own,tx=>tx.execute(sql`insert into app.module_claim_effect select * from app.module_claim_effect`))).rejects.toThrow();
});
it('refuses employee reimbursement and raw admin payment while preserving the finite admin native owner',async()=>{
 const row=await claim('approved');
 expect(await listReimbursementsDue(own)).toEqual([]);
 await expect(markReimbursementsPaid(own,{claimIds:[row.id]})).rejects.toThrow('Claim reimbursement unavailable');
 await refusal(withTenant(admin,tx=>tx.update(s.claimRequest).set({status:'paid',paidAt:new Date(),payoutRef:'forged'}).where(eq(s.claimRequest.id,row.id))),'Claim payment or cancellation source unavailable');
 expect(await markReimbursementsPaid(admin,{claimIds:[row.id],payoutRef:'Fictional bank confirmation'})).toEqual({paid:1});
 const [paid]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id));expect(paid.status).toBe('paid');expect(paid.payoutRef).toBe('Fictional bank confirmation');
 const events=await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${row.id}::uuid and event_type='claim-request.paid'`;
 expect(events).toEqual([{actor_id:admin.userId,payload:{via:'reimbursement',payoutRef:'Fictional bank confirmation'}}]);
});
it('rejects wrong selected employment and another actual employee without mutating the claim',async()=>{
 const row=await claim();await expect(cancelClaim(own,row.id,randomUUID())).rejects.toThrow('Claim does not belong to the selected employment');
 const strangerId=await createAppUser(b.tenantId,null,'employee'),stranger={...own,userId:strangerId,personId:null};
 await expect(cancelClaim(stranger,row.id)).rejects.toThrow('Only the claimant or an admin can cancel this claim');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('pending');
});

it('deletes an actual own draft and its receipt only through the finite native delete source',async()=>{
 const draft=await saveClaimDraft(own,{employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()},{fileName:'Fictional draft receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional receipt bytes')});
 const before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id)),receipts=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,draft.id));
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(own,async tx=>{await tx.execute(sql`select set_config('app.owner','true',true)`);await tx.delete(s.claimRequest).where(eq(s.claimRequest.id,draft.id));}),'Claim draft deletion source unavailable');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id))).toEqual(before);
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,draft.id))).toEqual(receipts);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
 await deleteClaimDraft(own,draft.id,subject.employmentId);
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id))).toEqual([]);
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,draft.id))).toEqual([]);
 expect(await owner.client`select actor_id,subject_employment_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${draft.id}::uuid and event_type='claim-request.draft-deleted'`).toEqual([{actor_id:own.userId,subject_employment_id:subject.employmentId}]);
 await expect(withTenant(own,tx=>tx.execute(sql`insert into app.claim_draft_delete_effect select * from app.claim_draft_delete_effect`))).rejects.toThrow();
});
it('keeps ordinary own draft submission independent of an administrative Department AND profile',async()=>{
 const root={...admin,grants:[{role:'hr_admin' as const,companyId:null}]},profileId=randomUUID();
 const change=async(command:DataPermissionCommand)=>{const state=await readDataPermissions(root),preview=await previewDataPermission(root,state.revision,command);await saveDataPermission(root,state.revision,command,preview.fingerprint);};
 await change({kind:'create',profileId,name:'Fictional other administrative department',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}});
 await change({kind:'assign',userId:own.userId!,profileId});
 const draft=await saveClaimDraft(own,{employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()});
 expect(await submitDraftClaims(own,{ids:[draft.id],employmentId:subject.employmentId})).toEqual({submitted:1});
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id)))[0].status).toBe('pending');
 await refusal(withTenant(own,async tx=>{await tx.transaction(async nested=>{await nested.update(s.claimRequest).set({amount:'99.00'}).where(eq(s.claimRequest.id,draft.id));await nested.update(s.claimRequest).set({amount:'25.00'}).where(eq(s.claimRequest.id,draft.id));});}),'Filed claim is immutable');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id)))[0].amount).toBe('25.00');
});

it('adds and reads actual own receipt bytes through the native port and refuses raw alteration or source flags',async()=>{
 const draft=await saveClaimDraft(own,{employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()});
 const file={fileName:'Fictional native receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional native receipt bytes')};
 const attachment=await addClaimAttachment(own,{claimRequestId:draft.id,...file});
 expect(await getClaimAttachment(own,attachment.id)).toEqual(file);
 const stored=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.id,attachment.id));
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(own,async tx=>{await tx.transaction(async nested=>{
  await nested.update(s.claimAttachment).set({fileName:'Changed.pdf'}).where(eq(s.claimAttachment.id,attachment.id));
  await nested.update(s.claimAttachment).set({fileName:file.fileName}).where(eq(s.claimAttachment.id,attachment.id));
 });}),'Claim receipts are immutable');
 await refusal(withTenant(own,tx=>tx.delete(s.claimAttachment).where(eq(s.claimAttachment.id,attachment.id))),'Claim receipt removal source unavailable');
 await refusal(withTenant(own,tx=>tx.execute(sql`select app.claim_own_receipt_native(${draft.id}::uuid,'Forged source.pdf','application/pdf',${file.content},'draft-add')`)),'Own receipt native source unavailable');
 await refusal(withTenant(own,tx=>tx.insert(s.claimAttachment).values({tenantId:b.tenantId,claimRequestId:draft.id,employmentId:subject.employmentId,fileName:file.fileName,mimeType:file.mimeType,content:file.content,sizeBytes:file.content.length,uploadedByUserId:own.userId!})),'Own claim receipt source unavailable');
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.id,attachment.id))).toEqual(stored);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
 const events=await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${draft.id}::uuid and event_type='claim-request.receipt-added'`;
 expect(events).toEqual([{actor_id:own.userId,payload:{fileName:file.fileName,sizeBytes:file.content.length}}]);
});
it('binds an initial draft receipt to the actual same-transaction source and refuses a second file slot',async()=>{
 const file={fileName:'Fictional initial receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional initial receipt bytes')};
 let proposedId:string|undefined;
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(own,async tx=>{
  const draft=await saveClaimDraft(own,{employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()},file,tx);proposedId=draft.id;
  await tx.execute(sql`select app.claim_own_receipt_native(${draft.id}::uuid,'Extra.pdf','application/pdf',${file.content},'draft-add')`);
 }),'Own receipt native source unavailable');
 expect(proposedId).toBeTruthy();
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,proposedId!))).toEqual([]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
 const actual=await saveClaimDraft(own,{employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()},file);
 const receipts=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,actual.id));
 expect(receipts).toHaveLength(1);expect(await getClaimAttachment(own,receipts[0].id)).toEqual(file);
});

it('refuses foreign-tenant and wrong-parent native claim references before a raw source can be born',async()=>{
 const other=await seedBase(),foreignType=randomUUID(),secondType=randomUUID(),wrongItem=randomUUID();
 await owner.db.insert(s.claimType).values([{id:foreignType,tenantId:other.tenantId,code:'FOREIGN',name:'Fictional foreign type'},{id:secondType,tenantId:b.tenantId,code:'OTHER',name:'Fictional other parent'}]);
 await owner.db.insert(s.claimItem).values({id:wrongItem,tenantId:b.tenantId,claimTypeId:secondType,code:'OTHER',name:'Fictional other item'});
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 const raw=(claimTypeId:string,claimItemId:string|null)=>withTenant(own,tx=>tx.insert(s.claimRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,claimTypeId,claimItemId,amount:'25.00',incurredOn:todayInKualaLumpur(),taxable:false,status:'draft'}));
 await refusal(raw(foreignType,null),'Claim source reference unavailable');
 await refusal(raw(typeId,wrongItem),'Claim source reference unavailable');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.employmentId,subject.employmentId))).toEqual([]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
});

it('publishes the own Claims courses and keeps a draft editable under Submit Execute denial',async()=>{
 const cap='function.claims.own.submit.execute';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'claim_own')).toMatchObject({changed:true,capabilities:10});
  expect(await publishActionCapabilityPackage(owner.client,'claim_own')).toMatchObject({changed:false});
  const input={employmentId:subject.employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()};
  const draft=await saveClaimDraft(own,input);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${own.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  const submit=()=>submitDraftClaims(own,{ids:[draft.id],employmentId:subject.employmentId});
  await expect(submit()).rejects.toThrow();
  const [stillDraft]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id));
  expect(stillDraft).toMatchObject({status:'draft',amount:'25.00'});
  const [admission]=await withTenant(own,tx=>tx.execute(sql`select
   app.claim_own_source_allowed(${subject.employmentId}::uuid,'claims.own.drafts','edit') as edit,
   app.claim_own_source_allowed(${subject.employmentId}::uuid,'claims.own.submit','execute') as submit`));
  expect(admission).toEqual({edit:true,submit:false});
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await expect(submit()).resolves.toEqual({submitted:1});
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.claims.own.%'`;
 }
});

it('publishes Claims Administration and keeps reimbursement visible under Execute denial',async()=>{
 const cap='function.claimsConfig.reimbursements.execute',row=await claim('approved');
 try{
  expect(await publishActionCapabilityPackage(owner.client,'claim_administration')).toMatchObject({changed:true,capabilities:10});
  expect(await publishActionCapabilityPackage(owner.client,'claim_administration')).toMatchObject({changed:false});
  expect((await listReimbursementsDue(admin)).find(item=>item.id===row.id)?.canMarkPaid).toBe(true);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${admin.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect((await listReimbursementsDue(admin)).find(item=>item.id===row.id)?.canMarkPaid).toBe(false);
  const pay=()=>markReimbursementsPaid(admin,{claimIds:[row.id],payoutRef:'Fictional payment'});
  await expect(pay()).rejects.toThrow();
  expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0]?.status).toBe('approved');
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await expect(pay()).resolves.toEqual({paid:1});
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
   where id in ('claims.view','claims.add','claims.edit','claims.delete','function.claims.administration.view',
    'function.claims.administration.delete','function.claims.administration.execute','function.claims.administration.approve',
    'function.claimsConfig.reimbursements.view','function.claimsConfig.reimbursements.execute')`;
 }
});
