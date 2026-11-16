/** Presentation ancestry only; callers supply the viewer's already-admitted navigation rows. */
export type BreadcrumbEntry = {href:string;label:string;section:string|null;parent:string|null;parentHref:string|null};
type Step = {href:string;labelKey:string};
type Family = {path:string;owner:string;steps:readonly Step[];preserve?:readonly string[]};
const settings:Step={href:'/payroll/setup',labelKey:'nav.payrollSettings'};
const transactions:Step={href:'/payroll/transactions',labelKey:'nav.payrollTransactions'};
const attendance:Step={href:'/admin/attendance/settings',labelKey:'nav.attendanceSettingsPage'};
const people:Step={href:'/admin/settings/people',labelKey:'nav.peopleSettings'};
const setup=(path:string,labelKey:string):Family=>({path,owner:settings.href,steps:[settings,{href:path,labelKey}]});
const attendanceList=(path:string,labelKey:string):Family=>({path,owner:attendance.href,steps:[attendance,{href:path,labelKey}]});
const peopleList=(path:string,labelKey:string):Family=>({path,owner:people.href,steps:[people,{href:path,labelKey}]});
// Explicit task parents: URL prefix alone cannot relate /admin/payroll-config to /payroll/setup,
// nor distinguish the Shift list /admin/attendance from its sibling Schedule and Mapping lists.
export const BREADCRUMB_FAMILIES:readonly Family[]=[
 setup('/admin/payroll-config','payroll.setup.schedule.title'),
 setup('/admin/payroll-cycle','payroll.setup.cycles.title'),
 setup('/admin/pay-components','payroll.setup.items.title'),
 setup('/admin/payroll-policy','payroll.setup.payrollPolicies.title'),
 setup('/payroll/formula-builder','payroll.setup.formulaBuilder.title'),
 setup('/payroll/income-tax-recalculation','payroll.setup.incomeTaxRecalculation.title'),
 setup('/payroll/configuration','payroll.setup.statutory.title'),
 setup('/payroll/payslip-information','payroll.setup.payslipInformation.title'),
 {path:'/admin/loans',owner:transactions.href,steps:[transactions,{href:'/admin/loans',labelKey:'loans.title'}],preserve:['employmentId']},
 {path:'/payroll/history-import',owner:transactions.href,steps:[transactions,{href:'/payroll/history-import',labelKey:'payroll.historyImport.title'}],preserve:['companyId']},
 {path:'/payroll/history-import/logs',owner:transactions.href,steps:[transactions,{href:'/payroll/history-import',labelKey:'payroll.historyImport.title'},{href:'/payroll/history-import/logs',labelKey:'payroll.historyRevisions.logFile'}],preserve:['companyId']},
 {path:'/payroll/transactions/individual/imports',owner:transactions.href,steps:[transactions,{href:'/payroll/transactions/individual',labelKey:'payroll.transactions.individual.title'},{href:'/payroll/transactions/individual/imports',labelKey:'payroll.individualImport.log'}],preserve:['employmentId','companyId']},
 attendanceList('/admin/attendance','attendanceSettingsHub.shift.title'),
 attendanceList('/admin/attendance/file-mappings','attendanceSettingsHub.fileMapping.title'),
 attendanceList('/admin/attendance/schedule','attendanceSettingsHub.schedule.title'),
 attendanceList('/admin/attendance-allowance','attendanceSettingsHub.allowance.title'),
 attendanceList('/admin/work-locations/clocking','attendanceSettingsHub.locations.title'),
 // Pages inside the settings hub are siblings of Shift, not children of it.
 {path:'/admin/attendance/settings',owner:attendance.href,steps:[attendance]},
 {path:'/admin/attendance/approval-workflow',owner:attendance.href,steps:[attendance]},
 peopleList('/admin/settings/hiring-defaults','nav.hiringDefaults'),
 peopleList('/admin/settings/movement','nav.movementSettings'),
 peopleList('/admin/settings/system-labels','nav.systemLabels'),
 peopleList('/admin/settings/profile-requests','nav.profileRequestSettings'),
 {path:'/reports/employee-master',owner:'/reports',steps:[{href:'/reports',labelKey:'nav.reports'},{href:'/reports/employee-master',labelKey:'employeeMasterReports.title'}]},
 {path:'/reports/builder',owner:'/reports',steps:[{href:'/reports',labelKey:'nav.reports'}]},
];
export type BreadcrumbPart={label:string;href?:string};
export type BreadcrumbTrail={parts:BreadcrumbPart[];detail:boolean};
const beneath=(path:string,parent:string)=>path===parent||path.startsWith(parent+'/');
/** A hidden owner never becomes visible through breadcrumb metadata. Group headings without a landing stay text. */
export function resolveBreadcrumbTrail(pathname:string,search:string,entries:readonly BreadcrumbEntry[],active:BreadcrumbEntry|null,translate:(key:string)=>string):BreadcrumbTrail|null {
 const family=BREADCRUMB_FAMILIES.filter(f=>beneath(pathname,f.path)).sort((a,b)=>b.path.length-a.path.length)[0];
 const owner=family&&entries.find(e=>e.href.split('?')[0]===family.owner);
 if(family&&owner){
  const params=new URLSearchParams(search);
  const parts:BreadcrumbPart[]=[];
  if(owner.section)parts.push({label:owner.section});
  if(owner.parent&&owner.parent!==owner.section)parts.push({label:owner.parent});
  const currentIndex=family.steps.findIndex(step=>step.href===pathname);
  const steps=currentIndex>=0?family.steps.slice(0,currentIndex+1):family.steps;
  for(const step of steps){
   const query=new URLSearchParams();
   if(step.href!==family.owner)for(const key of family.preserve??[]){const value=params.get(key);if(value)query.set(key,value);}
   parts.push({label:translate(step.labelKey),...(step.href!==pathname?{href:step.href+(query.size?'?'+query.toString():'')}:{})});
  }
  return {parts,detail:currentIndex<0};
 }
 if(family||!active)return null;
 const parts:BreadcrumbPart[]=[];
 if(active.section)parts.push({label:active.section});
 if(active.parent&&active.parent!==active.section)parts.push({label:active.parent,...(active.parentHref&&active.parentHref.split('?')[0]!==pathname?{href:active.parentHref}:{})});
 const activePath=active.href.split('?')[0];
 const detail=pathname!==activePath&&!(activePath==='/admin/rewards/shared'&&pathname==='/admin/rewards/plans');
 parts.push({label:active.label,...(detail?{href:active.href}:{})});
 return {parts,detail};
}
