import {describe,it,expect} from 'vitest';
import {navigationPlacement,navigationRouteOwner,placeNavigation,NAVIGATION_MODULES} from '../lib/navigation-workspaces';
import {performancePack} from '../packs/performance';

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
  // 7baeb78e — letters belong to the E-Letter module, not People.
  ['/me/letters','ops','eLetter','mine'],['/letters/templates','ops','eLetter','hr'],['/letters/register/abc','ops','eLetter','hr'],['/letters/settings/policy','ops','eLetter','config'],
  ['/admin/settings/movement','ops','people','config'],['/admin/organization','ops','people','config'],
  ['/leave/tracker','ops','leave','team'],['/admin/leave-config/generate','ops','leave','hr'],
  ['/admin/leave-config/types','ops','leave','config'],['/admin/work-locations','ops','attendance','config'],
  ['/attendance/requests','ops','attendance','mine'],['/roster','ops','attendance','hr'],
  ['/payroll','ops','payroll','hr'],['/payroll/setup','ops','payroll','config'],
  ['/me?tab=payroll','ops','payroll','mine'],['/me/tax-relief','ops','payroll','mine'],
  ['/me/payslip','ops','payroll','mine'],['/me/payslip/fictional','ops','payroll','mine'],
  ['/me/tp3','ops','payroll','mine'],['/me/ea','ops','payroll','mine'],
  ['/admin/claims/reimbursements','ops','claims','hr'],['/admin/claims','ops','claims','config'],
  // D-P1-32 PT-X5 — Performance & Talent (the area home and every route below it) and Performance admin (the cycle
  // list and one cycle's admin area), one module each.
  ['/lifecycle/v9','ops','onboarding','hr'],['/me/lifecycle','ops','onboarding','mine'],
  ['/performance/home','strata','performance','mine'],['/performance/my','strata','performance','mine'],
  ['/performance/workspace','strata','performance','mine'],['/performance/calibration/talent-box','strata','performance','mine'],
  ['/performance','strata','performanceAdmin','hr'],['/performance/0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e/cycle/calendar','strata','performanceAdmin','hr'],
  ['/performance/0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e','strata','performanceAdmin','hr'],['/reports?cat=leave','strata','workforceInsights','hr'],
 ] as const)('places %s with its module and job', (href,area,module,section)=>{
  expect(navigationPlacement(href)).toEqual({area,module,section});
 });
 it.each(['/admin/holidays','/admin/users','/admin/settings/email','/admin/system-testing','/mobile-preview'])('places shared configuration %s under the gear',href=>{
  expect(navigationPlacement(href)).toEqual({area:'system'});
 });
 it.each(['/lifecycle/v9?view=tasks','/lifecycle/v9?view=records','/','/me','/tasks','/approvals','/system-testing','/org','/assistant','/knowledge-base','/feedback','/reports'])('keeps %s shared across both sides',href=>{
  expect(navigationPlacement(href)).toEqual({area:'shared'});
 });
 it('collapses repeated already-authorized hrefs without changing their destination identity',()=>{
  const first={href:'/roster',gate:'manager'},second={href:'/roster',gate:'admin'};
  expect(placeNavigation([first,second]).placed).toEqual([{destination:first,placement:{area:'ops',module:'attendance',section:'hr'}}]);
 });
 it('assigns deep links by longest owned path and then exact query intent',()=>{
  const links=[{href:'/me'},{href:'/me?tab=payroll',ownedSubpaths:['/me/payslip']},{href:'/me/tax-relief'},
   {href:'/lifecycle/onboarding',exactHref:true,ownedSubpaths:['/lifecycle/onboarding/cases']},{href:'/lifecycle/onboarding/checklists'},
   {href:'/admin/personnel'},{href:'/admin/personnel/profile-changes'}];
  expect(navigationRouteOwner('/me','tab=payroll',links)?.destination.href).toBe('/me?tab=payroll');
  expect(navigationRouteOwner('/me','tab=profile',links)?.destination.href).toBe('/me');
  expect(navigationRouteOwner('/me/payslip/fictional','',links)?.destination.href).toBe('/me?tab=payroll');
  expect(navigationRouteOwner('/me/tax-relief','',links)?.destination.href).toBe('/me/tax-relief');
  expect(navigationRouteOwner('/lifecycle/onboarding/cases/fictional','',links)?.destination.href).toBe('/lifecycle/onboarding');
  expect(navigationRouteOwner('/lifecycle/onboarding/checklists','',links)?.destination.href).toBe('/lifecycle/onboarding/checklists');
  expect(navigationRouteOwner('/admin/personnel/profile-changes','status=pending',links)?.destination.href).toBe('/admin/personnel/profile-changes');
 });
 it('lights Performance & Talent across the area and Performance admin on the cycle pages and admin area (PT-X5)',()=>{
  const cycle='0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e',[area,admin]=performancePack.navLinks!;
  // The admin entry opens the latest cycle's admin area; it keeps owning /performance through its ownedSubpaths.
  const links=[{href:'/me'},area,{...admin,href:`/performance/${cycle}/cycle/calendar`}];
  for(const path of ['/performance/home','/performance/my','/performance/team/kpis','/performance/calibration','/performance/calibration/talent-box','/performance/workspace','/performance/assessment/calibration/s-1','/performance/review/r-1','/me/performance'])
   expect(navigationRouteOwner(path,'',links)?.destination.href,path).toBe('/performance/home');
  for(const path of ['/performance',`/performance/${cycle}`,`/performance/${cycle}/performance/run`,`/performance/${cycle}/release`,'/performance/leaders'])
   expect(navigationRouteOwner(path,'',links)?.destination.href,path).toBe(`/performance/${cycle}/cycle/calendar`);
  expect(navigationRouteOwner('/me','',links)?.destination.href).toBe('/me');
  // Without the admin entry (an employee), an admin route lights nothing of the area.
  expect(navigationRouteOwner(`/performance/${cycle}/cycle/calendar`,'',[area])).toBeUndefined();
 });
 it('keeps each module in exactly one workspace',()=>{
  // PT-X5: Talent and Development retired into the area's tabs; Rewards keeps its own module.
  expect(NAVIGATION_MODULES.filter(module=>module.workspace==='strata').map(module=>module.id)).toEqual(['performance','performanceAdmin','rewards','workforceInsights']);
  expect(new Set(NAVIGATION_MODULES.map(module=>module.id)).size).toBe(NAVIGATION_MODULES.length);
 });
});
