/** Navigation placement only. Callers supply already-authorized destinations; this file grants nothing. */
export type NavigationWorkspace = 'ops' | 'strata';
export type NavigationSection = 'mine' | 'team' | 'hr' | 'ai' | 'config';
export type NavigationModule = 'controlTower' | 'people' | 'eLetter' | 'onboarding' | 'leave' | 'attendance' | 'claims' | 'payroll'
  | 'performance' | 'performanceAdmin' | 'rewards' | 'workforceInsights';
export type NavigationPlacement = {area:'shared' | 'system'} | {area:NavigationWorkspace;module:NavigationModule;section:NavigationSection};
export const NAVIGATION_MODULES: readonly {id:NavigationModule;workspace:NavigationWorkspace;labelKey:string}[] = [
  {id:'controlTower',workspace:'ops',labelKey:'aiControlTower'},
  {id:'people',workspace:'ops',labelKey:'modulePeople'},
  // 7baeb78e — Letters is its own module, beside People. Same pages and addresses; placement only.
  {id:'eLetter',workspace:'ops',labelKey:'moduleELetter'},
  {id:'onboarding',workspace:'ops',labelKey:'moduleOnboarding'},
  {id:'leave',workspace:'ops',labelKey:'moduleLeave'},
  {id:'attendance',workspace:'ops',labelKey:'moduleAttendance'},
  {id:'claims',workspace:'ops',labelKey:'claims'},
  {id:'payroll',workspace:'ops',labelKey:'payroll'},
  // D-P1-32 PT-X5 (APR-025 D4): Performance & Talent and Performance admin, one entry each. The former Talent and
  // Development modules held the journey's ?module= entry points, which retired into the area's tabs.
  {id:'performance',workspace:'strata',labelKey:'performanceTalent'},
  {id:'performanceAdmin',workspace:'strata',labelKey:'performanceAdmin'},
  {id:'rewards',workspace:'strata',labelKey:'rewards'},
  {id:'workforceInsights',workspace:'strata',labelKey:'workforceInsights'},
];
// 'ai' (28 Oct 2026, owner): AI management's own pages, headed "AI management" in the AI Control Tower menu.
export const NAVIGATION_SECTIONS: readonly NavigationSection[] = ['mine','team','hr','ai','config'];
const modulePlacement = (module:NavigationModule,section:NavigationSection):NavigationPlacement => ({
  area:NAVIGATION_MODULES.find(item=>item.id===module)!.workspace,module,section,
});
const shared = new Set(['/','/me','/org','/tasks','/approvals','/system-testing','/assistant','/knowledge-base','/feedback']);
const system = new Set(['/admin/holidays','/admin/settings/system-labels','/admin/system-settings/approval-delegation',
  '/admin/settings/email','/admin/settings/email-templates','/admin/settings/login','/admin/settings/notifications','/admin/scheduled-actions','/admin/privacy','/admin/audit',
  '/admin/ai','/admin/users','/admin/system-explorer','/admin/system-testing','/mobile-preview','/admin/settings/dashboard']);
const peopleConfig = new Set(['/admin/organization','/admin/settings/employee-id','/admin/settings/hiring-defaults',
  '/admin/settings/movement','/admin/settings/profile-requests','/admin/settings/people-general']);
const leaveHr = new Set(['/admin/leave-config/adjustments','/admin/leave-config/data-import',
  '/admin/leave-config/generate','/admin/leave-config/earned-accrual','/admin/leave-config/balance-health',
  '/admin/leave-config/leave-credit','/leave/employee-balances']);
const PERFORMANCE_CYCLE_PATH = /^\/performance\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;
const attendanceMine = new Set(['/attendance/clock','/attendance/my-records','/attendance/my-roster',
  '/attendance/requests','/attendance/plan-ot','/attendance/request-status']);

/** Unknown destinations remain explicit so source/coverage checks can refuse incomplete placement. */
export function navigationPlacement(href:string):NavigationPlacement | undefined {
  const [path,query]=href.split('?'),params=new URLSearchParams(query);
  if(path==='/lifecycle/v9'&&['tasks','records'].includes(params.get('view')??''))return {area:'shared'};
  if(path==='/me'&&params.get('tab')==='payroll'||path==='/me/tax-relief'||path.startsWith('/me/payslip')||path==='/me/ea'||path==='/me/tp3')return modulePlacement('payroll','mine');
  if(shared.has(path)||path==='/reports'&&!params.has('cat'))return {area:'shared'};
  if(system.has(path))return {area:'system'};
  if(peopleConfig.has(path))return modulePlacement('people','config');
  if(path==='/personnel')return modulePlacement('people','mine');
  if(path.startsWith('/me/letters'))return modulePlacement('eLetter','mine');
  if(path.startsWith('/letters/settings'))return modulePlacement('eLetter','config');
  if(path.startsWith('/letters'))return modulePlacement('eLetter','hr');
  if(path==='/manage/my-team')return modulePlacement('people','team');
  if(path.startsWith('/admin/personnel')||path.startsWith('/admin/job-descriptions')||path==='/admin/notice-board')return modulePlacement('people','hr');
  if(path==='/control-tower/agents'||path.startsWith('/control-tower/agents/'))return modulePlacement('controlTower','ai');
  if(path.startsWith('/control-tower'))return modulePlacement('controlTower','hr');
  if(path.startsWith('/admin/lifecycle'))return modulePlacement('onboarding','config');
  if(path==='/me/lifecycle')return modulePlacement('onboarding','mine');
  if(path.startsWith('/lifecycle/v9'))return modulePlacement('onboarding','hr');
  if(path.startsWith('/lifecycle/onboarding')||path.startsWith('/lifecycle/requisitions'))return modulePlacement('onboarding','hr');
  if(path==='/lifecycle')return modulePlacement('onboarding','mine');
  if(path==='/leave/tracker')return modulePlacement('leave','team');
  if(leaveHr.has(path))return modulePlacement('leave','hr');
  if(path.startsWith('/admin/leave-config'))return modulePlacement('leave','config');
  if(path.startsWith('/leave'))return modulePlacement('leave','mine');
  if(attendanceMine.has(path))return modulePlacement('attendance','mine');
  if(path==='/admin/attendance/schedule-assignment')return modulePlacement('attendance','hr');
  if(path.startsWith('/admin/attendance')||path.startsWith('/admin/work-locations')||path==='/admin/card-assignment')return modulePlacement('attendance','config');
  if(path.startsWith('/attendance')||path==='/roster')return modulePlacement('attendance','hr');
  if(path==='/admin/claims/reimbursements')return modulePlacement('claims','hr');
  if(path.startsWith('/admin/claims'))return modulePlacement('claims','config');
  if(path.startsWith('/claims'))return modulePlacement('claims','mine');
  if(path.startsWith('/payroll/setup')||path.startsWith('/admin/pay-components'))return modulePlacement('payroll','config');
  if(path.startsWith('/payroll'))return modulePlacement('payroll','hr');
  // Performance admin: the cycle list (no cycle yet) and the admin area of one cycle, /performance/<cycle>/….
  if(path==='/performance'||PERFORMANCE_CYCLE_PATH.test(path))return modulePlacement('performanceAdmin','hr');
  if(path.startsWith('/performance'))return modulePlacement('performance','mine');
  if(path.startsWith('/admin/rewards'))return modulePlacement('rewards','config');
  if(path.startsWith('/rewards'))return modulePlacement('rewards','mine');
  if(path==='/analytics'||path.startsWith('/reports'))return modulePlacement('workforceInsights','hr');
  return undefined;
}

export type PlacedNavigation<T> = {destination:T;placement:NavigationPlacement};
export function placeNavigation<T extends {href:string}>(destinations:readonly T[]):{placed:PlacedNavigation<T>[];unplaced:T[]} {
  const placed:PlacedNavigation<T>[]=[],unplaced:T[]=[],seen=new Set<string>();
  for(const destination of destinations){
    if(seen.has(destination.href))continue;
    seen.add(destination.href);
    const placement=navigationPlacement(destination.href);
    if(placement)placed.push({destination,placement});else unplaced.push(destination);
  }
  return {placed,unplaced};
}

/** Longest path and then query specificity owns deep links. Shared /me must not steal My Payslips. */
export function navigationRouteOwner<T extends {href:string;exactHref?:boolean;ownedSubpaths?:string[]}>(
  pathname:string,search:string,destinations:readonly T[],
):PlacedNavigation<T> | undefined {
  const have=new URLSearchParams(search);
  return destinations.flatMap(destination=>{
    const [path,query]=destination.href.split('?'),want=new URLSearchParams(query);
    const pathMatches=path==='/'?pathname==='/':pathname===path||!destination.exactHref&&pathname.startsWith(path+'/');
    const owned=(destination.ownedSubpaths??[]).some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
    if(!owned&&(!pathMatches||[...want].some(([key,value])=>have.get(key)!==value)))return [];
    const placement=navigationPlacement(destination.href);if(!placement)return [];
    const matchedLength=owned?Math.max(...destination.ownedSubpaths!.filter(prefix=>pathname===prefix||pathname.startsWith(prefix+'/')).map(prefix=>prefix.length)):path.length;
    return [{destination,placement,score:matchedLength*1000+[...want].length*10+(owned?0:1)}];
  }).sort((a,b)=>b.score-a.score)[0];
}
