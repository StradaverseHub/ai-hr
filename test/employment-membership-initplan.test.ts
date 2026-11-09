/** Real appended migration, populated predecessor and native authority controls.
 * All policy edits are confined to this test worker's disposable database. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,assignment,company,employment,person,reportingLine,roleAssignment} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {addCalendarMonths,todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

const migration=readFileSync('db/migrations/3001_employment_membership_initplan.sql','utf8');
const compact=(value:string)=>value.replace(/\s+/g,'');
// Independent pg_get_expr identity of the reviewed predecessor, not parsed from
// the migration under test or derived from its replacement algorithm.
const originalMembership='(id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))';
const originalQual="((voided_atISNULL)AND(tenant_id=app.current_tenant_id())ANDCASEWHEN((SELECTcurrent_setting('app.bank_import_point_read'::text,true)AScurrent_setting)='on'::text)THENCASEWHENapp.is_admin_for(company_id)THENtrueELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))ENDELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))END)";
const currentMembership='(idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))';
const currentPattern=/\(id\s+IN\s*\(\s*SELECT\s+unnest\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)\)\s+AS\s+unnest\s*\)\)/g;
type Policy={schemaname:string;tablename:string;policyname:string;permissive:string;roles:string[];cmd:string;qual:string;with_check:string};
const policyQuery="select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='employment' and policyname='employment_rls'";
async function installedPolicy(){
 const rows=Array.from(await owner.client.unsafe<Policy[]>(policyQuery));expect(rows).toHaveLength(1);return rows[0];
}
function predecessorQual(current:string){
 expect(compact(current).split(currentMembership)).toHaveLength(3);
 const previous=current.replace(currentPattern,'(id = ANY ((SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[]))');
 expect(compact(previous)).toBe(originalQual);return previous;
}
async function setQual(qual:string){
 // Qual is a trusted PostgreSQL-deparsed expression from this owned test DB.
 await owner.client.begin(async tx=>{await tx.unsafe('ALTER POLICY employment_rls ON public.employment USING ('+qual+')');});
}
async function securitySnapshot(){
 const policies=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
 const functions=Array.from(await owner.client`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,
  p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,p.prosecdef,p.provolatile,p.proparallel
  from pg_proc p where p.oid in ('app.visible_employment_ids()'::regprocedure,'app.visible_person_ids()'::regprocedure,
   'app.can_see_employment(uuid)'::regprocedure,'app.can_see_person(uuid)'::regprocedure) order by p.oid::regprocedure::text`);
 const grants=Array.from(await owner.client`select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants
  where table_schema='public' and table_name in ('employment','assignment','person') order by table_schema,table_name,grantee,privilege_type`);
 return {policies,functions,grants};
}
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);

async function fixture(){
 const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const otherCompany=randomUUID();await owner.db.insert(company).values({id:otherCompany,tenantId:b.tenantId,legalName:'Fictional current-company employer'});
 const add=async(name:string,departmentId:string,companyId=b.companyId,assignmentCompanyId=companyId)=>{
  const personId=randomUUID(),id=randomUUID();
  await owner.db.insert(person).values({id:personId,tenantId:b.tenantId,fullName:name,primaryEmail:personId+'@example.invalid'});
  await owner.db.insert(employment).values({id,tenantId:b.tenantId,personId,companyId,hiredOn:'2020-01-01'});
  await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:id,companyId:assignmentCompanyId,departmentId,validFrom:'2020-01-01',employmentType:'full_time'});
  return {id,personId,name};
 };
 const alpha=await add('A fictional employee',b.deptA),beta=await add('B fictional manager',b.deptB);
 const gamma=await add('C fictional department peer',b.deptA),delta=await add('D fictional department peer',b.deptA);
 // Current Employment company, not historical Assignment company, owns narrowing.
 const transferred=await add('Z fictional transferred employee',b.deptB,otherCompany,b.companyId);
 const employeeUser=await createAppUser(b.tenantId,alpha.personId,'employee'),managerUser=await createAppUser(b.tenantId,beta.personId,'manager');
 const selfUser=await createAppUser(b.tenantId,transferred.personId,'employee'),scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
 const [edge]=await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:alpha.id,managerEmploymentId:beta.id,lineType:'administrative',validFrom:'2020-01-01'}).returning({id:reportingLine.id});
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:alpha.personId,roles:['employee']};
 const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:beta.personId,roles:['manager']};
 const selfCtx:SessionContext={tenantId:b.tenantId,userId:selfUser,personId:transferred.personId,roles:['employee']};
 const scopedCtx:SessionContext={tenantId:b.tenantId,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const partnerContexts:SessionContext[]=[];
 for(const role of ['payroll_partner','performance_comp_partner'] as const){
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.db.update(roleAssignment).set({role,companyId:otherCompany}).where(eq(roleAssignment.appUserId,userId));
  partnerContexts.push({tenantId:b.tenantId,userId,grants:[{role,companyId:otherCompany}]});
 }
 const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
 await owner.db.insert(person).values({id:foreignPerson,tenantId:foreign.tenantId,fullName:'Fictional foreign employee',primaryEmail:foreignPerson+'@example.invalid'});
 await owner.db.insert(employment).values({id:foreignEmployment,tenantId:foreign.tenantId,personId:foreignPerson,companyId:foreign.companyId,hiredOn:'2020-01-01'});
 await owner.db.insert(assignment).values({tenantId:foreign.tenantId,employmentId:foreignEmployment,companyId:foreign.companyId,departmentId:foreign.deptA,validFrom:'2020-01-01',employmentType:'full_time'});
 return {b,foreign,ctx,otherCompany,alpha,beta,gamma,delta,transferred,employeeUser,edge,employeeCtx,managerCtx,selfCtx,scopedCtx,partnerContexts,foreignEmployment};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type ChoicePage=Awaited<ReturnType<typeof readEmployeeChoices>>;
const stable=({contextId:_contextId,...page}:ChoicePage)=>page;
const ids=(page:ChoicePage)=>page.rows.map(row=>row.employmentId);

async function bankRows(ctx:SessionContext,on:boolean){
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);
  const [identity]=await tx.execute<{role:string;tenant:string;user:string;rls:boolean;readOnly:string;isolation:string}>(sql`
   select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as "user",
    row_security_active('public.employment'::regclass) as rls,current_setting('transaction_read_only') as "readOnly",
    current_setting('transaction_isolation') as isolation`);
  expect(identity).toEqual({role:'ai_hr_app',tenant:ctx.tenantId,user:ctx.userId!,rls:true,readOnly:'on',isolation:'repeatable read'});
  await tx.execute(sql`select set_config('app.bank_import_point_read',${on?'on':'off'},true)`);
  return (await tx.select({id:employment.id}).from(employment).orderBy(employment.id)).map(row=>row.id);
 },{readOnlySnapshot:true});
}
async function writeChecks(f:Fixture){
 // A visible employee may not turn read visibility into command authority.
 let denied:unknown;
 try{await withTenant(f.employeeCtx,tx=>tx.update(employment).set({employeeCode:'NOT-AUTHORIZED'}).where(eq(employment.id,f.alpha.id)));}
 catch(error){denied=error;}
 expect(pgSqlState(denied)).toBe('42501');
 const rollback=new Error('Intentional native authorized-write rollback');
 await expect(withTenant(f.ctx,async tx=>{
  const rows=await tx.update(employment).set({employeeCode:'MIGRATION-NATIVE-ADMIN'}).where(eq(employment.id,f.alpha.id)).returning({id:employment.id});
  expect(rows).toEqual([{id:f.alpha.id}]);throw rollback;
 })).rejects.toBe(rollback);
 const [after]=await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,f.alpha.id));expect(after.code).toBeNull();
}

async function authority(f:Fixture){
 const {b,ctx,alpha,beta,gamma,delta,transferred,employeeCtx,managerCtx,selfCtx,scopedCtx,partnerContexts}=f;
 const all=await readEmployeeChoices(ctx,{companyIds:[],selectedId:transferred.id});
 expect(all.total).toBe(5);expect(ids(all)).toEqual([alpha.id,beta.id,gamma.id,delta.id,transferred.id]);
 const employee=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:gamma.id});
 expect(employee.total).toBe(1);expect(ids(employee)).toEqual([alpha.id]);expect(employee.selected).toBeNull();
 expect(employee.companyOptions.map(row=>row.id)).toEqual([b.companyId]);expect(employee.departmentOptions.map(row=>row.id)).toEqual([b.deptA]);
 const selectedOutsideQuery=await readEmployeeChoices(employeeCtx,{companyIds:[],query:'no matching employee',selectedId:alpha.id});
 expect(selectedOutsideQuery.total).toBe(0);expect(selectedOutsideQuery.selected?.employmentId).toBe(alpha.id);
 const manager=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:alpha.id});
 expect(manager.total).toBe(2);expect(ids(manager)).toEqual([alpha.id,beta.id]);
 await owner.db.update(assignment).set({departmentId:b.deptA}).where(eq(assignment.employmentId,beta.id));
 let hod:ChoicePage;
 try{hod=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:transferred.id});expect(hod.total).toBe(4);expect(ids(hod)).toEqual([alpha.id,beta.id,gamma.id,delta.id]);expect(hod.selected).toBeNull();}
 finally{await owner.db.update(assignment).set({departmentId:b.deptB}).where(eq(assignment.employmentId,beta.id));}
 await owner.db.update(reportingLine).set({validFrom:addCalendarMonths(todayInKualaLumpur(),1)}).where(eq(reportingLine.id,f.edge.id));
 let future:ChoicePage;
 try{future=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId]});expect(future.total).toBe(1);expect(ids(future)).toEqual([beta.id]);}
 finally{await owner.db.update(reportingLine).set({validFrom:'2020-01-01'}).where(eq(reportingLine.id,f.edge.id));}
 const self=await readEmployeeChoices(selfCtx,{companyIds:[f.otherCompany],selectedId:transferred.id});
 expect(self.total).toBe(1);expect(ids(self)).toEqual([transferred.id]);expect(self.rows[0].companyId).toBe(f.otherCompany);expect(self.rows[0].departmentId).toBe(b.deptB);
 const deniedCompany=await readEmployeeChoices(scopedCtx,{companyIds:[f.otherCompany],selectedId:transferred.id});
 expect(deniedCompany.total).toBe(0);expect(deniedCompany.rows).toEqual([]);expect(deniedCompany.selected).toBeNull();expect(deniedCompany.companyOptions).toEqual([]);
 const deniedTenant=await readEmployeeChoices(adminCtx(f.foreign),{companyIds:[b.companyId],selectedId:alpha.id});
 expect(deniedTenant.total).toBe(0);expect(deniedTenant.rows).toEqual([]);expect(deniedTenant.selected).toBeNull();
 const partners:unknown[]=[];
 for(const partner of partnerContexts){
  const allowed=await readEmployeeChoices(partner,{companyIds:[f.otherCompany],selectedId:transferred.id});expect(allowed.total).toBe(1);expect(ids(allowed)).toEqual([transferred.id]);expect(allowed.selected?.employmentId).toBe(transferred.id);
  const denied=await readEmployeeChoices(partner,{companyIds:[b.companyId],selectedId:alpha.id});expect(denied.total).toBe(0);expect(denied.selected).toBeNull();partners.push({allowed:stable(allowed),denied:stable(denied)});
 }
 await owner.db.update(employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional migration control',voidedImportAttemptId:randomUUID()}).where(eq(employment.id,transferred.id));
 let voidedEmployment:ChoicePage,voidedPerson:ChoicePage;
 try{voidedEmployment=await readEmployeeChoices(partnerContexts[0],{companyIds:[f.otherCompany],selectedId:transferred.id});expect(voidedEmployment.total).toBe(0);expect(voidedEmployment.selected).toBeNull();}
 finally{await owner.db.update(employment).set({voidedAt:null,voidedBy:null,voidReason:null,voidedImportAttemptId:null}).where(eq(employment.id,transferred.id));}
 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,transferred.personId));
 try{voidedPerson=await readEmployeeChoices(partnerContexts[0],{companyIds:[f.otherCompany],selectedId:transferred.id});expect(voidedPerson.total).toBe(0);expect(voidedPerson.selected).toBeNull();}
 finally{await owner.db.update(person).set({voidedAt:null}).where(eq(person.id,transferred.personId));}
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,f.employeeUser));
 try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[]})).rejects.toThrow('calling authority');}
 finally{await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,f.employeeUser));}
 const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser)).returning();expect(grants).toHaveLength(1);
 try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:alpha.id})).rejects.toThrow('calling authority');}
 finally{await owner.db.insert(roleAssignment).values(grants);}
 const restored=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:alpha.id});expect(restored.total).toBe(1);expect(restored.selected?.employmentId).toBe(alpha.id);
 await expect(readEmployeeChoices({...ctx,personId:randomUUID()},{companyIds:[b.companyId]})).rejects.toThrow('calling authority');
 const foreignSelection=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:f.foreignEmployment});expect(foreignSelection.selected).toBeNull();
 const bank:Record<string,unknown>={};
 for(const [name,caller,expected] of [['admin',ctx,[alpha.id,beta.id,gamma.id,delta.id,transferred.id]],['employee',employeeCtx,[alpha.id]],['scoped',scopedCtx,[alpha.id,beta.id,gamma.id,delta.id]],['payroll',partnerContexts[0],[transferred.id]],['performance',partnerContexts[1],[transferred.id]]] as const){
  const off=await bankRows(caller,false),on=await bankRows(caller,true);expect(off).toEqual([...expected].sort());expect(on).toEqual(off);bank[name]={off,on};
 }
 await writeChecks(f);
 return {all:stable(all),employee:stable(employee),selectedOutsideQuery:stable(selectedOutsideQuery),manager:stable(manager),hod:stable(hod!),future:stable(future!),self:stable(self),deniedCompany:stable(deniedCompany),deniedTenant:stable(deniedTenant),partners,voidedEmployment:stable(voidedEmployment!),voidedPerson:stable(voidedPerson!),restored:stable(restored),bank};
}

it('installs the wrapped positive membership without changing any other authority metadata',async()=>{
 const installed=await installedPolicy();
 expect(installed).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(installed.with_check).toBe('((tenant_id = app.current_tenant_id()) AND app.is_admin_for(company_id))');
 expect(compact(installed.qual)).toBe(originalQual.replaceAll(originalMembership,currentMembership));
 const [functionRow]=await owner.client`select md5(prosrc) as body,prosecdef,provolatile,proconfig from pg_proc where oid='app.visible_employment_ids()'::regprocedure`;
 expect(functionRow).toEqual({body:'1bc7e85a740a98b9db79efb2b7768c8b',prosecdef:true,provolatile:'s',proconfig:['search_path=public']});
});

it('replays the real append on populated predecessor data with exact native before/after authority',async()=>{
 const f=await fixture(),installed=await installedPolicy(),metadata=await securitySnapshot();
 const previous=predecessorQual(installed.qual);
 try{
  await setQual(previous);
  expect(compact((await installedPolicy()).qual)).toBe(originalQual);
  const before=await authority(f);
  // Apply actual migration bytes, not a rewritten test replacement or fabricated ledger.
  await owner.client.begin(async tx=>{await tx.unsafe(migration);});
  expect(await installedPolicy()).toEqual(installed);
  expect(await securitySnapshot()).toEqual(metadata);
  const after=await authority(f);expect(after).toEqual(before);
 }finally{await setQual(installed.qual);}
 expect(await securitySnapshot()).toEqual(metadata);
},120000);

it.each(['using','with-check','roles','function-settings'] as const)('refuses unexpected %s drift and rolls the whole rehearsal back',async drift=>{
 const installed=await installedPolicy(),metadata=await securitySnapshot(),previous=predecessorQual(installed.qual);
 await expect(owner.client.begin(async tx=>{
  await tx.unsafe('ALTER POLICY employment_rls ON public.employment USING ('+previous+')');
  if(drift==='using')await tx.unsafe('ALTER POLICY employment_rls ON public.employment USING (false)');
  if(drift==='with-check')await tx.unsafe('ALTER POLICY employment_rls ON public.employment WITH CHECK (false)');
  if(drift==='roles')await tx.unsafe('ALTER POLICY employment_rls ON public.employment TO PUBLIC');
  if(drift==='function-settings')await tx.unsafe("ALTER FUNCTION app.visible_employment_ids() SET search_path='pg_catalog'");
  await tx.unsafe(migration);
  throw new Error('The migration unexpectedly accepted unreviewed authority drift');
 })).rejects.toMatchObject({code:'55000'});
 expect(await installedPolicy()).toEqual(installed);expect(await securitySnapshot()).toEqual(metadata);
});

it('retains positive policy truth for NULL, empty, duplicate and matching memberships',async()=>{
 const first=randomUUID(),second=randomUUID(),outside=randomUUID();
 const memberships=[sql`null::uuid[]`,sql`array[]::uuid[]`,sql`array[null::uuid]`,sql`array[${first}::uuid]`,sql`array[${second}::uuid]`,sql`array[${first}::uuid,${first}::uuid]`,sql`array[null::uuid,${first}::uuid]`];
 const subjects=[null,first,second,outside];
 const inputs=subjects.flatMap((subject,i)=>memberships.flatMap((members,j)=>[false,true].map((partner,k)=>sql`(${(i*memberships.length+j)*2+k},${subject}::uuid,${members},${partner})`)));
 const rows=await owner.db.execute<{id:number;old_allowed:boolean;new_allowed:boolean}>(sql`
  with inputs(id,subject,members,partner) as (values ${sql.join(inputs,sql`,`)})
  select id,((subject=any(members))or partner)is true as old_allowed,
   ((subject in(select unnest((select members))))or partner)is true as new_allowed from inputs order by id`);
 expect(rows).toHaveLength(56);expect(rows.every(row=>row.old_allowed===row.new_allowed)).toBe(true);
 expect(rows.some(row=>row.new_allowed)).toBe(true);expect(rows.some(row=>!row.new_allowed)).toBe(true);
});
