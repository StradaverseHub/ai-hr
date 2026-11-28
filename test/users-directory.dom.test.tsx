import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { UsersDirectory, directoryHref } from '../app/admin/users/users-directory';
import { userType, type UserDirectoryRow } from '../app/admin/users/directory-model';
const user=(key:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,status:'active',personId:'person-'+key,name:key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,...change});
const people=[user('Aisyah',{roles:[{id:'employee-a',role:'employee',companyId:null,company:null},{id:'hr-a',role:'hr_admin',companyId:'acme',company:'Acme'}]}),user('Arjun',{roles:[{id:'payroll-b',role:'payroll_partner',companyId:'beta',company:'Beta'}]}),user('Pending',{appUserId:null,status:'pending',hasEmployment:false}),user('Archived',{status:'archived',manuallyArchived:true}),user('External',{hasEmployment:false})];
const show=(rows=people,groupAdmin=true)=>render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={rows} groupAdmin={groupAdmin} includeArchived={false} companies={[{id:'acme',name:'Acme'},{id:'beta',name:'Beta'}]}/></NextIntlClientProvider>);
const names=()=>[...document.querySelectorAll('[data-directory-row] th')].map(el=>el.textContent);
const select=(label:string,value:string)=>fireEvent.change(screen.getByRole('combobox',{name:label}),{target:{value}});
const byName=(text:string)=>[...document.querySelectorAll('[data-directory-row]')].find(el=>el.querySelector('th')?.textContent?.includes(text)) as HTMLElement;
afterEach(cleanup);
describe('user directory filtering, grouping, User Type and View/Edit (board 0735d1b7)',()=>{
 it('works out User Type from the Personnel Profile link: employees and former employees are Internal',()=>{
  expect(userType(user('Employee'))).toBe('internal');
  // A former employee still holds an (ended) employment: listUsers' hasEmployment counts every employment state.
  expect(userType(user('Leaver',{status:'archived',hasEmployment:true}))).toBe('internal');
  expect(userType(user('Standalone',{hasEmployment:false}))).toBe('external');
  expect(userType(user('Unlinked',{personId:null,hasEmployment:false}))).toBe('external');
  expect(userType(user('Pending with employment',{appUserId:null,status:'pending',hasEmployment:true}))).toBe('internal');
  expect(userType(user('Pending without employment',{appUserId:null,status:'pending',hasEmployment:false}))).toBe('external');
 });
 it('shows the requested columns with User Type for group administrators and Last Login in Malaysia time',()=>{
  const rows=[user('Aina Rahman',{employeeCode:'E0012',roles:[{id:'e',role:'employee',companyId:'acme',company:'Acme'}]}),user('Daniel Tan',{employeeCode:'E0027',roles:[{id:'h1',role:'hr_admin',companyId:'acme',company:'Acme'},{id:'h2',role:'hr_admin',companyId:'beta',company:'Beta'}]}),
   user('Priya Nair',{employeeCode:'E0031'}),user('Lim Wei Jie',{appUserId:null,status:'pending',employeeCode:'E0044'}),user('Outside Contact',{hasEmployment:false}),user('Old Login',{personId:null,name:null,hasEmployment:false,loginSuffix:'abc123'})];
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={rows} groupAdmin={true} includeArchived={false} companies={[{id:'acme',name:'Acme'},{id:'beta',name:'Beta'}]}
   accounts={{'user-Aina Rahman':{username:'aina.r',status:'active',activeUntil:null},'user-Daniel Tan':{username:'daniel.t',status:'active',activeUntil:'2026-12-31',exemptionUntil:Date.UTC(2026,10,12,9,0)},'user-Priya Nair':{username:'priya.n',status:'active',activeUntil:null}}}
   lastSignIns={{'user-Aina Rahman':'2026-11-10T01:30:00.000Z','user-Daniel Tan':'2026-11-07T10:02:00.000Z'}}/></NextIntlClientProvider>);
  expect([...document.querySelectorAll('thead th')].map(th=>th.textContent)).toEqual(['Employee Name','Employee ID','Username','Email Address','User Type','Account Status','Role','Company Scope','Last Login','Actions']);
  const aina=byName('Aina Rahman');
  expect(within(aina).getByText('E0012')).toBeTruthy();expect(within(aina).getByText('aina.r')).toBeTruthy();expect(within(aina).getByText('10-Nov-2026 09:30')).toBeTruthy();
  expect(within(aina).getByText('Internal User')).toBeTruthy();
  // One View/Edit per row; no row buttons and no expandable panel.
  expect(within(aina).queryAllByRole('button')).toEqual([]);
  expect(within(aina).getByRole('link',{name:'View or edit Aina Rahman'})).toHaveAttribute('href','/admin/users/user-Aina Rahman/account');
  expect(within(aina).getByRole('link',{name:'View or edit Aina Rahman'}).textContent).toBe('View/Edit');
  const daniel=byName('Daniel Tan');
  expect(within(daniel).getByText('07-Nov-2026 18:02')).toBeTruthy();expect(within(daniel).getByText('Active until 31-Dec-2026')).toBeTruthy();
  expect(within(daniel).getByText('Authenticator paused until 12-Nov-2026 17:00')).toBeTruthy();
  expect(within(daniel).getByText('hr admin')).toBeTruthy();expect(within(daniel).getByText('Acme, Beta')).toBeTruthy();
  expect(within(byName('Priya Nair')).getAllByText('Never Logged In').length).toBeGreaterThan(0);
  const pending=byName('Lim Wei Jie');
  expect(within(pending).getByText('Pending Activation')).toBeTruthy();
  expect(within(pending).getByRole('link',{name:'View or edit Lim Wei Jie'})).toHaveAttribute('href','/admin/users/activation/person-Lim Wei Jie');
  expect(within(byName('Outside Contact')).getByText('External User')).toBeTruthy();
  const unlinked=byName('Unlinked login');
  expect(within(unlinked).getByText('External User')).toBeTruthy();expect(within(unlinked).getByText(en.admin.users.directory.unlinkedDetail)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'e0027'}});expect(names()).toHaveLength(1);expect(names()[0]).toContain('Daniel Tan');
 });
 it('keeps User Type, its filter and its grouping to group administrators',()=>{
  show(people,false);
  expect([...document.querySelectorAll('thead th')].map(th=>th.textContent)).not.toContain('User Type');
  expect(screen.queryByRole('combobox',{name:'User Type'})).toBeNull();
  expect([...screen.getByRole('combobox',{name:'Group by'}).querySelectorAll('option')].map(o=>o.textContent)).not.toContain('User Type');
  // Company-level administrators still open each login's account page (its owners keep their scope checks).
  expect(within(byName('Aisyah')).getByRole('link')).toHaveAttribute('href','/admin/users/user-Aisyah/account');
 });
 it('shows when an invitation was sent and when its email failed',()=>{
  show([user('Sent',{appUserId:null,status:'invited',invitationId:'i1',invitedRole:'employee',invitationSentAt:'2026-11-20T02:15:00.000Z',invitationDelivery:'sent'}),
   user('Failed',{appUserId:null,status:'invited',invitationId:'i2',invitedRole:'employee',invitationDelivery:'failed'})]);
  expect(within(byName('Sent')).getByText('Invitation sent 20-Nov-2026 10:15')).toBeTruthy();
  expect(within(byName('Failed')).getByText('Invitation email failed')).toBeTruthy();
  expect(within(byName('Failed')).getByRole('link')).toHaveAttribute('href','/admin/users/activation/person-Failed');
 });
 it('links every login to its account page and every person waiting for a login to the activation page',()=>{
  expect(directoryHref(user('A'))).toBe('/admin/users/user-A/account');
  expect(directoryHref(user('B',{appUserId:null,status:'pending'}))).toBe('/admin/users/activation/person-B');
  expect(directoryHref(user('C',{appUserId:null,status:'invited'}))).toBe('/admin/users/activation/person-C');
  expect(directoryHref(user('D',{appUserId:null,personId:null,status:'invited'}))).toBeNull();
 });
 it('filters status by account metadata and keeps inactive accounts to View/Edit',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Aisyah'),user('Arjun')]} accounts={{'user-Aisyah':{username:'ais.login',status:'suspended',activeUntil:'2026-12-31'}}} groupAdmin={true} includeArchived={false} companies={[]}/></NextIntlClientProvider>);
  expect(screen.getByRole('columnheader',{name:'Account Status'})).toBeTruthy();
  expect(screen.getAllByText('Active until 31-Dec-2026').length).toBeGreaterThan(0);expect(screen.getByText('ais.login')).toBeTruthy();
  select('Status','suspended');expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
  const row=document.querySelector('[data-directory-row]') as HTMLElement;
  expect(within(row).getByText('Inactive')).toBeTruthy();expect(within(row).getByText('Suspended')).toBeTruthy();
  expect(within(row).queryByRole('button')).toBeNull();expect(within(row).getByRole('link',{name:'View or edit Aisyah'})).toBeTruthy();
 });
 it('captures full-width account status and expiry metadata in the real directory',async()=>{
  const view=render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Fictional Employee A'),user('Fictional Employee B',{hasEmployment:false})]} accounts={{'user-Fictional Employee A':{username:'fictional.a',status:'active',activeUntil:'2026-12-31'},'user-Fictional Employee B':{username:'fictional.b',status:'suspended',activeUntil:null}}} groupAdmin={true} includeArchived={false} companies={[]}/></NextIntlClientProvider>);
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','security-users','real UsersDirectory; fictional accounts with scoped account metadata and User Type; no authenticated server journey');
 },60000);
 it('searches complete names/emails and filters status, role, company scope and User Type',()=>{
  show();expect(document.querySelectorAll('[data-directory-row]')).toHaveLength(4);
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'AISYAH@EXAMPLE.TEST'}});expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
  expect([...screen.getByRole('combobox',{name:'User Type'}).querySelectorAll('option')].map(o=>o.textContent)).toEqual(['All user types','Internal User','External User']);
  select('User Type','external');expect(names()).toHaveLength(2);
  select('User Type','internal');expect(names()).toHaveLength(2);
  select('User Type','all');select('Role filter','hr_admin');select('Company scope','acme');expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
  // The role and company must be from the SAME grant, not two unrelated grants on the person.
  select('Role filter','employee');expect(screen.getByText('No users match these filters')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));select('Status','archived');expect(names()).toHaveLength(1);expect(names()[0]).toContain('Archived');
 });
 it('groups by role without hiding multi-role membership or inflating the distinct user count',()=>{
  show();select('Group by','role');
  expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(2);
  expect(screen.getByText('4 of 5 users')).toBeTruthy();expect(screen.getByText(/Users with multiple roles/)).toBeTruthy();
  expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(4);
  select('Group by','status');expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(2);
  select('Group by','type');expect([...document.querySelectorAll('th[scope="rowgroup"]')].map(th=>th.textContent?.replace(/\d+$/,''))).toEqual(['External User','Internal User']);
 });
 it('groups by company scope and supports collapsing groups',()=>{
  show();select('Group by','company');expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(2);
  const header=[...document.querySelectorAll('th[scope="rowgroup"]')].find(el=>el.textContent?.startsWith('Acme'))!;
  const toggle=within(header as HTMLElement).getByRole('button');toggle.focus();
  fireEvent.click(toggle);expect(document.activeElement).toBe(toggle);expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(1);
  fireEvent.click(within(header as HTMLElement).getByRole('button'));expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(2);
 });
 it('renders no account mutation in the list: every action lives on the account page',()=>{
  show();
  for(const name of ['Archive','Restore','Add role','Reset Password','Authenticator Control','Edit'])expect(screen.queryByRole('button',{name})).toBeNull();
  expect(document.querySelector('form')).toBeNull();expect(document.querySelector('[role="region"]')).toBeNull();
 });
 it('paginates and resets to the first page when a filter changes',()=>{
  show(Array.from({length:45},(_,i)=>user(`Person ${String(i).padStart(2,'0')}`)));
  expect(names()).toHaveLength(20);fireEvent.click(screen.getByRole('button',{name:'Next'}));expect(names()[0]).toContain('Person 20');
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'Person 44'}});expect(names()).toHaveLength(1);expect(screen.getByText('Page 1 of 1')).toBeTruthy();
 });
});
