/** Reversible native plan reuse only; never caches a principal/permission/result or changes an installation. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {pendingTaskSummary} from '../../core/approvals-inbox';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('reuses the unchanged native principal expression plan while re-evaluating every real actor and refusal',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base=adminCtx(b);
 const [child]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional descendant',parentCompanyId:b.companyId}).returning();
 const [unrelated]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated'}).returning();
 async function actor(role:'employee'|'hr_admin'){
  const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional native plan actor',primaryEmail:randomUUID()+'@example.invalid'}).returning();
  const userId=await createAppUser(b.tenantId,person.id,role);
  if(role==='hr_admin')await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const [employment]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:person.id,companyId:b.companyId,hiredOn:'2025-01-01'}).returning();
  const ctx:SessionContext={...base,userId,personId:person.id,roles:[role],grants:[{role,companyId:role==='hr_admin'?b.companyId:null}]};
  return{ctx,userId,employmentId:employment.id};
 }
 const employee=await actor('employee'),hr=await actor('hr_admin');
 const read=async(ctx:SessionContext)=>{const [row]=await withTenant(ctx,tx=>tx.execute<{valid:boolean}>(sql`select app.principal_snapshot_current() as valid`));return row.valid;};
 const cases:[string,SessionContext,boolean][]=[['employee',employee.ctx,true],['hr',hr.ctx,true],['descendant',{...hr.ctx,grants:[{role:'hr_admin',companyId:child.id}]},true],['forgedRole',{...employee.ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},false],['expandedScope',{...hr.ctx,grants:[{role:'hr_admin',companyId:null}]},false],['unrelatedScope',{...hr.ctx,grants:[{role:'hr_admin',companyId:unrelated.id}]},false],['missingIdentity',{tenantId:b.tenantId,roles:[]},false],['foreignTenant',{...employee.ctx,tenantId:foreign.tenantId},false],['substitutedPerson',{...employee.ctx,personId:hr.ctx.personId},true]];
 const signature='app.principal_snapshot_current()';
 const definition=async()=>{const [row]=await owner.client`select pg_get_functiondef(oid) as ddl,prosrc as body,to_jsonb(pg_proc)-'prosrc' as attributes from pg_proc where oid=${signature}::regprocedure`;return row;};
 const installed=await definition();expect(installed.body).toMatch(/^\s*SELECT EXISTS\(/i);expect(installed.attributes.prosecdef).toBe(true);expect(installed.attributes.provolatile).toBe('s');
 const stable=(a:Record<string,unknown>)=>Object.fromEntries(Object.entries(a).filter(([key])=>key!=='prolang'));
 const expression=installed.body.trim().replace(/;\s*$/,'');expect(expression).not.toContain('$principal_plan$');
 const candidate=`CREATE OR REPLACE FUNCTION app.principal_snapshot_current() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $principal_plan$ BEGIN RETURN (${expression}); END; $principal_plan$;`;
 const controls=async()=>{
  for(const [name,ctx,expected]of cases)expect(await read(ctx),name).toBe(expected);
  await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,hr.userId));
  try{expect(await read(hr.ctx),'revoked actual grant').toBe(false);}finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,hr.userId));}
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,employee.userId));
  try{expect(await read(employee.ctx),'archived actual login').toBe(false);}finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,employee.userId));}
  await owner.db.update(s.employment).set({blacklistedAt:new Date()}).where(eq(s.employment.id,employee.employmentId));
  try{expect(await read(employee.ctx),'actual blocked employment').toBe(false);}finally{await owner.db.update(s.employment).set({blacklistedAt:null}).where(eq(s.employment.id,employee.employmentId));}
  expect(await read(employee.ctx)).toBe(true);expect(await read(hr.ctx)).toBe(true);
 };
 const phases:Record<string,unknown>={};const modules={attendance:false,claims:false,performance:false,rewards:false};
 const measure=async(phase:string)=>{
  const repeated:Record<string,number>={},inbox:Record<string,number>={};
  for(const [name,ctx,valid]of cases.slice(0,4)){
   let elapsed=0;for(let i=0;i<3;i++){const start=performance.now();const rows=await withTenant(ctx,tx=>tx.execute<{valid:boolean;n:number}>(sql`select app.principal_snapshot_current() as valid,n from generate_series(1,500) seq(n) order by n`));elapsed+=performance.now()-start;expect(rows).toHaveLength(500);expect(rows.every(row=>row.valid===valid)).toBe(true);}repeated[name]=elapsed;
  }
  for(const [name,ctx]of [['employee',employee.ctx],['hr',hr.ctx]] as const){let elapsed=0;for(let i=0;i<10;i++){const start=performance.now();const result=await pendingTaskSummary(ctx,undefined,modules);elapsed+=performance.now()-start;expect(result.items).toEqual([]);expect(result.total).toBe(0);}inbox[name]=elapsed;}
  phases[phase]={repeatedExpressionRows:500,readsPerActor:3,repeatedMs:repeated,emptyCanonicalInboxReadsPerActor:10,inboxMs:inbox};
 };
 let restored=false;
 try{
  await controls();await measure('original');await owner.client.unsafe(candidate);expect(stable((await definition()).attributes)).toEqual(stable(installed.attributes));
  await controls();await measure('candidate');await measure('warm');await owner.client.unsafe(installed.ddl);restored=true;expect(await definition()).toEqual(installed);await controls();await measure('restored');
 }finally{
  if(!restored)await owner.client.unsafe(installed.ddl);expect(await definition()).toEqual(installed);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'principal-plan-prototype.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_PRINCIPAL_PLAN_ONLY',releaseEligible:false,sourceExpressionSha256:createHash('sha256').update(installed.body).digest('hex'),phases,nativeControlCases:cases.length+3,metadataOwnerAclAndOriginalDdlRestored:true,permissionResultCaching:false,limitations:'Component experiment; no production change, full500 claim, or unmeasured exact invocation-count claim.'},null,2));
 }
},300000);
