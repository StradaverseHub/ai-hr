/** Concrete read routes only; dynamic record/workflow routes retain their seeded owner journeys. */
export const aiCentreRoutes=Object.freeze(['/assistant','/policies','/assistant?view=how','/assistant?view=privacy','/assistant?view=tools']);
const aiAdminRoutes=['/assistant?view=insights','/control-tower/loops','/control-tower/loops/payroll-cycle','/control-tower/exceptions','/control-tower/readiness','/control-tower/agents','/control-tower/agents/features','/control-tower/agents/assistant','/control-tower/agents/allowances','/control-tower/agents/runs'];
export const employeeRoutes=Object.freeze([
 ...aiCentreRoutes,
 '/','/me','/claims','/leave','/attendance/individual','/me/payslip','/notices','/performance/home','/lifecycle',
 '/tasks','/org','/delegations','/leave/history','/leave/credit','/leave/credit-details','/leave/tracker',
 '/me/calendar','/me/letters','/me/notifications','/me/payroll-readiness','/me/ea','/me/tp3','/me/tax-relief',
]);
export const hrRoutes=Object.freeze([
 ...aiCentreRoutes,...aiAdminRoutes,'/',
 '/admin/personnel','/attendance','/payroll','/reports','/reports/employee-master','/lifecycle','/lifecycle/onboarding','/lifecycle/offboarding','/roster','/letters/register','/performance','/rewards','/system-testing','/feedback','/knowledge-base','/admin/settings/movement','/admin/security-center','/payroll/formula-builder','/payroll/formula-builder/new','/claims',
 '/personnel','/tasks','/org','/delegations','/roster/import','/roster/exceptions',
 '/letters/approval','/letters/templates','/letters/templates/new','/letters/fields','/letters/reports','/letters/settings',
 '/admin/claims','/admin/claims/forms','/admin/claims/limits','/admin/claims/mileage','/admin/claims/reimbursements',
 '/admin/notice-board','/admin/holidays','/admin/locations','/admin/attendance/file-mappings','/admin/attendance/schedule',
 '/admin/rewards','/admin/rewards/shared','/rewards/approvals',
]);
export const managerRoutes=Object.freeze([
 ...aiCentreRoutes,
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
 companyHR:['/lifecycle',...aiAdminRoutes,'/admin/claims','/admin/attendance/schedule','/roster/import'],
 groupHR:['/lifecycle','/control-tower/agents/spending','/control-tower/agents/provider','/control-tower/agents/build-list','/letters/templates','/letters/settings','/admin/rewards','/admin/notice-board'],
});
