/** ADR-0169 phase B — server-side product destination registry for the Assistant context layer.
 *
 * Composes the SAME sources the sidebar composes (module pack navigation, V9 lifecycle navigation,
 * Security Center pages) plus the sidebar's own literal rows, so the Assistant can name real places in
 * the product without reading source code. Presentation only: it grants nothing. Every destination keeps
 * its own route guard, and the sidebar's runtime gates (module entitlement, lifecycle and security
 * availability) remain authoritative; `audience` here is a coarse role hint for wording.
 * `test/product-context-destinations.test.ts` fails when the sidebar gains a row this registry lacks,
 * or when a destination is not a real page or has no label. Not imported by the production Assistant
 * (outside the provider privacy closure until ADR-0169 §5.1 review passes). */
import '@/packs/register-all';
import {listPacks,type ModulePack,type NavChildDescriptor} from '@/packs/registry';
import {V9_NAVIGATION} from '@/lib/lifecycle-v9-navigation';
import {SECURITY_CENTER,SECURITY_PAGES} from '@/lib/security-center-navigation';
import {isAdmin,hasTeamAccess} from '@/lib/authz-model';
import {MODULE_CODES_WITH_NAV} from '@/lib/nav-entitlements';
import type {SessionContext} from '@/db/client';

export type DestinationAudience='everyone'|'manager'|'admin';
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
