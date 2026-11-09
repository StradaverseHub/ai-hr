/** Installed bounded Personnel projection: native data, stale-principal and exact page contracts. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {personnelListPage,type EmployeeListFilters} from '../core/read';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps point/fact fields, stable equal-name paging, native refusals and fresh purpose permissions',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const hire=(base:typeof b,name:string)=>hireEmployee({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const first=await hire(b,'Fictional equal Personnel name'),second=await hire(b,'Fictional equal Personnel name'),outside=await hire(foreign,'Fictional outside Personnel');
 const ids=[first.employmentId,second.employmentId].sort();
 const point=(subjects:string[]|null)=>withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.access_workforce_list_rows_for_ids(${subjects===null?sql`null::uuid[]`:sql`array[${sql.join(subjects.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`})r(value)order by value->>'employmentId'`));
 const facts=()=>withTenant(ctx,tx=>tx.execute<Record<string,unknown>>(sql`select * from app.access_workforce_list_facts()order by employment_id`));
 const full=await withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.access_workforce_list_rows()r(value)order by value->>'employmentId'`));
 expect(full.map(r=>r.value.employmentId)).toEqual(ids);expect(await point([...ids,ids[0],outside.employmentId,randomUUID()])).toEqual(full);
 expect(await point([])).toEqual([]);expect(await point(null)).toEqual([]);
 expect(await point(Array.from({length:2000},()=>ids[0]))).toEqual([full[0]]);
 const tooMany=await point(Array.from({length:2001},()=>ids[0])).then(()=>null,(e:unknown)=>e);expect(pgSqlState(tooMany)).toBe('22023');
 const typed=await facts();expect(typed.map(r=>r.employment_id)).toEqual(ids);
 const keys={employment_id:'employmentId',name:'name',email:'email',employee_code:'employeeCode',company:'company',company_id:'companyId',department_id:'departmentId',employment_type:'employmentType',terminated_on:'terminatedOn',final_confirmation_date:'finalConfirmationDate',confirmation_date:'confirmationDate',probation_end_date:'probationEndDate',provisional_end_on:'provisionalEndOn',resignation_date:'resignationDate',last_working_date:'lastWorkingDate',blacklisted_at:'blacklistedAt'};
 for(let i=0;i<typed.length;i++)for(const [key,jsonKey]of Object.entries(keys))expect(typed[i][key]).toEqual(full[i].value[jsonKey]);
 for(const sort of ['name','company'] as const){
  for(let offset=0;offset<3;offset++){
   const scope={companyIds:[b.companyId,foreign.companyId]};
   const page=await personnelListPage(ctx,{...scope,limit:1,offset,sort},scope);
   expect(page.rows.map(r=>r.employmentId)).toEqual(ids.slice(offset,offset+1));expect(page.total).toBe(2);expect(page.headcount.total).toBe(2);
  }
 }
 const filters:EmployeeListFilters[]=[{q:'Fictional equal'},{companyId:b.companyId},{filterCompanyIds:[foreign.companyId]},
  {departmentId:b.deptA},{departmentIds:[b.deptB]},{employmentType:'contract'},{status:'terminated'},{employmentStatuses:['blacklisted']}];
 for(const filter of filters){const scope={companyIds:[b.companyId],...filter},result=await personnelListPage(ctx,{...scope,limit:25,offset:0},scope);
  const expected=filter.filterCompanyIds||filter.departmentIds||filter.employmentType||filter.status||filter.employmentStatuses?0:2;
  expect(result.total).toBe(expected);expect(result.headcount.total).toBe(expected);expect(result.rows).toHaveLength(expected);
 }
 for(const bad of [{limit:2001,offset:0},{limit:25,offset:-1},{limit:1.5,offset:0}])await expect(personnelListPage(ctx,{companyIds:[b.companyId],...bad},{companyIds:[b.companyId]})).rejects.toBeInstanceOf(RangeError);
 for(const [signature,appExecute]of [['app._access_workforce_list_rows(uuid[])',false],['app.access_workforce_list_facts()',true],['app.access_workforce_list_rows_for_ids(uuid[])',true]]as const){
  const [acl]=await owner.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee=0 and a.privilege_type='EXECUTE')as public_execute from pg_proc p where p.oid=to_regprocedure(${signature})`;
  expect(acl).toEqual({app_execute:appExecute,public_execute:false});
 }
 const privateCall=await withTenant(ctx,tx=>tx.execute(sql`select * from app._access_workforce_list_rows(null::uuid[])`)).then(()=>null,(e:unknown)=>e);expect(pgSqlState(privateCall)).toBe('42501');
 await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
 expect(await point(ids)).toEqual([]);expect(await facts()).toEqual([]);
 await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;
 await owner.client`update access_capability set supported=true,bindings='[{"owner":"installed-personnel-fixture","operation":"read-write"}]'::jsonb where id='workforce.view'`;
 expect((await facts()).length).toBe(2);
 const before=await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:b.adminUserId,capabilityId:'workforce.view',companyId:b.companyId,effect:'deny' as const}};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);
 await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
 expect(await point(ids)).toEqual([]);expect(await facts()).toEqual([]);
 const scope={companyIds:[b.companyId]};expect(await personnelListPage(ctx,{...scope,limit:25,offset:0},scope)).toEqual({rows:[],total:0,headcount:{total:0,byStatus:{}}});
},120000);
