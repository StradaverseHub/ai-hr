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
 const spy=vi.spyOn(bankDbClient,'withTenant').mockImplementation(observed);
 try{try{await work();}catch(e){error=e;}}finally{spy.mockRestore();}
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
 const [retired]=await owner.db.execute(sql`select state,bank_retained_prepare_hash,bank_before_hash,bank_after_hash,bank_event_payload_hash,bank_event_scope_hash,bank_retained_root_xid from app.assistant_own_leave_review where id=${pending.actionId}::uuid`);expect(retired).toEqual({state:'refused',bank_retained_prepare_hash:null,bank_before_hash:null,bank_after_hash:null,bank_event_payload_hash:null,bank_event_scope_hash:null,bank_retained_root_xid:null});
 const complete=(await store.prepare(ctx,human())).review;await store.confirm(ctx,confirm(complete));
 await erasePersonPii(ctx,{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'FICTIONAL-BANK-COMPLETED',reason:'Fictional completed bank erasure'});
 const [closed]=await owner.db.execute(sql`select state,bank_retained_prepare_hash,bank_before_hash,bank_after_hash,bank_event_payload_hash,bank_event_scope_hash,bank_retained_root_xid from app.assistant_own_leave_review where id=${complete.actionId}::uuid`);expect(closed).toEqual({state:'completed',bank_retained_prepare_hash:null,bank_before_hash:null,bank_after_hash:null,bank_event_payload_hash:null,bank_event_scope_hash:null,bank_retained_root_xid:null});
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
