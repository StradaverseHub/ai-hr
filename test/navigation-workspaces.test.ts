import {describe,it,expect} from 'vitest';
import {navigationPlacement,navigationRouteOwner,placeNavigation,NAVIGATION_MODULES} from '../lib/navigation-workspaces';

describe('Ops and Strata placement never grants authority',()=>{
 it('preserves the exact authorized destination objects and reports unknown additions instead of guessing',()=>{
  const directory={href:'/personnel',gate:'employee'},personnel={href:'/admin/personnel',gate:'admin'},unknown={href:'/future-unclassified',gate:'private'};
  const result=placeNavigation([directory,personnel,unknown]);
  expect(result.placed.map(row=>row.destination)).toEqual([directory,personnel]);
  expect(result.placed[0].destination).toBe(directory);expect(result.placed[1].destination).toBe(personnel);
  expect(result.unplaced).toEqual([unknown]);
 });
 it.each([
  ['/personnel','ops','people','mine'],['/admin/personnel','ops','people','hr'],
  ['/admin/settings/movement','ops','people','config'],['/admin/organization','ops','people','config'],
  ['/leave/tracker','ops','leave','team'],['/admin/leave-config/generate','ops','leave','hr'],
  ['/admin/leave-config/types','ops','leave','config'],['/admin/work-locations','ops','attendance','config'],
  ['/attendance/requests','ops','attendance','mine'],['/roster','ops','attendance','hr'],
  ['/payroll','ops','payroll','hr'],['/payroll/setup','ops','payroll','config'],
  ['/me?tab=payroll','ops','payroll','mine'],['/me/tax-relief','ops','payroll','mine'],
  ['/me/payslip','ops','payroll','mine'],['/me/payslip/fictional','ops','payroll','mine'],
  ['/me/tp3','ops','payroll','mine'],['/me/ea','ops','payroll','mine'],
  ['/admin/claims/reimbursements','ops','claims','hr'],['/admin/claims','ops','claims','config'],
  ['/performance/workspace?module=tm','strata','talent','team'],['/performance/workspace?module=idp','strata','development','mine'],
  ['/performance/workspace','strata','performance','mine'],['/reports?cat=leave','strata','workforceInsights','hr'],
 ] as const)('places %s with its module and job', (href,area,module,section)=>{
  expect(navigationPlacement(href)).toEqual({area,module,section});
 });
 it.each(['/admin/holidays','/admin/users','/admin/settings/email','/admin/system-testing','/mobile-preview'])('places shared configuration %s under the gear',href=>{
  expect(navigationPlacement(href)).toEqual({area:'system'});
 });
 it.each(['/','/me','/tasks','/approvals','/system-testing','/org','/assistant','/knowledge-base','/feedback'])('keeps %s shared across both sides',href=>{
  expect(navigationPlacement(href)).toEqual({area:'shared'});
 });
 it('collapses repeated already-authorized hrefs without changing their destination identity',()=>{
  const first={href:'/roster',gate:'manager'},second={href:'/roster',gate:'admin'};
  expect(placeNavigation([first,second]).placed).toEqual([{destination:first,placement:{area:'ops',module:'attendance',section:'hr'}}]);
 });
 it('assigns deep links by longest owned path and then exact query intent',()=>{
  const links=[{href:'/me'},{href:'/me?tab=payroll',ownedSubpaths:['/me/payslip']},{href:'/me/tax-relief'},{href:'/performance/workspace'},{href:'/performance/workspace?module=tm'},
   {href:'/lifecycle/onboarding',exactHref:true,ownedSubpaths:['/lifecycle/onboarding/cases']},{href:'/lifecycle/onboarding/checklists'},
   {href:'/admin/personnel'},{href:'/admin/personnel/profile-changes'}];
  expect(navigationRouteOwner('/me','tab=payroll',links)?.destination.href).toBe('/me?tab=payroll');
  expect(navigationRouteOwner('/me','tab=profile',links)?.destination.href).toBe('/me');
  expect(navigationRouteOwner('/me/payslip/fictional','',links)?.destination.href).toBe('/me?tab=payroll');
  expect(navigationRouteOwner('/me/tax-relief','',links)?.destination.href).toBe('/me/tax-relief');
  expect(navigationRouteOwner('/performance/workspace','module=tm',links)?.placement).toEqual({area:'strata',module:'talent',section:'team'});
  expect(navigationRouteOwner('/lifecycle/onboarding/cases/fictional','',links)?.destination.href).toBe('/lifecycle/onboarding');
  expect(navigationRouteOwner('/lifecycle/onboarding/checklists','',links)?.destination.href).toBe('/lifecycle/onboarding/checklists');
  expect(navigationRouteOwner('/admin/personnel/profile-changes','status=pending',links)?.destination.href).toBe('/admin/personnel/profile-changes');
 });
 it('keeps each module in exactly one workspace',()=>{
  expect(new Set(NAVIGATION_MODULES.map(module=>module.id)).size).toBe(NAVIGATION_MODULES.length);
 });
});
