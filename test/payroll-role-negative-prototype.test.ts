/** Reversible native provided-grant predicate comparison. No installed migration or cached authority. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares a negative Payroll role precheck with canonical inputs, errors and real row boundaries',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),admin=adminCtx(b),child=randomUUID(),sibling=randomUUID();
 await owner.client`insert into company(id,tenant_id,legal_name,parent_company_id) values(${child}::uuid,${b.tenantId}::uuid,'Fictional Payroll child',${b.companyId}::uuid),(${sibling}::uuid,${b.tenantId}::uuid,'Fictional Payroll sibling',null)`;
 const childDepartment=randomUUID(),siblingDepartment=randomUUID();await owner.client`insert into department(id,tenant_id,company_id,name) values(${childDepartment}::uuid,${b.tenantId}::uuid,${child}::uuid,'Fictional Payroll child department'),(${siblingDepartment}::uuid,${b.tenantId}::uuid,${sibling}::uuid,'Fictional Payroll sibling department')`;
 const [original]=await owner.client<{ddl:string;body:string;owner:string;acl:string|null;config:unknown;secdef:boolean;volatility:string}[]>`select pg_get_functiondef(oid)as ddl,prosrc as body,proowner::text as owner,proacl::text as acl,proconfig as config,prosecdef as secdef,provolatile as volatility from pg_proc where oid='app.grants_payroll_admin_for(jsonb,uuid)'::regprocedure`;
 expect(original.body.trim()).toBe("SELECT app.grants_admin_for(grants,wanted_company) OR app.grants_have_role_for(grants,'payroll_partner',wanted_company)");
 const body=`
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM pg_catalog.jsonb_array_elements(coalesce(grants,'[]'::jsonb)) candidate
  WHERE candidate->>'role' IN ('hr_admin','super_admin','payroll_partner')
 ) THEN (${original.body.trim()}) ELSE false END
`;
 const candidate=original.ddl.replace(original.body,()=>body);expect(candidate).not.toBe(original.ddl);
 const values:unknown[]=[null,[],[{role:'employee',companyId:null}],[{role:'manager',companyId:b.companyId}],
  [{role:'hr_admin',companyId:null}],[{role:'hr_admin',companyId:b.companyId}],[{role:'hr_admin',companyId:child}],
  [{role:'super_admin',companyId:child}],[{role:'payroll_partner',companyId:null}],[{role:'payroll_partner',companyId:b.companyId}],
  [{role:'payroll_partner',companyId:foreign.companyId}],[{role:'employee',companyId:null},{role:'hr_admin',companyId:foreign.companyId}],{},'invalid-json-shape',
  [{role:'employee',companyId:'invalid-company'}],[{role:'hr_admin',companyId:'invalid-company'}],[{role:'payroll_partner',companyId:'invalid-company'}],
  [{role:'hr_admin',companyId:''}],[{role:'payroll_partner',companyId:''}],[{role:null,companyId:null}],null];
 const targets=[b.companyId,child,sibling,foreign.companyId,randomUUID(),null];
 const evaluate=(value:unknown,company:string|null)=>withTenant(admin,async tx=>{
  await tx.execute(sql`set transaction read only`);
  const argument=value===null?sql`null::jsonb`:sql`${JSON.stringify(value)}::jsonb`;
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.grants_payroll_admin_for(${argument},${company}::uuid)as allowed`);return{allowed:row.allowed};
 }).catch(error=>({error:pgSqlState(error)??'unknown'}));
 const inputs=values.flatMap(value=>targets.map(target=>({value,target}))),expected=[];
 for(const item of inputs)expected.push(await evaluate(item.value,item.target));
 const hire=(ctx:SessionContext,companyId:string,departmentId:string,name:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const employees=[await hire(admin,b.companyId,b.deptA,'Fictional Payroll root employee'),await hire(admin,child,childDepartment,'Fictional Payroll child employee'),await hire(admin,sibling,siblingDepartment,'Fictional Payroll sibling employee'),await hire(adminCtx(foreign),foreign.companyId,foreign.deptA,'Fictional Payroll foreign employee')];
 const txns=await owner.db.insert(s.payrollIndividualTxn).values(employees.map((e,index)=>({tenantId:index===3?foreign.tenantId:b.tenantId,companyId:[b.companyId,child,sibling,foreign.companyId][index],payPeriod:'2026-05',employmentId:e.employmentId,kind:'overtime' as const,txnDate:'2026-05-10',amount:'100'}))).returning({id:s.payrollIndividualTxn.id});
 const employeeUser=await createAppUser(b.tenantId,employees[0].personId,'employee'),managerUser=await createAppUser(b.tenantId,null,'manager'),hrUser=await createAppUser(b.tenantId,null,'hr_admin'),partnerUser=await createAppUser(b.tenantId,null,'employee');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,hrUser));await owner.db.update(s.roleAssignment).set({role:'payroll_partner',companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,partnerUser));
 const contexts:[string,SessionContext,string[]][]=[
  ['groupHR',admin,txns.slice(0,3).map(t=>t.id)],
  ['scopedHR',{...admin,userId:hrUser,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]},txns.slice(0,2).map(t=>t.id)],
  ['scopedPayrollPartner',{...admin,userId:partnerUser,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:b.companyId}]},txns.slice(0,2).map(t=>t.id)],
  ['employee',{...admin,userId:employeeUser,personId:employees[0].personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},[]],
  ['manager',{...admin,userId:managerUser,roles:['manager'],grants:[{role:'manager',companyId:null}]},[]],
  ['foreignHR',adminCtx(foreign),[txns[3].id]],
 ];
 const visible=(ctx:SessionContext)=>withTenant(ctx,async tx=>{await assertAssignedWorkPrincipalTx(tx,ctx);return(await tx.select({id:s.payrollIndividualTxn.id}).from(s.payrollIndividualTxn).orderBy(s.payrollIndividualTxn.id)).map(row=>row.id);});
 const controls:string[]=[];for(const[label,ctx,ids]of contexts){expect(await visible(ctx)).toEqual([...ids].sort());controls.push(label);}
 const measurements:{kind:string;phase:string;calls:number;elapsedMs:number;allowed:number}[]=[];
 const measure=(kind:'negative'|'positive'|'mixed')=>withTenant(admin,async tx=>{
  await tx.execute(sql`set transaction read only`);
  const role=kind==='negative'?sql`case when n%2=0 then 'employee' else 'manager' end`:kind==='positive'?sql`case when n%2=0 then 'hr_admin' else 'payroll_partner' end`:sql`case when n%10=0 then 'hr_admin' when n%10=1 then 'manager' else 'employee' end`;
  const [row]=await tx.execute<{allowed:number}>(sql`select sum(app.grants_payroll_admin_for(jsonb_build_array(jsonb_build_object('role',${role},'companyId',null,'fixtureOrdinal',n)),${b.companyId}::uuid)::int)::int as allowed from generate_series(1,25000)n`);return row.allowed;
 });
 try{
  await owner.client.unsafe(candidate);
  for(let i=0;i<inputs.length;i++)expect(await evaluate(inputs[i].value,inputs[i].target)).toEqual(expected[i]);
  for(const[label,ctx,ids]of contexts){expect(await visible(ctx)).toEqual([...ids].sort());controls.push('candidate-'+label);}
  const partner=contexts[2][1];await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,partnerUser));await expect(visible(partner)).rejects.toThrow();
  expect(await visible({...partner,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]})).toEqual([]);await owner.db.update(s.roleAssignment).set({role:'payroll_partner'}).where(eq(s.roleAssignment.appUserId,partnerUser));controls.push('liveRoleRevocation');
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,employeeUser));await expect(visible(contexts[3][1])).rejects.toThrow();await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,employeeUser));controls.push('archivedPrincipalRefused');
  for(const kind of ['negative','positive','mixed']as const)for(const phase of ['original','candidate','candidate-warm','restored']){
   await owner.client.unsafe(phase==='original'||phase==='restored'?original.ddl:candidate);
   const started=performance.now(),allowed=await measure(kind);expect(allowed).toBe(kind==='negative'?0:kind==='positive'?25000:2500);measurements.push({kind,phase,calls:25000,elapsedMs:performance.now()-started,allowed});
  }
 }finally{
  await owner.client.unsafe(original.ddl);
  const [restored]=await owner.client`select pg_get_functiondef(oid)as ddl,prosrc as body,proowner::text as owner,proacl::text as acl,proconfig as config,prosecdef as secdef,provolatile as volatility from pg_proc where oid='app.grants_payroll_admin_for(jsonb,uuid)'::regprocedure`;expect(restored).toEqual(original);
 }
 const ratios=Object.fromEntries(['negative','positive','mixed'].map(kind=>{const m=measurements.filter(row=>row.kind===kind);return[kind,Math.max(m[1].elapsedMs,m[2].elapsedMs)/Math.min(m[0].elapsedMs,m[3].elapsedMs)];}));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-role-negative-prototype.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_PAYROLL_ROLE_COMPONENT_ONLY',releaseEligible:false,inputCases:inputs.length,controls,measurements,ratios,ownerAclAndDefinitionRestored:true,positiveExpressionUnchanged:true,limitations:'Provided-grant component only; mixed distribution90percentnegative is synthetic; inclusive loaded SQL totals are not CPU or whole-system improvement evidence'},null,2));
 expect(ratios.negative).toBeLessThan(.8);expect(ratios.mixed).toBeLessThan(.8);
},600000);
