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
  const trail=resolveBreadcrumbTrail(c.pathname,c.search,entries,c.active,translate);
  expect(trail).not.toBeNull();
  expect(trail!.parts.flatMap(p=>p.href?[p.href]:[])).toEqual(c.expectedLinks);
  expect(trail!.parts.every(p=>p.label&&p.label!=='undefined')).toBe(true);
 });
 it('names query-selected views and keeps their page root clickable',()=>{
  const active={...entry('/payroll/transaction-view','Payroll'),label:'Transaction View'};
  const trail=resolveBreadcrumbTrail(active.href,'tab=grid',[],active,translate)!;
  expect(trail.detail).toBe(false);
  expect(trail.parts.slice(-2)).toEqual([{label:'Transaction View',href:'/payroll/transaction-view'},{label:'Transaction Detail'}]);
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
  const security={...entry('/admin/users/access','Security Center'),parentHref:'/admin/security-center'};
  expect(resolveBreadcrumbTrail('/admin/users/access','',[],security,translate)?.parts[1].href).toBe('/admin/security-center');
 });
 it('has translated ancestor labels in every shipped catalogue',()=>{
  const keys=new Set([...BREADCRUMB_FAMILIES.flatMap(f=>f.steps.map(s=>s.labelKey)),...Object.values(BREADCRUMB_VIEWS).flatMap(v=>Object.values(v.labels)),'payrollConfig.colCompany']);
  for(const file of readdirSync(new URL('../messages',import.meta.url)).filter(f=>f.endsWith('.json'))){
   const messages=JSON.parse(readFileSync(new URL('../messages/'+file,import.meta.url),'utf8'));
   for(const key of keys)expect(key.split('.').reduce((v,k)=>v?.[k],messages),file+':'+key).toBeTypeOf('string');
  }
 });
});
