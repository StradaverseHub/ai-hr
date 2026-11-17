import {describe,it,expect} from 'vitest';
import {navigationPlacement,navigationRouteOwner,placeNavigation,NAVIGATION_MODULES} from '../lib/navigation-workspaces';
import {resolveShellNavigation,type ShellNavigationFacts} from '../lib/navigation/shell-resolver';
import {performancePack} from '../packs/performance';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

describe('Ops and Strata placement never grants authority',()=>{
 it('preserves the exact authorized destination objects and reports unknown additions instead of guessing',()=>{
  const directory={href:'/personnel',gate:'employee'},personnel={href:'/admin/personnel',gate:'admin'},unknown={href:'/future-unclassified',gate:'private'};
  const result=placeNavigation([directory,personnel,unknown]);
  expect(result.placed.map(row=>row.destination)).toEqual([directory,personnel]);
  expect(result.placed[0].destination).toBe(directory);expect(result.placed[1].destination).toBe(personnel);
  expect(result.unplaced).toEqual([unknown]);
 });
 it.each([
  ['/lifecycle/probation','ops','probation','hr'],['/lifecycle/probation/case/part','ops','probation','hr'],['/lifecycle/probation/workflows','ops','probation','config'],['/lifecycle/contracts','ops','contracts','hr'],['/lifecycle/contracts/templates','ops','contracts','config'],
  ['/rewards','strata','rewards','mine'],['/rewards/analytics','strata','rewards','mine'],['/rewards/rules','strata','rewards','config'],
  ['/personnel','ops','people','mine'],['/admin/personnel','ops','people','hr'],
  // 7baeb78e — letters belong to the E-Letter module, not People.
  ['/me/letters','ops','eLetter','mine'],['/letters/templates','ops','eLetter','hr'],['/letters/register/abc','ops','eLetter','hr'],['/letters/settings/policy','ops','eLetter','config'],
  ['/admin/settings/system-labels','ops','people','config'],['/admin/settings/system-labels/profile-options','ops','people','config'],
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
  // ADR 2026-11-15-probation-shared-automation, decision 1: the shared builders and the moved V9 builder views.
  ['/automation/workflows','ops','automation','config'],['/automation/templates','ops','automation','config'],['/automation/groups','ops','automation','config'],
  ['/lifecycle/v9?view=workflows','ops','automation','config'],['/lifecycle/v9?view=templates','ops','automation','config'],['/lifecycle/v9?view=groups','ops','automation','config'],
  ['/recruitment','ops','recruitment','hr'],['/recruitment/positions/fictional','ops','recruitment','hr'],['/recruitment/settings','ops','recruitment','config'],['/me/referrals','ops','recruitment','mine'],['/me/referrals/mine','ops','recruitment','mine'],
  ['/lifecycle/offboarding/postings','ops','onboarding','hr'],['/lifecycle/offboarding/postings/fictional/edit','ops','onboarding','hr'],
  ['/lifecycle/v9?view=settings','ops','automation','config'],['/lifecycle/probation/postings','ops','probation','hr'],
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
 it.each(['/lifecycle/v9?view=tasks','/lifecycle/v9?view=records','/','/me','/tasks','/approvals','/system-testing','/org','/assistant','/policies','/knowledge-base','/feedback','/reports'])('keeps %s shared across both sides',href=>{
  expect(navigationPlacement(href)).toEqual({area:'shared'});
 });
 // Issue 17 (owner: "Merge both entirely"): every /control-tower page renders inside AI Centre, so it is placed with the
 // shared AI Centre row, and that row (ownedSubpaths ['/control-tower'], components/sidebar.tsx) owns each of them.
 const CONTROL_TOWER_PAGES=['/control-tower','/control-tower/readiness','/control-tower/exceptions','/control-tower/actions','/control-tower/opportunities',
  '/control-tower/how-it-works','/control-tower/agents','/control-tower/agents/features','/control-tower/agents/inventory','/control-tower/agents/assistant',
  '/control-tower/agents/allowances','/control-tower/agents/spending','/control-tower/agents/provider','/control-tower/agents/runs','/control-tower/agents/orchestrator',
  // AI v2 W8: Operations › Loops and each loop's page.
  '/control-tower/loops','/control-tower/loops/[loop]',
  // AI v2 P2-2a: the Payroll cycle view, its Salary payroll page and its settings.
  '/control-tower/loops/payroll-cycle','/control-tower/loops/payroll-cycle/salary','/control-tower/loops/payroll-cycle/settings',
  // AI v2 P2-2b: the payroll Audit loop's page.
  '/control-tower/loops/loop_payroll_audit',
  // AI v2 P2-1: a loop's promote page (wave 1 integration).
  '/control-tower/loops/[loop]/promote',
  // AI Centre restructure (4 Nov 2026): Administration › Build list.
  '/control-tower/agents/build-list'];
 it.each(CONTROL_TOWER_PAGES)('places %s under AI Centre (shared), owned by the AI Centre row',path=>{
  expect(navigationPlacement(path)).toEqual({area:'shared'});
  const links=[{href:'/'},{href:'/me'},{href:'/assistant',ownedSubpaths:['/control-tower']},{href:'/approvals'},{href:'/admin/personnel'}];
  expect(navigationRouteOwner(path,'',links)?.destination.href).toBe('/assistant');
  expect(navigationRouteOwner(path,'',links)?.placement).toEqual({area:'shared'});
 });
 it('covers every /control-tower page on disk',()=>{
  const found:string[]=[];const walk=(dir:string,route:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(entry.isDirectory())walk(join(dir,entry.name),route+'/'+entry.name);else if(entry.name==='page.tsx')found.push(route);}};
  walk(join(process.cwd(),'app','control-tower'),'/control-tower');
  expect(found.length).toBeGreaterThanOrEqual(15);
  expect(found.filter(route=>!CONTROL_TOWER_PAGES.includes(route))).toEqual([]);
  // A neighbouring address is not swallowed by the prefix.
  expect(navigationPlacement('/control-towers')).toBeUndefined();
  expect(NAVIGATION_MODULES.some(module=>(module.id as string)==='controlTower')).toBe(false);
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
  // Issue 17: the Control Tower module left Ops; People is first.
  expect(NAVIGATION_MODULES.filter(module=>module.workspace==='ops').map(module=>module.id)).toEqual(['people','eLetter','onboarding','leave','attendance','claims','payroll','probation','contracts','recruitment','automation']);
  // PT-X5: Talent and Development retired into the area's tabs; Rewards keeps its own module.
  expect(NAVIGATION_MODULES.filter(module=>module.workspace==='strata').map(module=>module.id)).toEqual(['performance','performanceAdmin','rewards','workforceInsights']);
  expect(new Set(NAVIGATION_MODULES.map(module=>module.id)).size).toBe(NAVIGATION_MODULES.length);
 });
});


describe('combined Recruitment and shared HR Automation gates remain independent',()=>{
 const hrefs=(facts:Partial<ShellNavigationFacts>)=>resolveShellNavigation({isAdmin:false,enabledModules:['lifecycle','recruitment'],...facts}).destinations.map(row=>row.href);
 const automation=(paths:string[])=>paths.filter(href=>{const placement=navigationPlacement(href);return placement&&'module'in placement&&placement.module==='automation';});
 const v9={onboardingV9Access:true,onboardingV9Navigation:{onboarding:true,offboarding:true,administration:true}};
 it('does not let native Recruitment or referral access grant Configuration or posting authority',()=>{
  const paths=hrefs({canAdministerRecruitment:true,referralPortal:true});expect(paths).toContain('/recruitment');expect(paths).toContain('/me/referrals');expect(automation(paths)).toEqual([]);expect(paths).not.toContain('/lifecycle/offboarding/postings');
 });
 it('composes both domains and mounts exactly the approved four Configuration links under the native On/Off gate',()=>{
  const paths=hrefs({...v9,canAdministerRecruitment:true,referralPortal:true,offboardingPostingsAccess:true});
  expect(paths).toContain('/recruitment');expect(paths).toContain('/me/referrals');expect(paths).toContain('/lifecycle/offboarding/postings');
  expect(automation(paths)).toEqual(['/automation/workflows','/automation/templates','/automation/groups','/lifecycle/v9?view=settings']);
  expect(paths.filter(href=>href==='/lifecycle/v9?view=settings')).toHaveLength(1);
  for(const view of ['workflows','templates','groups'])expect(paths).not.toContain('/lifecycle/v9?view='+view);
  for(const href of ['/lifecycle/contracts/workflows','/lifecycle/contracts/templates'])expect(paths).not.toContain(href);
 });
 it('does not infer native Recruitment, referral or posting access from broad administration or Configuration',()=>{
  const paths=hrefs({...v9,isAdmin:true});expect(paths).not.toContain('/recruitment');expect(paths).not.toContain('/me/referrals');expect(paths).not.toContain('/lifecycle/offboarding/postings');
  expect(automation(paths)).toHaveLength(4);
  expect(hrefs({canAdministerRecruitment:true,enabledModules:['lifecycle']})).not.toContain('/recruitment');
 });
 it('does not leak native On/Off settings to another module configurer even with Recruitment access',()=>{
  const paths=hrefs({canAdministerRecruitment:true,probationAccess:{page:true,configure:true}});expect(paths).toContain('/recruitment');expect(automation(paths)).toEqual(['/automation/workflows','/automation/templates','/automation/groups']);expect(paths).not.toContain('/lifecycle/v9?view=settings');
 });
});
