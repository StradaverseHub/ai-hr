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
// r426 (b3da5f59) — UPDATED, NOT LOOSENED: that row now reads "Leave Credit Status" (same key nav.leaveCreditHistory,
// same href /leave/credit); the three name lookups below pin the new wording.
// 2634fa7a — the approved Leave Credit Details entry follows Credit Status and precedes Leave Details.
// Both credit entries use the existing toil gate; the three core leave entries remain visible without it.
describe('My Leave uses the shared sidebar flyout',()=>{
 it.each([false,true])('keeps leaf links outside the rail and swaps/dismisses one panel in collapsed=%s',collapsed=>{
  const {container}=show(collapsed);const rail=container.querySelector('aside')!;expect(rail).not.toBeNull();
  const leave=screen.getByRole('button',{name:messages.nav.moduleLeave});
  expect(within(rail).queryByRole('link',{name:'Leave Request'})).toBeNull();
  expect(leave).toHaveAttribute('aria-expanded','false');
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:messages.nav.moduleLeave});
  expect(rail.contains(panel)).toBe(false);
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/credit','/leave/credit-details','/leave/details','/leave/tracker?calendar=1']);
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Request'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getByRole('link',{name:'Leave Credit Status'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getByRole('link',{name:'Leave Credit Details'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getAllByRole('link').filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.getAttribute('href'))).toEqual(['/leave/history']);
  // The old name is gone from the panel, not merely joined by the new one.
  expect(within(panel).queryByRole('link',{name:'Leave Overview'})).toBeNull();
  const attendance=screen.getByRole('button',{name:messages.nav.moduleAttendance});fireEvent.click(attendance);
  expect(screen.queryByRole('navigation',{name:messages.nav.moduleLeave})).toBeNull();
  expect(screen.getByRole('navigation',{name:messages.nav.moduleAttendance})).toBeInTheDocument();
  fireEvent.click(leave);expect(screen.queryByRole('navigation',{name:messages.nav.moduleAttendance})).toBeNull();
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('navigation',{name:messages.nav.moduleLeave})).toBeNull();expect(leave).toHaveFocus();
  fireEvent.click(leave);fireEvent.click(container.querySelector('.fixed.inset-0.z-40')!);expect(screen.queryByRole('navigation',{name:messages.nav.moduleLeave})).toBeNull();
  fireEvent.click(leave);fireEvent.click(screen.getByRole('link',{name:'Leave Request'}));expect(screen.queryByRole('navigation',{name:messages.nav.moduleLeave})).toBeNull();
  expect(within(rail).queryByRole('link',{name:'Leave Request Status'})).toBeNull();
 });
 it('highlights the overview and keeps core leave visible while sellable attendance is hidden',()=>{
  location.path='/leave';const view=show();const leave=screen.getByRole('button',{name:messages.nav.moduleLeave});expect(leave.classList.contains('bg-accent')).toBe(true);
  fireEvent.click(leave);const panel=screen.getByRole('navigation',{name:messages.nav.moduleLeave});
  expect(within(panel).getByRole('link',{name:'Leave Request'})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).not.toHaveAttribute('aria-current');
  view.unmount();show(false,[]);
  // Leave is shared core, so an empty sellable-module list must retain both CORE self-service links — and
  // r389: must drop Leave Credit History, which belongs to the sellable `toil` add-on.
  const coreLeave=screen.getByRole('button',{name:messages.nav.moduleLeave});expect(coreLeave.classList.contains('bg-accent')).toBe(true);
  expect(screen.queryByRole('button',{name:messages.nav.moduleAttendance})).toBeNull();
  fireEvent.click(coreLeave);const corePanel=screen.getByRole('navigation',{name:messages.nav.moduleLeave});expect(within(corePanel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/details','/leave/tracker?calendar=1']);
  expect(within(corePanel).queryByRole('link',{name:'Leave Credit Status'})).toBeNull();expect(within(corePanel).queryByRole('link',{name:'Leave Credit Details'})).toBeNull();
 });
 it.each([
  {path:'/leave/credit',active:'Leave Credit Status',inactive:'Leave Credit Details'},
  {path:'/leave/credit-details',active:'Leave Credit Details',inactive:'Leave Credit Status'},
 ])('offers both credit entries only with toil and lights only the current link on $path',({path,active,inactive})=>{
  location.path=path;
  const off=show(false,['attendance']);
  // The Leave module remains available while its paid credit children are absent.
  fireEvent.click(screen.getByRole('button',{name:messages.nav.moduleLeave}));
  expect(within(screen.getByRole('navigation',{name:messages.nav.moduleLeave})).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/details','/leave/tracker?calendar=1']);
  expect(within(screen.getByRole('navigation',{name:messages.nav.moduleLeave})).queryByRole('link',{name:'Leave Credit Status'})).toBeNull();
  expect(within(screen.getByRole('navigation',{name:messages.nav.moduleLeave})).queryByRole('link',{name:'Leave Credit Details'})).toBeNull();
  off.unmount();
  show(false,['toil']);
  const leave=screen.getByRole('button',{name:messages.nav.moduleLeave});
  expect(leave.classList.contains('bg-accent'),'My Leave is the open section on '+path).toBe(true);
  fireEvent.click(leave);
  const panel=screen.getByRole('navigation',{name:messages.nav.moduleLeave});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/leave','/leave/history','/leave/credit','/leave/credit-details','/leave/details','/leave/tracker?calendar=1']);
  expect(within(panel).getByRole('link',{name:active})).toHaveAttribute('aria-current','page');
  expect(within(panel).getByRole('link',{name:inactive})).not.toHaveAttribute('aria-current');
  expect(within(panel).getAllByRole('link').filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.getAttribute('href'))).toEqual([path]);
  expect(within(panel).getByRole('link',{name:'Leave Request'})).not.toHaveAttribute('aria-current');
  expect(within(panel).getByRole('link',{name:'Leave Request Status'})).not.toHaveAttribute('aria-current');
 });
 it.each([false,true])('the shared Leave module selects only the tracker on its route in collapsed=%s',collapsed=>{
  location.path='/leave/tracker';show(collapsed);
  const leave=screen.getByRole('button',{name:messages.nav.moduleLeave});
  expect(leave.classList.contains('bg-accent')).toBe(true);fireEvent.click(leave);
  const panel=screen.getByRole('navigation',{name:messages.nav.moduleLeave});
  expect(within(panel).getByRole('link',{name:messages.nav.teamLeaveTracker})).toHaveAttribute('href','/leave/tracker?calendar=1');
  expect(within(panel).getAllByRole('link').filter(link=>link.hasAttribute('aria-current')).map(link=>link.getAttribute('href'))).toEqual(['/leave/tracker?calendar=1']);
  expect(within(panel).getByRole('link',{name:'Leave Request'})).not.toHaveAttribute('aria-current');
 });

});
