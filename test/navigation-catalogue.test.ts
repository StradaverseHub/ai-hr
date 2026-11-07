import {describe,it,expect} from 'vitest';
import {declaredNavigationCatalogue,resolveNavigationCatalogue} from '../lib/navigation/catalogue';
import {resolveShellNavigation,type ShellNavigationFacts} from '../lib/navigation/shell-resolver';
import {SIDEBAR_AUDIENCE_INVENTORY,PERFORMANCE_ADMIN_ROW,isCollapsible} from '../lib/navigation/shell-inventory';

const facts:ShellNavigationFacts={isAdmin:false};
describe('stable shell metadata uses the canonical runtime policy',()=>{
 it('has explicit unique business identities, provenance, and complete placement for known declarations',()=>{
  const catalogue=declaredNavigationCatalogue();
  expect(catalogue.issues).toEqual([]);
  expect(catalogue.declarations.length).toBeGreaterThan(100);
  expect(new Set(catalogue.declarations.map(row=>row.id)).size).toBe(catalogue.declarations.length);
  expect(catalogue.declarations.every(row=>row.sourceOwner&&row.sourceKey&&row.placement)).toBe(true);
 });
 it.each([
  facts,{isAdmin:true},{isAdmin:false,enabledModules:[]},
  {isAdmin:false,hasAssignedApproval:true},{isAdmin:false,canConfigureIdentityEmail:true},
  {isAdmin:false,canConfigureAccess:true,canProvisionUsers:true},
  {isAdmin:false,onboardingV9Access:true,onboardingV9Navigation:{onboarding:true,offboarding:true,administration:true,records:true}},
  {isAdmin:false,rewardDestinations:['/rewards','/admin/rewards/access']},
 ])('binds the exact resolver result without adding a second capability policy (%j)',capabilities=>{
  const actual=resolveNavigationCatalogue(capabilities);
  expect(actual.issues).toEqual([]);
  expect(actual.rows.map(entry=>entry.row)).toEqual(resolveShellNavigation(capabilities).destinations);
 });
 it('retains Performance admin identity at the declared address and a substituted latest cycle',()=>{
  const base=resolveNavigationCatalogue({...facts,canAdministerOnehr:true});
  const href='/performance/11111111-2222-4333-8444-555555555555/cycle/calendar';
  const latest=resolveNavigationCatalogue({...facts,canAdministerOnehr:true,performanceAdminHref:href});
  const admin=base.rows.find(entry=>entry.declaration.descriptor===PERFORMANCE_ADMIN_ROW)!;
  const dynamic=latest.rows.find(entry=>entry.navigationHref===href)!;
  expect(dynamic.declaration.id).toBe(admin.declaration.id);
  expect(dynamic.declaration.sourceKey).toBe(admin.declaration.sourceKey);
  expect(dynamic.declaration.declaredHref).toBe('/performance');
  expect(dynamic.declaration.ownedSubpaths).toEqual(['/performance']);
  expect(latest.rows.find(entry=>entry.row.href==='/performance/home')?.declaration.id).not.toBe(admin.declaration.id);
 });
 it('preserves click query semantics and distinct report/V9 query destinations',()=>{
  const catalogue=declaredNavigationCatalogue();
  expect(catalogue.declarations.find(row=>row.descriptor.labelKey==='teamLeaveTracker')?.navigationHref).toBe('/leave/tracker?calendar=1');
  const reports=catalogue.declarations.filter(row=>row.declaredHref.startsWith('/reports?cat='));
  expect(reports).toHaveLength(6);
  expect(new Set(reports.map(row=>row.id)).size).toBe(6);
  expect(new Set(reports.map(row=>row.navigationHref)).size).toBe(6);
 });
 it('keeps replaced and duplicate presentation explicit and disabled rows non-actionable',()=>{
  const result=resolveNavigationCatalogue({isAdmin:true,onboardingAccess:true,onboardingMaster:true});
  expect(result.rows.some(entry=>entry.declaration.status==='replaced')).toBe(false);
  expect(result.rows.find(entry=>entry.declaration.id==='shell.rosterAdministration')?.state).toBe('duplicate');
  const first=SIDEBAR_AUDIENCE_INVENTORY[0].items[0];
  if(isCollapsible(first))throw new Error('Dashboard fixture must be a leaf');
  const original=first.disabled;first.disabled=true;
  try{expect(resolveNavigationCatalogue(facts).rows.find(entry=>entry.row===first)?.state).toBe('disabled');}
  finally{first.disabled=original;}
 });
 it('fails closed on a newly injected leaf instead of deriving a fresh identity from its URL or label',()=>{
  const group=SIDEBAR_AUDIENCE_INVENTORY[0],first=group.items[0];
  if(isCollapsible(first))throw new Error('Dashboard fixture must be a leaf');
  group.items.push({...first,href:'/future-new-leaf',labelKey:'futureNewLeaf'});
  try{
   const result=resolveNavigationCatalogue(facts);
   expect(result.issues.some(issue=>issue.code==='unmapped-declaration')).toBe(true);
   expect(result.issues.some(issue=>issue.code==='unmapped-runtime-row')).toBe(true);
   expect(result.rows.some(entry=>entry.row.href==='/future-new-leaf')).toBe(false);
  }finally{group.items.pop();}
 });
});
