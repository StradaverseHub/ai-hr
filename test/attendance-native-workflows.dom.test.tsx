// @vitest-environment jsdom
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viLocale from '../messages/vi.json';
const source=vi.hoisted(()=>({session:vi.fn(),locale:'en'}));
vi.mock('server-only',()=>({}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:source.session}));
vi.mock('next/link',()=>({default:({href,children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a href={href} {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>{
 const messages={en,ms,zh,ta,th,vi:viLocale}[source.locale as 'en'];
 return (key:string)=>messages.assistant.workspace.attendanceNativeWorkflows[key as keyof typeof messages.assistant.workspace.attendanceNativeWorkflows];
}}));
import {AttendanceNativeWorkflows} from '../components/assistant/attendance-native-workflows';
beforeEach(()=>{source.locale='en';source.session.mockReset();source.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:['employee']});});
async function view(){const root=document.createElement('div');root.innerHTML=renderToStaticMarkup(await AttendanceNativeWorkflows());return root;}
describe('Attendance native workflow handoffs',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('renders bounded native destinations and honest copy in %s',async locale=>{
  source.locale=locale;source.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:['hr_admin']});const root=await view();
  expect([...root.querySelectorAll('a')].map(a=>a.getAttribute('href'))).toEqual(['/attendance/clock','/attendance/individual','/admin/attendance/schedule-assignment','/roster','/admin/personnel']);
  for(const link of root.querySelectorAll('a')){expect(link.textContent?.trim().length).toBeGreaterThan(8);expect(link.className).toContain('min-h-11');expect(link.getAttribute('href')).not.toContain('employmentId');}
  expect(root.querySelector('section')?.getAttribute('aria-labelledby')).toBe(root.querySelector('h2')?.id);
  expect(root.querySelectorAll('form,input,button')).toHaveLength(0);
  expect(root.textContent).not.toContain('attendanceNativeWorkflows.');
 });
 it.each(['employee','manager','payroll_partner','performance_partner','performance_comp_partner','operator','system'])('does not infer Attendance administration from %s',async role=>{
  source.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:[role]});const root=await view();expect([...root.querySelectorAll('a')].map(a=>a.getAttribute('href'))).toEqual(['/attendance/clock']);
 });
 it.each(['hr_admin','super_admin'])('offers native administration navigation for %s without requiring a PERSON link',async role=>{
  source.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:[role],grants:[{role,companyId:'company'}]});expect((await view()).querySelectorAll('a')).toHaveLength(5);
 });
 it('hides administrative navigation on missing USER, unavailable session and subsequent revocation',async()=>{
  source.session.mockResolvedValueOnce({roles:['hr_admin']});expect((await view()).querySelectorAll('a')).toHaveLength(1);
  source.session.mockRejectedValueOnce(Error('PRIVATE session'));const failed=await view();expect(failed.querySelectorAll('a')).toHaveLength(1);expect(failed.textContent).not.toContain('PRIVATE');
  source.session.mockResolvedValueOnce({userId:'user',roles:['hr_admin']});expect((await view()).querySelectorAll('a')).toHaveLength(5);
  expect((await view()).querySelectorAll('a')).toHaveLength(1);
 });
});
