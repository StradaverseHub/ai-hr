// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {UserMenu} from '../components/user-menu';
import {FunctionAccessGrid} from '../components/function-access-grid';
import {MATRIX_ROLES} from '../lib/permissions';
vi.mock('../components/logout-button',()=>({LogoutButton:()=>null}));
vi.mock('../components/tour-launcher',()=>({TourLauncher:()=>null}));
vi.mock('../components/ui-theme-switcher',()=>({UiThemeSwitcher:()=>null}));
afterEach(cleanup);
describe('effective access is discoverable without misrepresenting a role grant',()=>{
 it('offers the account-menu entry only from the current server navigation hint',()=>{
  const tree=(allowed:boolean)=><NextIntlClientProvider locale="en" messages={en}><UserMenu name="Fictional user" employeeCode={null} employed={false} canConfigureAccess={allowed}/></NextIntlClientProvider>;
  const view=render(tree(false));fireEvent.click(screen.getByRole('button',{name:en.topbar.accountMenu}));
  expect(screen.queryByRole('menuitem',{name:en.accessConfiguration.title})).toBeNull();
  view.rerender(tree(true));expect(screen.getByRole('menuitem',{name:en.accessConfiguration.title}).getAttribute('href')).toBe('/admin/users/access');
 });
 it('describes Assistant availability as conditional for every role without implying native effect authority',()=>{
  const note=en.admin.users.scope.assistantWorkspace;
  render(<FunctionAccessGrid roleLabel={role=>role} screenLabel={entry=>entry.screenKey} scopeNote={entry=>entry.screenKey==='assistantWorkspace'?note:null} labels={{accessible:'Role allows screen',notAccessible:'Role refuses screen',screenColumn:'Screen'}}/>);
  const row=screen.getByRole('rowheader',{name:/^assistantWorkspace/}).closest('tr')!;
  expect(Array.from(row.querySelectorAll('td [title]')).map(node=>node.getAttribute('title'))).toEqual(MATRIX_ROLES.map(()=>note));
  expect(row.querySelector('[title="Role allows screen"]')).toBeNull();
 });
 it('shows a capability condition for every role instead of a green role-only grant',()=>{
  const note=en.admin.users.scope.accessConfiguration;
  render(<FunctionAccessGrid roleLabel={role=>role} screenLabel={entry=>entry.screenKey} scopeNote={entry=>entry.screenKey==='accessConfiguration'?note:null} labels={{accessible:'Role allows screen',notAccessible:'Role refuses screen',screenColumn:'Screen'}}/>);
  const row=screen.getByRole('rowheader',{name:new RegExp('^accessConfiguration')}).closest('tr')!;
  expect(row.querySelectorAll(`[title="${note}"]`)).toHaveLength(MATRIX_ROLES.length);
  expect(row.querySelector('[title="Role allows screen"]')).toBeNull();
 });
 it('keeps non-administrator roles refused for group-only provisioning while explaining the administrator scope condition',()=>{
  const note=en.admin.users.scope.createLogin;
  render(<FunctionAccessGrid roleLabel={role=>role} screenLabel={entry=>entry.screenKey} scopeNote={entry=>entry.screenKey==='createLogin'?note:null} labels={{accessible:'Role allows screen',notAccessible:'Role refuses screen',screenColumn:'Screen'}}/>);
  const row=screen.getByRole('rowheader',{name:/^createLogin/}).closest('tr')!;
  expect(Array.from(row.querySelectorAll('td [title]')).map(node=>node.getAttribute('title'))).toEqual(MATRIX_ROLES.map(role=>role==='hr_admin'||role==='super_admin'?note:'Role refuses screen'));
 });

});
