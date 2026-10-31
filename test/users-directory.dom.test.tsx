import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
import { UsersDirectory } from '../app/(app)/admin/users/users-directory';
import type { UserDirectoryRow } from '../app/(app)/admin/users/directory-model';
const user=(key:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,status:'active',personId:'person-'+key,name:key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,...change});
const people=[user('Aisyah',{roles:[{id:'employee-a',role:'employee',companyId:null,company:null},{id:'hr-a',role:'hr_admin',companyId:'acme',company:'Acme'}]}),user('Arjun',{roles:[{id:'payroll-b',role:'payroll_partner',companyId:'beta',company:'Beta'}]}),user('Pending',{appUserId:null,status:'pending',hasEmployment:false}),user('Archived',{status:'archived',manuallyArchived:true}),user('External',{hasEmployment:false})];
const show=(rows=people,groupAdmin=true)=>render(<NextIntlClientProvider locale="en" messages={en}><UsersDirectory rows={rows} groupAdmin={groupAdmin} includeArchived={false} companies={[{id:'acme',name:'Acme'},{id:'beta',name:'Beta'}]} roleOptions={groupAdmin?['employee','hr_admin','payroll_partner']:['hr_admin']} assistantGrantedIds={['user-Aisyah']}/></NextIntlClientProvider>);
const names=()=>[...document.querySelectorAll('[data-directory-row] th')].map(el=>el.textContent);
const select=(label:string,value:string)=>fireEvent.change(screen.getByRole('combobox',{name:label}),{target:{value}});
afterEach(cleanup);
describe('user directory filtering, grouping and focused access editing',()=>{
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
  fireEvent.click(within(row as HTMLElement).getByRole('button',{name:'Manage'}));
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
  fireEvent.click(screen.getByRole('button',{name:'Manage'}));
  expect(screen.queryByRole('button',{name:'Archive'})).toBeNull();expect(screen.queryByRole('button',{name:'Allow assistant'})).toBeNull();
  expect(screen.getByRole('combobox',{name:'Role'}).querySelectorAll('option')).toHaveLength(2);
  cleanup();show([user('Terminated',{status:'archived'}),user('Manual archive',{status:'archived',manuallyArchived:true})]);select('Status','archived');
  const rows=[...document.querySelectorAll('[data-directory-row]')];
  const terminated=rows.find(el=>el.textContent?.includes('Terminated'))!;fireEvent.click(within(terminated as HTMLElement).getByRole('button',{name:'Manage'}));expect(screen.queryByRole('button',{name:'Restore'})).toBeNull();
  const archived=rows.find(el=>el.textContent?.includes('Manual archive'))!;fireEvent.click(within(archived as HTMLElement).getByRole('button',{name:'Manage'}));expect(screen.getByRole('button',{name:'Restore'})).toBeTruthy();
 });
 it('paginates and resets to the first page when a filter changes',()=>{
  show(Array.from({length:45},(_,i)=>user(`Person ${String(i).padStart(2,'0')}`)));
  expect(names()).toHaveLength(20);fireEvent.click(screen.getByRole('button',{name:'Next'}));expect(names()[0]).toContain('Person 20');
  fireEvent.change(screen.getByRole('searchbox',{name:'Search users'}),{target:{value:'Person 44'}});expect(names()).toHaveLength(1);expect(screen.getByText('Page 1 of 1')).toBeTruthy();
 });
});
