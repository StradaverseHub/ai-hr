/** The actual /me loader must complete while a same-tenant Workforce writer owns Access. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {appUser,domainEvent} from '../db/schema';
import {readMyProfilePresentation} from '../app/me/presentation';
import {myProfileRecord} from '../app/me/record';
import {setCompensation} from '../core/comp';
import {hireEmployee} from '../core/org';
import {getPersonPhoto,setPersonPhoto} from '../core/person-photo';
import {myProfileChangeRequests} from '../core/profile';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {readOwnProfileFacts} from '../core/profile-view';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const preferred='profile.personal_details.preferredname';
const photoField='profile.personal_details.photo';
const bankAccount='bank_statutory.bank_information.bankaccountno';
const account='1234567890';

it('loads nonempty own profile data in one lock-free authorized snapshot with unchanged masking and history',async()=>{
 await resetDb();
 const b=await seedBase(),admin=adminCtx(b);
 await setModule(b.tenantId,'payroll','active');
 await setModule(b.tenantId,'attendance','active');
 const hired=async(fullName:string)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const employee=await hired('Fictional profile snapshot'),other=await hired('Fictional other subject');
 const userId=await createAppUser(b.tenantId,employee.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:employee.personId,roles:['employee']};
 await setStatutoryProfileMY(admin,{personId:employee.personId,icNumber:null,bankName:'Maybank',bankAccountNo:account});
 await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:3500,monthlyAllowance:20,
  effectiveFrom:'2020-01-01',remarks:'Fictional private salary note'});
 const photo=Buffer.from([137,80,78,71,13,10,26,10,1]);
 await setPersonPhoto(admin,{personId:employee.personId,content:photo,fileName:'fictional.png',mimeType:'image/png',sizeBytes:photo.length});
 const fields=Object.fromEntries(essVisibleFields().map(field=>[
  field.id,field.ess.binding&&['immediate','approval'].includes(field.ess.edit)?'editable':'viewOnly',
 ]));
 const policy=async (hidden:string[]=[])=>saveProfileVisibilityPolicy(admin,{
  policy:{version:5,fields:{...fields,...Object.fromEntries(hidden.map(field=>[field,'hide']))},
   primaryOnly:[],groups:{},approvals:{[preferred]:{required:true,attachmentRequired:false}}},
  withdrawnReason:'Fictional policy update',
 });
 await policy();
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId:employee.employmentId});
 const requested=await submitOwnProfileEdit(ctx,{employmentId:employee.employmentId,proposal:{v:2,
  fields:[{fieldId:preferred,before:workspace.baselines[preferred],value:'Fictional requested name'}],registers:[]}});
 expect(requested.requestId).toBeTruthy();

 const [facts,history,record]=await Promise.all([
  readOwnProfileFacts(ctx,employee.employmentId),
  myProfileChangeRequests(ctx),
  myProfileRecord(ctx,employee.employmentId),
 ]);
 expect(facts.header).toMatchObject({name:'Fictional profile snapshot',photo:true});
 expect(facts.records.length).toBeGreaterThan(0);
 expect(history).toEqual([expect.objectContaining({id:requested.requestId,status:'pending'})]);
 expect(record?.compensation?.basicSalary).toBe('3500.00');
 expect(workspace.values[bankAccount]).toBe('•••• 7890');
 const [auditBefore]=await owner.db.select({count:sql<number>`count(*)::int`}).from(domainEvent).where(eq(domainEvent.tenantId,b.tenantId));

 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const actual=database.withTenant;
  const modes:{snapshot:boolean;advisories:number}[]=[];
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(
   context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2],
  )=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);
   await tx.execute(sql`set local statement_timeout='5s'`);
   const result=await read(tx);
   const [mode]=await tx.execute<{snapshot:boolean;advisories:number}>(sql`select
    current_setting('transaction_isolation')='repeatable read' and current_setting('transaction_read_only')='on' as snapshot,
    (select count(*)::int from pg_locks where pid=pg_backend_pid() and locktype='advisory') as advisories`);
   modes.push(mode);
   return result;
  },options));
  try{
   const page=await readMyProfilePresentation(ctx,employee.employmentId);
   expect(page.kind).toBe('ready');
   if(page.kind!=='ready')throw Error('Own snapshot unavailable');
   expect(page.record).toMatchObject({employmentId:employee.employmentId,
    employment:{company:record?.employment.company,hiredOn:record?.employment.hiredOn},
    compensation:{basicSalary:'3500.00',currency:record?.compensation?.currency}});
   expect(page.workspace).toEqual(workspace);
   expect(page.facts).toEqual(facts);
   expect(page.profileRequests).toEqual(history);
   expect(JSON.stringify(page)).not.toContain(account);
   expect(JSON.stringify(page)).not.toContain('Fictional private salary note');
   expect(modes).toEqual([{snapshot:true,advisories:0}]);
   expect(spy).toHaveBeenCalledTimes(1);
  }finally{spy.mockRestore();}
 });

 const [auditAfter]=await owner.db.select({count:sql<number>`count(*)::int`}).from(domainEvent).where(eq(domainEvent.tenantId,b.tenantId));
 expect(auditAfter).toEqual(auditBefore);
 await expect(readMyProfilePresentation(ctx,other.employmentId)).resolves.toMatchObject({kind:'choose'});
 await expect(readMyProfilePresentation({...ctx,personId:other.personId},other.employmentId)).rejects.toThrow('Current AI calling authority could not be confirmed.');

 await policy([preferred,photoField,bankAccount]);
 const hidden=await readMyProfilePresentation(ctx,employee.employmentId);
 expect(hidden.kind).toBe('ready');
 if(hidden.kind!=='ready')throw Error('Own snapshot unavailable after policy edit');
 expect(hidden.presentation.visible.has(bankAccount)).toBe(false);
 expect(hidden.workspace.values[bankAccount]).toBeUndefined();
 expect(hidden.workspace.baselines[bankAccount]).toBeUndefined();
 expect(hidden.facts.header.photo).toBe(false);
 expect(hidden.profileRequests).toEqual([expect.objectContaining({id:requested.requestId,status:'rejected',decisionReason:null})]);
 expect(JSON.stringify(hidden.profileRequests)).not.toContain('Fictional requested name');
 await expect(getPersonPhoto(ctx,employee.personId)).resolves.toBeNull();

 await owner.db.update(appUser).set({personId:other.personId}).where(eq(appUser.id,userId));
 await expect(readMyProfilePresentation(ctx,employee.employmentId)).rejects.toThrow('Current AI calling authority could not be confirmed.');
 const relinked={...ctx,personId:other.personId};
 await expect(readMyProfilePresentation(relinked,employee.employmentId)).resolves.toMatchObject({kind:'choose'});
 await expect(readMyProfilePresentation(relinked,other.employmentId)).resolves.toMatchObject({
  kind:'ready',profileRequests:[],facts:{header:{name:'Fictional other subject',photo:false}},
 });

 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,userId));
 await expect(readMyProfilePresentation(relinked,other.employmentId)).rejects.toThrow('Current AI calling authority could not be confirmed.');
});
