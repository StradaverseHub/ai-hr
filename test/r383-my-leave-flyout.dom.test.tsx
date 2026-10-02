import React from 'react';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {Sidebar} from '../components/sidebar';
const location=vi.hoisted(()=>({path:'/leave/history'}));
vi.mock('next/navigation',()=>({usePathname:()=>location.path,useSearchParams:()=>new URLSearchParams()}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:React.forwardRef<HTMLAnchorElement,any>((props,ref)=>React.createElement('a',{...props,ref,onClick:(event:any)=>{event.preventDefault();props.onClick?.(event);}},props.children))};});
const show=(collapsed=false,enabledModules:string[]|null=null)=>render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} canApprove={false} defaultCollapsed={collapsed} enabledModules={enabledModules}/></NextIntlClientProvider>);
beforeEach(()=>{location.path='/leave/history';});
describe('My Leave uses the shared sidebar flyout',()=>{
 it.each([false,true])('keeps leaf links outside the rail and swaps/dismisses one panel in collapsed=%s',collapsed=>{
  const {container}=show(collapsed);const rail=container.querySelector('aside')!;expect(rail).not.toBeNull();
  const leave=screen.getByRole('button',{name:'My Leave'});
  expect(within(rail).queryByRole('link',{name:'Leave Overview'})).toBeNull();
  expect(leave).toHaveAttribute('aria-expanded','false');
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(rail.contains(panel)).toBe(false);
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history']);
  expect(within(panel).getByRole('link',{name:'Leave History'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Overview'})).not.toHaveAttribute('aria-current');
  const attendance=screen.getByRole('button',{name:'My Attendance'});fireEvent.click(attendance);
  expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  expect(screen.getByRole('navigation',{name:'My Attendance'})).toBeInTheDocument();
  fireEvent.click(leave);expect(screen.queryByRole('navigation',{name:'My Attendance'})).toBeNull();
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();expect(leave).toHaveFocus();
  fireEvent.click(leave);fireEvent.click(container.querySelector('.fixed.inset-0.z-40')!);expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  fireEvent.click(leave);fireEvent.click(screen.getByRole('link',{name:'Leave Overview'}));expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  expect(within(rail).queryByRole('link',{name:'Leave History'})).toBeNull();
 });
 it('highlights only the existing overview destination and preserves entitlement visibility',()=>{
  location.path='/leave';const view=show();const leave=screen.getByRole('button',{name:'My Leave'});expect(leave.className).toContain('bg-accent');
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(within(panel).getByRole('link',{name:'Leave Overview'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave History'})).not.toHaveAttribute('aria-current');
  view.unmount();show(false,[]);expect(screen.queryByRole('button',{name:'My Leave'})).toBeNull();
 });
 it('does not highlight My Leave on the distinct team tracker route',()=>{
  location.path='/leave/tracker';show();const leave=screen.getByRole('button',{name:'My Leave'});
  expect(leave.className).not.toContain('bg-accent');fireEvent.click(leave);
  const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(within(panel).getAllByRole('link').every(link=>!link.hasAttribute('aria-current'))).toBe(true);
 });

});
