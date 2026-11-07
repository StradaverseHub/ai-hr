/** Pure projection tests; no native fixture execution or runtime qualification. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {projectNavigationFixtureBindings,readNavigationFixtureBindings} from '../scripts/performance/navigation-fixture-bindings';
import {fixtureNavigationActor,navigationExpectedText} from '../scripts/performance/navigation-protocol';
const uuid=(n:number)=>'00000001-0000-0000-0000-'+String(n).padStart(12,'0');
function fixture(){
 const tenants=Array.from({length:2},(_,t)=>({tenantId:uuid(1000+t),companies:Array.from({length:5},(_,c)=>({companyId:uuid(2000+t*5+c)})),rewardDraft:undefined as {companyId:string;employmentId:string}|undefined}));
 const users=Array.from({length:500},(_,index)=>{const tenant=Math.floor(index/250),company=Math.floor((index%250)/50);return {index,tenant,company,tenantId:tenants[tenant].tenantId,companyId:tenants[tenant].companies[company].companyId,employmentId:uuid(index+1),...fixtureNavigationActor(index),token:'NEVER_EXPORT_TOKEN',password:'NEVER_EXPORT_PASSWORD'};});
 const assistantHistory=Object.fromEntries([1,4,251,254].map(index=>[index,{version:1,userIndex:index,rowsVerified:true,defaultCompanyScopeOnly:true,threads:20,exchanges:160,rootTitles:Array.from({length:20},(_,n)=>`PERF saved ${index} root ${String(n).padStart(2,'0')}`)}]));
 return {today:'2026-11-07',month:'2026-11',tenants,users,assistantHistory};
}
const ownedTemporary:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const path of ownedTemporary.splice(0))rmSync(path,{recursive:true,force:true});});
describe('bounded expected content from the existing native fictional fixture',()=>{
 it('projects exact company/tenant population, employment scope and sealed expected titles without private fields',()=>{
  const bindings=projectNavigationFixtureBindings(fixture());expect(bindings.size).toBe(500);
  expect(bindings.get(0)?.activeHeadcount).toBe('250');expect(bindings.get(1)?.activeHeadcount).toBe('50');
  expect(Object.keys(bindings.get(0)!.rosterScope)).toHaveLength(250);expect(Object.keys(bindings.get(1)!.rosterScope)).toHaveLength(50);
  expect(bindings.get(1)!.rosterScope[uuid(251)]).toBeUndefined();expect(bindings.get(1)!.firstSavedHistoryTitle).toBe('PERF saved 1 root 00');
  expect(navigationExpectedText('$fixture.seedMonth',1,bindings.get(1))).toBe('2026-11');
  expect(navigationExpectedText('$fixture.firstSavedHistoryTitle',1,bindings.get(1))).toBe('PERF saved 1 root 00');
  expect(()=>navigationExpectedText('$fixture.firstSavedHistoryTitle',2,bindings.get(2))).toThrow(/unseeded/);
  const serialized=JSON.stringify([...bindings.values()]);expect(serialized).not.toContain('NEVER_EXPORT');expect(serialized).not.toContain('password');expect(serialized).not.toContain('token');
 });
 it('accounts for the real preflight reward prerequisite only in its actual permitted company/tenant',()=>{
  const value=fixture();value.tenants[0].rewardDraft={companyId:value.tenants[0].companies[2].companyId,employmentId:uuid(9999)};
  const bindings=projectNavigationFixtureBindings(value);expect(bindings.get(0)?.activeHeadcount).toBe('251');expect(bindings.get(1)?.activeHeadcount).toBe('50');
  expect(bindings.get(101)?.activeHeadcount).toBe('51');expect(bindings.get(250)?.activeHeadcount).toBe('250');
  expect(bindings.get(0)!.rosterScope[uuid(9999)]).toBeNull();expect(Object.hasOwn(bindings.get(1)!.rosterScope,uuid(9999))).toBe(false);
 });
 it('reads only the bounded regular 0600 fixture beneath its private 0700 owned runner directory',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'navigation-fixture-unit-'));ownedTemporary.push(temporary);
  const directory=join(temporary,'system-performance-private'),path=join(directory,'fixture.json');mkdirSync(directory,{mode:0o700});
  vi.stubEnv('GITHUB_ACTIONS','true');vi.stubEnv('RUNNER_ENVIRONMENT','github-hosted');vi.stubEnv('GITHUB_REPOSITORY','StradaverseHub/ai-hr');vi.stubEnv('AIHR_PERFORMANCE_ROLE_FIXTURE','true');vi.stubEnv('RUNNER_TEMP',temporary);vi.stubEnv('PERF_PRIVATE_DIR',directory);
  writeFileSync(path,JSON.stringify(fixture()),{mode:0o600});expect(readNavigationFixtureBindings().size).toBe(500);
  chmodSync(path,0o644);expect(()=>readNavigationFixtureBindings()).toThrow(/Bounded private/);chmodSync(path,0o600);
  writeFileSync(path,'x'.repeat(2*1024*1024+1));expect(()=>readNavigationFixtureBindings()).toThrow(/Bounded private/);
  rmSync(path);const other=join(temporary,'other.json');writeFileSync(other,JSON.stringify(fixture()),{mode:0o600});symlinkSync(other,path);expect(()=>readNavigationFixtureBindings()).toThrow();
 });
 it('refuses incomplete, duplicate, wrong-scope/role/name and unsealed fictional fixture metadata',()=>{
  for(const edit of [(v:ReturnType<typeof fixture>)=>v.users.pop(),(v:ReturnType<typeof fixture>)=>{v.users[1].index=0;},
   (v:ReturnType<typeof fixture>)=>{v.users[1].companyId=v.tenants[1].companies[0].companyId;},
   (v:ReturnType<typeof fixture>)=>{v.users[1].name='Wrong native actor';},(v:ReturnType<typeof fixture>)=>{v.users[1].role='employee';},
   (v:ReturnType<typeof fixture>)=>{v.assistantHistory['1'].rowsVerified=false;}]){
   const value=fixture();edit(value);expect(()=>projectNavigationFixtureBindings(value)).toThrow();
  }
 });
});
