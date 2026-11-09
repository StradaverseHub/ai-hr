/** Concrete read routes only; dynamic record/workflow routes retain their seeded owner journeys. */
import assert from 'node:assert/strict';
export const aiCentreRoutes=Object.freeze(['/assistant','/policies','/assistant?view=how','/assistant?view=privacy','/assistant?view=tools']);
export const attendanceReadRoutes=Object.freeze(['/attendance','/attendance/daily']);
export const architectureHrReadRoutes=Object.freeze(['/analytics','/roster','/admin/job-descriptions']);
const aiAdminRoutes=['/assistant?view=insights','/control-tower/loops','/control-tower/loops/payroll-cycle','/control-tower/exceptions','/control-tower/readiness','/control-tower/agents','/control-tower/agents/features','/control-tower/agents/assistant','/control-tower/agents/allowances','/control-tower/agents/runs'];
export const employeeRoutes=Object.freeze([
 ...aiCentreRoutes,...attendanceReadRoutes,
 '/','/me','/claims','/leave','/attendance/individual','/me/payslip','/notices','/performance/home','/lifecycle',
 '/tasks','/org','/delegations','/leave/history','/leave/credit','/leave/credit-details','/leave/tracker',
 '/me/calendar','/me/letters','/me/notifications','/me/payroll-readiness','/me/ea','/me/tp3','/me/tax-relief',
]);
export const hrRoutes=Object.freeze([
 ...aiCentreRoutes,...aiAdminRoutes,'/',
 '/admin/personnel',...attendanceReadRoutes,'/payroll',...architectureHrReadRoutes,'/reports','/reports/employee-master','/lifecycle','/lifecycle/onboarding','/lifecycle/offboarding','/letters/register','/performance','/rewards','/system-testing','/feedback','/knowledge-base','/admin/settings/movement','/admin/security-center','/payroll/formula-builder','/payroll/formula-builder/new','/claims',
 '/personnel','/tasks','/org','/delegations','/roster/import','/roster/exceptions',
 '/letters/approval','/letters/templates','/letters/templates/new','/letters/fields','/letters/reports','/letters/settings',
 '/admin/claims','/admin/claims/forms','/admin/claims/limits','/admin/claims/mileage','/admin/claims/reimbursements',
 '/admin/notice-board','/admin/holidays','/admin/holidays/groups','/admin/settings/system-labels','/admin/settings/system-labels/profile-options','/leave/employee-balances','/leave/employee-records','/admin/locations','/admin/attendance/file-mappings','/admin/attendance/schedule',
 '/admin/rewards','/admin/rewards/shared','/rewards/approvals',
]);
export const managerRoutes=Object.freeze([
 ...aiCentreRoutes,...attendanceReadRoutes,
 '/','/approvals','/approvals/history','/performance/home','/claims','/tasks','/org','/delegations','/leave/tracker',
]);
export const routePools=Object.freeze({employee:employeeRoutes,manager:managerRoutes,companyHR:hrRoutes,groupHR:Object.freeze([...hrRoutes,'/control-tower/agents/spending','/control-tower/agents/provider','/control-tower/agents/build-list'])});
const concreteReadRoutes=new Set(Object.values(routePools).flat());
export const wholeSystemRouteCount=concreteReadRoutes.size;
/** Keep known static views distinct; discard arbitrary query values from measurement labels. */
export function readRouteForMeasurement(path){return concreteReadRoutes.has(path)?path:path.split('?')[0];}
export const additionalBrowserRoutes=Object.freeze({
 employee:[...aiCentreRoutes,'/tasks','/org','/me/calendar','/me/letters','/me/notifications','/leave/history'],
 manager:['/tasks','/delegations','/leave/tracker'],
 companyHR:['/lifecycle',...aiAdminRoutes,...architectureHrReadRoutes,'/admin/claims','/admin/attendance/schedule','/roster/import'],
 groupHR:['/lifecycle',...architectureHrReadRoutes,'/control-tower/agents/spending','/control-tower/agents/provider','/control-tower/agents/build-list','/letters/templates','/letters/settings','/admin/rewards','/admin/notice-board'],
});

const primaryActor=Object.freeze({employee:4,manager:2,companyHR:1,groupHR:0});
const origin='https://localhost:3443';
const claimsForms='/admin/claims/forms';
const claimsConfig='/admin/claims';
const usableWitness=new Map([
 ['/', 'home-card-inventory'],['/analytics','analytics-fixture-metrics'],
 ['/roster','roster-scoped-employments'],['/admin/job-descriptions','job-description-controls'],
]);
const expectedCounts=Object.freeze({employee:30,manager:16,companyHR:69,groupHR:72});
const nativeRoutes=Object.freeze(Object.entries(routePools).flatMap(([role,routes])=>
 routes.map(requested=>Object.freeze({role,actorIndex:primaryActor[role],requested,
  final:requested===claimsForms?claimsConfig:requested,redirectStatus:requested===claimsForms?308:null,
  witness:usableWitness.get(requested)??null}))));

export function nativePreflightRoutePlan(){
 for(const [role,routes]of Object.entries(routePools)){
  assert.equal(new Set(routes).size,expectedCounts[role]);
  assert.equal(routes.length,expectedCounts[role]);
  assert(additionalBrowserRoutes[role].every(route=>routes.includes(route)),'Additional rendered route lies outside the closed role union');
 }
 return nativeRoutes;
}

export function nativePreflightRouteFor(role,actorIndex,requested){
 const expected=nativeRoutes.find(row=>row.role===role&&row.actorIndex===actorIndex&&row.requested===requested);
 assert(expected,'Unreviewed native preflight actor/route pair');return expected;
}

export function assertNativeClaimsFormsRedirect(status,location){
 assert.equal(status,308,'Claims Forms requires its guarded permanent redirect');
 assert(location===claimsConfig||location===origin+claimsConfig,'Claims Forms redirect location differs');
}

/** Data adjudication only. Native route/account/failure facts come from the owned page. */
export function assertNativeRenderedVisit(row){
 assert(row&&typeof row==='object');
 assert.deepEqual(Object.keys(row).sort(),['accountObserved','actorIndex','elapsedMs','failureCount','final','readiness','redirectStatus','requested','role','status','witness']);
 const expected=nativePreflightRouteFor(row.role,row.actorIndex,row.requested);
 assert.equal(row.final,expected.final,'Native preflight final route or query differs');
 assert.equal(row.redirectStatus,expected.redirectStatus,'Native preflight redirect chain differs');
 assert.equal(row.status,200);assert.equal(row.accountObserved,true);assert.equal(row.failureCount,0);
 assert(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0&&row.elapsedMs<=90000,'Native rendered-route deadline exceeded');
 assert.equal(row.witness,expected.witness,'Native preflight usable-content witness differs');
 assert.equal(row.readiness,expected.witness?'usable-content':'rendered-only','Native preflight readiness exceeds observed content');
 return expected;
}

export function requireNativeRenderedUnion(rows){
 assert(Array.isArray(rows)&&rows.length===nativePreflightRoutePlan().length,'Native rendered route union incomplete');
 const seen=new Set();let usable=0;
 for(const row of rows){
  const expected=assertNativeRenderedVisit(row);assert(!seen.has(expected),'Duplicate native rendered actor/route pair');seen.add(expected);
  if(expected.witness)usable++;
 }
 return{total:seen.size,usable,renderedOnly:seen.size-usable};
}
