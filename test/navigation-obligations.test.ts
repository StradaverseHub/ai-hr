/** Current source census integrity only; not runtime, visibility or fixture authority. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const root=new URL('../',import.meta.url);
const read=(path:string)=>readFileSync(new URL(path,root),'utf8');
const census=JSON.parse(read('scripts/performance/navigation-obligations.json'));
const roles=['employee','manager','companyHR','groupHR'];
function dynamicPages(path='app'):string[]{
 return readdirSync(new URL(path+'/',root),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?dynamicPages(path+'/'+entry.name):
  entry.name==='page.tsx'&&path.split('/').some(part=>part.startsWith('['))?[path+'/'+entry.name]:[]).sort();
}
describe('finite current navigation obligations, never qualification',()=>{
 it('retains every declared identity and four-role obligation without accepting any source claim',()=>{
  const ledger=JSON.parse(read('scripts/performance/navigation-coverage-ledger.json'));
  expect(census.declarations).toHaveLength(222);
  expect(census.declarations.map(({id,sourceOwner,sourceKey,declaredHref}:any)=>({id,sourceOwner,sourceKey,declaredHref})))
   .toEqual(ledger.entries.map(({id,sourceOwner,sourceKey,declaredHref}:any)=>({id,sourceOwner,sourceKey,declaredHref})));
  for(const row of census.declarations){expect(row.requiredRoles).toEqual(roles);expect(row.nativeDisposition).toBe('unresolved-native-owner');}
  expect(ledger.entries.every((row:any)=>row.status==='uncovered')).toBe(true);expect(ledger.backlog.map((row:any)=>row.id)).toContain('nested-submenus');
 });
 it('keeps all current dynamic page owners, parameters, realms and exact bytes explicit',()=>{
  expect(census.parameterizedPages.map((row:any)=>row.source).sort()).toEqual(dynamicPages());
  expect(census.parameterizedPages).toHaveLength(120);
  expect(Object.fromEntries(['hr','operator','invitation'].map(realm=>[realm,census.parameterizedPages.filter((row:any)=>row.realm===realm).length])))
   .toEqual({hr:117,operator:1,invitation:2});
  for(const row of census.parameterizedPages){
   expect(row.parameters).toEqual(row.source.split('/').filter((part:string)=>part.startsWith('[')).map((part:string)=>part.replace(/^\[+|\]+$/g,'').replace(/^\.\.\./,'')));
   expect(createHash('sha256').update(readFileSync(new URL(row.source,root))).digest('hex')).toBe(row.sha256);
   expect(row.descriptorBinding).toBe('unresolved');
  }
 });
 it('rechecks current family owners and labels absent historical composition honestly',()=>{
  expect(census.families).toHaveLength(46);expect(new Set(census.families.map((row:any)=>row.id)).size).toBe(46);
  for(const row of census.families){
   expect(row.currentSourceOwners.length).toBeGreaterThan(0);expect(row.usableOracle).toBe('unreviewed-per-leaf');expect(row.requiredNativeBinding).not.toBe('');
   for(const owner of row.currentSourceOwners)expect(createHash('sha256').update(readFileSync(new URL(owner.path,root))).digest('hex')).toBe(owner.sha256);
   for(const path of row.historicalOwnersAbsentFromCurrentSource)expect(existsSync(new URL(path,root))).toBe(false);
  }
  expect(census.families.find((row:any)=>row.id==='personnel-record').historicalOwnersAbsentFromCurrentSource).toContain('lib/personnel-record-navigation.ts');
 });
 it('keeps actual execution and resources unresolved while accounting for all proposed cases',()=>{
  const plan=JSON.parse(read('scripts/performance/navigation-scenarios.json'));
  expect(census.currentPlan).toEqual({cases:52,destinations:14,originalCasesPreserved:48,additionalCases:4,roles:{employee:12,manager:12,companyHR:14,groupHR:14}});
  expect(plan.scenarios).toHaveLength(census.currentPlan.cases);
  for(const rows of [census.declarations,census.families,census.parameterizedPages])for(const row of rows){expect(row.baseline).toBe('not-executed');expect(row.steady500).toBe('not-executed');}
  expect(census.capacity).toMatchObject({scenarioMs:90000,maximumCases:1024,stepsPerCase:8,checksPerCase:16,rampMs:10000,steadyMs:300000,httpActors:500,cohortAssignment:'not-reviewed',wholeUniverseFitsOneSteadyWindow:'not-proven'});
  expect(census.projectionBoundary).toMatchObject({implementation:'pending-native-startup-owner',privateFieldsPermitted:false,roleAuthority:'actual-native-owner-required'});
  for(const field of ['sourceMatrixComplete','runtimeAcceptance','releaseAuthorized','backlogMayBeCleared'])expect(census[field]).toBe(false);
 });
});
