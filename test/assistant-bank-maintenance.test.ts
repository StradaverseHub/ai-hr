import {assertReviewBodyPendingParentContract} from './helpers/review-body-pending-parent-contract';
import {erasePersonPii} from '../core/pdpa';
import {appendEvent} from '../db/events';
import {verifyTenantChain} from '../core/audit-chain';
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
beforeEach(async()=>{vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');vi.stubEnv('AI_CONFIG_SECRET','fictional-bank-maintenance-custody-key-1234');await resetDb();b=await seedBase();for(const m of ['assistant','payroll','country-my'])await setModule(b.tenantId,m,'active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:ctx.userId!});target=await hireEmployee(ctx,{person:{fullName:'Fictional Bank Employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});await pack().statutory.set(ctx,{personId:target.personId,icNumber:null,epfNumber:'PRIVATE-EPF',socsoNumber:'PRIVATE-SOCSO',taxNumber:'PRIVATE-TAX',bankName:'Legacy Fictional Bank',bankAccountNo:'000-FICTIONAL-OLD'});await pack().statutory.setBank(ctx,{personId:target.personId,bankName:'Legacy Fictional Bank',bankAccountNo:'000-FICTIONAL-OLD',enableCustomHolderName:true,customHolderName:'Old Payee',enableCustomHolderId:true,customHolderId:'PRIVATE-OLD-ID'});});
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

// Authored UNRUN. Append to published45aa test/assistant-bank-maintenance.test.ts; reuse real fixture owners.
import * as bankDbClient from '../db/client';
import {pgSqlState} from '../lib/db-error';
import type {Tx} from '../db/client';
type BankPrepared=Awaited<ReturnType<typeof store.prepare>>['review'];
async function retainedState(){return{native:await state(),custody:Array.from(await owner.db.execute(sql`
 select to_jsonb(r) ledger,(select to_jsonb(c) from app.assistant_own_leave_review_content c where c.action_id=r.id) body
 from app.assistant_own_leave_review r where r.tenant_id=${b.tenantId}::uuid order by r.id`)),
 captures:Array.from(await owner.db.execute(sql`select to_jsonb(c) body from app.native_outcome_source_capture c where c.tenant_id=${b.tenantId}::uuid order by c.id`)),
 targets:Array.from(await owner.db.execute(sql`select to_jsonb(t) body from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.tenant_id=${b.tenantId}::uuid order by t.capture_id,t.kind,t.target_id`))};}
async function bankSqlFlow(r:BankPrepared,hooks:{entry?:(tx:Tx)=>Promise<void>;after?:(tx:Tx,eventId:string)=>Promise<void>}={}){
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.assistant_bank_review_arm(${r.actionId}::uuid)`);
  await hooks.entry?.(tx);
  const native=await pack().statutory.setBank(ctx,{personId:target.personId,...fields()},tx);
  const events=await tx.execute<{id:string}>(sql`select id from domain_event where tenant_id=${b.tenantId}::uuid
   and aggregate_id=${native.id}::uuid and event_type='employee.bank.updated' and xmin=pg_current_xact_id()::xid`);
  expect(events).toHaveLength(1);const eventId=events[0].id;
  await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${eventId}::uuid)`);
  await hooks.after?.(tx,eventId);return eventId;
 });
}
async function exactBankRefusal(work:()=>Promise<unknown>,message:string){
 const before=await retainedState();let error:unknown,rawError:unknown;const real=bankDbClient.withTenant;
 const observed:typeof withTenant=async(who,run,options)=>{try{return await real(who,run,options);}catch(e){rawError=e;throw e;}};
 const previousObserver=bankAuditErrorObserver;
 const spy=bankAuditHarnessActive?null:vi.spyOn(bankDbClient,'withTenant').mockImplementation(observed);
 if(bankAuditHarnessActive)bankAuditErrorObserver=e=>{rawError=e;};
 try{try{await work();}catch(e){error=e;}}finally{spy?.mockRestore();bankAuditErrorObserver=previousObserver;}
 error=rawError??error;
 expect(pgSqlState(error)).toBe('42501');const messages:unknown[]=[];
 for(let current=error;current&&typeof current==='object';current=(current as {cause?:unknown}).cause)messages.push((current as {message?:unknown}).message);
 expect(messages).toContain(message);expect(await retainedState()).toEqual(before);
}
async function withBankHook(spec:{relation:'employee_statutory_my'|'public.domain_event'|'app.assistant_own_leave_review'|'app.assistant_own_leave_review_content';timing:'BEFORE'|'AFTER';event:'INSERT'|'UPDATE'|'DELETE';prefix:'aa'|'zz';when:string;body:string},work:(sequence:string)=>Promise<void>){
 const name=spec.prefix+'_bank_probe_'+randomUUID().replaceAll('-',''),sequence='bank_probe_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`CREATE SEQUENCE app.${sequence};
  CREATE FUNCTION app.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$
  BEGIN IF ${spec.when} THEN PERFORM nextval('app.${sequence}');${spec.body} END IF;
  ${spec.event==='DELETE'?'RETURN OLD;':'RETURN NEW;'} END $probe$;
  CREATE TRIGGER ${name} ${spec.timing} ${spec.event} ON ${spec.relation} FOR EACH ROW EXECUTE FUNCTION app.${name}();`));
 try{await work(sequence);}finally{await owner.db.execute(sql.raw(`DROP TRIGGER ${name} ON ${spec.relation};DROP FUNCTION app.${name}();DROP SEQUENCE app.${sequence};`));}
}
async function probeValue(sequence:string){const [row]=await owner.db.execute<{value:string}>(sql.raw(`select last_value::text value from app.${sequence}`));return BigInt(row.value);}
async function markProbe(sequence:string){const [row]=await owner.db.execute<{value:string}>(sql.raw(`select nextval('app.${sequence}')::text value`));return BigInt(row.value);}

it('bank closure: actual native roundtrip retains independently seeded nonempty statutory columns and recovers after later lawful native update',async()=>{
 const before=await profile();expect(before?.epfNumber).toBe('PRIVATE-EPF');expect(before?.socsoNumber).toBe('PRIVATE-SOCSO');
 const r=(await store.prepare(ctx,human())).review,done=await store.confirm(ctx,confirm(r));expect(done.kind).toBe('completed');
 const privateState=await retainedState();expect(privateState.captures).toHaveLength(1);expect(privateState.targets.length).toBeGreaterThan(0);
 const after=await profile();expect(after?.epfNumber).toBe('PRIVATE-EPF');expect(after?.socsoNumber).toBe('PRIVATE-SOCSO');
 expect(after?.bankAccountNo).toBe('000-FICTIONAL-NEW');
 await pack().statutory.set(ctx,{personId:target.personId,icNumber:null,epfNumber:'LAWFUL-LATER-EPF'});
 expect((await profile())?.epfNumber).toBe('LAWFUL-LATER-EPF');expect((await store.reopen(ctx,r.actionId)).kind).toBe('completed');
});
it('bank closure: a valid EPF write succeeds unarmed, but the same write before native ENTRY cannot replace protected review source',async()=>{
 const sentinel=Error('rollback valid unarmed EPF positive');let positive=false;
 await expect(withTenant(ctx,async tx=>{const rows=await tx.execute(sql`update employee_statutory_my set epf_number='VALID-ENTRY-EPF' where person_id=${target.personId}::uuid returning epf_number`);expect(rows).toHaveLength(1);expect(rows[0].epf_number).toBe('VALID-ENTRY-EPF');positive=true;throw sentinel;})).rejects.toBe(sentinel);expect(positive).toBe(true);
 const r=(await store.prepare(ctx,human())).review;let entryAttempted=false;
 await exactBankRefusal(()=>bankSqlFlow(r,{entry:async tx=>{entryAttempted=true;await tx.execute(sql`update employee_statutory_my set epf_number='VALID-ENTRY-EPF' where person_id=${target.personId}::uuid`);}}),'Bank retained source changed');expect(entryAttempted).toBe(true);
});
it('bank closure: real shared custody arms protected identity before entering the original native setter',async()=>{
 const r=(await store.prepare(ctx,human())).review,before=await retainedState(),original=pack().statutory.setBank;
 let entered=false,nativeError:unknown;
 const spy=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(nativeCtx,p,tx)=>{
  entered=true;if(!tx)throw Error('real enclosing native Tx required');
  try{await tx.execute(sql`update employee_statutory_my set epf_number='VALID-ENTRY-EPF' where person_id=${p.personId}::uuid`);}
  catch(error){nativeError=error;throw error;}
  return original(nativeCtx,p,tx);
 });
 try{
  await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();expect(entered).toBe(true);
  expect(pgSqlState(nativeError)).toBe('42501');const messages:unknown[]=[];
  for(let e=nativeError;e&&typeof e==='object';e=(e as {cause?:unknown}).cause)messages.push((e as {message?:unknown}).message);
  expect(messages).toContain('Bank retained source changed');expect(await retainedState()).toEqual(before);
 }finally{spy.mockRestore();}
});
it.each(['aa','zz'] as const)('bank closure: actual %s native BEFORE writer changing retained EPF refuses at exact fence',async prefix=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:'employee_statutory_my',timing:'BEFORE',event:'UPDATE',prefix,when:`NEW.person_id='${target.personId}'::uuid`,body:"NEW.epf_number:='VALID-HOOK-EPF';"},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank retained source changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it.each(['ledger','body'] as const)('bank closure: quiet %s AFTER writer cannot mutate native retained source after completion',async location=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:location==='ledger'?'app.assistant_own_leave_review':'app.assistant_own_leave_review_content',timing:'AFTER',event:location==='ledger'?'UPDATE':'DELETE',prefix:'zz',when:location==='ledger'?`NEW.id='${r.actionId}'::uuid AND NEW.state='completed'`:`OLD.action_id='${r.actionId}'::uuid`,body:`UPDATE public.employee_statutory_my SET epf_number='VALID-LATE-EPF' WHERE person_id='${target.personId}'::uuid;`},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank native command closed until commit');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it.each(['metadata','skip_delete'] as const)('bank closure: initial completed %s is compared with independent pre-completion custody',async mode=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:mode==='metadata'?'app.assistant_own_leave_review':'app.assistant_own_leave_review_content',timing:'BEFORE',event:mode==='metadata'?'UPDATE':'DELETE',prefix:'zz',when:mode==='metadata'?`NEW.id='${r.actionId}'::uuid AND NEW.state='completed'`:`OLD.action_id='${r.actionId}'::uuid`,body:mode==='metadata'?"NEW.created_at:=NEW.created_at+interval '1 second';":'RETURN NULL;'},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),mode==='metadata'?'Bank armed review immutable':'Bank completed custody changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it.each(['native','event','ledger'] as const)('bank closure: late same-root %s no-op is refused even after constraints forced immediate',async location=>{
 const r=(await store.prepare(ctx,human())).review;let lateAttempted=false;
 await withBankOwnerNoops(async({eventNoop,ledgerNoop})=>exactBankRefusal(()=>bankSqlFlow(r,{after:async(tx,eventId)=>{
  await tx.execute(sql`set constraints all immediate`);lateAttempted=true;
  if(location==='native')await tx.execute(sql`update employee_statutory_my set epf_number=epf_number where person_id=${target.personId}::uuid`);
  if(location==='event')await eventNoop(tx,eventId);
  if(location==='ledger')await ledgerNoop(tx,r.actionId);
 }}),location==='native'?'Bank native command closed until commit':location==='event'?'Bank native event closed until commit':'Bank completed command closed until commit'));expect(lateAttempted).toBe(true);
});
// The app has no direct private ledger/event UPDATE grant. Run actual owner-context DML inside
// the SAME app transaction, with unique disposable fixture functions, never a different root.
async function withBankOwnerNoops(work:(helpers:{eventNoop(tx:Tx,id:string):Promise<void>;ledgerNoop(tx:Tx,id:string):Promise<void>;predecessor(tx:Tx,id:string,event:string):Promise<boolean>})=>Promise<void>){
 const suffix=randomUUID().replaceAll('-',''),event='bank_event_noop_'+suffix,ledger='bank_ledger_noop_'+suffix,verify='bank_predecessor_'+suffix;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.${event}(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$ BEGIN UPDATE public.domain_event SET payload=payload WHERE id=p;END $probe$;
  CREATE FUNCTION app.${ledger}(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$ BEGIN UPDATE app.assistant_own_leave_review SET state=state WHERE id=p;END $probe$;
  CREATE FUNCTION app.${verify}(p uuid,e uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$ SELECT app._assistant_generic_review_verify(p,e) $probe$;
  REVOKE ALL ON FUNCTION app.${verify}(uuid,uuid),app.${event}(uuid),app.${ledger}(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION app.${verify}(uuid,uuid),app.${event}(uuid),app.${ledger}(uuid) TO ai_hr_app;`));
 try{await work({predecessor:async(tx,id,eventId)=>{const [row]=await tx.execute<{valid:boolean}>(sql`select ${sql.raw('app.'+verify)}(${id}::uuid,${eventId}::uuid) valid`);return row.valid;},eventNoop:async(tx,id)=>{await tx.execute(sql`select ${sql.raw('app.'+event)}(${id}::uuid)`);},ledgerNoop:async(tx,id)=>{await tx.execute(sql`select ${sql.raw('app.'+ledger)}(${id}::uuid)`);}});}
 finally{await owner.db.execute(sql.raw(`DROP FUNCTION app.${verify}(uuid,uuid);DROP FUNCTION app.${event}(uuid);DROP FUNCTION app.${ledger}(uuid);`));}
}

it('bank closure: actual native DELETE-body trigger crossing server deadline rolls back native effect and pending custody',async()=>{
 const r=(await store.prepare(ctx,human())).review;
 await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=clock_timestamp()+interval '2 seconds' where id=${r.actionId}::uuid`);
 await withBankHook({relation:'app.assistant_own_leave_review_content',timing:'AFTER',event:'DELETE',prefix:'zz',when:`OLD.action_id='${r.actionId}'::uuid`,body:'PERFORM pg_sleep(2.2);'},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank completion deadline unavailable');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it('bank closure: canonical pending and completed privacy erasure removes private retained hashes with real audit',async()=>{
 const pending=(await store.prepare(ctx,human())).review;
 await erasePersonPii(ctx,{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'FICTIONAL-BANK-PENDING',reason:'Fictional bank review erasure'});
 const [retired]=await owner.db.execute(sql`select state,bank_retained_prepare_hash,bank_before_hash,bank_after_hash,bank_event_payload_hash,bank_event_scope_hash,bank_retained_root_xid,bank_audit_preimage from app.assistant_own_leave_review where id=${pending.actionId}::uuid`);expect(retired).toEqual({state:'refused',bank_retained_prepare_hash:null,bank_before_hash:null,bank_after_hash:null,bank_event_payload_hash:null,bank_event_scope_hash:null,bank_retained_root_xid:null,bank_audit_preimage:null});
 const complete=(await store.prepare(ctx,human())).review;await store.confirm(ctx,confirm(complete));
 const [armed]=await owner.db.execute<{image:unknown}>(sql`select bank_audit_preimage image from app.assistant_own_leave_review where id=${complete.actionId}::uuid`);expect(armed.image).not.toBeNull();
 await erasePersonPii(ctx,{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'FICTIONAL-BANK-COMPLETED',reason:'Fictional completed bank erasure'});
 const [closed]=await owner.db.execute(sql`select state,bank_retained_prepare_hash,bank_before_hash,bank_after_hash,bank_event_payload_hash,bank_event_scope_hash,bank_retained_root_xid,bank_audit_preimage from app.assistant_own_leave_review where id=${complete.actionId}::uuid`);expect(closed).toEqual({state:'completed',bank_retained_prepare_hash:null,bank_before_hash:null,bank_after_hash:null,bank_event_payload_hash:null,bank_event_scope_hash:null,bank_retained_root_xid:null,bank_audit_preimage:null});
});

it.each(['created_at','expires_at'] as const)('bank V2: actual initial-arm %s callback cannot nominate a new completed baseline',async field=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:'app.assistant_own_leave_review',timing:'BEFORE',event:'UPDATE',prefix:'zz',
  when:`NEW.id='${r.actionId}'::uuid AND OLD.bank_retained_root_xid IS NULL AND NEW.bank_retained_root_xid IS NOT NULL AND NEW.state='awaiting_confirmation'`,
  body:`NEW.${field}:=NEW.${field}+interval '${field==='expires_at'?'1 hour':'1 second'}';`},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank armed custody changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it('bank V2: an actual initial-arm body-deleting callback rolls back before native ENTRY',async()=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:'app.assistant_own_leave_review',timing:'AFTER',event:'UPDATE',prefix:'zz',
  when:`NEW.id='${r.actionId}'::uuid AND OLD.bank_retained_root_xid IS NULL AND NEW.bank_retained_root_xid IS NOT NULL AND NEW.state='awaiting_confirmation'`,
  body:`DELETE FROM app.assistant_own_leave_review_content WHERE action_id='${r.actionId}'::uuid;`},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank armed custody changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it('bank V2: a real paired bank/event mutation passes predecessor proof unarmed but cannot launder the protected human after-state',async()=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankOwnerNoops(async({predecessor})=>withBankHook({relation:'public.domain_event',timing:'AFTER',event:'INSERT',prefix:'zz',
  when:`NEW.aggregate_type='employee-statutory' AND NEW.event_type='employee.bank.updated' AND NEW.payload->>'personId'='${target.personId}'`,
  body:`UPDATE public.employee_statutory_my SET bank_account_no='ROGUE-PAIRED' WHERE person_id='${target.personId}'::uuid;
   UPDATE public.domain_event SET payload=jsonb_set(payload,'{after,bankAccountNo}','"ROGUE-PAIRED"'::jsonb,false) WHERE id=NEW.id;`},async sequence=>{
  const baseline=await retainedState(),rollback=Error('paired native baseline rollback');let actualPair=false;
  await expect(withTenant(ctx,async tx=>{
   const native=await pack().statutory.setBank(ctx,{personId:target.personId,...fields()},tx);
   const events=await tx.execute<{id:string;after:string}>(sql`select id,payload#>>'{after,bankAccountNo}' as after from domain_event
    where aggregate_id=${native.id}::uuid and event_type='employee.bank.updated' and xmin=pg_current_xact_id()::xid`);
   expect(events).toHaveLength(1);expect(events[0].after).toBe('ROGUE-PAIRED');
   const [row]=await tx.execute<{bank:string}>(sql`select bank_account_no bank from employee_statutory_my where id=${native.id}::uuid`);
   expect(row.bank).toBe('ROGUE-PAIRED');expect(await predecessor(tx,r.actionId,events[0].id)).toBe(true);actualPair=true;throw rollback;
  })).rejects.toBe(rollback);expect(actualPair).toBe(true);expect(await retainedState()).toEqual(baseline);
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank reviewed after-state changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 }));
});
it.each(['payload','timestamp'] as const)('bank V2: native event %s must match the independently declared whole event commitment',async part=>{
 const r=(await store.prepare(ctx,human())).review;
 await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',
  when:`NEW.aggregate_type='employee-statutory' AND NEW.event_type='employee.bank.updated' AND NEW.payload->>'personId'='${target.personId}'`,
  body:part==='payload'?`NEW.payload:=NEW.payload||'{"unreviewedBankFact":true}'::jsonb;`:"NEW.occurred_at:=NEW.occurred_at-interval '1 microsecond';"},async sequence=>{
  const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank reviewed event changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
 });
});
it('bank V2: genuine cross-zone encrypted prepare/confirm/recover preserves caller timezone and date authority',async()=>{
 // A long-established employment avoids manufacturing a date-sensitive hire admission at midnight.
 await owner.db.update(s.employment).set({hiredOn:'2020-01-01'}).where(eq(s.employment.id,target.employmentId));
 await owner.db.insert(s.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,cutOffDay:25})
  .onConflictDoUpdate({target:s.companyPayrollConfig.companyId,set:{cutOffDay:25}});
 await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'report.read.bank',role:'hr_admin',allowed:true});
 const config=await owner.db.select().from(s.companyPayrollConfig).where(eq(s.companyPayrollConfig.companyId,b.companyId));
 const grants=await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.tenantId,b.tenantId));
 expect(config).toHaveLength(1);expect(grants.length).toBeGreaterThan(0);
 const real=bankDbClient.withTenant;let zone='America/Los_Angeles',observed=0;
 const zoned:typeof withTenant=async(who,work,options)=>real(who,async tx=>{
  await tx.execute(sql`select set_config('TimeZone',${zone},true)`);
  const [before]=await tx.execute<{zone:string;date:string}>(sql`select current_setting('TimeZone') zone,current_date::text date`);
  const result=await work(tx);
  const [after]=await tx.execute<{zone:string;date:string}>(sql`select current_setting('TimeZone') zone,current_date::text date`);
  expect(before.zone).toBe(zone);expect(after).toEqual(before);observed++;return result;
 },options);
 const spy=vi.spyOn(bankDbClient,'withTenant').mockImplementation(zoned);
 try{
  const r=(await store.prepare(ctx,human())).review;zone='Pacific/Auckland';const done=await store.confirm(ctx,confirm(r));expect(done.kind).toBe('completed');
  zone='Etc/GMT+12';expect(await store.reopen(ctx,r.actionId)).toEqual(done);expect(observed).toBeGreaterThanOrEqual(3);
 }finally{spy.mockRestore();}
});
it('bank V2: later owner DELETE cannot remove completed metadata while genuine USER FK cascade remains admitted',async()=>{
 const r=(await store.prepare(ctx,human())).review;await store.confirm(ctx,confirm(r));
 await exactBankRefusal(()=>owner.db.execute(sql`delete from app.assistant_own_leave_review where id=${r.actionId}::uuid`),'Bank completed identity immutable');
 const userId=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(ctx,{appUserId:userId});
 const who:SessionContext={...await entitledCtx(b,['hr_admin']),userId,personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const second=(await store.prepare(who,human())).review;await store.confirm(who,confirm(second));const nativeBefore=await profile();
 const [exists]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from app.assistant_own_leave_review where id=${second.actionId}::uuid`);expect(exists.count).toBe(1);
 // This is the actual configured app_user -> review ON DELETE CASCADE, not a forged erasure GUC.
 await owner.db.delete(s.appUser).where(eq(s.appUser.id,userId));
 const [gone]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from app.assistant_own_leave_review where id=${second.actionId}::uuid`);expect(gone.count).toBe(0);expect(await profile()).toEqual(nativeBefore);
});

let bankAuditHarnessActive=false;
let bankAuditErrorObserver:((error:unknown)=>void)|null=null;
// V3 audit slots are qualified by the native audit owner, against an independent PRE-native root.
async function observedBankSuccess<T>(work:()=>Promise<T>):Promise<T>{
 const real=bankDbClient.withTenant;const raw:Array<{code:string|null;messages:unknown[]}>=[];let result:T|undefined,publicFailure:unknown;
 const record=(error:unknown)=>{
  const messages:unknown[]=[];for(let e=error;e&&typeof e==='object';e=(e as {cause?:unknown}).cause)messages.push((e as {message?:unknown}).message);
  raw.push({code:pgSqlState(error)??null,messages});
 };
 const observed:typeof withTenant=async(who,run,options)=>{try{return await real(who,run,options);}catch(error){record(error);throw error;}};
 const previousObserver=bankAuditErrorObserver;const spy=bankAuditHarnessActive?null:vi.spyOn(bankDbClient,'withTenant').mockImplementation(observed);if(bankAuditHarnessActive)bankAuditErrorObserver=record;
 try{try{result=await work();}catch(error){publicFailure=error;}}finally{spy?.mockRestore();bankAuditErrorObserver=previousObserver;}
 // This is fixture-only observation before the public boundary sanitizes. No production cause/log change.
 expect({publicFailure:publicFailure instanceof Error?publicFailure.name:null,raw},'real transaction positive must complete; original inner SQL cause retained here').toEqual({publicFailure:null,raw:[]});
 return result as T;
}
type AuditMode='unarmed'|'guc'|'persisted'|'history';
async function withAuditMode<T>(mode:AuditMode,work:(guc:'on'|'off')=>Promise<T>):Promise<T>{
 vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');
 const [initial]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`);expect(initial.n).toBe(0);
 if(mode==='persisted')await owner.db.execute(sql`insert into tenant_setting(tenant_id,key,value,source,updated_by) values(${b.tenantId}::uuid,'audit.hash_chain_enabled','true'::jsonb,'customer',${ctx.userId}::uuid) on conflict(tenant_id,key) do update set value='true'::jsonb`);
 if(mode==='history')await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-audit-history',aggregateId:randomUUID(),eventType:'fictional-audit-history.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}});});
 const real=bankDbClient.withTenant,guc=mode==='guc'?'on':'off';
 const configured:typeof withTenant=async(who,run,options)=>{try{return await real(who,async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain',${guc},true)`);const value=await run(tx);const [after]=await tx.execute<{guc:string}>(sql`select current_setting('app.audit_hash_chain') guc`);expect(after.guc).toBe(guc);return value;},options);}catch(error){bankAuditErrorObserver?.(error);throw error;}};
 const spy=vi.spyOn(bankDbClient,'withTenant').mockImplementation(configured);
 bankAuditHarnessActive=true;try{return await work(guc);}finally{bankAuditHarnessActive=false;bankAuditErrorObserver=null;spy.mockRestore();}
}
async function auditEvent(id:string){const [row]=await owner.db.execute<{id:string;chain_seq:string|null;prev_hash:string|null;hash:string|null;recomputed:string|null}>(sql`select id,chain_seq::text,prev_hash,hash,app.domain_event_hash(prev_hash,tenant_id,chain_seq,aggregate_type,aggregate_id,event_type,actor_type::text,actor_id,subject_employment_id,payload) recomputed from domain_event where id=${id}::uuid`);expect(row).toBeDefined();return row;}
it.each(['unarmed','guc','persisted','history'] as const)('bank V4: real encrypted roundtrip and non-assistant native event retain canonical %s audit behavior',async mode=>{
 await withAuditMode(mode,async()=>{
  const native=await withTenant(ctx,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-native-audit-control',aggregateId:randomUUID(),eventType:'fictional-native-audit-control.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:'native parity'}},{returnId:true}));expect(native).toEqual(expect.any(String));
  const control=await auditEvent(native!);
  const r=(await store.prepare(ctx,human())).review;
  const done=await observedBankSuccess(()=>store.confirm(ctx,confirm(r)));expect(done.kind).toBe('completed');
  const [receipt]=await owner.db.execute<{id:string}>(sql`select receipt_event_id id from app.assistant_own_leave_review where id=${r.actionId}::uuid`);const bank=await auditEvent(receipt.id);
  if(mode==='unarmed'){expect(control).toMatchObject({chain_seq:null,prev_hash:null,hash:null});expect(bank).toMatchObject({chain_seq:null,prev_hash:null,hash:null});}
  else{expect(control.hash).toMatch(/^[a-f0-9]{64}$/);expect(control.hash).toBe(control.recomputed);expect(bank.hash).toBe(bank.recomputed);expect(bank.prev_hash).toBe(control.hash);expect(BigInt(bank.chain_seq!)).toBe(BigInt(control.chain_seq!)+BigInt(1));}
  expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toEqual(done);expect(await observedBankSuccess(()=>store.confirm(ctx,confirm(r)))).toEqual(done);
  const chain=await verifyTenantChain(ctx);expect(chain.valid).toBe(true);expect(chain.issues).toEqual([]);expect(chain.unchainedInsideChain).toBe(0);
 });
});
it.each(['unarmed','guc'] as const)('bank V4: %s audit tuple cannot launder a different armed mode with a valid native hash',async mode=>{
 await withAuditMode(mode,async()=>{
  const r=(await store.prepare(ctx,human())).review;
  const body=mode==='unarmed'?`NEW.chain_seq:=1;NEW.prev_hash:='GENESIS';NEW.hash:=app.domain_event_hash(NEW.prev_hash,NEW.tenant_id,NEW.chain_seq,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload);`:'NEW.chain_seq:=NULL;NEW.prev_hash:=NULL;NEW.hash:=NULL;';
  await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body},async sequence=>{
   const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank reviewed event changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
  });
 });
});
it.each(['chain_seq','prev_hash','hash'] as const)('bank V4: generated %s tamper rolls back real native effect and whole custody',async field=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review;
  const body=field==='chain_seq'?'NEW.chain_seq:=NEW.chain_seq+1;':field==='prev_hash'?"NEW.prev_hash:='FICTIONAL-WRONG-HEAD';":"NEW.hash:=repeat('0',64);";
  await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body},async sequence=>{
   const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank reviewed event changed');expect(await probeValue(sequence)).toBe(before+BigInt(1));
  });
 });
});
it('bank V4: actual first-event GUC disarm after arm cannot change independently committed mode',async()=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review,original=pack().statutory.setBank;let entered=false;
  const native=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(who,input,tx)=>{entered=true;if(!tx)throw Error('Expected actual enclosing transaction');await tx.execute(sql`select set_config('app.audit_hash_chain','off',true)`);return original(who,input,tx);});
  try{await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'aa',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body:'PERFORM 1;'},async sequence=>{const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank audit decision changed before native INSERT');expect(entered).toBe(true);expect(await probeValue(sequence)).toBe(before+BigInt(1));});}finally{native.mockRestore();}
 });
});
it('bank V4: another canonical event between arm and native INSERT cannot nominate a new expected head',async()=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review,original=pack().statutory.setBank;let inserted=false;
  const native=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(who,input,tx)=>{if(!tx)throw Error('Expected actual enclosing transaction');await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-head-interposition',aggregateId:randomUUID(),eventType:'fictional-head-interposition.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}});inserted=true;return original(who,input,tx);});
  try{await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank audit decision changed before native INSERT');expect(inserted).toBe(true);}finally{native.mockRestore();}
 });
});
it('bank V4: real competing native audit lock refuses whole confirmation with 55P03 instead of lock inversion',async()=>{
 const r=(await store.prepare(ctx,human())).review,before=await retainedState();let release!:()=>void,ready!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{ready=resolve;});
 const blocker=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit-chain:'||${b.tenantId}::text))`);ready();await held;});
 await started;const real=bankDbClient.withTenant;let raw:unknown;
 const observe:typeof withTenant=async(who,run,options)=>{try{return await real(who,run,options);}catch(error){raw=error;throw error;}};
 const spy=vi.spyOn(bankDbClient,'withTenant').mockImplementation(observe);
 try{await expect(store.confirm(ctx,confirm(r))).rejects.toThrow();expect(pgSqlState(raw)).toBe('55P03');const messages:unknown[]=[];for(let e=raw;e&&typeof e==='object';e=(e as {cause?:unknown}).cause)messages.push((e as {message?:unknown}).message);expect(messages).toContain('Audit chain busy');}
 finally{spy.mockRestore();release();await blocker;}
 expect(await retainedState()).toEqual(before);expect(await observedBankSuccess(()=>store.confirm(ctx,confirm(r)))).toMatchObject({kind:'completed'});
});
it('bank V4: native unarmed non-assistant INSERT retains exact preexisting caller-slot semantics',async()=>{
 const id=randomUUID();await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain','off',true)`);await tx.insert(s.domainEvent).values({id,tenantId:b.tenantId,aggregateType:'fictional-legacy-slot-parity',aggregateId:randomUUID(),eventType:'fictional-legacy-slot-parity.created',actorType:'user',actorId:ctx.userId!,payload:{fictional:true},chainSeq:41,prevHash:'FICTIONAL-LEGACY-PREV',hash:'FICTIONAL-LEGACY-HASH'});});
 expect(await auditEvent(id)).toMatchObject({chain_seq:'41',prev_hash:'FICTIONAL-LEGACY-PREV',hash:'FICTIONAL-LEGACY-HASH'});
});
it('bank V4: private native audit preimage owner grants no app log or helper read authority',async()=>{
 let failure:unknown;try{await withTenant(ctx,tx=>tx.execute(sql`select app._domain_event_next(${b.tenantId}::uuid,true)`));}catch(error){failure=error;}expect(pgSqlState(failure)).toBe('42501');
 const [acl]=await owner.db.execute<{app:boolean;public:boolean;same_owner:boolean}>(sql`select (select proowner from pg_proc where oid='app._domain_event_next(uuid,boolean)'::regprocedure)=(select proowner from pg_proc where oid='app.domain_event_chain_tg()'::regprocedure) same_owner,has_function_privilege('ai_hr_app','app._domain_event_next(uuid,boolean)','EXECUTE') app,exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app._domain_event_next(uuid,boolean)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public`);expect(acl).toEqual({same_owner:true,app:false,public:false});
});
it('bank V4: raw arm COMMIT without completion rolls back and original encrypted packet still reopens and confirms',async()=>{
 const r=(await store.prepare(ctx,human())).review;
 await exactBankRefusal(()=>withTenant(ctx,tx=>tx.execute(sql`select app.assistant_bank_review_arm(${r.actionId}::uuid)`)),'Bank completed custody changed');
 expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toEqual({kind:'prepared',review:r});
 expect(await observedBankSuccess(()=>store.confirm(ctx,confirm(r)))).toMatchObject({kind:'completed'});
});
it('bank V4: repeated same-root arm keeps original encrypted binding and body and never rebases expected audit head',async()=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review;
  const [before]=await withTenant(ctx,tx=>tx.execute<{review:{metadata:{binding:unknown};sealed:unknown}}>(sql`select app.assistant_assigned_review_read(${r.actionId}::uuid,${C.action}) review`));let repeated=false;
  await bankSqlFlow(r,{entry:async tx=>{
   await tx.execute(sql`select app.assistant_bank_review_arm(${r.actionId}::uuid)`);repeated=true;
   const [after]=await tx.execute<{review:{metadata:{binding:unknown};sealed:unknown}}>(sql`select app.assistant_assigned_review_read(${r.actionId}::uuid,${C.action}) review`);
   expect(after.review.metadata.binding).toEqual(before.review.metadata.binding);expect(after.review.sealed).toEqual(before.review.sealed);
  }});expect(repeated).toBe(true);expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toMatchObject({kind:'completed'});
 });
});
it('bank V4: completed recovery keeps original event contribution after later native bank, audit mode/head and employment ordering change',async()=>{
 const r=(await store.prepare(ctx,human())).review,done=await observedBankSuccess(()=>store.confirm(ctx,confirm(r)));
 await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-later-chain',aggregateId:randomUUID(),eventType:'fictional-later-chain.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}});});
 const company=await createCompany(ctx,{legalName:'Fictional Later Shared Bank Company',country:'MY',currency:'MYR'}),department=await createDepartment(ctx,{companyId:company.id,name:'Fictional Later Department'});
 const earlier=await hireEmployee(ctx,{person:{id:target.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [selected]=await owner.db.execute<{id:string}>(sql`select id from employment where tenant_id=${b.tenantId}::uuid and person_id=${target.personId}::uuid order by (terminated_on is not null),hired_on,id limit 1`);expect(selected.id).toBe(earlier.employmentId);
 await pack().statutory.setBank(ctx,{personId:target.personId,bankName:fields().bankName,bankAccountNo:'000-FICTIONAL-LATER',enableCustomHolderName:false,enableCustomHolderId:false});
 const [chained]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`);expect(chained.n).toBeGreaterThan(0);
 expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toEqual(done);expect(await observedBankSuccess(()=>store.confirm(ctx,confirm(r)))).toEqual(done);
});
it.each(['discarded','expired'] as const)('bank V4: %s cleanup retains SQL NULL private audit preimage and closes original custody',async state=>{
 const r=(await store.prepare(ctx,human())).review;
 if(state==='discarded')expect(await store.discard(ctx,{action:C.action,contractVersion:1,actionId:r.actionId})).toMatchObject({kind:'retired',receipt:{state}});
 else{await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);
  const [due]=await owner.db.execute(sql`select state,created_at<expires_at chronology,expires_at<clock_timestamp() due,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);expect(due).toEqual({state:'awaiting_confirmation',chronology:true,due:true,bodies:1});
  expect(await store.reopen(ctx,r.actionId)).toMatchObject({kind:'retired',receipt:{state}});}
 const [row]=await owner.db.execute(sql`select state,bank_audit_preimage,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);expect(row).toEqual({state,bank_audit_preimage:null,bodies:0});
});

async function auditControl(){const id=await withTenant(ctx,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-audit-edge-control',aggregateId:randomUUID(),eventType:'fictional-audit-edge-control.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true}));expect(id).toEqual(expect.any(String));return auditEvent(id!);}
async function withAuditFixtureWriter(work:(helpers:{erase(tx:Tx,id:string):Promise<void>;system(tx:Tx,tenant:string,id:string):Promise<void>})=>Promise<void>){
 const suffix=randomUUID().replaceAll('-',''),erase='bank_audit_erase_'+suffix,system='bank_audit_system_'+suffix;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.${erase}(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$ BEGIN DELETE FROM public.domain_event WHERE id=p;END $probe$;
 CREATE FUNCTION app.${system}(t uuid,p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $probe$ BEGIN INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(p,t,'fictional-other-native-system',p,'fictional-other-native-system.created','system',NULL,'{"fictional":true}'::jsonb);END $probe$;
 REVOKE ALL ON FUNCTION app.${erase}(uuid),app.${system}(uuid,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION app.${erase}(uuid),app.${system}(uuid,uuid) TO ai_hr_app;`));
 try{await work({erase:async(tx,id)=>{await tx.execute(sql`select ${sql.raw('app.'+erase)}(${id}::uuid)`);},system:async(tx,tenant,id)=>{await tx.execute(sql`select ${sql.raw('app.'+system)}(${tenant}::uuid,${id}::uuid)`);}});}
 finally{await owner.db.execute(sql.raw(`DROP FUNCTION app.${erase}(uuid);DROP FUNCTION app.${system}(uuid,uuid);`));}
}
it('bank V5: genuine interposed event plus paired canonical rewrite cannot duplicate the protected selected chain position',async()=>{
 await withAuditMode('guc',async()=>{
  const head=await auditControl();expect(head.hash).toMatch(/^[a-f0-9]{64}$/);const selected=(BigInt(head.chain_seq!)+BigInt(1)).toString(),r=(await store.prepare(ctx,human())).review,original=pack().statutory.setBank;let inserted=false;
  const native=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(who,input,tx)=>{if(!tx)throw Error('Expected real enclosing Tx');const id=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-interposed-F',aggregateId:randomUUID(),eventType:'fictional-interposed-F.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true});expect(id).toEqual(expect.any(String));inserted=true;return original(who,input,tx);});
  try{await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'aa',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body:'PERFORM 1;'},async earlySequence=>{const earlyBefore=await markProbe(earlySequence);await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body:`NEW.chain_seq:=${selected};NEW.prev_hash:='${head.hash}';NEW.hash:=app.domain_event_hash(NEW.prev_hash,NEW.tenant_id,NEW.chain_seq,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload);`},async sequence=>{const before=await markProbe(sequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank audit decision changed before native INSERT');expect(inserted).toBe(true);expect(await probeValue(earlySequence)).toBe(earlyBefore+BigInt(1));expect(await probeValue(sequence),'late paired rewrite must not run after canonical owner refusal').toBe(before);});});}finally{native.mockRestore();}
 });
});
it.each(['duplicate_insert','retarget_update','predecessor_update','predecessor_delete'] as const)('bank V5: actual late %s cannot invalidate original audit edge after constraints forced immediate',async operation=>{
 await withAuditMode('guc',async()=>{
  const head=await auditControl();expect(head.hash).toMatch(/^[a-f0-9]{64}$/);const selected=(BigInt(head.chain_seq!)+BigInt(1)).toString(),r=(await store.prepare(ctx,human())).review;let lateAttempted=false;
  const retarget=operation==='retarget_update',insert=operation==='duplicate_insert',deleting=operation==='predecessor_delete';
  const event=insert?'INSERT':deleting?'DELETE':'UPDATE',timing='BEFORE' as const,prefix=insert||retarget?'zz':'aa';
  const when=insert||retarget?`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='fictional-late-audit-edge.created'`:`OLD.id='${head.id}'::uuid`;
  const body=insert||retarget?`NEW.chain_seq:=${selected};NEW.prev_hash:='${head.hash}';NEW.hash:=app.domain_event_hash(NEW.prev_hash,NEW.tenant_id,NEW.chain_seq,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload);`:'PERFORM 1;';
  await withBankHook({relation:'public.domain_event',timing,event,prefix,when,body},async sequence=>{
   const before=await markProbe(sequence);
   await withAuditFixtureWriter(async({erase})=>withBankOwnerNoops(async({eventNoop})=>exactBankRefusal(()=>bankSqlFlow(r,{after:async tx=>{
    await tx.execute(sql`set constraints all immediate`);lateAttempted=true;
    if(insert||retarget){const id=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-late-audit-edge',aggregateId:randomUUID(),eventType:'fictional-late-audit-edge.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true});if(retarget){expect(id).toEqual(expect.any(String));await eventNoop(tx,id!);}}
    else if(deleting)await erase(tx,head.id);else await eventNoop(tx,head.id);
   }}),'Bank audit edge closed until commit')));
   expect(lateAttempted).toBe(true);expect(await probeValue(sequence)).toBe(before+BigInt(1));
  });
 });
});
it('bank V5: ordinary later append and other-tenant SYSTEM INSERT still work in completed Bank root after immediate constraints',async()=>{
 const other=await seedBase(),otherId=randomUUID();
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review;let appended:string|undefined;
  await withAuditFixtureWriter(async({system})=>{await bankSqlFlow(r,{after:async tx=>{
   await tx.execute(sql`set constraints all immediate`);
   appended=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-later-native-append',aggregateId:randomUUID(),eventType:'fictional-later-native-append.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true});
   await system(tx,other.tenantId,otherId);
  }});});expect(appended).toEqual(expect.any(String));
  const [receipt]=await owner.db.execute<{id:string}>(sql`select receipt_event_id id from app.assistant_own_leave_review where id=${r.actionId}::uuid`),bank=await auditEvent(receipt.id),later=await auditEvent(appended!),foreign=await auditEvent(otherId);
  expect(later.prev_hash).toBe(bank.hash);expect(later.hash).toBe(later.recomputed);expect(BigInt(later.chain_seq!)).toBe(BigInt(bank.chain_seq!)+BigInt(1));expect(foreign.chain_seq).toBe(bank.chain_seq);expect(foreign.hash).toBe(foreign.recomputed);
  expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toMatchObject({kind:'completed'});expect((await verifyTenantChain(ctx)).valid).toBe(true);
 });
});
it('bank V5: a legitimate audit append between human prepare and actual arm does not change encrypted review authority',async()=>{
 await withAuditMode('guc',async()=>{const r=(await store.prepare(ctx,human())).review,control=await auditControl(),done=await observedBankSuccess(()=>store.confirm(ctx,confirm(r)));const [row]=await owner.db.execute<{id:string}>(sql`select receipt_event_id id from app.assistant_own_leave_review where id=${r.actionId}::uuid`);expect((await auditEvent(row.id)).prev_hash).toBe(control.hash);expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toEqual(done);});
});
it('bank V5: canonical native SYSTEM owner writer remains admitted without user/person/purpose even when GUC is off and persisted audit is on',async()=>{
 await withAuditMode('persisted',async()=>{
  const id=randomUUID();await owner.db.transaction(async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain','off',true),set_config('app.tenant_id','',true),set_config('app.user_id','',true),set_config('app.roles','',true)`);await tx.insert(s.domainEvent).values({id,tenantId:b.tenantId,aggregateType:'fictional-native-system',aggregateId:randomUUID(),eventType:'fictional-native-system.created',actorType:'system',actorId:null,payload:{fictional:true}});});
  const event=await auditEvent(id);expect(event.chain_seq).toBe('1');expect(event.hash).toBe(event.recomputed);
 });
});
it('bank V5: genuine unlinked USER native event requires no Personnel-purpose or assistant entitlement',async()=>{
 await withAuditMode('guc',async()=>{
  const userId=await createAppUser(b.tenantId,null,'hr_admin'),who:SessionContext={...await entitledCtx(b,['hr_admin']),userId,personId:null,grants:[{role:'hr_admin',companyId:null}]};
  const id=await withTenant(who,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-native-unlinked',aggregateId:randomUUID(),eventType:'fictional-native-unlinked.created',actor:{type:'user',id:userId},payload:{fictional:true}},{returnId:true}));expect(id).toEqual(expect.any(String));const event=await auditEvent(id!);expect(event.chain_seq).toBe('1');expect(event.hash).toBe(event.recomputed);
 });
});
it('bank V5: actual native AFTER INSERT observer sees and qualifies its own persisted event through fresh canonical owner',async()=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review;
  await withBankHook({relation:'public.domain_event',timing:'AFTER',event:'INSERT',prefix:'zz',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='employee.bank.updated'`,body:"IF app._domain_event_preimage_for(NEW::public.domain_event) IS NULL THEN RAISE EXCEPTION 'Fictional AFTER observer missed own persisted event' USING ERRCODE='42501';END IF;"},async sequence=>{const before=await markProbe(sequence);expect(await observedBankSuccess(()=>store.confirm(ctx,confirm(r)))).toMatchObject({kind:'completed'});expect(await probeValue(sequence)).toBe(before+BigInt(1));});
 });
});

it('bank V6: initially unarmed frame refuses genuine chain-start interpose before late NULL laundering can run',async()=>{
 await withAuditMode('unarmed',async()=>{
  // Positive native control in a real rolled-back transaction: first chaining is lawful outside a
  // held Bank frame. It must not leave history that would arm the attack's original PRE baseline.
  let nativeControl=false;await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);const id=await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-first-chain-control',aggregateId:randomUUID(),eventType:'fictional-first-chain-control.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true});const [row]=await tx.execute<{seq:string;valid:boolean}>(sql`select chain_seq::text seq,hash=app.domain_event_hash(prev_hash,tenant_id,chain_seq,aggregate_type,aggregate_id,event_type,actor_type::text,actor_id,subject_employment_id,payload) valid from domain_event where id=${id!}::uuid`);expect(row).toEqual({seq:'1',valid:true});nativeControl=true;throw Error('FICTIONAL-NATIVE-CONTROL-ROLLBACK');})).rejects.toThrow('FICTIONAL-NATIVE-CONTROL-ROLLBACK');expect(nativeControl).toBe(true);
  const [clear]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`);expect(clear.n).toBe(0);
  const r=(await store.prepare(ctx,human())).review,original=pack().statutory.setBank;let entered=false,firstChained=false;
  const native=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(who,input,tx)=>{entered=true;if(!tx)throw Error('Expected actual enclosing Tx');await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'fictional-first-chain-F',aggregateId:randomUUID(),eventType:'fictional-first-chain-F.created',actor:{type:'user',id:ctx.userId!},payload:{fictional:true}},{returnId:true});firstChained=true;await tx.execute(sql`select set_config('app.audit_hash_chain','off',true)`);return original(who,input,tx);});
  try{await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'aa',when:`NEW.tenant_id='${b.tenantId}'::uuid AND NEW.event_type='fictional-first-chain-F.created'`,body:'PERFORM 1;'},async firstSequence=>{const firstBefore=await markProbe(firstSequence);await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',when:`NEW.event_type='employee.bank.updated'`,body:'NEW.chain_seq:=NULL;NEW.prev_hash:=NULL;NEW.hash:=NULL;'},async lateSequence=>{const lateBefore=await markProbe(lateSequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank audit decision changed before native INSERT');expect(entered).toBe(true);expect(firstChained,'first chain must be refused at actual owner before returning').toBe(false);expect(await probeValue(firstSequence)).toBe(firstBefore+BigInt(1));expect(await probeValue(lateSequence),'late laundering cannot run').toBe(lateBefore);});});}finally{native.mockRestore();}
 });
});
it('bank V6: supplied SYSTEM audit slots normalize through native owner before bounded dependency guard',async()=>{
 await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review,id=randomUUID();let selected:string|undefined;
  await bankSqlFlow(r,{after:async(tx,eventId)=>{selected=eventId;await tx.execute(sql`set constraints all immediate`);const [bank]=await tx.execute<{seq:string}>(sql`select chain_seq::text seq from domain_event where id=${eventId}::uuid`);
   // Original native0534 overwrites these deliberately supplied slots while armed. The new BEFORE
   // fence must run after that normalization, rather than refuse a tuple that never becomes real.
   await tx.insert(s.domainEvent).values({id,tenantId:b.tenantId,aggregateType:'fictional-supplied-system-slots',aggregateId:randomUUID(),eventType:'fictional-supplied-system-slots.created',actorType:'system',actorId:null,payload:{fictional:true},chainSeq:Number(bank.seq),prevHash:'FICTIONAL-SUPPLIED-PREV',hash:'FICTIONAL-SUPPLIED-HASH'});
  }});const bank=await auditEvent(selected!),normalized=await auditEvent(id);expect(BigInt(normalized.chain_seq!)).toBe(BigInt(bank.chain_seq!)+BigInt(1));expect(normalized.prev_hash).toBe(bank.hash);expect(normalized.hash).toBe(normalized.recomputed);expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toMatchObject({kind:'completed'});
 });
});
it('bank V6: another-tenant native SYSTEM INSERT remains allowed while original Bank frame is still pending and stable',async()=>{
 const other=await seedBase(),otherId=randomUUID();await withAuditMode('guc',async()=>{
  const r=(await store.prepare(ctx,human())).review;let entered=false;
  await withAuditFixtureWriter(async({system})=>{await bankSqlFlow(r,{entry:async tx=>{await system(tx,other.tenantId,otherId);entered=true;}});});expect(entered).toBe(true);const foreign=await auditEvent(otherId);expect(foreign.chain_seq).toBe('1');expect(foreign.hash).toBe(foreign.recomputed);expect(await observedBankSuccess(()=>store.reopen(ctx,r.actionId))).toMatchObject({kind:'completed'});
 });
});
it('bank V6: insertion-time frame observation cannot be bypassed by masking NEW tenant before owner and restoring it late',async()=>{
 const other=await seedBase();await withAuditMode('unarmed',async()=>{
  const r=(await store.prepare(ctx,human())).review,original=pack().statutory.setBank;let entered=false;
  const native=vi.spyOn(pack().statutory,'setBank').mockImplementation(async(who,input,tx)=>{entered=true;if(!tx)throw Error('Expected actual enclosing Tx');await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);return original(who,input,tx);});
  try{await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'aa',when:"NEW.event_type='employee.bank.updated'",body:`NEW.tenant_id:='${other.tenantId}'::uuid;`},async earlySequence=>{const earlyBefore=await markProbe(earlySequence);await withBankHook({relation:'public.domain_event',timing:'BEFORE',event:'INSERT',prefix:'zz',when:"NEW.event_type='employee.bank.updated'",body:`NEW.tenant_id:='${b.tenantId}'::uuid;NEW.chain_seq:=NULL;NEW.prev_hash:=NULL;NEW.hash:=NULL;PERFORM set_config('app.audit_hash_chain','off',true);`},async lateSequence=>{const lateBefore=await markProbe(lateSequence);await exactBankRefusal(()=>store.confirm(ctx,confirm(r)),'Bank audit decision changed before native INSERT');expect(entered).toBe(true);expect(await probeValue(earlySequence)).toBe(earlyBefore+BigInt(1));expect(await probeValue(lateSequence)).toBe(lateBefore);});});}finally{native.mockRestore();}
 });
});
