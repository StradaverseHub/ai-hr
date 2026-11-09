/** Read-only projection of the EXISTING native, fictional system-load fixture.
 * No private identity/session/provider fields leave this helper or enter evidence. */
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,readSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {performanceFixtureCalendar} from './fixture-workload.mjs';
import {fixtureNavigationActor,type NavigationFixtureTextBindings} from './navigation-protocol';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Data projection only; the browser separately proves these expected seeded facts. */
export function projectNavigationFixtureBindings(value:unknown):ReadonlyMap<number,Readonly<NavigationFixtureTextBindings>>{
 assert(value&&typeof value==='object','Native fictional navigation fixture missing');
 const fixture=value as any;
 assert(typeof fixture.today==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(fixture.today)&&fixture.month===fixture.today.slice(0,7),'Native fictional fixture dates differ');
 const calendar=performanceFixtureCalendar(fixture.today);
 assert(Array.isArray(fixture.users)&&fixture.users.length===500&&Array.isArray(fixture.tenants)&&fixture.tenants.length===2,'Native fictional fixture population differs');
 const companies=new Set<string>(),employments=new Set<string>(),indices=new Set<number>(),bindings=new Map<number,Readonly<NavigationFixtureTextBindings>>();
 for(const [tenantIndex,tenant]of fixture.tenants.entries()){
  assert(tenant&&UUID.test(tenant.tenantId)&&Array.isArray(tenant.companies)&&tenant.companies.length===5,'Native fictional company fixture missing');
  for(const company of tenant.companies){assert(UUID.test(company.companyId)&&!companies.has(company.companyId),'Native fictional company identity differs');companies.add(company.companyId);}
  if(tenant.rewardDraft)assert(tenant.rewardDraft.companyId===tenant.companies[2].companyId&&UUID.test(tenant.rewardDraft.employmentId),'Native fictional reward prerequisite differs');
  for(const actor of fixture.users.filter((row:any)=>row?.tenant===tenantIndex)){
   const expected=fixtureNavigationActor(actor.index),companyIndex=Math.floor((actor.index%250)/50);
   assert(!indices.has(actor.index)&&actor.tenant===Math.floor(actor.index/250)&&actor.company===companyIndex&&actor.role===expected.role&&actor.name===expected.name
    &&actor.tenantId===tenant.tenantId&&actor.companyId===tenant.companies[companyIndex].companyId&&UUID.test(actor.employmentId)&&!employments.has(actor.employmentId),'Native fictional actor allocation differs');
   indices.add(actor.index);employments.add(actor.employmentId);
   const history=fixture.assistantHistory?.[String(actor.index)];
   let firstSavedHistoryTitle:string|undefined;
   if(history){
    assert(history.version===1&&history.userIndex===actor.index&&history.rowsVerified===true&&history.defaultCompanyScopeOnly===true&&history.threads===20&&history.exchanges===160
     &&Array.isArray(history.rootTitles)&&history.rootTitles.length===20&&history.rootTitles.every((title:unknown,index:number)=>title===`PERF saved ${actor.index} root ${String(index).padStart(2,'0')}`),'Native sealed saved-history fixture differs');
    firstSavedHistoryTitle=history.rootTitles[0];
   }
   const rosterScope:Record<string,string|null>={};
   for(const candidate of fixture.users.filter((row:any)=>row?.tenant===tenantIndex&&(actor.role==='groupHR'||row.company===companyIndex))){
    const canonical=fixtureNavigationActor(candidate.index);assert(UUID.test(candidate.employmentId)&&candidate.name===canonical.name,'Native roster fixture identity differs');
    rosterScope[candidate.employmentId]=canonical.name;
   }
   const population=actor.role==='groupHR'?250:50;
   const extra=tenant.rewardDraft&&(actor.role==='groupHR'||tenant.rewardDraft.companyId===actor.companyId)?1:0;
   if(extra){assert(!fixture.users.some((row:any)=>row.employmentId===tenant.rewardDraft.employmentId),'Native reward fixture duplicates an existing employment');rosterScope[tenant.rewardDraft.employmentId]=null;}
   bindings.set(actor.index,Object.freeze({rosterScope:Object.freeze(rosterScope),actorName:expected.name,actorEmployeeCode:'PERF'+String(actor.index).padStart(4,'0'),
    firstCompanyPersonName:'PERF Person '+String(Math.floor(actor.index/50)*50).padStart(4,'0'),activeHeadcount:String(population+extra),
    historicalPayrollMonth:calendar.historicalMonth,seedToday:fixture.today,seedMonth:fixture.month,...(firstSavedHistoryTitle?{firstSavedHistoryTitle}:{})}));
  }
 }
 assert(indices.size===500&&Array.from({length:500},(_,index)=>index).every(index=>indices.has(index)),'Native fictional actor inventory incomplete');
 return bindings;
}
export function readNavigationFixtureBindings():ReadonlyMap<number,Readonly<NavigationFixtureTextBindings>>{
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&process.env.AIHR_PERFORMANCE_ROLE_FIXTURE==='true','Hosted fictional fixture reader required');
 const directory=resolve(process.env.RUNNER_TEMP??'/missing','system-performance-private');
 assert(process.env.PERF_PRIVATE_DIR===directory,'Unexpected native fictional fixture directory');
 const parent=lstatSync(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink()&&realpathSync(directory)===directory&&parent.uid===process.getuid!()&&(parent.mode&0o777)===0o700,'Private native fictional fixture directory required');
 const path=join(directory,'fixture.json'),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid!()&&(before.mode&0o777)===0o600&&before.size>0&&before.size<=2*1024*1024,'Bounded private native fictional fixture required');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const read=readSync(fd,bytes,offset,bytes.length-offset,offset);assert(read>0,'Native fictional fixture truncated during read');offset+=read;}
  assert(readSync(fd,Buffer.alloc(1),0,1,offset)===0,'Native fictional fixture exceeded its bounded snapshot');
  const after=fstatSync(fd),named=lstatSync(path);
  for(const field of ['dev','ino','size','mtimeMs','ctimeMs']as const)assert(before[field]===after[field]&&after[field]===named[field],'Native fictional fixture changed while reading');
  assert(!named.isSymbolicLink(),'Native fictional fixture became a symlink');
  return projectNavigationFixtureBindings(JSON.parse(bytes.toString('utf8')));
 }finally{closeSync(fd);}
}
