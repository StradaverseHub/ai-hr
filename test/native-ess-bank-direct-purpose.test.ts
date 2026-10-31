/** Native ESS regression, for hosted DB checks. No Assistant custody or elevated employee fixture. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {setBankProfileMY,setStatutoryProfileMY,setPassportProfileMY,canMaintainBankProfileMY} from '../localization/my/statutory';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {migrateTestDb,resetDb,seedBase,owner,adminCtx,createAppUser,closeAll,type Base} from './harness';

const bank='bank_statutory.bank_information.bankname',account='bank_statutory.bank_information.bankaccountno';
const phone='profile.contact_and_permanent_address.phone';
const bankFields=[bank,account,'bank_statutory.bank_information.enablecustomholdername','bank_statutory.bank_information.customholdername','bank_statutory.bank_information.enablecustomholderid','bank_statutory.bank_information.customholderid'];
const oldAccount='FICTIONAL-ESS-OLD',newAccount='FICTIONAL-ESS-NEW';
let b:Base,self:Awaited<ReturnType<typeof subject>>;
async function subject(base=b){
 const hr={...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]};
 const hired=await hireEmployee(hr,{person:{fullName:'Fictional native ESS bank subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'employee');
 await setStatutoryProfileMY(hr,{personId:hired.personId,icNumber:null,bankName:'Maybank',bankAccountNo:oldAccount,epfNumber:'PRIVATE-EPF'});
 return {...hired,ctx:{...adminCtx(base),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext};
}
async function policy(mode:'off'|'approval'|'viewOnly'='off',base=b){
 const approvals=Object.fromEntries([...bankFields,phone].map(id=>[id,{required:mode==='approval'&&id===account,attachmentRequired:false}]));
 await saveProfileVisibilityPolicy({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]},{policy:{version:5,fields:Object.fromEntries(essVisibleFields().map(f=>[f.id,mode==='viewOnly'&&f.id===account?'viewOnly':f.ess.binding&&['immediate','approval'].includes(f.ess.edit)?'editable':'viewOnly'])),primaryOnly:[],groups:{},approvals},withdrawnReason:'Fictional native bank regression policy'});
}
const input=(personId=self.personId)=>({personId,bankName:'Maybank',bankAccountNo:newAccount,enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null});
const proposal=(fields:{fieldId:string;value:unknown}[]=[{fieldId:account,value:newAccount}])=>({v:2,fields,registers:[]});
async function begin(tx:Tx,fields=proposal(),employmentId=self.employmentId){await tx.execute(sql`select app.profile_direct_begin(${employmentId}::uuid,${JSON.stringify(fields)}::jsonb)`);}
async function purpose(tx:Tx,personId=self.personId){const [row]=await tx.execute<{allowed:boolean}>(sql`select app.profile_direct_bank_person(${personId}::uuid) as allowed`);return row.allowed;}
async function audit(tx:Tx){await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'person',aggregateId:self.personId,eventType:'profile.self-applied',actor:actorOf(self.ctx),subjectEmploymentId:self.employmentId,payload:{fields:[account]}});}
async function snapshot(tenantId=b.tenantId){return {
 statutory:await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.tenantId,tenantId)).orderBy(s.employeeStatutoryMy.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,tenantId)).orderBy(s.domainEvent.id),
 intents:await owner.db.execute(sql`select xact_id::text,tenant_id,user_id,person_id,employment_id,proposal,audited from app.profile_direct_intent where tenant_id=${tenantId}::uuid order by xact_id,user_id`),
 registers:await owner.db.execute(sql`select xact_id::text,tenant_id,user_id,kind,client_id,row_id from app.profile_direct_register where tenant_id=${tenantId}::uuid order by xact_id,user_id,kind,client_id`),
};}
function bankReads(spy:{mock:{calls:unknown[][]}}){return spy.mock.calls.filter(args=>!!args[0]&&typeof args[0]==='object'&&'bankAccountNo' in args[0]).length;}
async function beforeReadRefusal(prepare?:(tx:Tx)=>Promise<unknown>,ctx:SessionContext=self.ctx,command:Parameters<typeof setBankProfileMY>[1]=input(),cleanup?:()=>Promise<unknown>){
 const before=await snapshot();let reads=0;
 try{await expect(withTenant(ctx,async tx=>{const spy=vi.spyOn(tx,'select');try{if(prepare)await prepare(tx);await setBankProfileMY(ctx,command,tx);}finally{reads=bankReads(spy);spy.mockRestore();}})).rejects.toThrow();}finally{if(cleanup)await cleanup();}
 expect(reads).toBe(0);expect(await snapshot()).toEqual(before);
}
/** Storage-owner-only adversarial fixture. Application code cannot create these rows. Use it to
 * isolate the purpose predicate from begin's independent policy/shape refusal, including stale Tx. */
async function retainedIntent(fields:unknown,xid?:string){await owner.db.execute(sql`insert into app.profile_direct_intent(xact_id,tenant_id,user_id,employment_id,person_id,proposal,audited) values(coalesce(${xid??null}::xid8,pg_current_xact_id()),${b.tenantId}::uuid,${self.ctx.userId}::uuid,${self.employmentId}::uuid,${self.personId}::uuid,${JSON.stringify(fields)}::jsonb,true)`);}


async function currentAdversarialIntent(tx:Tx,fields:unknown){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 const [row]=await tx.execute<{xid:string}>(sql`select pg_current_xact_id()::text as xid`);await retainedIntent(fields,row.xid);
 const [native]=await tx.execute<{allowed:boolean}>(sql`select app.profile_direct_person(${self.personId}::uuid) as allowed`);
 expect(native.allowed).toBe(true); // Isolate the added bank-purpose condition from native own admission.
}

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{await resetDb();b=await seedBase();self=await subject();await policy();});

it('admits a real non-HR bank intent before audit, reads the six-column slice, then commits native bank and actual profile audit events',async()=>{
 expect(self.ctx.roles).toEqual(['employee']);let reads=0;
 await withTenant(self.ctx,async tx=>{await begin(tx);expect(await purpose(tx)).toBe(true);const spy=vi.spyOn(tx,'select');try{await setBankProfileMY(self.ctx,input(),tx);reads=bankReads(spy);}finally{spy.mockRestore();}await audit(tx);});
 expect(reads).toBe(1);const state=await snapshot();expect(state.statutory).toHaveLength(1);expect(state.statutory[0]).toMatchObject({bankName:'Maybank',bankAccountNo:newAccount,epfNumber:'PRIVATE-EPF'});
 const events=state.events.filter(e=>e.eventType==='employee.bank.updated'||e.eventType==='profile.self-applied');expect(events.map(e=>e.eventType).sort()).toEqual(['employee.bank.updated','profile.self-applied']);expect(events.every(e=>e.actorType==='user'&&e.actorId===self.ctx.userId&&e.subjectEmploymentId===self.employmentId)).toBe(true);expect(state.intents).toHaveLength(0);expect(state.registers).toHaveLength(0);
});
it.each([false,true])('keeps canonical approval-off submission working for real non-HR, mixed phone+bank=%s',async mixed=>{
 const workspace=await readOwnProfileWorkspace(self.ctx,{employmentId:self.employmentId});const values:Record<string,string>={[account]:newAccount};if(mixed)values[phone]='0123456789';
 const result=await submitOwnProfileEdit(self.ctx,{employmentId:self.employmentId,proposal:{v:2,fields:Object.entries(values).map(([fieldId,value])=>({fieldId,before:workspace.baselines[fieldId],value})),registers:[]}});
 expect(result.saved.slice().sort()).toEqual(Object.keys(values).sort());expect(result.waiting).toEqual([]);expect(result.requestId).toBeNull();expect((await snapshot()).statutory[0].bankAccountNo).toBe(newAccount);if(mixed)expect((await owner.db.select().from(s.person).where(eq(s.person.id,self.personId)))[0].phone).toBe('0123456789');
});
it.each(bankFields)('recognizes the declared canonical bank field %s without requiring entry-time audit',async fieldId=>{
 const before=await snapshot();await expect(withTenant(self.ctx,async tx=>{await begin(tx,proposal([{fieldId,value:fieldId.includes('enablecustom')?false:fieldId===bank?'Maybank':newAccount}]));expect(await purpose(tx)).toBe(true);throw Error('purpose probe rollback');})).rejects.toThrow('purpose probe rollback');expect(await snapshot()).toEqual(before);
});
it('refuses both ordinary employee calls and an enclosing transaction without a protected intent before bank read',async()=>{await beforeReadRefusal();const before=await snapshot();await expect(setBankProfileMY(self.ctx,input())).rejects.toThrow();expect(await snapshot()).toEqual(before);});
it('does not turn a valid phone-only direct intent into permission to read the bank slice',async()=>{await beforeReadRefusal(async tx=>{await begin(tx,proposal([{fieldId:phone,value:'0123456789'}]));expect(await purpose(tx)).toBe(false);});});
it('refuses unknown fields at begin and in a protected adversarial intent before bank read',async()=>{
 await beforeReadRefusal(tx=>begin(tx,proposal([{fieldId:'bank_statutory.bank_information.unknown',value:newAccount}])));
 await beforeReadRefusal(async tx=>{await currentAdversarialIntent(tx,proposal([{fieldId:'bank_statutory.bank_information.unknown',value:newAccount}]));expect(await purpose(tx)).toBe(false);},self.ctx,input(),()=>owner.db.execute(sql`delete from app.profile_direct_intent where tenant_id=${b.tenantId}::uuid`));
});
it('requires proposal v2 scalar bank fields rather than a bank-looking register entry',async()=>{
 for(const proposed of [{...proposal(),v:1},{v:2,fields:[],registers:[{kind:'bank',fields:[{fieldId:account,value:newAccount}]}]}]){
  const before=await snapshot();try{await expect(withTenant(self.ctx,async tx=>{await currentAdversarialIntent(tx,proposed);expect(await purpose(tx)).toBe(false);throw Error('purpose probe rollback');})).rejects.toThrow('purpose probe rollback');}
  finally{await owner.db.execute(sql`delete from app.profile_direct_intent where tenant_id=${b.tenantId}::uuid`);}expect(await snapshot()).toEqual(before);
 }
});
it.each(['approval','viewOnly'] as const)('checks current %s policy in both begin and the bank purpose predicate',async mode=>{
 await policy(mode);await beforeReadRefusal(tx=>begin(tx));
 const before=await snapshot();try{await expect(withTenant(self.ctx,async tx=>{await currentAdversarialIntent(tx,proposal());expect(await purpose(tx)).toBe(false);throw Error('purpose probe rollback');})).rejects.toThrow('purpose probe rollback');}
 finally{await owner.db.execute(sql`delete from app.profile_direct_intent where tenant_id=${b.tenantId}::uuid`);}expect(await snapshot()).toEqual(before);
});
it('refuses a retained intent from a different transaction before bank read',async()=>{const before=await snapshot();try{await retainedIntent(proposal());await beforeReadRefusal(async tx=>{expect(await purpose(tx)).toBe(false);});}finally{await owner.db.execute(sql`delete from app.profile_direct_intent where tenant_id=${b.tenantId}::uuid`);}expect(await snapshot()).toEqual(before);});
it('binds the protected person and explicit employment nomination before any bank read',async()=>{
 const foreign=await subject();await beforeReadRefusal(async tx=>{await begin(tx);expect(await purpose(tx,foreign.personId)).toBe(false);},self.ctx,input(foreign.personId));
 await beforeReadRefusal(tx=>begin(tx),self.ctx,{...input(),employmentId:foreign.employmentId});
});
it('isolates actual employees, logins and bank rows across two real tenants before bank read',async()=>{
 const otherBase=await seedBase(),foreign=await subject(otherBase);await policy('off',otherBase);const foreignBefore=await snapshot(otherBase.tenantId);
 await beforeReadRefusal(tx=>begin(tx),self.ctx,input(foreign.personId));
 await beforeReadRefusal(async tx=>{await begin(tx,proposal(),foreign.employmentId);expect(await purpose(tx,self.personId)).toBe(false);},foreign.ctx,input(self.personId));
 expect(await snapshot(otherBase.tenantId)).toEqual(foreignBefore);
});
it.each(['relinked','archived','blocked','ended','future'] as const)('refuses the actual current %s principal/employment without bank read',async mode=>{
 if(mode==='relinked'){const foreign=await subject();await owner.db.update(s.appUser).set({personId:foreign.personId}).where(eq(s.appUser.id,self.ctx.userId!));}
 if(mode==='archived')await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,self.ctx.userId!));
 if(mode==='blocked')await owner.db.update(s.employment).set({blacklistedAt:'2024-01-02'}).where(eq(s.employment.id,self.employmentId));
 if(mode==='ended')await owner.db.update(s.employment).set({lastWorkingDate:'2024-01-02'}).where(eq(s.employment.id,self.employmentId));
 if(mode==='future')await owner.db.update(s.employment).set({hiredOn:'9999-12-31'}).where(eq(s.employment.id,self.employmentId));
 if(['blocked','archived','ended'].includes(mode)){const [current]=await owner.db.execute<{blocked:boolean}>(sql`select app.login_blocked(${self.ctx.userId}::uuid) as blocked`);expect(current.blocked).toBe(true);}
 await beforeReadRefusal(tx=>begin(tx));
});
it('does not let a bank intent grant Passport or the administrative bank editor',async()=>{
 expect(await canMaintainBankProfileMY(self.ctx,{personId:self.personId,employmentId:self.employmentId})).toBe(false);const before=await snapshot();
 await expect(withTenant(self.ctx,async tx=>{await begin(tx);await setPassportProfileMY(self.ctx,{personId:self.personId,passportNumber:'FICTIONAL-PASSPORT'},tx);})).rejects.toThrow();expect(await snapshot()).toEqual(before);
});
it('keeps protected intent rows private to their database owner',async()=>{await expect(withTenant(self.ctx,tx=>tx.execute(sql`select * from app.profile_direct_intent`))).rejects.toThrow();});
it('rolls back a native bank update and its bank event when the actual profile audit is missing',async()=>{const before=await snapshot();await expect(withTenant(self.ctx,async tx=>{await begin(tx);await setBankProfileMY(self.ctx,input(),tx);})).rejects.toThrow();expect(await snapshot()).toEqual(before);});
it.each(['wrongValue','extraDelta','identity'] as const)('retains the existing deferred %s guard even with an actual profile audit',async fault=>{
 const before=await snapshot();await expect(withTenant(self.ctx,async tx=>{await begin(tx);await setBankProfileMY(self.ctx,{...input(),bankAccountNo:fault==='wrongValue'?'FICTIONAL-WRONG':newAccount},tx);
  if(fault==='extraDelta')await tx.update(s.employeeStatutoryMy).set({numChildren:99}).where(eq(s.employeeStatutoryMy.personId,self.personId));
  if(fault==='identity')await tx.update(s.employeeStatutoryMy).set({id:randomUUID()}).where(eq(s.employeeStatutoryMy.personId,self.personId));
  await audit(tx);
 })).rejects.toThrow();expect(await snapshot()).toEqual(before);
});
it('rolls the native bank effect, actual audits and protected intent back with the enclosing transaction',async()=>{const before=await snapshot();await expect(withTenant(self.ctx,async tx=>{await begin(tx);await setBankProfileMY(self.ctx,input(),tx);await audit(tx);throw Error('outer ESS rollback');})).rejects.toThrow('outer ESS rollback');expect(await snapshot()).toEqual(before);});
