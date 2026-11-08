/** Source/grammar tests only. These do not mint native bindings or browser proof. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {PERSONNEL_RECORD_TAB_DEFINITIONS,ESS_PROFILE_TAB_DEFINITIONS} from '../lib/personnel-record-navigation';
import {DRAFT_TAB_DEFINITIONS} from '../lib/employee-draft-schema';
import {NAVIGATION_V3_PROTOCOL,NAVIGATION_V3_FIRST_CHOICES,NAVIGATION_V3_LIMITS,parseNavigationV3Request} from '../scripts/performance/navigation-v3-protocol';
import {compileNavigationV3Plan,NAVIGATION_V3_CENSUS_SHA256} from '../scripts/performance/navigation-v3-planner';
import {navigationV3CommissioningStatus} from '../scripts/performance/navigation-v3-admission';
const first=()=>({id:'v3.personnel.profile.companyHR',family:'personnel-record',destinationId:'nested.personnelRecord.profile',fixtureRole:'companyHR',record:{kind:'workforce-employment',relation:'own-current'},interaction:'read'});
const request=(...intents:unknown[])=>({protocol:NAVIGATION_V3_PROTOCOL,scope:'first-record-contract-unadmitted',intents:intents.length?intents:[first()]});
it('projects every first-family stable identity from the exact existing descriptor owners in original order',()=>{
 for(const [family,facts]of [['personnel-record',PERSONNEL_RECORD_TAB_DEFINITIONS],['personnel-draft',DRAFT_TAB_DEFINITIONS],['self-profile',ESS_PROFILE_TAB_DEFINITIONS]]as const){
  expect(NAVIGATION_V3_FIRST_CHOICES.filter(row=>row.family===family).map(row=>({key:row.key,id:row.id}))).toEqual(facts.map(row=>({key:row.key,id:row.navigationId})));
 }
 expect(NAVIGATION_V3_FIRST_CHOICES).toHaveLength(26);expect(new Set(NAVIGATION_V3_FIRST_CHOICES.map(row=>row.id)).size).toBe(26);
 expect(NAVIGATION_V3_FIRST_CHOICES.some(row=>row.family==='personnel-record'&&row.key==='others')).toBe(false);
});
it('accepts closed symbolic intentions without inventing native outcomes or making fixture role authority',()=>{
 for(const fixtureRole of ['employee','manager','companyHR','groupHR'])for(const relation of ['own-current','permitted-report','allowed-other-company','historical','foreign-tenant','same-tenant-out-of-scope','nonexistent']){
  const plan=compileNavigationV3Plan(request({...first(),fixtureRole,record:{kind:'workforce-employment',relation}}));
  expect(plan.cases[0].nativeDisposition).toBe('unresolved');expect(plan.cases[0].execution).toBe('not-executed');expect(plan.runtimeAcceptance).toBe(false);
 }
});
it('refuses caller UUIDs, URLs, principals, selectors, scripts, native verdicts and authorization flags',()=>{
 for(const extra of [{href:'/admin/personnel/a'},{employmentId:'00000000-0000-4000-8000-000000000001'},{verified:true},{nativeBinding:{}},{grants:[]},{outcome:'denied'},{steps:[{evaluate:'private()'}]},{selector:'body'}])expect(()=>parseNavigationV3Request(request({...first(),...extra}))).toThrow();
 for(const row of [{...first(),family:'unknown'},{...first(),destinationId:'nested.essProfile.profile'},{...first(),destinationId:'profile'},{...first(),id:'v3.bad\n'},{...first(),id:'/'},{...first(),fixtureRole:'operator'},{...first(),record:{kind:'draft',relation:'own-reserved-draft'}},{...first(),record:{kind:'workforce-employment',relation:'own-current',tenantId:'foreign'}}])expect(()=>parseNavigationV3Request(request(row))).toThrow();
});
it('refuses duplicated cases and duplicated semantic obligations with another case label',()=>{
 expect(()=>parseNavigationV3Request(request(first(),first()))).toThrow('Duplicate');expect(()=>parseNavigationV3Request(request(first(),{...first(),id:'v3.duplicate'}))).toThrow('Duplicate');
 expect(()=>parseNavigationV3Request({...request(),releaseAuthorized:true})).toThrow();expect(()=>parseNavigationV3Request(request(...Array.from({length:1025},first)))).toThrow();
});
it('allows only owned draft profile dirty/save intentions and no financial/ESS/foreign mutation intent',()=>{
 const draft={...first(),family:'personnel-draft',destinationId:'nested.personnelDraft.profile',record:{kind:'draft',relation:'own-reserved-draft'}};
 for(const interaction of ['draft-unsaved-cancel','draft-unsaved-discard','draft-save-reopen']){
  const plan=compileNavigationV3Plan(request({...draft,interaction}));expect(plan.cases[0].steps).toHaveLength(6);expect(plan.cases[0].admission).toBe('UNADMITTED_CONTRACT_ONLY');
  for(const row of [{...first(),interaction},{...draft,interaction,record:{kind:'draft',relation:'foreign-tenant'}},{...draft,interaction,destinationId:'nested.personnelDraft.payroll'},{...first(),interaction,family:'self-profile',destinationId:'nested.essProfile.profile',record:{kind:'own-employment',relation:'own-current'}}])expect(()=>parseNavigationV3Request(request(row))).toThrow();
 }
});
it('retains all 46 families/four-role obligations and all120 pages even for a one-case proposal',()=>{
 const plan=compileNavigationV3Plan(request()),original=JSON.parse(readFileSync('docs/qualification/nested-navigation-owner-inventory-20261108.json','utf8'));
 expect(plan.families.map(row=>row.id)).toEqual(original.families.map((row:{id:string})=>row.id));expect(plan.families).toHaveLength(46);
 expect(plan.parameterizedPages.map(row=>row.source)).toEqual(original.parameterizedPageCensus.map((row:{source:string})=>row.source));expect(plan.parameterizedPages).toHaveLength(120);
 expect(plan.parameterizedPages.every(row=>row.nativeBinding==='unbound'&&row.execution==='not-executed'&&row.descriptorAssociation==='unresolved')).toBe(true);
 for(const row of plan.families){expect(row.roles.map(role=>role.role)).toEqual(['employee','manager','companyHR','groupHR']);expect(row.roles.every(role=>role.nativeDisposition==='unresolved'&&role.baseline==='not-executed'&&role.loaded==='not-executed')).toBe(true);}
 expect(plan.parameterizedPages.filter(row=>row.realm==='operator')).toHaveLength(1);expect(plan.parameterizedPages.filter(row=>row.realm==='invitation')).toHaveLength(2);
});
it('pins the fixed census bytes and never publishes capacity, source completion, native or release acceptance',()=>{
 expect(createHash('sha256').update(readFileSync('docs/qualification/nested-navigation-owner-inventory-20261108.json')).digest('hex')).toBe(NAVIGATION_V3_CENSUS_SHA256);
 const plan=compileNavigationV3Plan(request());expect(plan.capacity).toMatchObject({scenarioTimeoutMs:90000,maximumCases:1024,stepsPerCase:8,checksPerCase:16,roleMatrixComplete:false,steady500ScheduleFits:'not-proven'});
 expect(NAVIGATION_V3_LIMITS).toEqual({scenarioMs:90000,scenarios:1024,steps:8,checks:16,steadyUsers:500,realSignIns:4,loadedContexts:6});
 expect(plan.sourceMatrixComplete).toBe(false);expect(plan.runtimeAcceptance).toBe(false);expect(plan.releaseAuthorized).toBe(false);expect(navigationV3CommissioningStatus().nativeBindingAvailable).toBe(false);
 expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.families[0].roles)).toBe(true);expect(Object.isFrozen(plan.cases[0].record)).toBe(true);expect(Object.isFrozen(plan.commissioning.blockers)).toBe(true);expect(Reflect.set(plan.cases[0].record,'relation','foreign-tenant')).toBe(false);expect(plan.cases[0].record.relation).toBe('own-current');
});
