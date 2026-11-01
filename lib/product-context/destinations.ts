/** ADR-0169 phase B — server-side product destination registry for the Assistant context layer.
 *
 * Composes the SAME sources the sidebar composes (module pack navigation, V9 lifecycle navigation,
 * Security Center pages) plus the sidebar's own literal rows, so the Assistant can name real places in
 * the product without reading source code. Presentation only: it grants nothing. Every destination keeps
 * its own route guard, and the sidebar's runtime gates (module entitlement, lifecycle and security
 * availability) remain authoritative; `audience` here is a coarse role hint for wording.
 * `test/product-context-destinations.test.ts` fails when the sidebar gains a row this registry lacks,
 * or when a destination is not a real page or has no label. Not imported by the production Assistant
 * (outside the provider privacy closure until ADR-0169 §5.1 review passes).
 *
 * ADR-0170 step 4 adds LINKABLE PAGES: every real static page a role may open, so a reply may link a page the
 * sidebar does not list (run 41302596155 retried a reply that linked /admin/payroll-cycle). They are link
 * targets only, never listed to the model (product_destinations stays the labelled sidebar set). The index is
 * derived by `classifyPage` from each page's own route guard and frozen below; test/setup-copilot-destinations
 * re-derives it from app/ and fails on drift. */
import '@/packs/register-all';
import {listPacks,type ModulePack,type NavChildDescriptor} from '@/packs/registry';
import {V9_NAVIGATION} from '@/lib/lifecycle-v9-navigation';
import {SECURITY_CENTER,SECURITY_PAGES} from '@/lib/security-center-navigation';
import {isAdmin,hasTeamAccess} from '@/lib/authz-model';
import {MODULE_CODES_WITH_NAV} from '@/lib/nav-entitlements';
import type {SessionContext} from '@/db/client';

export type DestinationAudience='everyone'|'manager'|'admin';
/** What a destination is for, where its label alone could mislead (review B3: the model sent a harassment report to
 * Feedback, the product feedback board read by the software team). Shown to the model beside the label. */
export const DESTINATION_PURPOSE:Readonly<Record<string,string>>=Object.freeze({
 '/feedback':'Product feedback to the software team about this application: problems, ideas and new functions. Never for workplace concerns, complaints about people or personal matters; those go to the person\'s HR team.',
 // Review M16 (run 41343676782, pp-scope-2): a payroll partner asking for the October payroll summary was sent here.
 // Payroll runs and their reports are on the payroll pages, which only HR administrators open (scopedAdmin).
 '/me/payslip':'The signed-in person\'s own released payslips only. Never a payroll run, a payroll summary, a company report or anyone else\'s pay.',
});
export type ProductDestination=Readonly<{href:string;labelKey:string;audience:DestinationAudience;module:string|null;source:'pack'|'lifecycle_v9'|'security'|'sidebar'}>;

// The sidebar's own literal rows (components/sidebar.tsx GROUPS, node children and additional rows),
// with the audience its group/row flags give them. Pack-, V9- and security-owned rows come from their owners.
const SIDEBAR:readonly (readonly [string,string,DestinationAudience,string|null])[]=[
 ['/','dashboard','everyone',null],['/me','myWorkspace','everyone',null],['/system-testing','mySystemTesting','everyone','system_testing'],
 ['/org','orgChart','everyone',null],['/feedback','feedback','everyone',null],['/assistant','assistant','everyone','assistant'],
 ['/knowledge-base','knowledgeBase','everyone',null],['/mobile-preview','mobilePreview','admin',null],['/tasks','myTasks','everyone',null],
 ['/personnel','people','everyone','employees'],['/approvals','approvals','manager',null],
 ['/me/payslip','myPayslips','everyone','payroll'],['/me/letters','myLetters','everyone','employees'],['/me/tax-relief','taxRelief','everyone','payroll'],
 ['/me/tp3','myTp3','everyone','payroll'],['/me/ea','myEa','everyone','payroll'],
 ['/admin/personnel','personnelAdmin','admin','employees'],['/admin/job-descriptions','jobDescriptions','admin',null],
 ['/admin/personnel/profile-changes','profileChanges','admin','employees'],['/admin/claims/reimbursements','reimbursementsDue','admin','claims'],
 ['/admin/organization','organization','admin',null],['/admin/notice-board','noticeBoard','admin',null],['/analytics','analytics','admin',null],
 ['/admin/audit','auditTrail','admin',null],['/reports','reports','admin',null],
 ['/control-tower','controlTowerOverview','admin',null],['/control-tower/readiness','controlTowerReadiness','admin',null],
 ['/control-tower/exceptions','controlTowerExceptions','admin',null],['/control-tower/actions','controlTowerActions','admin',null],
 ['/control-tower/opportunities','controlTowerOpportunities','admin',null],['/control-tower/how-it-works','controlTowerHow','admin',null],
 ['/control-tower/agents/inventory','aiManagementInventory','admin',null],['/control-tower/agents','aiManagementOverview','admin',null],
 ['/control-tower/agents/provider','aiManagementProvider','admin',null],['/control-tower/agents/assistant','aiManagementAssistant','admin',null],
 ['/control-tower/agents/features','aiManagementFeatures','admin',null],['/control-tower/agents/allowances','aiManagementAllowances','admin',null],
 ['/control-tower/agents/spending','aiManagementSpending','admin',null],['/control-tower/agents/orchestrator','aiManagementOrchestrator','admin',null],
 ['/control-tower/agents/runs','aiManagementRuns','admin',null],
 ['/reports?cat=master','reportMaster','admin',null],['/reports?cat=attendance','reportAttendance','admin',null],['/reports?cat=leave','reportLeave','admin',null],
 ['/reports?cat=payroll','reportPayroll','admin',null],['/reports?cat=claim','reportClaim','admin',null],['/reports?cat=performance','reportPerformance','admin',null],
 ['/admin/settings/employee-id','employeeIdConfig','admin',null],['/admin/settings/people-general','peopleGeneral','admin',null],
 ['/admin/settings/dashboard','dashboardCardConfig','admin',null],['/admin/settings/system-labels','systemLabels','admin',null],
 ['/admin/system-settings/approval-delegation','delegations','admin',null],['/admin/settings/movement','movementSettings','admin',null],
 ['/admin/settings/hiring-defaults','hiringDefaults','admin',null],['/admin/holidays','holidays','admin',null],
 ['/admin/settings/profile-requests','profileRequestSettings','admin',null],['/admin/settings/login','loginPresentation','admin',null],
 ['/admin/settings/email','identityEmail','admin',null],['/admin/settings/email-templates','emailTemplates','admin',null],
 ['/admin/settings/notifications','workflowEmail','admin',null],['/admin/scheduled-actions','scheduledActions','admin',null],
 ['/admin/privacy','dataPrivacy','admin',null],['/admin/system-explorer','systemExplorer','admin','system_explorer'],
 ['/admin/system-testing','systemTesting','admin','system_testing'],
];
const groupAudience=(group:'main'|'manage'|'admin'):DestinationAudience=>group==='admin'?'admin':group==='manage'?'manager':'everyone';
const rowAudience=(row:NavChildDescriptor,fallback:DestinationAudience):DestinationAudience=>row.adminOnly?'admin':row.managerUp&&fallback==='everyone'?'manager':fallback;
function packDestinations(pack:ModulePack):ProductDestination[]{
 const rows:ProductDestination[]=[];
 for(const node of pack.navNodes??[])for(const child of node.children)rows.push({href:child.href,labelKey:child.labelKey,audience:rowAudience(child,groupAudience(node.group)),module:pack.id,source:'pack'});
 for(const link of pack.navLinks??[])rows.push({href:link.href,labelKey:link.labelKey,audience:rowAudience(link,groupAudience(link.group)),module:pack.id,source:'pack'});
 return rows;
}
let cached:readonly ProductDestination[]|undefined;
/** Every product destination, deduplicated by href (first owner wins: pack, V9, security, then sidebar). */
export function productDestinations():readonly ProductDestination[]{
 if(cached)return cached;
 const all:ProductDestination[]=[
  ...listPacks('module').flatMap(pack=>packDestinations(pack as ModulePack)),
  ...V9_NAVIGATION.map(row=>({href:row.href,labelKey:row.labelKey,audience:'admin' as const,module:'lifecycle',source:'lifecycle_v9' as const})),
  {href:SECURITY_CENTER,labelKey:'securityCenter',audience:'admin',module:null,source:'security'},
  ...SECURITY_PAGES.map(row=>({href:row.href,labelKey:row.navKey,audience:'admin' as const,module:null,source:'security' as const})),
  ...SIDEBAR.map(([href,labelKey,audience,module])=>({href,labelKey,audience,module,source:'sidebar' as const})),
 ];
 const seen=new Set<string>();
 cached=Object.freeze(all.filter(row=>!seen.has(row.href)&&seen.add(row.href)).map(row=>Object.freeze(row)));
 return cached;
}
const NAV_GATED:ReadonlySet<string>=new Set(MODULE_CODES_WITH_NAV);
/** Destinations whose coarse audience fits this caller. `visibleModules` is the sidebar's own module
 * visibility (lib/nav-entitlements); it filters only modules the sidebar gates. Advisory: the page guard decides. */
export function destinationsFor(ctx:SessionContext,visibleModules?:readonly string[]):readonly ProductDestination[]{
 const admin=isAdmin(ctx),manager=admin||hasTeamAccess(ctx);
 return productDestinations().filter(row=>(row.audience==='everyone'||(row.audience==='manager'&&manager)||(row.audience==='admin'&&admin))
  &&(row.module===null||visibleModules===undefined||!NAV_GATED.has(row.module)||visibleModules.includes(row.module)));
}

/** ADR-0170 step 4 — who may open a page, from its route and its own guard call (page plus its layouts below
 * app/). Advisory like the rest of this file: a page that checks permission inside its reads is classed by its
 * outer guard, so a link can still land on that page's refusal. Pure; the drift test feeds it the source. */
const ADMIN_GUARD=/\b(requireAdmin|scopedAdmin|requireConfigSection|requirePayrollAccess|requireGroupAdministration|requireSecurityCenter|requireOnehrAdminAccess|requireIdentityEmailAdmin|requireAccessConfiguration|requireWorkforceAccess)\(/;
/** Areas that are administrator work whatever their guard; review routes are linked only through a suggestion;
 * sign-in and operator pages are not destinations. */
const ADMIN_AREAS=['/admin','/control-tower','/payroll','/letters','/reports','/analytics'],NOT_LINKABLE=['/assistant','/login','/reset-password','/operator','/mobile-preview'];
const AREA_MODULE:Readonly<Record<string,string>>={'/attendance':'attendance','/roster':'attendance','/leave':'leave','/claims':'claims','/performance':'performance','/payroll':'payroll','/lifecycle':'lifecycle','/rewards':'rewards','/letters':'employees'};
const under=(route:string,area:string)=>route===area||route.startsWith(area+'/');
export function classifyPage(route:string,source:string):Readonly<{audience:DestinationAudience;module:string|null}>|null{
 if(NOT_LINKABLE.some(area=>under(route,area)))return null;
 const area=Object.keys(AREA_MODULE).find(prefix=>under(route,prefix)),module=source.match(/requireModule\(\s*'([a-z_-]+)'/)?.[1]??(area?AREA_MODULE[area]:null);
 if(ADMIN_AREAS.some(prefix=>under(route,prefix))||ADMIN_GUARD.test(source)||(/\bisAdmin\(/.test(source)&&/\b(redirect|notFound|forbidden)\(/.test(source)))return{audience:'admin',module};
 if(/\brequireTeamAccess\(/.test(source))return{audience:'manager',module};
 return /\b(scopedSession|requireModule|requireSession|getSession)\(/.test(source)?{audience:'everyone',module}:null;
}
/** GENERATED by classifyPage over every static app/ page (test/setup-copilot-destinations.test.ts pins it):
 * [path, audience, module]. Pages the classifier cannot place are not linkable. */
type PageRow=readonly [string,DestinationAudience,string|null];
export const LINKABLE_PAGES:readonly PageRow[]=Object.freeze(([
 ['/','admin',null],['/admin','admin',null],['/admin/ai','admin',null],['/admin/attendance','admin',null],
 ['/admin/attendance-allowance','admin',null],['/admin/attendance-allowance/new','admin',null],['/admin/attendance-policy','admin',null],
 ['/admin/attendance-policy/rules/new','admin',null],['/admin/attendance-policy/schedule','admin',null],
 ['/admin/attendance/approval-workflow','admin',null],['/admin/attendance/approval-workflow/new','admin',null],
 ['/admin/attendance/file-mappings','admin',null],['/admin/attendance/file-mappings/new','admin',null],['/admin/attendance/new','admin',null],
 ['/admin/attendance/schedule','admin',null],['/admin/attendance/schedule-assignment','admin',null],
 ['/admin/attendance/schedule-assignment/bulk','admin',null],['/admin/attendance/schedule/new','admin',null],
 ['/admin/attendance/settings','admin',null],['/admin/attendance/settings/company-policy','admin',null],
 ['/admin/attendance/settings/overtime-patterns','admin',null],['/admin/attendance/settings/registered-devices','admin',null],
 ['/admin/attendance/settings/work-schedule-overtime','admin',null],['/admin/audit','admin',null],['/admin/card-assignment','admin','attendance'],
 ['/admin/claims','admin',null],['/admin/claims/forms','admin',null],['/admin/claims/limits','admin',null],['/admin/claims/mileage','admin',null],
 ['/admin/claims/reimbursements','admin',null],['/admin/holidays','admin',null],['/admin/holidays/groups','admin',null],
 ['/admin/holidays/groups/new','admin',null],['/admin/holidays/replacements','admin',null],['/admin/job-descriptions','admin',null],
 ['/admin/job-descriptions/configuration','admin',null],['/admin/job-descriptions/new','admin',null],['/admin/leave','admin',null],
 ['/admin/leave-approval','admin',null],['/admin/leave-config/adjustments','admin',null],['/admin/leave-config/approval-chains','admin',null],
 ['/admin/leave-config/balance-health','admin',null],['/admin/leave-config/bf-import','admin',null],
 ['/admin/leave-config/company-rules','admin',null],['/admin/leave-config/data-import','admin',null],
 ['/admin/leave-config/earned-accrual','admin',null],['/admin/leave-config/entitlement-tables','admin',null],
 ['/admin/leave-config/generate','admin',null],['/admin/leave-config/history-import','admin',null],['/admin/leave-config/import','admin',null],
 ['/admin/leave-config/leave-credit','admin',null],['/admin/leave-config/leave-credit/rules','admin','toil'],
 ['/admin/leave-config/records','admin',null],['/admin/leave-config/records/balances','admin',null],
 ['/admin/leave-config/records/entitlement','admin',null],['/admin/leave-config/settings','admin',null],
 ['/admin/leave-config/special-setting','admin',null],['/admin/leave-config/types','admin',null],['/admin/leave/adjustments','admin',null],
 ['/admin/leave/application-rules','admin',null],['/admin/leave/approval','admin',null],['/admin/leave/audit','admin',null],
 ['/admin/leave/entitlements','admin',null],['/admin/leave/entitlements/archive','admin',null],
 ['/admin/leave/entitlements/ledger-archive','admin',null],['/admin/leave/entitlements/templates','admin',null],
 ['/admin/leave/generate','admin',null],['/admin/leave/import','admin',null],['/admin/leave/payroll','admin',null],
 ['/admin/leave/replacement','admin',null],['/admin/lifecycle','admin','lifecycle'],['/admin/lifecycle/onboarding','admin','lifecycle'],
 ['/admin/lifecycle/onboarding/access','admin','lifecycle'],['/admin/lifecycle/onboarding/groups','admin','lifecycle'],['/admin/loans','admin',null],
 ['/admin/loans/new','admin',null],['/admin/locations','admin',null],['/admin/locations/clocking/new','admin',null],
 ['/admin/notice-board','admin',null],['/admin/notice-board/new','admin',null],['/admin/organization','admin',null],
 ['/admin/organization/new','admin',null],['/admin/pay-components','admin',null],['/admin/pay-components/new','admin',null],
 ['/admin/payroll-config','admin',null],['/admin/payroll-cycle','admin',null],['/admin/payroll-permissions','admin',null],
 ['/admin/payroll-policy','admin',null],['/admin/personnel','admin',null],['/admin/personnel/child-relief','admin',null],
 ['/admin/personnel/duplicates','admin',null],['/admin/personnel/import','admin',null],['/admin/personnel/import/history','admin',null],
 ['/admin/personnel/new','admin',null],['/admin/personnel/profile-changes','admin',null],['/admin/personnel/settings','admin',null],
 ['/admin/privacy','admin',null],['/admin/rewards','admin','rewards'],['/admin/rewards/access','admin','rewards'],
 ['/admin/rewards/shared','admin','rewards'],['/admin/scheduled-actions','admin',null],['/admin/security-center','admin',null],
 ['/admin/settings','admin',null],['/admin/settings/dashboard','admin',null],['/admin/settings/email','admin',null],
 ['/admin/settings/email-templates','admin',null],['/admin/settings/employee-id','admin',null],['/admin/settings/hiring-defaults','admin',null],
 ['/admin/settings/login','admin',null],['/admin/settings/movement','admin',null],['/admin/settings/movement/reasons','admin',null],
 ['/admin/settings/movement/types/new','admin',null],['/admin/settings/notifications','admin','notifications'],
 ['/admin/settings/people-general','admin',null],['/admin/settings/profile-options','admin',null],['/admin/settings/profile-requests','admin',null],
 ['/admin/settings/profile-requests/rules','admin',null],['/admin/settings/system-labels','admin',null],
 ['/admin/settings/system-labels/profile-options','admin',null],['/admin/system-explorer','admin','system_explorer'],
 ['/admin/system-settings/approval-delegation','admin',null],['/admin/system-testing','admin','system_testing'],
 ['/admin/system-testing/new','admin','system_testing'],['/admin/toil','admin',null],['/admin/users','admin',null],
 ['/admin/users/access','admin',null],['/admin/users/create','admin',null],['/admin/users/function-access','admin',null],
 ['/admin/users/invite','admin',null],['/admin/work-locations','admin',null],['/admin/work-locations/clocking','admin',null],
 ['/admin/work-locations/clocking/new','admin',null],['/admin/work-locations/new','admin',null],['/analytics','admin',null],
 ['/approvals','admin',null],['/approvals/history','admin',null],['/attendance','everyone','attendance'],
 ['/attendance/application-history','admin','attendance'],['/attendance/application-history/visible','everyone','attendance'],
 ['/attendance/breakdown','admin','attendance'],['/attendance/clock','everyone','attendance'],['/attendance/daily','everyone','attendance'],
 ['/attendance/import','admin','attendance'],['/attendance/import/logs','admin','attendance'],['/attendance/individual','everyone','attendance'],
 ['/attendance/my-records','everyone','attendance'],['/attendance/my-roster','everyone','attendance'],['/attendance/plan-ot','everyone','attendance'],
 ['/attendance/plan-ot/apply','everyone','attendance'],['/attendance/recompute','admin','attendance'],
 ['/attendance/request-status','everyone','attendance'],['/attendance/requests','everyone','attendance'],['/claims','everyone','claims'],
 ['/control-tower','admin',null],['/control-tower/actions','admin',null],['/control-tower/agents','admin',null],
 ['/control-tower/agents/allowances','admin',null],['/control-tower/agents/assistant','admin',null],['/control-tower/agents/features','admin',null],
 ['/control-tower/agents/inventory','admin',null],['/control-tower/agents/orchestrator','admin',null],['/control-tower/agents/provider','admin',null],
 ['/control-tower/agents/runs','admin',null],['/control-tower/agents/spending','admin',null],['/control-tower/exceptions','admin',null],
 ['/control-tower/how-it-works','admin',null],['/control-tower/opportunities','admin',null],['/control-tower/readiness','admin',null],
 ['/delegations','everyone',null],['/feedback','everyone',null],['/knowledge-base','everyone',null],['/leave','admin','leave'],
 ['/leave/credit','everyone','leave'],['/leave/credit-details','everyone','leave'],['/leave/details','everyone','leave'],
 ['/leave/employee-balances','admin','leave'],['/leave/employee-records','admin','leave'],['/leave/history','everyone','leave'],
 ['/leave/tracker','admin','leave'],['/letters/approval','admin','employees'],['/letters/fields','admin','employees'],
 ['/letters/generate','admin','employees'],['/letters/generate/new','admin','employees'],['/letters/register','admin','employees'],
 ['/letters/reports','admin','employees'],['/letters/settings','admin','employees'],['/letters/settings/automation','admin','employees'],
 ['/letters/settings/policy','admin','employees'],['/letters/templates','admin','employees'],['/letters/templates/new','admin','employees'],
 ['/lifecycle','everyone','lifecycle'],['/lifecycle/acknowledgement','everyone','lifecycle'],['/lifecycle/onboarding','everyone','lifecycle'],
 ['/lifecycle/onboarding/checklists','everyone','lifecycle'],['/lifecycle/requisitions/onboarding','everyone','lifecycle'],
 ['/lifecycle/v9','everyone','lifecycle'],['/manage/my-team','manager',null],['/me','everyone',null],['/me/calendar','everyone',null],
 ['/me/ea','everyone','payroll'],['/me/home','everyone',null],['/me/letters','everyone','employees'],['/me/lifecycle','everyone','lifecycle'],
 ['/me/notifications','everyone','notifications'],['/me/payslip','everyone','payroll'],['/me/performance','everyone',null],
 ['/me/tax-relief','everyone','payroll'],['/me/tp3','everyone','payroll'],['/notices','everyone',null],['/org','everyone',null],
 ['/payroll','admin','payroll'],['/payroll/back-pay','admin','payroll'],['/payroll/borang-8a/preview','admin','payroll'],
 ['/payroll/borang-8b/preview','admin','payroll'],['/payroll/borang-a/preview','admin','payroll'],['/payroll/borang-bbcd/preview','admin','payroll'],
 ['/payroll/configuration','admin','payroll'],['/payroll/configuration/eis','admin','payroll'],['/payroll/configuration/epf','admin','payroll'],
 ['/payroll/configuration/hrdf','admin','payroll'],['/payroll/configuration/pcb','admin','payroll'],
 ['/payroll/configuration/skbbk','admin','payroll'],['/payroll/configuration/socso','admin','payroll'],['/payroll/control-tower','admin','payroll'],
 ['/payroll/cp39/preview','admin','payroll'],['/payroll/cp8d/preview','admin','payroll'],['/payroll/formula-builder','admin','payroll'],
 ['/payroll/formula-builder/new','admin','payroll'],['/payroll/history-import','admin','payroll'],['/payroll/history-import/logs','admin','payroll'],
 ['/payroll/income-tax-recalculation','admin','payroll'],['/payroll/individual-payslip','admin','payroll'],
 ['/payroll/multi-cycle-worksheet','admin','payroll'],['/payroll/payment-submission','admin','payroll'],
 ['/payroll/payslip-information','admin','payroll'],['/payroll/pcb-detail','admin','payroll'],['/payroll/process','admin','payroll'],
 ['/payroll/process/result','admin','payroll'],['/payroll/reports','admin','payroll'],['/payroll/setup','admin','payroll'],
 ['/payroll/sip-contribution/preview','admin','payroll'],['/payroll/statutory-adjustment','admin','payroll'],
 ['/payroll/statutory-detail','admin','payroll'],['/payroll/statutory-forms','admin','payroll'],['/payroll/statutory-forms/ea','admin','payroll'],
 ['/payroll/statutory-forms/ea/view','admin','payroll'],['/payroll/statutory-forms/event','admin','payroll'],
 ['/payroll/statutory-forms/open','admin','payroll'],['/payroll/statutory-forms/pcb2ii','admin','payroll'],
 ['/payroll/statutory-forms/pcb2ii/receipts','admin','payroll'],['/payroll/statutory-forms/pcb2ii/view','admin','payroll'],
 ['/payroll/transaction-view','admin','payroll'],['/payroll/transactions','admin','payroll'],['/payroll/transactions/adjustments','admin','payroll'],
 ['/payroll/transactions/fixed','admin','payroll'],['/payroll/transactions/import-components','admin','payroll'],
 ['/payroll/transactions/individual','admin','payroll'],['/payroll/transactions/individual/imports','admin','payroll'],
 ['/payroll/transactions/tp1','admin','payroll'],['/payroll/transactions/tp1/new','admin','payroll'],['/payroll/transactions/tp3','admin','payroll'],
 ['/payroll/transactions/view','admin','payroll'],['/payroll/transactions/zakat','admin','payroll'],
 ['/payroll/transactions/zakat/election','admin','payroll'],['/performance','admin','performance'],
 ['/performance/assessments','everyone','performance'],['/performance/calibration','everyone','performance'],
 ['/performance/calibration/talent-box','everyone','performance'],['/performance/competency','everyone','performance'],
 ['/performance/competency/team','everyone','performance'],['/performance/department','everyone','performance'],
 ['/performance/feedback','everyone','performance'],['/performance/home','everyone','performance'],['/performance/leaders','admin','performance'],
 ['/performance/led','everyone','performance'],['/performance/my','everyone','performance'],['/performance/my/kpis','everyone','performance'],
 ['/performance/plan','everyone','performance'],['/performance/plan/profile','everyone','performance'],
 ['/performance/plan/team','everyone','performance'],['/performance/team','everyone','performance'],
 ['/performance/team/kpis','everyone','performance'],['/performance/workspace','everyone','performance'],['/personnel','everyone',null],
 ['/reports','admin',null],['/reports/employee-master','admin',null],['/rewards','everyone','rewards'],['/rewards/approvals','everyone','rewards'],
 ['/roster','everyone','attendance'],['/roster/exceptions','everyone','attendance'],['/roster/import','admin','attendance'],
 ['/system-testing','everyone','system_testing'],['/tasks','everyone',null],
] satisfies PageRow[]).map(row=>Object.freeze(row)));
/** Every product path this caller may link: the labelled destinations plus the linkable pages its role and
 * readable modules allow. Query strings and fragments are dropped. */
export function linkablePathsFor(ctx:SessionContext,visibleModules?:readonly string[]):readonly string[]{
 const admin=isAdmin(ctx),manager=admin||hasTeamAccess(ctx);
 const pages=LINKABLE_PAGES.filter(([,audience,module])=>(audience==='everyone'||(audience==='manager'&&manager)||(audience==='admin'&&admin))
  &&(module===null||visibleModules===undefined||!NAV_GATED.has(module)||visibleModules.includes(module))).map(([path])=>path);
 return Object.freeze([...new Set([...destinationsFor(ctx,visibleModules).map(row=>row.href.split(/[?#]/)[0]||'/'),...pages])]);
}
