import {describe,it,expect} from 'vitest';
import {resolveBreadcrumbTrail,type BreadcrumbEntry,BREADCRUMB_FAMILIES,BREADCRUMB_VIEWS} from '../lib/navigation/breadcrumbs';
import cases from './fixtures/breadcrumb-audit-82.json';
import en from '../messages/en.json';
import {readFileSync,readdirSync} from 'node:fs';
const entry=(href:string,parent:string|null=null):BreadcrumbEntry=>({href,label:href,section:'Ops',parent,parentHref:null});
const entries=[entry('/payroll/setup','Payroll'),entry('/payroll/transactions','Payroll'),entry('/admin/attendance/settings','Attendance'),entry('/admin/settings/people','People'),entry('/reports')];
const translate=(key:string)=>key.split('.').reduce((v,k)=>v[k],en as any) as string;

describe('audited breadcrumb journeys',()=>{
 it.each(cases)('$auditEntry has its explicit task ancestry without a first-child module link',c=>{
  const recordId='00000000-0000-4000-8000-000000000082';
  const trail=resolveBreadcrumbTrail(c.pathname.replaceAll(':id',recordId),c.search,entries,{...c.active,href:c.active.href.replaceAll(':id',recordId)},translate);
  expect(trail).not.toBeNull();
  expect(trail!.parts.flatMap(p=>p.href?[p.href.replaceAll(recordId,':id')]:[])).toEqual(c.expectedLinks);
  expect(trail!.parts.every(p=>p.label&&p.label!=='undefined')).toBe(true);
 });
 it('names the Termination Reasons subpage instead of repeating the Movement Settings heading',()=>{
  const trail=resolveBreadcrumbTrail('/admin/settings/movement/reasons','',entries,null,translate)!;
  expect(trail.detail).toBe(false);expect(trail.parts.at(-1)).toEqual({label:'Termination Reasons'});
 });
 it('names query-selected views and keeps their page root clickable',()=>{
  const active={...entry('/payroll/transaction-view','Payroll'),label:'Transaction View'};
  const trail=resolveBreadcrumbTrail(active.href,'tab=grid',[],active,translate)!;
  expect(trail.detail).toBe(false);
  expect(trail.parts.slice(-2)).toEqual([{label:'Transaction View',href:'/payroll/transaction-view'},{label:'Transaction Detail'}]);
 });
 it('keeps Schedule Assignment and its bulk form under their HR entry rather than Shift settings',()=>{
  const active={...entry('/admin/attendance/schedule-assignment','Attendance'),label:'Schedule Assignment'};
  const root=resolveBreadcrumbTrail(active.href,'',[...entries,active],active,translate)!;
  expect(root.parts.filter(p=>p.href)).toEqual([]);expect(root.parts.at(-1)?.label).toBe('Schedule Assignment');
  const bulk=resolveBreadcrumbTrail(active.href+'/bulk','',[...entries,active],active,translate)!;
  expect(bulk.detail).toBe(true);
  expect(bulk.parts.filter(p=>p.href).map(p=>p.href)).toEqual(['/admin/attendance/schedule-assignment']);
 });
 it('preserves the selected loan employee while dropping unrelated query controls',()=>{
  const trail=resolveBreadcrumbTrail('/admin/loans/record','employmentId=fictional&error=private&q=ignored',entries,null,translate)!;
  expect(trail.parts.filter(p=>p.href).map(p=>p.href)).toEqual(['/payroll/transactions','/admin/loans?employmentId=fictional']);
 });
 it('does not expose an ancestor when its admitted owner is absent',()=>{
  expect(resolveBreadcrumbTrail('/admin/payroll-config/record/edit','',[],entry('/payroll'),translate)).toBeNull();
  expect(resolveBreadcrumbTrail('/reports/employee-master/new','',[],null,translate)).toBeNull();
 });
 it('uses a current text crumb on a task list and the record heading below it',()=>{
  const list=resolveBreadcrumbTrail('/payroll/formula-builder','',entries,null,translate)!;
  expect(list.detail).toBe(false);expect(list.parts.at(-1)).toEqual({label:'Pay Formula Builder'});
  const record=resolveBreadcrumbTrail('/payroll/formula-builder/record','view=1',entries,null,translate)!;
  expect(record.detail).toBe(true);expect(record.parts.at(-1)?.href).toBe('/payroll/formula-builder');
 });
 it('keeps explicit landing pages clickable and suppresses duplicate group labels',()=>{
  const active={...entry('/admin/holidays'),section:'System Configuration',parent:'System Configuration'};
  expect(resolveBreadcrumbTrail('/admin/holidays','',[],active,translate)?.parts.map(p=>p.label)).toEqual(['System Configuration','/admin/holidays']);
  // Board 8fa0a31d (revision 2) — a Security Center page is a child of the Security Center module row, which has no
  // section heading; the module crumb links to its breadcrumb-only admitted overview landing. The overview itself reads
  // as one current crumb, never linking to itself.
  const security={...entry('/admin/users/access'),label:'Security & Permissions',section:null,parent:'Security Center',parentHref:'/admin/security-center'};
  expect(resolveBreadcrumbTrail('/admin/users/access','',[],security,translate)?.parts).toEqual([
   {label:'Security Center',href:'/admin/security-center'},{label:'Security & Permissions'},
  ]);
  const landing={href:'/admin/security-center',label:'Security Center',section:null,parent:null,parentHref:null};
  expect(resolveBreadcrumbTrail('/admin/security-center','',[],landing,translate)?.parts).toEqual([{label:'Security Center'}]);
  // A module without an admitted landing (System Configuration, or a viewer who may not open the overview) is text.
  const unadmitted={...security,parentHref:null};
  expect(resolveBreadcrumbTrail('/admin/users/access','',[],unadmitted,translate)?.parts[0]).toEqual({label:'Security Center'});
  expect(resolveBreadcrumbTrail('/admin/users/access','',[],{...security,parentHref:'/admin/users/access'},translate)?.parts[0]).toEqual({label:'Security Center'});
  const system={...entry('/admin/holidays'),section:null,parent:'System Configuration',parentHref:null};
  expect(resolveBreadcrumbTrail('/admin/holidays','',[],system,translate)?.parts).toEqual([{label:'System Configuration'},{label:'/admin/holidays'}]);
 });
 it('has translated ancestor labels in every shipped catalogue',()=>{
  const keys=new Set([...BREADCRUMB_FAMILIES.flatMap(f=>f.steps.map(s=>s.labelKey)),...Object.values(BREADCRUMB_VIEWS).flatMap(v=>Object.values(v.labels)),'payrollConfig.colCompany']);
  for(const file of readdirSync(new URL('../messages',import.meta.url)).filter(f=>f.endsWith('.json'))){
   const messages=JSON.parse(readFileSync(new URL('../messages/'+file,import.meta.url),'utf8'));
   for(const key of keys)expect(key.split('.').reduce((v,k)=>v?.[k],messages),file+':'+key).toBeTypeOf('string');
  }
 });
});
