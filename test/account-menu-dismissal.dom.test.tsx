import {describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {renderToString} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {UserMenu} from '../components/user-menu';

vi.mock('@/app/auth-actions',()=>({logoutAction:async()=>{}}));
vi.mock('@/app/ui-theme-actions',()=>({setUiTheme:async()=>({ok:true})}));

function setup(){
 const clicked=vi.fn();
 const view=render(<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}>
  <UserMenu name="Fictional reviewer" employeeCode="MENU-01" employed/>
  <button onClick={clicked}>Outside destination</button>
 </NextIntlClientProvider>);
 return {...view,clicked,trigger:screen.getByRole('button',{name:'Account menu'}),outside:screen.getByRole('button',{name:'Outside destination'})};
}

describe('account menu dismissal across header stacking contexts',()=>{
 it('exposes the identity before hydration and enables the account control when it can respond',async()=>{
  const html=renderToString(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">
   <UserMenu name="Fictional reviewer" employeeCode="MENU-01" employed/>
  </NextIntlClientProvider>);
  const serverDocument=new DOMParser().parseFromString(html,'text/html');
  const serverTrigger=serverDocument.querySelector<HTMLButtonElement>('button[data-tour="account"]');
  expect(serverTrigger?.disabled).toBe(true);
  expect(serverTrigger?.textContent).toContain('MENU-01');

  const view=setup();
  expect(view.trigger).toBeEnabled();
  await userEvent.setup().click(view.trigger);
  expect(screen.getByRole('menu')).toBeVisible();
 });

 it('closes on an outside click while allowing that destination to work',async()=>{
  const v=setup(),user=userEvent.setup();await user.click(v.trigger);
  expect(screen.getByRole('menu')).toBeVisible();
  await user.click(v.outside);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(v.clicked).toHaveBeenCalledOnce();expect(v.outside).toHaveFocus();
  expect(v.trigger).toHaveAttribute('aria-expanded','false');
 });
 it('keeps inside controls available instead of treating them as outside clicks',async()=>{
  const v=setup(),user=userEvent.setup();await user.click(v.trigger);
  await user.click(within(screen.getByRole('menu')).getByRole('combobox',{name:'Theme'}));
  expect(screen.getByRole('menu')).toBeInTheDocument();
 });
 it('dismisses on Escape and returns focus to its own trigger',async()=>{
  const v=setup(),user=userEvent.setup();await user.click(v.trigger);
  within(screen.getByRole('menu')).getByRole('combobox',{name:'Theme'}).focus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();expect(v.trigger).toHaveFocus();
 });
 it('dismisses when the keyboard leaves the account controls without taking focus back',async()=>{
  const v=setup(),user=userEvent.setup();await user.click(v.trigger);
  within(screen.getByRole('menu')).getByRole('menuitem',{name:'Log out'}).focus();
  await user.tab();
  expect(v.outside).toHaveFocus();expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 });
 it('still toggles with the same trigger and can reopen after outside dismissal',async()=>{
  const v=setup(),user=userEvent.setup();await user.click(v.trigger);await user.click(v.trigger);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await user.click(v.trigger);await user.click(v.outside);await user.click(v.trigger);
  expect(screen.getByRole('menu')).toBeInTheDocument();
 });
});
