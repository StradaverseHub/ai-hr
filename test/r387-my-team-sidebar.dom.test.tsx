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
  if(!collapsed)fireEvent.click(screen.getByRole('button',{name:messages.nav.manage}));
  return view;
}

describe('My Team is actually mounted in the authorized viewer’s Manage rail',()=>{
  it.each(['manager','hr_admin','super_admin'])('%s sees My Team immediately beside the preserved tracker without optional attendance',role=>{
    rail([role]);
    const manage=document.getElementById('nav-section-manage');
    expect(manage,'the real Manage section is rendered').not.toBeNull();
    const links=within(manage!).getAllByRole('link');
    const tracker=within(manage!).getByRole('link',{name:messages.nav.teamLeaveTracker});
    const team=within(manage!).getByRole('link',{name:messages.nav.myTeam});
    expect(tracker).toHaveAttribute('href','/leave/tracker?calendar=1');
    expect(team).toHaveAttribute('href','/manage/my-team');
    expect(links.indexOf(team)).toBe(links.indexOf(tracker)+1);
  });

  it.each(['employee','payroll_partner','performance_comp_partner'])('%s retains the calendar but cannot acquire the team menu through the broader admin rail',role=>{
    rail([role]);
    expect(screen.getByRole('link',{name:messages.nav.teamLeaveTracker})).toHaveAttribute('href','/leave/tracker?calendar=1');
    expect(screen.queryByRole('link',{name:messages.nav.myTeam})).not.toBeInTheDocument();
  });

  it('a manager who also has a partner role retains team access',()=>{
    rail(['manager','payroll_partner']);
    expect(screen.getByRole('link',{name:messages.nav.myTeam})).toHaveAttribute('href','/manage/my-team');
  });

  it('the collapsed manager rail retains the accessible My Team destination',()=>{
    rail(['manager'],true);
    expect(screen.getByRole('link',{name:messages.nav.myTeam})).toHaveAttribute('href','/manage/my-team');
  });

  it('the real server shell passes the same role predicate that guards the page',()=>{
    const layout=readFileSync(resolve(process.cwd(),'app/layout.tsx'),'utf8');
    expect(layout).toContain('canAccessTeam={hasTeamAccess(session)}');
    const page=readFileSync(resolve(process.cwd(),'app/manage/my-team/page.tsx'),'utf8');
    expect(page).toContain('await requireTeamAccess(s)');
  });
});
