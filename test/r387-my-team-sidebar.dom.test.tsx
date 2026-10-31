import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {SessionContext} from '../db/client';

vi.mock('next/navigation',()=>({
  usePathname:()=> '/',
  useSearchParams:()=>new URLSearchParams(),
  redirect:vi.fn(),
}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));

import {hasTeamAccess} from '../lib/authz';
import {Sidebar} from '../components/sidebar';

function rail(roles:string[],collapsed=false) {
  const session={roles} as SessionContext;
  // Root layout deliberately gives partners an administration rail. That is not team authority.
  const isAdmin=roles.some(role=>['hr_admin','super_admin','payroll_partner','performance_comp_partner'].includes(role));
  const view=render(<NextIntlClientProvider locale="en" messages={messages}>
    <Sidebar isAdmin={isAdmin} canApprove={roles.includes('manager')} canAccessTeam={hasTeamAccess(session)}
      enabledModules={['leave']} defaultCollapsed={collapsed}/>
  </NextIntlClientProvider>);
  return view;
}

function openModule(name:string) {
  const trigger=screen.getByRole('button',{name});
  fireEvent.click(trigger);
  return screen.getByRole('navigation',{name});
}

describe('My Team keeps its exact role boundary inside People',()=>{
  it.each(['manager','hr_admin','super_admin'])('%s sees My Team under People and the preserved calendar under Leave without optional attendance',role=>{
    rail([role]);
    const people=openModule(messages.nav.modulePeople);
    expect(within(people).getByRole('link',{name:messages.nav.myTeam})).toHaveAttribute('href','/manage/my-team');
    expect(within(people).getByRole('link',{name:messages.nav.people})).toHaveAttribute('href','/personnel');
    expect(within(people).getByText(messages.nav.sectionTeam)).toBeInTheDocument();
    const leave=openModule(messages.nav.moduleLeave);
    expect(within(leave).getByRole('link',{name:messages.nav.teamLeaveTracker})).toHaveAttribute('href','/leave/tracker?calendar=1');
    expect(within(leave).queryByRole('link',{name:messages.nav.myTeam})).toBeNull();
  });

  it.each(['employee','payroll_partner','performance_comp_partner','performance_partner'])('%s retains the calendar but cannot acquire My Team through the broader admin rail',role=>{
    rail([role]);
    const peopleTrigger=screen.queryByRole('button',{name:messages.nav.modulePeople});
    if(peopleTrigger) {
      fireEvent.click(peopleTrigger);
      expect(within(screen.getByRole('navigation',{name:messages.nav.modulePeople})).queryByRole('link',{name:messages.nav.myTeam})).toBeNull();
    } else expect(screen.getByRole('link',{name:messages.nav.modulePeople})).toHaveAttribute('href','/personnel');
    expect(screen.queryByRole('link',{name:messages.nav.myTeam})).not.toBeInTheDocument();
    const leave=openModule(messages.nav.moduleLeave);
    expect(within(leave).getByRole('link',{name:messages.nav.teamLeaveTracker})).toHaveAttribute('href','/leave/tracker?calendar=1');
  });

  it('a manager who also has a partner role retains team access',()=>{
    rail(['manager','payroll_partner']);
    expect(within(openModule(messages.nav.modulePeople)).getByRole('link',{name:messages.nav.myTeam})).toHaveAttribute('href','/manage/my-team');
  });

  it('the collapsed manager rail retains the accessible My Team destination',()=>{
    rail(['manager'],true);
    expect(within(openModule(messages.nav.modulePeople)).getByRole('link',{name:messages.nav.myTeam})).toHaveAttribute('href','/manage/my-team');
  });

  it('the real server shell passes the same role predicate that guards the page',()=>{
    const layout=readFileSync(resolve(process.cwd(),'app/(app)/layout.tsx'),'utf8');
    expect(layout).toContain('canAccessTeam={hasTeamAccess(session)}');
    const page=readFileSync(resolve(process.cwd(),'app/(app)/manage/my-team/page.tsx'),'utf8');
    expect(page).toContain('await requireTeamAccess(s)');
  });
});
