import {assertReviewBodyPendingParentContract} from './helpers/review-body-pending-parent-contract';
import {erasePersonPii} from '../core/pdpa';
/** Authored exact-SHA CI witnesses; native country owner and real migrated encrypted custody. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import * as vault from '../lib/pii/vault';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {requirePackFor} from '../localization/registry';
import {bankMaintenanceReviews as store,readBankMaintenanceChoices} from '../core/assistant-actions/bank-maintenance-review-store';
import {BankMaintenance as C} from '../lib/assistant-actions/bank-maintenance-contract';
import {prepareBankMaintenanceSourceTx} from '../core/assistant-actions/bank-maintenance-source';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,target:{employmentId:string;personId:string};
const pack=()=>requirePackFor('MY'),fields=()=>({bankName:pack().client.bankNames[0],bankAccountNo:'000-FICTIONAL-NEW',enableCustomHolderName:false,customHolderName:'disabled name is cleared',enableCustomHolderId:false,customHolderId:'disabled id is cleared'});
const human=()=>({action:C.action,contractVersion:1,employmentId:target.employmentId,subjectId:target.personId,fields:fields()});
const confirm=(r:{actionId:string;reviewedDigest:string})=>({action:C.action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const profile=()=>withTenant(ctx,tx=>pack().statutory.get(ctx,target.personId,tx));
async function state(){return{profile:await profile(),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-bank-maintenance-custody-key-1234');await resetDb();b=await seedBase();for(const m of ['assistant','payroll','country-my'])await setModule(b.tenantId,m,'active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:ctx.userId!});target=await hireEmployee(ctx,{person:{fullName:'Fictional Bank Employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});await pack().statutory.set(ctx,{personId:target.personId,icNumber:null,epfNumber:'PRIVATE-EPF',socsoNumber:'PRIVATE-SOCSO',taxNumber:'PRIVATE-TAX',bankName:'Legacy Fictional Bank',bankAccountNo:'000-FICTIONAL-OLD'});await pack().statutory.setBank(ctx,{personId:target.personId,bankName:'Legacy Fictional Bank',bankAccountNo:'000-FICTIONAL-OLD',enableCustomHolderName:true,customHolderName:'Old Payee',enableCustomHolderId:true,customHolderId:'PRIVATE-OLD-ID'});});
it('keeps the same native source digest when equivalent entitlement sets arrive in another order',async()=>{
 const left=structuredClone(ctx.entitlements!);if(!left)throw Error('Expected resolved fixture entitlements');
 const right={...left,enabledModules:[...left.enabledModules].reverse(),scopedModules:Object.fromEntries(Object.entries(left.scopedModules).reverse().map(([code,companies])=>[code,[...companies].reverse()])),settings:Object.fromEntries(Object.entries(left.settings).reverse())},before=await state(),input=C.Human.parse(human());
 const first=await withTenant(ctx,tx=>prepareBankMaintenanceSourceTx(tx,{...ctx,entitlements:left},input)),second=await withTenant(ctx,tx=>prepareBankMaintenanceSourceTx(tx,{...ctx,entitlements:right},input));
 expect(second.reviewedDigest).toBe(first.reviewedDigest);expect(second.review).toEqual(first.review);expect(await state()).toEqual(before);
});
it('reviews exact account/holder changes, preserves all sibling statutory columns and reopens the same native receipt',async()=>{
 const before=await state(),r=(await store.prepare(ctx,human())).review;expect(await state()).toEqual(before);expect(r.review.before.bankAccountNo).toBe('000-FICTIONAL-OLD');expect(r.review.after).toEqual({...fields(),customHolderName:null,customHolderId:null});expect(JSON.stringify(r)).not.toMatch(/PRIVATE-EPF|PRIVATE-SOCSO|PRIVATE-TAX/);
 const done=await store.confirm(ctx,confirm(r));expect(done.kind).toBe('completed');expect(await store.reopen(ctx,r.actionId)).toEqual(done);expect(await store.confirm(ctx,confirm(r))).toEqual(done);
 const after=(await profile())!;const {bankName,bankAccountNo,enableCustomHolderName,customHolderName,enableCustomHolderId,customHolderId,updatedAt,...preserved}=after;const {bankName:oldBank,bankAccountNo:oldAccount,enableCustomHolderName:oldEnableName,customHolderName:oldName,enableCustomHolderId:oldEnableId,customHolderId:oldId,updatedAt:oldUpdated,...oldPreserved}=before.profile!;expect(preserved).toEqual(oldPreserved);expect({bankName,bankAccountNo,enableCustomHolderName,customHolderName,enableCustomHolderId,customHolderId}).toEqual(r.review.after);
 const events=await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.tenantId}=${b.tenantId}::uuid and ${s.domainEvent.eventType}='employee.bank.updated'`);const added=events.filter(event=>!before.events.some(old=>old.id===event.id));expect(added).toHaveLength(1);expect(added[0].payload).toMatchObject({personId:target.personId,before:r.review.before,after:r.review.after});
});
it('uses native trimming and rejects enabled blank holder values before custody or a write',async()=>{
 const h=human(),r=(await store.prepare(ctx,{...h,fields:{...h.fields,bankAccountNo:'  000-NEW  ',enableCustomHolderName:true,customHolderName:'  Fictional Payee  '}})).review;expect(r.review.after.bankAccountNo).toBe('000-NEW');expect(r.review.after.customHolderName).toBe('Fictional Payee');const before=await state();await expect(store.prepare(ctx,{...h,fields:{...h.fields,enableCustomHolderId:true,customHolderId:' '}})).rejects.toThrow();expect(await state()).toEqual(before);
});
it.each(['profile','company','configuration'] as const)('invalidates a changed %s source without a bank write',async kind=>{
 const r=(await store.prepare(ctx,human())).review;if(kind==='profile')await pack().statutory.setBank(ctx,{personId:target.personId,...fields(),bankAccountNo:'000-NATIVE-INTERVENING'});else if(kind==='company')await owner.db.update(s.company).set({currency:'SGD'}).where(eq(s.company.id,b.companyId));else await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'report.read.bank',role:'hr_admin',allowed:true});const before=await state();await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();expect(await state()).toEqual(before);
});
it.each(['identity','bank','statutory','compensation'] as const)('checks current %s category before private native snapshot or custody decrypt',async category=>{
 const r=(await store.prepare(ctx,human())).review;await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:false});const native=vi.spyOn(pack().statutory,'reviewedBank'),unwrap=vi.spyOn(vault,'unwrapDek');unwrap.mockClear();await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();await expect(store.reopen(ctx,r.actionId)).rejects.toThrow();expect(native).not.toHaveBeenCalled();expect(unwrap).not.toHaveBeenCalled();
});
it('hands unsupported country to native Personnel without country fallback',async()=>{
 await owner.db.update(s.company).set({country:'SG'}).where(eq(s.company.id,b.companyId));const native=vi.spyOn(pack().statutory,'setBank');expect(await readBankMaintenanceChoices(ctx,{query:'Fictional'})).toMatchObject({kind:'choices',employees:[{supported:false}]});await expect(store.prepare(ctx,human())).rejects.toThrow();expect(native).not.toHaveBeenCalled();
});
it('rejects a real self-linked HR login and forged human fields',async()=>{
 const id=await createAppUser(b.tenantId,target.personId,'hr_admin');await grantAssistant(ctx,{appUserId:id});const self={...ctx,userId:id,personId:target.personId};await expect(store.prepare(self,human())).rejects.toThrow();await expect(store.prepare(ctx,{...human(),icNumber:'forged'})).rejects.toThrow();
});
it('rolls back native values and the event on late failure, then recovers through the original review',async()=>{
 const r=(await store.prepare(ctx,human())).review,before=await state();await owner.client.unsafe("create function public.ai_bank_fail() returns trigger language plpgsql as $$begin if new.event_type='employee.bank.updated' then raise exception 'fictional bank failure';end if;return new;end$$");await owner.client.unsafe('create trigger ai_bank_fail before insert on domain_event for each row execute function public.ai_bank_fail()');try{await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();expect(await state()).toEqual(before);}finally{await owner.client.unsafe('drop trigger ai_bank_fail on domain_event');await owner.client.unsafe('drop function public.ai_bank_fail()');}expect((await store.confirm(ctx,confirm(r))).kind).toBe('completed');
});
it('rejects historical native bank events at the SQL completion boundary',async()=>{
 const r=(await store.prepare(ctx,human())).review;await pack().statutory.setBank(ctx,{personId:target.personId,...fields()});const [event]=await owner.db.execute<{id:string}>(sql`select id from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employee.bank.updated' order by sequence desc limit 1`);await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${event.id}::uuid)`))).rejects.toThrow();
});
it('refuses current grant loss and expires without a native write',async()=>{
 const r=(await store.prepare(ctx,human())).review,before=await state();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);expect(await store.confirm(ctx,confirm(r))).toMatchObject({kind:'retired',receipt:{state:'expired'}});expect(await state()).toEqual(before);await revokeAssistant(ctx,{appUserId:ctx.userId!});await expect(store.prepare(ctx,human())).rejects.toThrow();
});

it('binds added retained-company scope and checks its granular denial before private source',async()=>{
 const r=(await store.prepare(ctx,human())).review,company=await createCompany(ctx,{legalName:'Fictional retained bank company',country:'MY',currency:'MYR'}),department=await createDepartment(ctx,{companyId:company.id,name:'Fictional retained bank department'});await hireEmployee(ctx,{person:{id:target.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();await store.discard(ctx,{action:C.action,contractVersion:1,actionId:r.actionId});const fresh=(await store.prepare(ctx,human())).review;
 await setPayrollPermissionGrant(ctx,{companyId:company.id,permissionKey:'report.read.bank',role:'hr_admin',allowed:false});const native=vi.spyOn(pack().statutory,'reviewedBank');await expect(store.confirm(ctx,confirm(fresh))).rejects.toThrow();expect(native).not.toHaveBeenCalled();
});
it('honors an explicit Workforce denial in another retained employment company',async()=>{
 const company=await createCompany(ctx,{legalName:'Fictional denied bank company',country:'MY',currency:'MYR'}),department=await createDepartment(ctx,{companyId:company.id,name:'Fictional denied bank department'});await hireEmployee(ctx,{person:{id:target.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});const r=(await store.prepare(ctx,human())).review;
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"bank-parity-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);const current=await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx)),input={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId:ctx.userId!,capabilityId:'workforce.maintain',companyId:company.id,effect:'deny' as const}},preview=await previewAccessConfiguration(ctx,input,accessConfigurationStore);await saveAccessConfiguration(ctx,{...input,previewFingerprint:preview.fingerprint},accessConfigurationStore);
 const native=vi.spyOn(pack().statutory,'reviewedBank');await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();expect(native).not.toHaveBeenCalled();
});

it('hands a missing native statutory profile to Personnel without creating one from bank values',async()=>{await owner.db.delete(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,target.personId));const native=vi.spyOn(pack().statutory,'setBank');await expect(store.prepare(ctx,human())).rejects.toThrow();expect(native).not.toHaveBeenCalled();expect(await profile()).toBeNull();});

it('shared body contract: real Personnel pending writes and terminal retarget refusal',async()=>{await assertReviewBodyPendingParentContract({ctx,kind:C.action,businessSnapshot:state,retireTx:(tx,id)=>tx.execute(sql`select app.assistant_assigned_review_read(${id}::uuid,${C.action},true)`),prepare:async()=>(await store.prepare(ctx,human())).review,retire:r=>store.discard(ctx,{action:C.action,contractVersion:1,actionId:r.actionId})});});

it.each(['completed','expired','refused'] as const)('shared body guard refuses actual Personnel %s parent without state synthesis',async terminalState=>{
 await assertReviewBodyPendingParentContract({ctx,kind:C.action,terminalState,businessSnapshot:state,
  prepare:async()=>(await store.prepare(ctx,human())).review,
  retire:async r=>{
   if(terminalState==='completed'){expect((await store.confirm(ctx,confirm(r))).kind).toBe('completed');return;}
   if(terminalState==='expired'){
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);
    expect(await store.confirm(ctx,confirm(r))).toMatchObject({kind:'retired',receipt:{state:'expired'}});return;
   }
   await erasePersonPii(ctx,{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'FICTIONAL-SHARED-BODY-GUARD',reason:'Fictional retained-body refusal'});
  },
 });
});
