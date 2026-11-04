/** Concrete read routes only; dynamic record/workflow routes retain their seeded owner journeys. */
const aiCentreRoutes=['/assistant','/assistant?view=inbox','/assistant?view=jobs','/assistant?view=how'];
const aiManagementRoutes=['/control-tower/agents','/control-tower/agents/features','/control-tower/agents/inventory','/control-tower/agents/assistant','/control-tower/agents/allowances','/control-tower/agents/spending','/control-tower/agents/runs'];
export const employeeRoutes=Object.freeze([
 ...aiCentreRoutes,
 '/','/me','/claims','/leave','/attendance/individual','/me/payslip','/notices','/performance/home','/lifecycle',
 '/tasks','/org','/delegations','/leave/history','/leave/credit','/leave/credit-details','/leave/tracker',
 '/me/calendar','/me/letters','/me/notifications','/me/ea','/me/tp3','/me/tax-relief',
]);
export const hrRoutes=Object.freeze([
 ...aiCentreRoutes,...aiManagementRoutes,
 '/admin/personnel','/attendance','/payroll','/reports','/reports/employee-master','/lifecycle/onboarding','/lifecycle/offboarding','/roster','/letters/register','/performance','/rewards','/system-testing','/feedback','/knowledge-base','/control-tower','/admin/settings/movement','/admin/security-center','/payroll/formula-builder','/payroll/formula-builder/new','/claims',
 '/people','/tasks','/org','/delegations','/roster/import','/roster/exceptions',
 '/letters/approval','/letters/templates','/letters/templates/new','/letters/fields','/letters/reports','/letters/settings',
 '/admin/claims','/admin/claims/forms','/admin/claims/limits','/admin/claims/mileage','/admin/claims/reimbursements',
 '/admin/notice-board','/admin/holidays','/admin/locations','/admin/attendance/file-mappings','/admin/attendance-policy',
 '/admin/rewards','/admin/rewards/shared','/rewards/approvals',
]);
export const managerRoutes=Object.freeze([
 ...aiCentreRoutes,
 '/','/approvals','/approvals/history','/performance/home','/claims','/tasks','/org','/delegations','/leave/tracker',
]);
export const routePools=Object.freeze({employee:employeeRoutes,manager:managerRoutes,companyHR:hrRoutes,groupHR:hrRoutes});
export const wholeSystemRouteCount=new Set(Object.values(routePools).flat()).size;
export const additionalBrowserRoutes=Object.freeze({
 employee:[...aiCentreRoutes,'/tasks','/org','/me/calendar','/me/letters','/me/notifications','/leave/history'],
 manager:['/tasks','/delegations','/leave/tracker'],
 companyHR:[...aiManagementRoutes,'/admin/claims','/admin/attendance-policy','/roster/import'],
 groupHR:['/letters/templates','/letters/settings','/admin/rewards','/admin/notice-board'],
});
