/** ADR 0181 payroll addendum, step 2: the Payroll list's close permission and Transaction View's reprocess
 * outcomes now ask the payroll permission once for all companies (personnelFormulaPermissionsTx) instead of
 * resolvePayrollPermission once per company. This proves the two give the same companies for every caller shape,
 * override layout and company scope, on fictional data. */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignRole,revokeRole} from '../core/admin';
import {resolvePayrollPermission,setPayrollPermissionGrant} from '../packs/payroll/service';
import {payrollCloseCompanyIdsTx} from '../core/payroll';
import {personnelFormulaPermissionsTx} from '../core/pay-formula-personnel-permissions';
import type {PayrollPermissionKey} from '../lib/payroll-permissions';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const KEYS=['payroll.close','payroll.reprocess.selective'] as const satisfies readonly PayrollPermissionKey[];
let b:Base,companyB:string,childOfA:string,companies:string[],ctx:SessionContext,hrRoleId:string;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Company B',companyLabel:'FIC-B'}).returning();
 companyB=co.id;
 const [child]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Subsidiary of A',companyLabel:'FIC-A1',parentCompanyId:b.companyId}).returning();
 childOfA=child.id;companies=[b.companyId,companyB,childOfA];
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional scoped payroll caller',primaryEmail:randomUUID()+'@fixture.test'}).returning();
 const userId=await createAppUser(b.tenantId,person.id,'hr_admin');
 const global=await owner.db.select().from(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,userId),isNull(s.roleAssignment.companyId)));
 hrRoleId=(await assignRole(group(),{appUserId:userId,role:'hr_admin',companyId:b.companyId})).id;
 await assignRole(group(),{appUserId:userId,role:'payroll_partner',companyId:companyB});
 for(const row of global)await revokeRole(group(),{roleAssignmentId:row.id});
 ctx={...await entitledCtx(b,['hr_admin','payroll_partner']),userId,personId:person.id,
  grants:[{role:'hr_admin',companyId:b.companyId},{role:'payroll_partner',companyId:companyB}]};
});

/** Both answers inside one transaction, so they read the same snapshot. */
async function compare(who:SessionContext,key:PayrollPermissionKey,scope=companies){
 return withTenant(who,async tx=>{
  const set=[...((await personnelFormulaPermissionsTx(tx,who,scope,[key])).get(key)??new Set<string>())].sort();
  const perCompany:string[]=[];
  for(const id of scope)if(await resolvePayrollPermission(tx,who,key,id))perCompany.push(id);
  return {set,perCompany:perCompany.sort()};
 });
}

const layouts:Record<string,()=>Promise<void>>={
 'code defaults':async()=>{},
 'company-scoped deny for HR on A, allow for partner on A':async()=>{for(const key of KEYS){
  await setPayrollPermissionGrant(group(),{companyId:b.companyId,permissionKey:key,role:'hr_admin',allowed:false});
  await setPayrollPermissionGrant(group(),{companyId:b.companyId,permissionKey:key,role:'payroll_partner',allowed:true});}},
 'tenant-wide allow for partner only':async()=>{for(const key of KEYS)
  await setPayrollPermissionGrant(group(),{companyId:null,permissionKey:key,role:'payroll_partner',allowed:true});},
 'tenant-wide deny for HR, company-scoped allow for HR on the subsidiary':async()=>{for(const key of KEYS){
  await setPayrollPermissionGrant(group(),{companyId:null,permissionKey:key,role:'hr_admin',allowed:false});
  await setPayrollPermissionGrant(group(),{companyId:childOfA,permissionKey:key,role:'hr_admin',allowed:true});}},
};

describe('payroll permission once for all companies equals once per company',()=>{
 it.each(Object.keys(layouts))('matches for every caller shape and key: %s',async layout=>{
  await layouts[layout]();
  const callers:Record<string,SessionContext>={
   scoped:ctx,
   groupAdmin:group(),
   rolesOnly:adminCtx(b),
   emptyGrants:{...group(),grants:[],roles:['super_admin']},
   unmatchedGrant:{...group(),grants:[{role:'hr_admin',companyId:companyB}],roles:['hr_admin']},
   noUser:{...group(),userId:undefined},
  };
  let allowed=0,refused=0;
  for(const [name,who] of Object.entries(callers))for(const key of KEYS){
   const {set,perCompany}=await compare(who,key);
   expect({name,key,set},`${layout}: ${name} ${key}`).toEqual({name,key,set:perCompany});
   allowed+=perCompany.length;refused+=companies.length-perCompany.length;
  }
  // Non-vacuous: every layout has both allowed and refused companies.
  expect(allowed).toBeGreaterThan(0);expect(refused).toBeGreaterThan(0);
 });

 it('matches after the actual role is revoked while the session still claims it',async()=>{
  expect((await compare(ctx,'payroll.close')).perCompany).toContain(b.companyId);
  await revokeRole(group(),{roleAssignmentId:hrRoleId});
  for(const key of KEYS){const {set,perCompany}=await compare(ctx,key);expect(set).toEqual(perCompany);expect(set).not.toContain(b.companyId);}
 });

 it('matches for a single company and for a company outside the tenant',async()=>{
  for(const key of KEYS){
   for(const scope of [[b.companyId],[companyB],[randomUUID()]]){const {set,perCompany}=await compare(ctx,key,scope);expect(set).toEqual(perCompany);}
  }
 });

 it('payrollCloseCompanyIdsTx equals the previous per-company loop',async()=>{
  await layouts['company-scoped deny for HR on A, allow for partner on A']();
  for(const who of [ctx,group(),adminCtx(b)]){
   const result=await withTenant(who,async tx=>{
    const now=[...(await payrollCloseCompanyIdsTx(tx,who,[...companies,b.companyId]))].sort();
    const scoped=await tx.select({id:s.company.id}).from(s.company)
     .where(and(inArray(s.company.id,companies),sql`app.can_admin_payroll_for(${s.company.id})`));
    const before:string[]=[];
    for(const row of scoped)if(await resolvePayrollPermission(tx,who,'payroll.close',row.id))before.push(row.id);
    return {now,before:before.sort()};
   });
   expect(result.now).toEqual(result.before);
  }
  const groupResult=await withTenant(group(),tx=>payrollCloseCompanyIdsTx(tx,group(),companies));
  expect(groupResult.size).toBeGreaterThan(0);
 });
});
