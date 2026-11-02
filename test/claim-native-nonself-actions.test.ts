/** Real native hierarchy/assignment courses. No fabricated publication, completion or default rows. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createClaimType,submitClaim,decideClaim,listClaimsForEmployment,listPendingClaims,actionablePendingClaimIds,submitClaimWithAttachment,addClaimAttachment,getClaimAttachment,saveClaimDraft,deleteClaimDraft} from '../core/claims';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand,type DataPermissionState,type DataPermissionPreview} from '../core/data-permissions';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext,typeId:string;
type Actor={ctx:SessionContext;personId:string;employmentId:string;userId:string};
let top:Actor,middle:Actor,leaf:Actor,peer:Actor,stranger:Actor;
beforeAll(migrateTestDb);afterAll(closeAll);
async function actor(name:string,departmentId:string,manager?:string):Promise<Actor>{
 const hired=await hireEmployee(admin,{person:{fullName:'Fictional '+name,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2026-01-01',reportingManagerEmploymentId:manager});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 return {...hired,userId,ctx:{...admin,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]}};
}
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 top=await actor('top manager',b.deptA);middle=await actor('direct manager',b.deptA,top.employmentId);
 leaf=await actor('claim subject',b.deptA,middle.employmentId);peer=await actor('department peer',b.deptA);stranger=await actor('unrelated actor',b.deptB);
 typeId=(await createClaimType(admin,{code:'COURSES',name:'Fictional native courses',requiresReceipt:false,defaultTaxable:false})).id;
});
const submission=(employmentId=leaf.employmentId)=>({employmentId,claimTypeId:typeId,amount:25,incurredOn:todayInKualaLumpur()});
async function refusal(run:Promise<unknown>,message:string){
 let failure:unknown;try{await run;}catch(error){failure=error;}
 let denied=false;for(let error=failure;error&&typeof error==='object';error=(error as {cause?:unknown}).cause){if((error as {code?:string}).code==='42501'&&(error as {message?:string}).message===message)denied=true;}expect(denied).toBe(true);
}
async function assignOtherDepartment(userId:string){
 const profileId=randomUUID();
 const change=async(command:DataPermissionCommand)=>{const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,command);await saveDataPermission(admin,state.revision,command,preview.fingerprint);};
 await change({kind:'create',profileId,name:'Fictional other department AND',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}});
 await change({kind:'assign',userId,profileId});
}
it('preserves recursive-manager and HOD submission/read without granting their indirect decision',async()=>{
 const recursive=await submitClaim(top.ctx,submission()),department=await submitClaim(top.ctx,submission(peer.employmentId));
 expect((await listClaimsForEmployment(top.ctx,leaf.employmentId)).map(row=>row.id)).toContain(recursive.id);
 expect((await listClaimsForEmployment(top.ctx,peer.employmentId)).map(row=>row.id)).toContain(department.id);
 const queue=await listPendingClaims(top.ctx);
 expect(queue.find(row=>row.id===recursive.id)?.canDecide).toBe(false);expect(queue.find(row=>row.id===department.id)?.canDecide).toBe(false);
 expect(await actionablePendingClaimIds(top.ctx,[recursive.id,department.id])).toEqual([]);
 await expect(decideClaim(top.ctx,{claimRequestId:recursive.id,decision:'approve'})).rejects.toThrow('Only an admin or the administrative manager can decide this claim');
 await expect(submitClaim(stranger.ctx,submission())).rejects.toThrow('Nonself claim submission unavailable');
 const source=await owner.client`select actor_id,subject_employment_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${recursive.id}::uuid and event_type='claim-request.submitted'`;
 expect(source).toEqual([{actor_id:top.userId,subject_employment_id:leaf.employmentId}]);
});
it('keeps actual assigned decisions independent of an administrative Department AND profile',async()=>{
 const pending=await submitClaim(admin,submission());await assignOtherDepartment(middle.userId);
 await expect(submitClaim(middle.ctx,submission())).rejects.toThrow('Nonself claim submission unavailable');
 const rows=await listPendingClaims(middle.ctx);expect(rows.find(row=>row.id===pending.id)?.canDecide).toBe(true);
 expect(await actionablePendingClaimIds(middle.ctx,[pending.id])).toEqual([pending.id]);
 await decideClaim(middle.ctx,{claimRequestId:pending.id,decision:'approve',deciderEmploymentId:middle.employmentId});
 const [stored]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id));expect(stored.status).toBe('approved');expect(stored.decidedByEmploymentId).toBe(middle.employmentId);
 expect(await owner.client`select actor_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${pending.id}::uuid and event_type='claim-request.approved'`).toEqual([{actor_id:middle.userId}]);
});
it('retains the real self-super exception with a narrowed current carrier and refuses ordinary self approval',async()=>{
 const pending=await submitClaim(leaf.ctx,submission());
 await expect(decideClaim(leaf.ctx,{claimRequestId:pending.id,decision:'approve'})).rejects.toThrow('You cannot decide your own claim');
 await refusal(withTenant(leaf.ctx,tx=>tx.update(s.claimRequest).set({status:'approved',decidedAt:new Date()}).where(eq(s.claimRequest.id,pending.id))),'Claim command unavailable');
 const superId=leaf.userId;await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:superId,role:'super_admin',companyId:null});
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional narrowed carrier company'}).returning({id:s.company.id});
 // Stored super_admin remains global as the schema requires. Only the current carrier is narrowed.
 const selfSuper:SessionContext={...admin,userId:superId,personId:leaf.personId,roles:['super_admin'],grants:[{role:'super_admin',companyId:other.id}]};
 expect((await listPendingClaims(selfSuper)).find(row=>row.id===pending.id)?.canDecide).toBe(true);
 await decideClaim(selfSuper,{claimRequestId:pending.id,decision:'approve'});
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('approved');
 expect(await owner.client`select actor_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${pending.id}::uuid and event_type='claim-request.approved'`).toEqual([{actor_id:superId}]);
});
it('refuses raw administrative decisions without native audit, restored content, and unborn conflict receipts',async()=>{
 const pending=await submitClaim(admin,submission()),[before]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id));
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(admin,tx=>tx.update(s.claimRequest).set({status:'approved',decidedAt:new Date()}).where(eq(s.claimRequest.id,pending.id))),'Claim command effects incomplete');
 await refusal(withTenant(admin,async tx=>{await tx.transaction(async nested=>{await nested.update(s.claimRequest).set({amount:'99.00'}).where(eq(s.claimRequest.id,pending.id));await nested.update(s.claimRequest).set({amount:'25.00'}).where(eq(s.claimRequest.id,pending.id));});}),'Filed claim is immutable');
 await refusal(withTenant(admin,tx=>tx.insert(s.claimRequest).values(before).onConflictDoNothing()),'Claim command effects incomplete');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id))).toEqual([before]);expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
 await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.claim_command_effect`))).rejects.toThrow();
});

it('uses the actual scoped delegation relationship for a nonself decision without granting submission',async()=>{
 await actor('stand-in report',b.deptB,stranger.employmentId);
 await setReportingLine(admin,{subordinateEmploymentId:middle.employmentId,managerEmploymentId:stranger.employmentId,lineType:'delegate',validFrom:'2026-01-01',scopes:[{module:'claims',taskType:'claims.claim'}],orgScope:{companyId:b.companyId,departmentId:b.deptA}});
 const pending=await submitClaim(admin,submission());await assignOtherDepartment(stranger.userId);
 expect((await listPendingClaims(stranger.ctx)).find(row=>row.id===pending.id)?.canDecide).toBe(true);
 await expect(submitClaim(stranger.ctx,submission())).rejects.toThrow('Nonself claim submission unavailable');
 await decideClaim(stranger.ctx,{claimRequestId:pending.id,decision:'reject',rejectReason:'Fictional scoped stand-in refusal'});
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('rejected');
 expect(await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${pending.id}::uuid and event_type='claim-request.rejected'`).toEqual([{actor_id:stranger.userId,payload:{rejectReason:'Fictional scoped stand-in refusal'}}]);
});
it('derives recipient floors from actual graph and data facts and narrows administrative hierarchy reads',async()=>{
 const pending=await submitClaim(admin,submission());
 const floor=(userId:string,cap:string)=>owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${b.tenantId},true)`;
  const [row]=await tx`select app.claim_nonself_native_allowed(${b.tenantId}::uuid,${userId}::uuid,${cap},${b.companyId}::uuid) as allowed`;return row.allowed;
 });
 expect(await floor(top.userId,'function.claims.related.execute')).toBe(true);
 expect(await floor(top.userId,'function.claims.assigned.approve')).toBe(false);
 expect(await floor(middle.userId,'function.claims.assigned.approve')).toBe(true);
 expect(await floor(stranger.userId,'function.claims.assigned.approve')).toBe(false);
 await assignOtherDepartment(top.userId);
 expect(await floor(top.userId,'function.claims.related.execute')).toBe(false);
 expect(await listClaimsForEmployment(top.ctx,leaf.employmentId)).toEqual([]);
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('pending');
 await expect(withTenant(top.ctx,tx=>tx.execute(sql`select app.claim_nonself_native_allowed(${b.tenantId}::uuid,${middle.userId}::uuid,'function.claims.assigned.approve',${b.companyId}::uuid)`))).rejects.toThrow();
});

it('invalidates actual native relationship revoke and restore after a sealed decision',async()=>{
 const pending=await submitClaim(admin,submission());
 const graph=await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,leaf.employmentId));
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(admin,async tx=>{
  await decideClaim(admin,{claimRequestId:pending.id,decision:'approve'},tx);
  await setReportingLine(admin,{subordinateEmploymentId:leaf.employmentId,managerEmploymentId:top.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()},tx);
  await setReportingLine(admin,{subordinateEmploymentId:leaf.employmentId,managerEmploymentId:middle.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()},tx);
  const current=await tx.select({manager:s.reportingLine.managerEmploymentId}).from(s.reportingLine).where(sql`${s.reportingLine.subordinateEmploymentId}=${leaf.employmentId}::uuid and ${s.reportingLine.lineType}='administrative' and ${s.reportingLine.supersededAt} is null and ${s.reportingLine.validFrom}<=current_date and (${s.reportingLine.validTo} is null or ${s.reportingLine.validTo}>current_date)`);
  expect(current).toEqual([{manager:middle.employmentId}]);
 }),'Claim command effects incomplete');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('pending');
 expect(await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,leaf.employmentId))).toEqual(graph);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
});
it('keeps a legitimate same-transaction approval and native reimbursement outcome composable',async()=>{
 const pending=await submitClaim(admin,submission());
 await withTenant(admin,async tx=>{
  await decideClaim(admin,{claimRequestId:pending.id,decision:'approve'},tx);
  const [paid]=await tx.execute<{paid:number}>(sql`select app.claim_reimburse_native(ARRAY[${pending.id}::uuid],'Fictional native chain') as paid`);expect(paid.paid).toBe(1);
 });
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('paid');
 const events=await owner.client`select event_type from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${pending.id}::uuid order by sequence`;
 expect(events.map(row=>row.event_type)).toEqual(['claim-request.submitted','claim-request.approved','claim-request.paid']);
});

it('retains the native HR decision through genuine hierarchy visibility outside the HR company grant',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional separate HR grant company'}).returning({id:s.company.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:top.userId,role:'hr_admin',companyId:other.id});
 const hierarchyHr:SessionContext={...top.ctx,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id}]};
 const [native]=await withTenant(hierarchyHr,tx=>tx.execute<{companyAdmin:boolean}>(sql`select app.is_admin_for(${b.companyId}::uuid) as "companyAdmin"`));expect(native.companyAdmin).toBe(false);
 const pending=await submitClaim(admin,submission());expect((await listPendingClaims(hierarchyHr)).find(row=>row.id===pending.id)?.canDecide).toBe(true);
 await decideClaim(hierarchyHr,{claimRequestId:pending.id,decision:'approve'});
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)))[0].status).toBe('approved');
});

it('refuses a foreign-tenant decider reference without changing the actual subject or audit',async()=>{
 const pending=await submitClaim(admin,submission()),other=await seedBase();
 const foreign=await hireEmployee(adminCtx(other),{companyId:other.companyId,departmentId:other.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional foreign decider',primaryEmail:randomUUID()+'@fixture.invalid'}});
 const before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id));
 const audits=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(decideClaim(admin,{claimRequestId:pending.id,decision:'approve',deciderEmploymentId:foreign.employmentId}),'Claim decision fields unavailable');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id))).toEqual(before);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audits);
});

it('constructs actual nonself submission and maintenance receipts with exact native byte audits',async()=>{
 const file={fileName:'Fictional team receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional team receipt bytes')};
 const submitted=await submitClaimWithAttachment(top.ctx,submission(),file);
 const files=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,submitted.id));expect(files).toHaveLength(1);expect(files[0].uploadedByUserId).toBe(top.userId);
 expect(await getClaimAttachment(top.ctx,files[0].id)).toEqual(file);expect(await getClaimAttachment(leaf.ctx,files[0].id)).toEqual(file);expect(await getClaimAttachment(stranger.ctx,files[0].id)).toBeNull();
 const added=await addClaimAttachment(admin,{claimRequestId:submitted.id,...file,fileName:'Fictional administrative addition.pdf'});
 expect(await getClaimAttachment(admin,added.id)).toEqual({...file,fileName:'Fictional administrative addition.pdf'});
 const events=await owner.client`select actor_id,event_type from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${submitted.id}::uuid order by sequence`;
 expect(events).toEqual([{actor_id:top.userId,event_type:'claim-request.submitted'},{actor_id:top.userId,event_type:'claim-request.receipt-added'},{actor_id:admin.userId,event_type:'claim-request.receipt-added'}]);
});
it('keeps assigned receipt read outside administrative data scope without granting upload or a posted constructor course',async()=>{
 const file={fileName:'Fictional assigned receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional assigned receipt bytes')};
 const submitted=await submitClaimWithAttachment(admin,submission(),file);
 const [stored]=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,submitted.id));
 await assignOtherDepartment(middle.userId);
 expect(await getClaimAttachment(middle.ctx,stored.id)).toEqual(file);
 await refusal(addClaimAttachment(middle.ctx,{claimRequestId:submitted.id,...file}),'Claim receipt unavailable');
 const audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(admin,tx=>tx.insert(s.claimAttachment).values({tenantId:b.tenantId,claimRequestId:submitted.id,employmentId:leaf.employmentId,uploadedByUserId:b.adminUserId,fileName:file.fileName,mimeType:file.mimeType,sizeBytes:file.content.length,content:file.content})),'Claim receipt source unavailable');
 await refusal(withTenant(top.ctx,tx=>tx.execute(sql`select app.claim_receipt_native(${submitted.id}::uuid,${file.fileName},${file.mimeType},${file.content},'submit')`)),'Claim receipt native source unavailable');
 await refusal(withTenant(top.ctx,tx=>tx.execute(sql`select app.claim_own_receipt_native(${submitted.id}::uuid,${file.fileName},${file.mimeType},${file.content},'receipt-add')`)),'Own claim receipt unavailable');
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,submitted.id))).toEqual([stored]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);
});

// This owner-held downgrade exercises the real guarded bodies, but is NOT strict APP-login evidence.
async function ownerAppTransaction(actor:SessionContext,run:(tx:Tx)=>Promise<void>){
 return owner.withTenant(actor,async tx=>{await tx.execute(sql`set local role ai_hr_app`);await run(tx);});
}
it('requeues an owner-held protocol decision after early validation and native revoke/restore',async()=>{
 const pending=await submitClaim(admin,submission());
 const [line]=await owner.db.select().from(s.reportingLine).where(sql`${s.reportingLine.subordinateEmploymentId}=${leaf.employmentId}::uuid and ${s.reportingLine.managerEmploymentId}=${middle.employmentId}::uuid and ${s.reportingLine.lineType}='administrative' and ${s.reportingLine.supersededAt} is null`);
 const before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)),audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(ownerAppTransaction(middle.ctx,async tx=>{
  await decideClaim(middle.ctx,{claimRequestId:pending.id,decision:'approve'},tx);
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);
  // The native command above ran as app. Only the storage-owner test operator changes real source
  // facts below; no manager permission, owner GUC or synthetic authority receipt is introduced.
  await tx.execute(sql`reset role`);
  await tx.update(s.reportingLine).set({managerEmploymentId:top.employmentId}).where(eq(s.reportingLine.id,line.id));
  await tx.update(s.reportingLine).set({managerEmploymentId:middle.employmentId}).where(eq(s.reportingLine.id,line.id));
  const [current]=await tx.execute<{allowed:boolean}>(sql`select app.claim_decision_allowed(${leaf.employmentId}::uuid) as allowed`);expect(current.allowed).toBe(true);
 }),'Claim command effects incomplete');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id))).toEqual(before);
 expect(await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.id,line.id))).toEqual([line]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);
});
it('requeues owner-held own receipt protocol completion after early validation and restored login authority',async()=>{
 const audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 let id:string|undefined;
 await refusal(ownerAppTransaction(leaf.ctx,async tx=>{
  const saved=await saveClaimDraft(leaf.ctx,submission(),{fileName:'Fictional retained receipt.pdf',mimeType:'application/pdf',content:Buffer.from('Fictional retained receipt bytes')},tx);id=saved.id;
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);await tx.execute(sql`reset role`);
  await tx.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,leaf.userId));await tx.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,leaf.userId));
  const [current]=await tx.execute<{own:boolean}>(sql`select app.claim_subject_is_own(${leaf.employmentId}::uuid) as own`);expect(current.own).toBe(true);
 }),'Claim receipt effects incomplete');
 expect(id).toBeTruthy();expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,id!))).toEqual([]);
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,id!))).toEqual([]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);
});
it('requeues owner-held closed Draft protocol completion after early validation and restored login authority',async()=>{
 const saved=await saveClaimDraft(leaf.ctx,submission()),before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,saved.id));
 const audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(ownerAppTransaction(leaf.ctx,async tx=>{
  await deleteClaimDraft(leaf.ctx,saved.id,leaf.employmentId,tx);
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);await tx.execute(sql`reset role`);
  await tx.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,leaf.userId));await tx.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,leaf.userId));
  const [current]=await tx.execute<{own:boolean}>(sql`select app.claim_subject_is_own(${leaf.employmentId}::uuid) as own`);expect(current.own).toBe(true);
 }),'Claim draft delete effects incomplete');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,saved.id))).toEqual(before);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);
});
it('refuses filed-row hard deletion, invalid lifecycle rewinds, and source edits hidden inside Submit',async()=>{
 const filed=await submitClaim(admin,submission());
 await refusal(withTenant(admin,tx=>tx.delete(s.claimRequest).where(eq(s.claimRequest.id,filed.id))),'Claim lifecycle source unavailable');
 await decideClaim(admin,{claimRequestId:filed.id,decision:'reject'});
 await refusal(withTenant(admin,tx=>tx.update(s.claimRequest).set({status:'pending',decidedAt:null,decidedByEmploymentId:null}).where(eq(s.claimRequest.id,filed.id))),'Claim lifecycle source unavailable');
 const draft=await saveClaimDraft(leaf.ctx,submission());
 await refusal(withTenant(leaf.ctx,tx=>tx.update(s.claimRequest).set({status:'pending',description:'Changed through Execute'}).where(eq(s.claimRequest.id,draft.id))),'Claim draft fields unavailable');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,filed.id)))[0].status).toBe('rejected');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,draft.id)))[0].status).toBe('draft');
});

async function nativeDataTransitionTx(tx:Tx,command:DataPermissionCommand){
 const [state]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);
 const [preview]=await tx.execute<{value:DataPermissionPreview}>(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},false,null) as value`);
 expect(preview.value.fingerprint).toBeTruthy();
 const [done]=await tx.execute<{value:{revision:string}}>(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},true,${preview.value.fingerprint}) as value`);
 expect(done.value.revision).toBeTruthy();
}
it('requeues a genuine APP-session decision after early flush and canonical assign/restore without owner elevation',async()=>{
 const profileId=randomUUID(),create:DataPermissionCommand={kind:'create',profileId,name:'Fictional actual APP data control',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}};
 const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,create);await saveDataPermission(admin,state.revision,create,preview.fingerprint);
 const assignments=(await readDataPermissions(admin)).assignments,pending=await submitClaim(admin,submission());
 const before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id));
 await refusal(withTenant(admin,async tx=>{
  const [session]=await tx.execute<{owner:boolean;app:boolean}>(sql`select pg_has_role(session_user,(select relowner from pg_class where oid='public.app_user'::regclass),'USAGE') as owner,pg_has_role(current_user,'ai_hr_app','USAGE') as app`);expect(session).toEqual({owner:false,app:true});
  await decideClaim(admin,{claimRequestId:pending.id,decision:'approve'},tx);
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);
  await nativeDataTransitionTx(tx,{kind:'assign',userId:middle.userId,profileId});
  const [assigned]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(assigned.value.assignments).toContainEqual({userId:middle.userId,profileId});
  await nativeDataTransitionTx(tx,{kind:'assign',userId:middle.userId,profileId:null});
  const [restored]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(restored.value.assignments).toEqual(assignments);
  const [native]=await tx.execute<{allowed:boolean}>(sql`select app.claim_decision_allowed(${leaf.employmentId}::uuid) as allowed`);expect(native.allowed).toBe(true);
 }),'Claim command effects incomplete');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id))).toEqual(before);
 expect((await readDataPermissions(admin)).assignments).toEqual(assignments);
});

for(const course of ['receipt','cancel','reimburse'] as const)it(`requeues genuine APP-session ${course} completion after early flush and canonical control restore`,async()=>{
 const profileId=randomUUID(),create:DataPermissionCommand={kind:'create',profileId,name:'Fictional actual APP retained '+course,enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}};
 const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,create);await saveDataPermission(admin,state.revision,create,preview.fingerprint);
 const assignments=(await readDataPermissions(admin)).assignments,pending=await submitClaim(admin,submission());
 if(course==='reimburse')await decideClaim(admin,{claimRequestId:pending.id,decision:'approve'});
 const before=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id)),audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(admin,async tx=>{
  const [session]=await tx.execute<{owner:boolean;app:boolean}>(sql`select pg_has_role(session_user,(select relowner from pg_class where oid='public.app_user'::regclass),'USAGE') as owner,pg_has_role(current_user,'ai_hr_app','USAGE') as app`);expect(session).toEqual({owner:false,app:true});
  if(course==='receipt')await tx.execute(sql`select app.claim_receipt_native(${pending.id}::uuid,'Fictional canonical control receipt.pdf','application/pdf',${Buffer.from('Fictional actual receipt source')},'receipt-add')`);
  else if(course==='cancel')await tx.execute(sql`select * from app.claim_cancel_native(${pending.id}::uuid,null)`);
  else {const [paid]=await tx.execute<{paid:number}>(sql`select app.claim_reimburse_native(ARRAY[${pending.id}::uuid],'Fictional restored control reimbursement') as paid`);expect(paid.paid).toBe(1);}
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);
  await nativeDataTransitionTx(tx,{kind:'assign',userId:middle.userId,profileId});
  const [assigned]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(assigned.value.assignments).toContainEqual({userId:middle.userId,profileId});
  await nativeDataTransitionTx(tx,{kind:'assign',userId:middle.userId,profileId:null});
  const [restored]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(restored.value.assignments).toEqual(assignments);
 }),course==='receipt'?'Claim receipt effects incomplete':'Claim native effects incomplete');
 expect(await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,pending.id))).toEqual(before);
 expect(await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,pending.id))).toEqual([]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);
 expect((await readDataPermissions(admin)).assignments).toEqual(assignments);
});
