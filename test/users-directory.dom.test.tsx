import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
vi.mock('../app/admin/users/[userId]/account/actions',()=>({accountAction:vi.fn(async()=>({status:'saved'})),generatePasswordAction:vi.fn(),accountHistoryAction:vi.fn(async()=>({status:'ok',entries:[]}))}));
import { UsersDirectory } from '../app/admin/users/users-directory';
import type { UserDirectoryRow } from '../app/admin/users/directory-model';
const user=(key:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,status:'active',personId:'person-'+key,name:key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,...change});
const people=[user('Aisyah',{roles:[{id:'employee-a',role:'employee',companyId:null,company:null},{id:'hr-a',role:'hr_admin',companyId:'acme',company:'Acme'}]}),user('Arjun',{roles:[{id:'payroll-b',role:'payroll_partner',companyId:'beta',company:'Beta'}]}),user('Pending',{appUserId:null,status:'pending',hasEmployment:false}),user('Archived',{status:'archived',manuallyArchived:true}),user('External',{hasEmployment:false})];
const show=(rows=people,groupAdmin=true)=>render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={rows} groupAdmin={groupAdmin} includeArchived={false} companies={[{id:'acme',name:'Acme'},{id:'beta',name:'Beta'}]} roleOptions={groupAdmin?['employee','hr_admin','payroll_partner']:['hr_admin']} assistantGrantedIds={['user-Aisyah']}/></NextIntlClientProvider>);
const names=()=>[...document.querySelectorAll('[data-directory-row] th')].map(el=>el.textContent);
const select=(label:string,value:string)=>fireEvent.change(screen.getByRole('combobox',{name:label}),{target:{value}});
afterEach(cleanup);
describe('user directory filtering, grouping and focused access editing',()=>{
 it('shows scoped account metadata beside status and filters suspended or expired accounts',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Aisyah'),user('Arjun')]} accounts={{'user-Aisyah':{username:'ais.login',status:'suspended',activeUntil:'2026-12-31'}}} groupAdmin={true} includeArchived={false} companies={[]} roleOptions={[]} assistantGrantedIds={[]}/></NextIntlClientProvider>);
  expect(screen.getByRole('columnheader',{name:'Account Status'})).toBeTruthy();
  expect(screen.getAllByText('Active until 31-Dec-2026').length).toBeGreaterThan(0);expect(screen.getByText('ais.login')).toBeTruthy();
  select('Status','suspended');expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
  const row=document.querySelector('[data-directory-row]') as HTMLElement;
  expect(within(row).getByText('Inactive')).toBeTruthy();expect(within(row).getByText('Suspended')).toBeTruthy();
  // Inactive accounts offer Edit only; the account controls already built live inside it.
  expect(within(row).queryByRole('button',{name:'Reset Password'})).toBeNull();
  fireEvent.click(within(row).getByRole('button',{name:'Edit'}));
  const panel=screen.getByRole('region',{name:'Access for Aisyah'});
  expect(within(panel).getByRole('link',{name:'Security history'})).toHaveAttribute('href','/admin/users/user-Aisyah/account');
  expect(within(panel).getByRole('button',{name:en.accountManagement.reactivate})).toBeTruthy();
  expect(within(panel).getByRole('button',{name:en.accountManagement.expiry})).toBeTruthy();
  expect(within(panel).queryByRole('button',{name:en.accountManagement.suspend})).toBeNull();
 });
 it('shows the requested columns, Last Login in Malaysia time and actions by account status',()=>{
  const rows=[user('Aina Rahman',{employeeCode:'E0012',roles:[{id:'e',role:'employee',companyId:'acme',company:'Acme'}]}),user('Daniel Tan',{employeeCode:'E0027',roles:[{id:'h1',role:'hr_admin',companyId:'acme',company:'Acme'},{id:'h2',role:'hr_admin',companyId:'beta',company:'Beta'}]}),
   user('Priya Nair',{employeeCode:'E0031'}),user('Lim Wei Jie',{appUserId:null,status:'pending',employeeCode:'E0044'}),user('Outside Scope',{employeeCode:'E0050'})];
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={rows} groupAdmin={true} includeArchived={false} companies={[{id:'acme',name:'Acme'},{id:'beta',name:'Beta'}]} roleOptions={['employee']} assistantGrantedIds={[]}
   accounts={{'user-Aina Rahman':{username:'aina.r',status:'active',activeUntil:null},'user-Daniel Tan':{username:'daniel.t',status:'active',activeUntil:'2026-12-31',exemptionUntil:Date.UTC(2026,10,12,9,0)},'user-Priya Nair':{username:'priya.n',status:'active',activeUntil:null}}}
   lastSignIns={{'user-Aina Rahman':'2026-11-10T01:30:00.000Z','user-Daniel Tan':'2026-11-07T10:02:00.000Z'}}/></NextIntlClientProvider>);
  expect([...document.querySelectorAll('thead th')].map(th=>th.textContent)).toEqual(['Employee Name','Employee ID','Username','Email Address','Account Status','Role','Company Scope','Last Login','Actions']);
  const byName=(text:string)=>[...document.querySelectorAll('[data-directory-row]')].find(el=>el.querySelector('th')?.textContent?.includes(text)) as HTMLElement;
  const aina=byName('Aina Rahman');
  expect(within(aina).getByText('E0012')).toBeTruthy();expect(within(aina).getByText('aina.r')).toBeTruthy();expect(within(aina).getByText('10-Nov-2026 09:30')).toBeTruthy();
  expect(within(aina).getAllByRole('button').map(b=>b.textContent)).toEqual(['Reset Password','Authenticator Control','Edit']);
  const daniel=byName('Daniel Tan');
  expect(within(daniel).getByText('07-Nov-2026 18:02')).toBeTruthy();expect(within(daniel).getByText('Active until 31-Dec-2026')).toBeTruthy();
  expect(within(daniel).getByText('Authenticator paused until 12-Nov-2026 17:00')).toBeTruthy();
  expect(within(daniel).getByText('hr admin')).toBeTruthy();expect(within(daniel).getByText('Acme, Beta')).toBeTruthy();
  expect(within(byName('Priya Nair')).getAllByText('Never Logged In').length).toBeGreaterThan(0);
  const pending=byName('Lim Wei Jie');
  expect(within(pending).getByText('Pending Activation')).toBeTruthy();
  expect(within(pending).getByRole('link',{name:'Set Username and Password'})).toHaveAttribute('href','/admin/users/create?activate=person-Lim Wei Jie');
  expect(within(pending).getByRole('link',{name:'Send Invitation'})).toHaveAttribute('href','/admin/users/invite?activate=person-Lim Wei Jie');
  expect(within(pending).queryByRole('button',{name:'Edit'})).toBeNull();
  // Not admitted by the account scope proof: the reason is shown instead of silently hiding the actions.
  const outside=byName('Outside Scope');
  expect(within(outside).queryByRole('button',{name:'Reset Password'})).toBeNull();expect(within(outside).getByRole('button',{name:'Edit'})).toBeTruthy();
  expect(within(outside).getByText(en.admin.users.directory.unavailableScope)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'e0027'}});expect(names()).toHaveLength(1);expect(names()[0]).toContain('Daniel Tan');
 });
 it('explains unavailable password actions when another sign-in provider is selected',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Aisyah')]} managedSignIn={false} groupAdmin={true} includeArchived={false} companies={[]} roleOptions={[]} assistantGrantedIds={[]}/></NextIntlClientProvider>);
  expect(screen.getByText(en.admin.users.directory.unavailableProvider)).toBeTruthy();expect(screen.queryByRole('button',{name:'Reset Password'})).toBeNull();
 });
 it('opens Reset Password and Authenticator Control from the employee row',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Aina Rahman')]} accounts={{'user-Aina Rahman':{username:'aina.r',status:'active',activeUntil:null}}} groupAdmin={true} includeArchived={false} companies={[]} roleOptions={[]} assistantGrantedIds={[]}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Reset Password'}));
  const reset=await screen.findByRole('dialog',{name:'Reset Password'});
  expect(within(reset).getByDisplayValue('Aina Rahman')).toBeTruthy();expect(within(reset).getByDisplayValue('aina.r')).toBeTruthy();
  fireEvent.click(within(reset).getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('button',{name:'Authenticator Control'}));
  expect(await screen.findByRole('dialog',{name:'Authenticator Control · Aina Rahman'})).toBeTruthy();
 });
 it('captures full-width account status and expiry metadata in the real directory',async()=>{
  const view=render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={[user('Fictional Employee A'),user('Fictional Employee B')]} accounts={{'user-Fictional Employee A':{username:'fictional.a',status:'active',activeUntil:'2026-12-31'},'user-Fictional Employee B':{username:'fictional.b',status:'suspended',activeUntil:null}}} groupAdmin={true} includeArchived={false} companies={[]} roleOptions={['employee']} assistantGrantedIds={[]}/></NextIntlClientProvider>);
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','security-users','real UsersDirectory; fictional accounts with scoped account metadata; no authenticated server journey');
 },60000);
 it('searches complete names/emails and filters status, role, company scope and employee record',()=>{
  show();expect(document.querySelectorAll('[data-directory-row]')).toHaveLength(4);
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'AISYAH@EXAMPLE.TEST'}});expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
  select('Employee record','standalone');expect(names()).toHaveLength(2);
  select('Employee record','all');select('Role filter','hr_admin');select('Company scope','acme');expect(names()).toHaveLength(1);expect(names()[0]).toContain('Aisyah');
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
  select('Group by','type');expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(2);
 });
 it('groups by company scope, supports collapsing groups, and keeps each user’s full grants',()=>{
  show();select('Group by','company');expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(2);
  const header=[...document.querySelectorAll('th[scope="rowgroup"]')].find(el=>el.textContent?.startsWith('Acme'))!;
  const toggle=within(header as HTMLElement).getByRole('button');toggle.focus();
  fireEvent.click(toggle);expect(document.activeElement).toBe(toggle);expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(1);
  fireEvent.click(within(header as HTMLElement).getByRole('button'));expect(names().filter(n=>n?.includes('Aisyah'))).toHaveLength(2);
 });
 it('keeps mutations out of the collapsed rows and targets only the expanded user',()=>{
  show();expect(screen.queryByRole('button',{name:'Archive'})).toBeNull();
  const row=[...document.querySelectorAll('[data-directory-row]')].find(el=>el.textContent?.includes('Aisyah'))!;
  fireEvent.click(within(row as HTMLElement).getByRole('button',{name:'Edit'}));
  const panel=screen.getByRole('region',{name:'Access for Aisyah'});
  expect(within(panel).getByRole('button',{name:'Remove assistant'})).toBeTruthy();
  expect(within(panel).getByRole('button',{name:'Archive'})).toBeTruthy();
  expect(panel.querySelector('input[name="appUserId"]')?.getAttribute('value')).toBe('user-Aisyah');
  expect(panel.querySelector('input[name="roleAssignmentId"]')?.getAttribute('value')).toBe('employee-a');
  expect(within(panel).getByRole('combobox',{name:'Role'})).toHaveValue('');
  expect(within(panel).getByRole('button',{name:'Remove employee for Group-wide'})).toBeTruthy();
 });
 it('retains delegated-administrator boundaries and archived/termination restore behavior',()=>{
  show([user('Scoped',{roles:[{id:'scoped-role',role:'hr_admin',companyId:'acme',company:'Acme'}]})],false);
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.queryByRole('button',{name:'Archive'})).toBeNull();expect(screen.queryByRole('button',{name:'Allow assistant'})).toBeNull();
  expect(screen.getByRole('combobox',{name:'Role'}).querySelectorAll('option')).toHaveLength(2);
  cleanup();show([user('Terminated',{status:'archived'}),user('Manual archive',{status:'archived',manuallyArchived:true})]);select('Status','archived');
  const rows=[...document.querySelectorAll('[data-directory-row]')];
  const terminated=rows.find(el=>el.textContent?.includes('Terminated'))!;fireEvent.click(within(terminated as HTMLElement).getByRole('button',{name:'Edit'}));expect(screen.queryByRole('button',{name:'Restore'})).toBeNull();
  const archived=rows.find(el=>el.textContent?.includes('Manual archive'))!;fireEvent.click(within(archived as HTMLElement).getByRole('button',{name:'Edit'}));expect(screen.getByRole('button',{name:'Restore'})).toBeTruthy();
 });
 it('paginates and resets to the first page when a filter changes',()=>{
  show(Array.from({length:45},(_,i)=>user(`Person ${String(i).padStart(2,'0')}`)));
  expect(names()).toHaveLength(20);fireEvent.click(screen.getByRole('button',{name:'Next'}));expect(names()[0]).toContain('Person 20');
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'Person 44'}});expect(names()).toHaveLength(1);expect(screen.getByText('Page 1 of 1')).toBeTruthy();
 });
});
