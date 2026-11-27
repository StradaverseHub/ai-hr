/** Board 0735d1b7 — Security Center > Users duplicate tabs (core/login-duplicates.ts) on a real database.
 *
 * What is proved, with fictional people and independent expected values:
 *  - exact keys: IC with every non-digit removed, passport upper-cased without spaces, work email trimmed and
 *    case-insensitive; a near IC (one digit different) never groups; blank emails never group; people without a login
 *    never count; a passport group that is exactly an IC group is shown once;
 *  - merged logins count as their master in both tabs (the merged login itself leaves both tabs);
 *  - group administrators only: a company-scoped administrator is refused; another tenant's logins are invisible;
 *  - counts are capped at 1,001 ("1,000+") and "Count exactly" gives the exact number, with keyset paging. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {countLoginDuplicateGroups,readLoginDuplicateGroup,readLoginDuplicates,LoginDuplicatesError,type DuplicateGroup} from '../core/login-duplicates';
import {mergeLogins} from '../core/login-merge';
import {parseKeysetPageQuery} from '../lib/pagination';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {allowPeopleDuplicates} from './helpers/allow-people-duplicates';

let base:Base,ctx:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();await allowPeopleDuplicates(base.tenantId);ctx=adminCtx(base);});
afterAll(closeAll);

type Login={appUserId:string;personId:string};
/** A fictional login. `employed` hires the person (Internal User); otherwise a person with no employment (External). */
async function login(b:Base,name:string,email:string,opts:{ic?:string|null;passport?:string|null;employed?:boolean}={}):Promise<Login>{
 let personId:string;
 if(opts.employed){
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@hire.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  personId=hired.personId;
  await owner.db.update(schema.person).set({primaryEmail:email}).where(sql`id=${personId}::uuid`);
 }else{
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:email}).returning({id:schema.person.id});
  personId=p.id;
 }
 if(opts.ic!==undefined||opts.passport!==undefined)
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId,icNumber:opts.ic??null,passportNumber:opts.passport??null})
   .onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{icNumber:opts.ic??null,passportNumber:opts.passport??null}});
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId}).returning({id:schema.appUser.id});
 return {appUserId:u.id,personId};
}
const first=()=>parseKeysetPageQuery({});
const members=(groups:DuplicateGroup[])=>groups.map(g=>({basis:g.basis,ids:g.accounts.map(a=>a.appUserId).sort()}))
 .sort((a,b)=>`${a.basis}${a.ids.join()}`.localeCompare(`${b.basis}${b.ids.join()}`));
const sorted=(...ids:string[])=>[...ids].sort();

describe('board 0735d1b7: duplicate login groups',()=>{
 it('groups exact IC and passport matches after normalising, never near matches, and shows a passport duplicate of an IC group once',async()=>{
  const a=await login(base,'Fictional Aina One','aina1@example.test',{ic:'900101-14-5555',passport:'X1',employed:true});
  const b=await login(base,'Fictional Aina Two','aina2@example.test',{ic:'900101145555',passport:'x1'});
  await login(base,'Fictional Near IC','near@example.test',{ic:'900101145556'});
  const d=await login(base,'Fictional Pass One','pass1@example.test',{passport:'a 123 456'});
  const e=await login(base,'Fictional Pass Two','pass2@example.test',{passport:'A123456 '});
  // A person without a login who shares the IC never counts.
  const [stranger]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional No Login',primaryEmail:'nologin@example.test'}).returning({id:schema.person.id});
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:base.tenantId,personId:stranger.id,icNumber:'900101145555'});
  // The database stores an IC as its 12 digits (app.normalize_people_nric, 0594), so '900101-14-5555' reads back plain.
  const read=await readLoginDuplicates(ctx,'identity',first());
  expect(members(read.groups)).toEqual([{basis:'ic',ids:sorted(a.appUserId,b.appUserId)},{basis:'passport',ids:sorted(d.appUserId,e.appUserId)}]);
  expect(read.total).toEqual({count:2,capped:false});
  const ic=read.groups.find(g=>g.basis==='ic')!;
  expect(ic.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(ic.digest).not.toContain('900101145555');
  expect(ic.differentProfiles).toBe(true);
  expect(Object.fromEntries(ic.accounts.map(x=>[x.appUserId,x.userType]))).toEqual({[a.appUserId]:'internal',[b.appUserId]:'external'});
  expect(ic.accounts.find(x=>x.appUserId===a.appUserId)).toMatchObject({icNumber:'900101145555',status:'active',inactiveCause:null});
  expect(await countLoginDuplicateGroups(ctx)).toEqual({identity:2,email:0});
  expect((await readLoginDuplicates(ctx,'email',first())).groups).toEqual([]);
 });

 it('groups work emails case-insensitively and trimmed, never blank emails',async()=>{
  const f=await login(base,'Fictional Email One',' Same@Example.TEST ');
  const g=await login(base,'Fictional Email Two','same@example.test');
  await login(base,'Fictional Blank One','');
  await login(base,'Fictional Blank Two','   ');
  await login(base,'Fictional Other','other@example.test');
  const read=await readLoginDuplicates(ctx,'email',first());
  expect(members(read.groups)).toEqual([{basis:'email',ids:sorted(f.appUserId,g.appUserId)}]);
  expect(await countLoginDuplicateGroups(ctx)).toEqual({identity:0,email:1});
  const group=await readLoginDuplicateGroup(ctx,read.groups[0].digest);
  expect(group?.accounts.map(x=>x.appUserId).sort()).toEqual(sorted(f.appUserId,g.appUserId));
 });

 it('maps a merged login to its master in both tabs, and the merged login leaves both',async()=>{
  const a=await login(base,'Fictional Master','master@example.test',{ic:'880202-10-1234'});
  const b=await login(base,'Fictional Merged','shared@example.test',{ic:'880202101234'});
  const j=await login(base,'Fictional Email Twin','SHARED@example.test');
  expect(members((await readLoginDuplicates(ctx,'email',first())).groups)).toEqual([{basis:'email',ids:sorted(b.appUserId,j.appUserId)}]);
  const ic=(await readLoginDuplicates(ctx,'identity',first())).groups[0];
  await mergeLogins(ctx,{basis:'ic',groupDigest:ic.digest,masterId:a.appUserId,mergedIds:[b.appUserId],carry:{roleAssignmentIds:[],assistant:false},
   reason:'Fictional duplicate login of one person',confirmation:'MERGE'});
  // IC: master and merged login are one effective login now, so no group is left.
  expect((await readLoginDuplicates(ctx,'identity',first())).groups).toEqual([]);
  // Email: the merged login's email now brings its MASTER into the group; the merged login itself never appears.
  const email=(await readLoginDuplicates(ctx,'email',first())).groups;
  expect(members(email)).toEqual([{basis:'email',ids:sorted(a.appUserId,j.appUserId)}]);
  expect(email[0].lockedMasterId).toBe(a.appUserId);
  expect(email[0].accounts.find(x=>x.appUserId===a.appUserId)?.mergedCount).toBe(1);
  expect(await countLoginDuplicateGroups(ctx)).toEqual({identity:0,email:1});
 });

 it('refuses a company-scoped administrator and keeps another tenant invisible',async()=>{
  await login(base,'Fictional A1','dup-a@example.test',{ic:'770707-07-7777'});
  await login(base,'Fictional A2','dup-a2@example.test',{ic:'770707077777'});
  const scoped:SessionContext={...ctx,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(readLoginDuplicates(scoped,'identity',first())).rejects.toBeInstanceOf(LoginDuplicatesError);
  await expect(countLoginDuplicateGroups(scoped)).rejects.toBeInstanceOf(LoginDuplicatesError);
  const other=await seedBase(),otherCtx=adminCtx(other);await allowPeopleDuplicates(other.tenantId);
  // The same IC in the other tenant: it never joins tenant A's group and tenant A's group is not readable there.
  await login(other,'Fictional B1','dup-b@example.test',{ic:'770707077777'});
  const mine=(await readLoginDuplicates(ctx,'identity',first())).groups;
  expect(mine).toHaveLength(1);expect(mine[0].accounts).toHaveLength(2);
  expect((await readLoginDuplicates(otherCtx,'identity',first())).groups).toEqual([]);
  expect(await readLoginDuplicateGroup(otherCtx,mine[0].digest)).toBeNull();
  expect(await countLoginDuplicateGroups(otherCtx)).toEqual({identity:0,email:0});
 });

 it('caps the tab count at 1,001, counts exactly on request and pages groups by key',async()=>{
  // 1,002 IC groups of two external logins each, written in bulk as the owner.
  await owner.db.execute(sql`with people as (
    insert into person(tenant_id,full_name,primary_email)
    select ${base.tenantId}::uuid,'Fictional Bulk '||n,'bulk'||n||'@example.test' from generate_series(1,2004) n returning id,full_name),
   numbered as (select id,(regexp_replace(full_name,'\\D','','g'))::int as n from people),
   stat as (insert into employee_statutory_my(tenant_id,person_id,ic_number)
    select ${base.tenantId}::uuid,id,lpad(((n+1)/2)::text,12,'0') from numbered returning person_id)
   insert into app_user(tenant_id,workos_user_id,person_id) select ${base.tenantId}::uuid,'user_bulk_'||id,id from numbered`);
  expect(await countLoginDuplicateGroups(ctx)).toEqual({identity:1001,email:0});
  const page=await readLoginDuplicates(ctx,'identity',parseKeysetPageQuery({size:'25'}));
  expect(page.total).toEqual({count:1000,capped:true});
  expect(page.groups).toHaveLength(25);expect(page.hasNext).toBe(true);expect(page.hasPrev).toBe(false);
  expect(page.groups.every(g=>g.accounts.length===2)).toBe(true);
  const ids=page.groups.map(g=>g.id);
  expect(ids).toEqual([...ids].sort());
  const next=await readLoginDuplicates(ctx,'identity',parseKeysetPageQuery({size:'25',after:ids.at(-1),page:'1'}));
  expect(next.groups).toHaveLength(25);expect(next.hasPrev).toBe(true);expect(next.anchorFound).toBe(true);
  expect(next.groups.every(g=>g.id>ids.at(-1)!)).toBe(true);
  const exact=await readLoginDuplicates(ctx,'identity',parseKeysetPageQuery({size:'25',count:'exact'}));
  expect(exact.total).toEqual({count:1002,capped:false});
 },120_000);
});
