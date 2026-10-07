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
// r389 (a6a4aa5f, bc3e203d) — UPDATED, NOT LOOSENED. The first row's NAME is "Leave Request" now (was "Leave
// Overview"; same key nav.leaveOverview, same href), and the node gained a third row, Leave Credit History at
// /leave/credit, which the sidebar gates on the paid `toil` module. So the link lists below read three hrefs
// when the rail expresses no module opinion (enabledModules null) and still read TWO with an empty sellable
// list — that second case is the gate, asserted from the rendered rail rather than from the map.
// r404 (42e55e2b) — UPDATED, NOT LOOSENED: Leave Details (/leave/details) is the fourth row and is core leave,
// so it is listed with AND without the `toil` module; only Leave Credit History is gated.
describe('My Leave uses the shared sidebar flyout',()=>{
 it.each([false,true])('keeps leaf links outside the rail and swaps/dismisses one panel in collapsed=%s',collapsed=>{
  const {container}=show(collapsed);const rail=container.querySelector('aside')!;expect(rail).not.toBeNull();
  const leave=screen.getByRole('button',{name:'My Leave'});
  expect(within(rail).queryByRole('link',{name:'Leave Request'})).toBeNull();
  expect(leave).toHaveAttribute('aria-expanded','false');
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(rail.contains(panel)).toBe(false);
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/credit','/leave/details']);
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Request'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getByRole('link',{name:'Leave Credit History'})).not.toHaveAttribute('aria-current');
  // The old name is gone from the panel, not merely joined by the new one.
  expect(within(panel).queryByRole('link',{name:'Leave Overview'})).toBeNull();
  const attendance=screen.getByRole('button',{name:'My Attendance'});fireEvent.click(attendance);
  expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  expect(screen.getByRole('navigation',{name:'My Attendance'})).toBeInTheDocument();
  fireEvent.click(leave);expect(screen.queryByRole('navigation',{name:'My Attendance'})).toBeNull();
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();expect(leave).toHaveFocus();
  fireEvent.click(leave);fireEvent.click(container.querySelector('.fixed.inset-0.z-40')!);expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  fireEvent.click(leave);fireEvent.click(screen.getByRole('link',{name:'Leave Request'}));expect(screen.queryByRole('navigation',{name:'My Leave'})).toBeNull();
  expect(within(rail).queryByRole('link',{name:'Leave Request Status'})).toBeNull();
 });
 it('highlights the overview and keeps core leave visible while sellable attendance is hidden',()=>{
  location.path='/leave';const view=show();const leave=screen.getByRole('button',{name:'My Leave'});expect(leave.classList.contains('bg-accent')).toBe(true);
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(within(panel).getByRole('link',{name:'Leave Request'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).not.toHaveAttribute('aria-current');
  view.unmount();show(false,[]);
  // Leave is shared core, so an empty sellable-module list must retain both CORE self-service links — and
  // r389: must drop Leave Credit History, which belongs to the sellable `toil` add-on.
  const coreLeave=screen.getByRole('button',{name:'My Leave'});expect(coreLeave.classList.contains('bg-accent')).toBe(true);
  expect(screen.queryByRole('button',{name:'My Attendance'})).toBeNull();
  fireEvent.click(coreLeave);expect(within(screen.getByRole('navigation',{name:'My Leave'})).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/details']);
 });
 it('r389 · offers Leave Credit History only with the toil module, and lights it alone on its own page',()=>{
  location.path='/leave/credit';
  const off=show(false,['attendance']);
  // Without toil no visible row answers for /leave/credit, so Home is not the active section and starts
  // closed — the same shape as the tracker case below. Open it, then the flyout: the row is simply absent.
  const home=screen.getByRole('button',{name:messages.nav.sectionHome});expect(home).toHaveAttribute('aria-expanded','false');fireEvent.click(home);
  fireEvent.click(screen.getByRole('button',{name:'My Leave'}));
  expect(within(screen.getByRole('navigation',{name:'My Leave'})).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/details']);
  expect(within(screen.getByRole('navigation',{name:'My Leave'})).queryByRole('link',{name:'Leave Credit History'})).toBeNull();
  off.unmount();
  show(false,['toil']);
  const leave=screen.getByRole('button',{name:'My Leave'});
  expect(leave.classList.contains('bg-accent'),'My Leave is the open section on /leave/credit').toBe(true);
  fireEvent.click(leave);
  const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/credit','/leave/details']);
  expect(within(panel).getByRole('link',{name:'Leave Credit History'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Request'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).not.toHaveAttribute('aria-current');
 });
 it.each([false,true])('does not highlight My Leave on the tracker route in collapsed=%s',collapsed=>{
  location.path='/leave/tracker';show(collapsed);
  if(!collapsed){
   // Manage is active on the tracker; the inactive Home section initially stays closed.
   expect(screen.queryByRole('button',{name:'My Leave'})).toBeNull();
   const home=screen.getByRole('button',{name:messages.nav.sectionHome});expect(home).toHaveAttribute('aria-expanded','false');fireEvent.click(home);
  }
  const leave=screen.getByRole('button',{name:'My Leave'});
  expect(leave.classList.contains('bg-accent')).toBe(false);fireEvent.click(leave);
  const panel=screen.getByRole('navigation',{name:'My Leave'});
  expect(within(panel).getAllByRole('link').every(link=>!link.hasAttribute('aria-current'))).toBe(true);
 });

});
