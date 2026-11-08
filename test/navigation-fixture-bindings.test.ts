/** Pure projection tests; no native fixture execution or runtime qualification. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {projectNavigationFixtureBindings,readNavigationFixtureBindings} from '../scripts/performance/navigation-fixture-bindings';
import {navigationExpectedText} from '../scripts/performance/navigation-protocol';
import {fictionalNavigationFixture,navigationFixtureUuid as uuid} from './helpers/navigation-fixture';
const fixture=fictionalNavigationFixture;
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

it('refuses the real producer omission and tenant mismatches rather than manufacturing a tenant claim',()=>{
 for(const edit of [(v:ReturnType<typeof fixture>)=>{delete(v.users[1]as Partial<(typeof v.users)[number]>).tenantId;},
  (v:ReturnType<typeof fixture>)=>{v.users[1].tenantId=v.tenants[1].tenantId;},
  (v:ReturnType<typeof fixture>)=>{(v.users[1]as any).employmentId=[v.users[1].employmentId];},
  (v:ReturnType<typeof fixture>)=>{v.tenants[1].tenantId=v.tenants[0].tenantId;for(const user of v.users.filter(row=>row.tenant===1))user.tenantId=v.tenants[0].tenantId;}]){
  const value=fixture();edit(value);expect(()=>projectNavigationFixtureBindings(value)).toThrow();
 }
});
