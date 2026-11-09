/** Render the real tab owners; declaration inventory alone cannot prove their wiring. */
import {expect,it,vi} from 'vitest';
import {render} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import {messagesForLocale} from '../i18n/catalogs';
import {HolidayTabs} from '../components/holiday-tabs';
import {StatutoryTabs} from '../components/statutory-tabs';
import {SystemLabelsTabs} from '../components/system-labels-tabs';
import {ClaimsTabs} from '../components/claims-tabs';
import {AttendanceTabs} from '../components/attendance-tabs';
import {LeaveInquiryNav} from '../components/leave/leave-inquiry-nav';

const current=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',query:''}));
vi.mock('next-intl/server',()=>({
 getTranslations:async(namespace:string)=>createTranslator({locale:current.locale,messages:await messagesForLocale(current.locale),namespace:namespace as never,onError:error=>{throw error;}}),
}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams(current.query)}));

const locales=['en','ms','zh','ta','th','vi'] as const;
type Expected=readonly (readonly [id:string,href:string,labelKey:string])[];
it.each(locales)('preserves actual tab order, addresses, labels and active destination in %s',async locale=>{
 current.locale=locale;current.query='';const messages=await messagesForLocale(locale);
 function label(namespace:string,key:string){
  let dictionary:unknown=messages;
  for(const part of [...namespace.split('.'),key]){
   expect(dictionary).toBeTypeOf('object');dictionary=(dictionary as Record<string,unknown>)[part];
  }
  expect(dictionary).toBeTypeOf('string');return dictionary;
 }
 const check=(container:HTMLElement,expected:Expected,namespace:string,activeHref:string)=>{
  const links=Array.from(container.querySelectorAll('a'));
  expect(links.map(link=>[link.getAttribute('data-navigation-destination'),link.getAttribute('href'),link.textContent])).toEqual(
   expected.map(([id,href,key])=>[id,href,label(namespace,key)]));
  expect(links.filter(link=>/(?:^|\s)border-primary(?:\/\d+)?(?:\s|$)/.test(link.className)).map(link=>link.getAttribute('href'))).toEqual([activeHref]);
 };
 const strips=[
  {node:await HolidayTabs({active:'groups'}),namespace:'admin.holidayTabs',active:'/admin/holidays/groups',expected:[
   ['submenu.holidays.holidays','/admin/holidays','holidays'],['submenu.holidays.groups','/admin/holidays/groups','groups'],
  ]},
  {node:await StatutoryTabs({active:'skbbk'}),namespace:'payroll.config',active:'/payroll/configuration/skbbk',expected:[
   ['submenu.statutory.overview','/payroll/configuration','tabOverview'],['submenu.statutory.epf','/payroll/configuration/epf','body_epf'],
   ['submenu.statutory.socso','/payroll/configuration/socso','body_socso'],['submenu.statutory.skbbk','/payroll/configuration/skbbk','body_skbbk'],
   ['submenu.statutory.eis','/payroll/configuration/eis','body_eis'],['submenu.statutory.pcb','/payroll/configuration/pcb','body_pcb'],
   ['submenu.statutory.hrdf','/payroll/configuration/hrdf','body_hrdf'],
  ]},
  {node:await SystemLabelsTabs({active:'profile-options'}),namespace:'admin.systemLabelsTabs',active:'/admin/settings/system-labels/profile-options',expected:[
   ['submenu.systemLabels.organisation','/admin/settings/system-labels','organisation'],['submenu.systemLabels.profileOptions','/admin/settings/system-labels/profile-options','profileOptions'],
  ]},
  {node:await ClaimsTabs({active:'limits'}),namespace:'admin.claimsTabs',active:'/admin/claims/limits',expected:[
   ['submenu.claims.types','/admin/claims','types'],['submenu.claims.limits','/admin/claims/limits','limits'],
   ['submenu.claims.mileage','/admin/claims/mileage','mileage'],['submenu.claims.reimbursements','/admin/claims/reimbursements','reimbursements'],
  ]},
  {node:await AttendanceTabs({active:'daily'}),namespace:'attendance.tabs',active:'/attendance/daily',expected:[
   ['submenu.attendance.overview','/attendance','overview'],['submenu.attendance.daily','/attendance/daily','daily'],
   ['submenu.attendance.individual','/attendance/individual','individual'],
  ]},
 ] as const;
 for(const strip of strips){const view=render(strip.node);check(view.container,strip.expected,strip.namespace,strip.active);view.unmount();}
 // The current client picker owns these five keys; stale server carry must not win.
 current.query='pickerQ=Anna&pickerCompany=company-a&pickerBusinessUnit=unit-a&pickerDepartment=department-a&pickerStatus=ended&pickerPage=99';
 const inquiry=render(await LeaveInquiryNav({active:'records',employmentId:'employee-a',carry:{
  q:'ANNUAL',type:['annual','replacement'],pickerQ:'stale server query',asOf:'2026-11-07',from:'2026-01-01',status:'approved',
 }}));
 const links=Array.from(inquiry.container.querySelectorAll('a'));
 expect(links.map(link=>[link.getAttribute('data-navigation-destination'),link.textContent])).toEqual([
  ['submenu.leaveInquiry.balances',label('leave.inquiry','employeeBalances')],['submenu.leaveInquiry.records',label('leave.inquiry','employeeLeaveRecord')],
 ]);
 expect(links.map(link=>new URL(link.getAttribute('href')!,'https://localhost:3443').pathname)).toEqual(['/leave/employee-balances','/leave/employee-records']);
 for(const link of links){
  const parameters=new URL(link.getAttribute('href')!,'https://localhost:3443').searchParams;
  expect([...parameters.keys()].sort()).toEqual(['emp','q','type','type','pickerQ','pickerCompany','pickerBusinessUnit','pickerDepartment','pickerStatus'].sort());
  expect(parameters.get('emp')).toBe('employee-a');expect(parameters.get('q')).toBe('ANNUAL');expect(parameters.getAll('type')).toEqual(['annual','replacement']);
  expect(['pickerQ','pickerCompany','pickerBusinessUnit','pickerDepartment','pickerStatus'].map(key=>parameters.get(key))).toEqual(['Anna','company-a','unit-a','department-a','ended']);
 }
 expect(links.filter(link=>link.getAttribute('aria-current')==='page').map(link=>new URL(link.getAttribute('href')!,'https://localhost:3443').pathname)).toEqual(['/leave/employee-records']);
 inquiry.unmount();
});
