import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {readHomeTeamPage,readHomeCelebrationPage,readHomeTeamCalendar} from '../core/employee-home-sharing';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {saveOwnHomePersonPrivacy} from '../core/employee-home-person-privacy';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {requestLeave,decideLeave} from '../packs/leave/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,caller:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>caller}));
const {GET:teamGET}=await import('../app/api/home/team/route');
const today=()=>todayInKualaLumpur();
const add=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(name:string,p:{manager?:string;companyId?:string;departmentId?:string;personId?:string}={}){
 const hired=await hireEmployee(adminCtx(b),{person:p.personId?{id:p.personId}:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:p.companyId??b.companyId,departmentId:p.departmentId??b.deptA,employmentType:'full_time',hiredOn:add(today(),-1200),
  ...(p.manager?{reportingManagerEmploymentId:p.manager}:{})});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']};
 return {...hired,ctx};
}
async function configure(team:'off'|'direct'|'department',celebrations=false,ordinal=0,audienceRole:'employee'|'manager'='employee'){
 const configuration=defaultEmployeeHomeConfiguration();configuration.teamVisibility=team;
 configuration.celebrations={enabled:celebrations,scope:team==='off'?'direct':team};
 return saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole,configuration,expectedOrdinal:ordinal,reason:'Fictional Home sharing acceptance'});
}
async function celebrationFacts(employee:Awaited<ReturnType<typeof worker>>,on=today()){
 await owner.db.update(s.person).set({dateOfBirth:'2000'+on.slice(4)}).where(eq(s.person.id,employee.personId));
 await owner.db.update(s.employment).set({hiredOn:String(Number(on.slice(0,4))-4)+on.slice(4)}).where(eq(s.employment.id,employee.employmentId));
}
describe('minimal Home sharing under actual application RLS',()=>{
 it('defaults off, then exposes only configured department employment/name/presence without granting Personnel access',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional colleague');
  expect(await readHomeTeamPage(own.ctx,own.employmentId)).toEqual({scope:'off',date:today(),totalPeople:0,items:[],nextCursor:null});
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items).toEqual([]);
  await configure('department');
  const result=await readHomeTeamPage(own.ctx,own.employmentId);
  expect(result).toEqual({scope:'department',date:today(),totalPeople:1,items:[{employmentId:peer.employmentId,name:'Fictional colleague',presence:null}],nextCursor:null});
  caller=own.ctx;const response=await teamGET(new Request('http://localhost/api/home/team?employmentId='+own.employmentId));
  expect(await response.json()).toEqual({version:1,employmentId:own.employmentId,page:result});
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  for(const query of ['employmentId=x&employmentId=y','employmentId=x&companyId='+b.companyId,'employmentId=x&view=all','employmentId=x&date=2026-02-31','employmentId=x&after=not-a-cursor'])
   expect((await teamGET(new Request('http://localhost/api/home/team?'+query))).status).toBe(400);
  expect((await teamGET(new Request('http://localhost/api/home/team?employmentId='+peer.employmentId))).status).toBe(403);
  const ownAdmin:SessionContext={...own.ctx,userId:await createAppUser(b.tenantId,own.personId,'hr_admin'),roles:['hr_admin']};
  await expect(readHomeTeamPage(ownAdmin,peer.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(withTenant(ownAdmin,tx=>tx.execute(sql`SELECT app.home_team_page(${peer.employmentId}::uuid,${today()}::date)`))).rejects.toThrow();
  expect(await withTenant(own.ctx,tx=>tx.select({id:s.person.id}).from(s.person).where(eq(s.person.id,peer.personId)))).toEqual([]);
  expect(await withTenant(own.ctx,tx=>tx.select({id:s.employment.id}).from(s.employment).where(eq(s.employment.id,peer.employmentId)))).toEqual([]);
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT * FROM app._home_peer_cohort(${own.employmentId}::uuid,'team')`))).rejects.toThrow();
  for(const key of ['personId','dateOfBirth','salary','reason','office','wfh'])expect(JSON.stringify(result)).not.toContain(key);
 });
 it('uses approved leave rather than a pending request or inferred office/WFH status',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional on leave'),date=today();
  await configure('department');
  const [type]=await owner.db.insert(s.leaveType).values({tenantId:b.tenantId,name:'Fictional shared presence',code:'HP_'+randomUUID().slice(0,6).toUpperCase(),
   counting:'calendar_days',paid:true,visibleToEmployee:true,role:'annual'}).returning();
  await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:peer.employmentId,leaveTypeId:type.id,
   entryType:'accrual',days:'20',effectiveOn:today().slice(0,4)+'-01-01'});
  const request=await requestLeave(adminCtx(b),{employmentId:peer.employmentId,leaveTypeId:type.id,startDate:date,endDate:date,today:today(),reason:'Private fictional medical detail'});
  expect((await readHomeTeamPage(own.ctx,own.employmentId,{date})).items[0].presence).toBeNull();
  await decideLeave(adminCtx(b),{leaveRequestId:request.leaveRequestId,decision:'approved'});
  const result=await readHomeTeamPage(own.ctx,own.employmentId,{date});expect(result.items[0].presence).toBe('leave');
  expect(JSON.stringify(result)).not.toContain('medical');expect(JSON.stringify(result)).not.toContain(type.id);
 });
 it('follows current direct relationships and role policy, never a posted company or an expired/delegate edge',async()=>{
  const manager=await worker('Fictional manager'),own=await worker('Fictional viewer',{manager:manager.employmentId}),
   peer=await worker('Fictional peer',{manager:manager.employmentId}),unrelated=await worker('Fictional unrelated');
  await configure('direct');
  expect(new Set((await readHomeTeamPage(own.ctx,own.employmentId)).items.map(row=>row.employmentId))).toEqual(new Set([manager.employmentId,peer.employmentId]));
  await owner.db.update(s.reportingLine).set({validTo:today()}).where(and(eq(s.reportingLine.subordinateEmploymentId,peer.employmentId),eq(s.reportingLine.managerEmploymentId,manager.employmentId)));
  await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:unrelated.employmentId,managerEmploymentId:manager.employmentId,lineType:'delegate',validFrom:today()});
  expect((await readHomeTeamPage(own.ctx,own.employmentId)).items.map(row=>row.employmentId)).toEqual([manager.employmentId]);
  // The same manager uses the separate Manager policy, which remains off until explicitly configured.
  expect((await readHomeTeamPage(manager.ctx,manager.employmentId)).scope).toBe('off');
  await configure('direct',false,0,'manager');
  expect((await readHomeTeamPage(manager.ctx,manager.employmentId)).items.map(row=>row.employmentId)).toEqual([own.employmentId]);
 });
 it('counts the full cohort, pages deterministically, and refuses a foreign or removed cursor and revoked login',async()=>{
  const own=await worker('Fictional viewer');
  const peers=[await worker('Fictional A'),await worker('Fictional B'),await worker('Fictional C')];await configure('department');
  const first=await readHomeTeamPage(own.ctx,own.employmentId,{limit:2});expect(first.totalPeople).toBe(3);
  expect(first.items.map(row=>row.employmentId)).toEqual(peers.slice(0,2).map(row=>row.employmentId));expect(first.nextCursor).toBe(peers[1].employmentId);
  const second=await readHomeTeamPage(own.ctx,own.employmentId,{after:first.nextCursor!,limit:2});
  expect(second.totalPeople).toBe(3);expect(second.items.map(row=>row.employmentId)).toEqual([peers[2].employmentId]);expect(second.nextCursor).toBeNull();
  await expect(readHomeTeamPage(own.ctx,own.employmentId,{after:randomUUID()})).rejects.toThrow();
  await owner.db.update(s.employment).set({blacklistedAt:today()}).where(eq(s.employment.id,peers[1].employmentId));
  await expect(readHomeTeamPage(own.ctx,own.employmentId,{after:first.nextCursor!})).rejects.toThrow();
  await expect(readHomeTeamPage(own.ctx,peers[0].employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,own.ctx.userId!));
  await expect(readHomeTeamPage(own.ctx,own.employmentId)).rejects.toThrow();
 });
 it('never turns a cross-company reporting edge, missing company proof, or foreign subject into a shared peer',async()=>{
  const boss=await worker('Fictional boss'),own=await worker('Fictional viewer',{manager:boss.employmentId});
  const same=await worker('Fictional same-company peer',{manager:boss.employmentId});
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other company'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional other department'}).returning();
  const other=await worker('Fictional cross-company peer',{companyId:company.id,departmentId:department.id,manager:boss.employmentId});
  await configure('direct');
  expect(new Set((await readHomeTeamPage(own.ctx,own.employmentId)).items.map(row=>row.employmentId))).toEqual(new Set([boss.employmentId,same.employmentId]));
  await owner.db.update(s.assignment).set({companyId:null}).where(eq(s.assignment.employmentId,same.employmentId));
  expect((await readHomeTeamPage(own.ctx,own.employmentId)).items.map(row=>row.employmentId)).toEqual([boss.employmentId]);
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT app.home_team_page(${other.employmentId}::uuid,${today()}::date)`))).rejects.toThrow();
  const foreign=await seedBase();
  const stranger=await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional foreign tenant',primaryEmail:randomUUID()+'@example.invalid'},
   companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:today()});
  await expect(readHomeCelebrationPage(own.ctx,stranger.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT app.home_celebration_page(${stranger.employmentId}::uuid)`))).rejects.toThrow();
 });
 it('applies latest person-wide opt-outs on every celebration read and excludes birth year/private rows',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional celebration');await celebrationFacts(peer);await configure('department',true);
  const result=await readHomeCelebrationPage(own.ctx,own.employmentId);
  expect(result.items).toEqual([{employmentId:peer.employmentId,name:'Fictional celebration',date:today(),kind:'anniversary',years:4},
   {employmentId:peer.employmentId,name:'Fictional celebration',date:today(),kind:'birthday',years:null}]);
  for(const key of ['2000'+today().slice(4),'dateOfBirth','personId','hideBirthday','hideAnniversary'])expect(JSON.stringify(result)).not.toContain(key);
  const secondLogin:SessionContext={...peer.ctx,userId:await createAppUser(b.tenantId,peer.personId,'employee')};
  await saveOwnHomePersonPrivacy(secondLogin,{expectedOrdinal:0,hideBirthday:true,hideAnniversary:false});
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items.map(row=>row.kind)).toEqual(['anniversary']);
  await saveOwnHomePersonPrivacy(peer.ctx,{expectedOrdinal:1,hideBirthday:true,hideAnniversary:true});
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items).toEqual([]);
  expect(await withTenant(own.ctx,tx=>tx.select().from(s.employeeHomePersonPrivacyRevision))).toEqual([]);
  await saveOwnHomePersonPrivacy(secondLogin,{expectedOrdinal:2,hideBirthday:false,hideAnniversary:false});
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).total).toBe(2);
 });
 it('deduplicates one person’s concurrent employments, rechecks privacy at the cursor, and honors default-off changes',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional celebration');
  const second=await worker('Same fictional person',{personId:peer.personId});await celebrationFacts(peer);await celebrationFacts(second);
  await configure('department',true);
  const first=await readHomeCelebrationPage(own.ctx,own.employmentId,{limit:1});expect(first.total).toBe(2);expect(first.items).toHaveLength(1);expect(first.nextCursor).not.toBeNull();
  const next=await readHomeCelebrationPage(own.ctx,own.employmentId,{after:first.nextCursor!,limit:1});expect(next.items).toHaveLength(1);expect(next.nextCursor).toBeNull();
  await saveOwnHomePersonPrivacy(peer.ctx,{expectedOrdinal:0,hideBirthday:true,hideAnniversary:true});
  await expect(readHomeCelebrationPage(own.ctx,own.employmentId,{after:first.nextCursor!})).rejects.toThrow();
  await configure('off',false,1);expect((await readHomeTeamPage(own.ctx,own.employmentId)).scope).toBe('off');
  expect(await readHomeCelebrationPage(own.ctx,own.employmentId)).toMatchObject({scope:'off',total:0,items:[]});
 });
 it('keeps a recorded final day inclusive and omits a later celebration after the employment ends',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional departing peer');await configure('department',true);
  await celebrationFacts(peer,add(today(),3));
  await owner.db.update(s.employment).set({lastWorkingDate:add(today(),2)}).where(eq(s.employment.id,peer.employmentId));
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items).toEqual([]);
  await celebrationFacts(peer,today());
  await owner.db.update(s.employment).set({lastWorkingDate:today()}).where(eq(s.employment.id,peer.employmentId));
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items).toHaveLength(2);
  await owner.db.update(s.employment).set({lastWorkingDate:add(today(),-1)}).where(eq(s.employment.id,peer.employmentId));
  expect((await readHomeTeamPage(own.ctx,own.employmentId)).items).toEqual([]);
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items).toEqual([]);
 });
 it('counts one person once and uses one representative cursor even when leave belongs to their other employment',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional concurrent colleague');
  const other=await worker('Same fictional person',{personId:peer.personId});await configure('department');
  const [representative,onLeave]=[peer.employmentId,other.employmentId].sort();
  await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:onLeave,leaveTypeId:b.annualLeaveTypeId,
   startDate:today(),endDate:today(),durationType:'half_day_am',status:'approved',days:'0.5',reason:'Private fictional detail'});
  const member={employmentId:representative,name:'Fictional concurrent colleague',presence:'leave'};
  expect(await readHomeTeamPage(own.ctx,own.employmentId)).toMatchObject({totalPeople:1,items:[member]});
  expect(await readHomeTeamPage(own.ctx,own.employmentId,{onlyLeave:true})).toMatchObject({totalPeople:1,items:[member]});
  expect((await readHomeTeamCalendar(own.ctx,own.employmentId,today(),today())).days).toEqual([
   {date:today(),available:true,totalPeople:1,items:[{employmentId:representative,name:'Fictional concurrent colleague'}],nextCursor:null}]);
 });
 it('shares only proven same-employer leave dates and represents missing viewer history as unavailable, never zero',async()=>{
  const own=await worker('Fictional viewer'),peer=await worker('Fictional transferred colleague');await configure('department');
  const past=add(today(),-10),transfer=add(today(),-5);
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional old employer'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional old department'}).returning();
  const [initial]=await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,peer.employmentId)).orderBy(s.assignment.validFrom,s.assignment.id);
  await owner.db.update(s.assignment).set({companyId:company.id,departmentId:department.id,validTo:transfer}).where(eq(s.assignment.id,initial.id));
  await owner.db.insert(s.assignment).values({...initial,id:randomUUID(),validFrom:transfer,validTo:null});
  await owner.db.insert(s.leaveRequest).values([past,today()].map(date=>({tenantId:b.tenantId,employmentId:peer.employmentId,leaveTypeId:b.annualLeaveTypeId,
   startDate:date,endDate:date,durationType:'full_day' as const,status:'approved' as const,days:'1',reason:'Private fictional old employer detail'})));
  const calendar=await readHomeTeamCalendar(own.ctx,own.employmentId,past,today());
  expect(calendar.days.find(day=>day.date===past)).toMatchObject({available:true,totalPeople:0,items:[]});
  expect(calendar.days.find(day=>day.date===today())).toMatchObject({available:true,totalPeople:1});
  const [viewerInitial]=await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,own.employmentId)).orderBy(s.assignment.validFrom,s.assignment.id);
  await owner.db.update(s.assignment).set({companyId:null,validTo:transfer}).where(eq(s.assignment.id,viewerInitial.id));
  await owner.db.insert(s.assignment).values({...viewerInitial,id:randomUUID(),validFrom:transfer,validTo:null});
  const unknown=await readHomeTeamCalendar(own.ctx,own.employmentId,past,today());
  expect(unknown.days.find(day=>day.date===past)).toEqual({date:past,available:false,totalPeople:null,items:[],nextCursor:null});
  await expect(readHomeTeamPage(own.ctx,own.employmentId,{date:past,onlyLeave:true})).rejects.toThrow();
 });
 it('returns exact whole-day counts with five names and a compatible current-authority continuation',async()=>{
  const own=await worker('Fictional viewer'),peers=[];await configure('department');
  for(const suffix of ['A','B','C','D','E','F'])peers.push(await worker('Fictional team '+suffix));
  await owner.db.insert(s.leaveRequest).values(peers.map(peer=>({tenantId:b.tenantId,employmentId:peer.employmentId,leaveTypeId:b.annualLeaveTypeId,
   startDate:today(),endDate:today(),durationType:'full_day' as const,status:'approved' as const,days:'1'})));
  const day=(await readHomeTeamCalendar(own.ctx,own.employmentId,today(),today())).days[0];
  expect(day.totalPeople).toBe(6);expect(day.items).toHaveLength(5);expect(day.nextCursor).toBe(peers[4].employmentId);
  const remaining=await readHomeTeamPage(own.ctx,own.employmentId,{date:today(),onlyLeave:true,after:day.nextCursor!});
  expect(remaining.totalPeople).toBe(6);expect(remaining.items.map(row=>row.employmentId)).toEqual([peers[5].employmentId]);
  await owner.db.update(s.employment).set({blacklistedAt:today()}).where(eq(s.employment.id,peers[4].employmentId));
  await expect(readHomeTeamPage(own.ctx,own.employmentId,{date:today(),onlyLeave:true,after:day.nextCursor!})).rejects.toThrow();
 });
 it('keeps an unavailable current company or department distinct from a configured-off policy and an empty team',async()=>{
  const own=await worker('Fictional viewer');await worker('Fictional peer');await configure('department');
  await owner.db.update(s.department).set({archivedAt:new Date()}).where(eq(s.department.id,b.deptA));
  await expect(readHomeTeamPage(own.ctx,own.employmentId)).rejects.toThrow();
  const noDepartment=await readHomeTeamCalendar(own.ctx,own.employmentId,today(),today());
  expect(noDepartment).toEqual({scope:'unavailable',from:today(),to:today(),days:[{date:today(),available:false,totalPeople:null,items:[],nextCursor:null}]});
  await owner.db.update(s.assignment).set({companyId:null}).where(eq(s.assignment.employmentId,own.employmentId));
  expect(await readHomeTeamCalendar(own.ctx,own.employmentId,today(),today())).toEqual(noDepartment);
 });
});
