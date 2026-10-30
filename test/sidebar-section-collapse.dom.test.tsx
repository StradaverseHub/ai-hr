import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
const route=vi.hoisted(()=>({pathname:'/',search:''}));
vi.mock('next/navigation',()=>({usePathname:()=>route.pathname,useSearchParams:()=>new URLSearchParams(route.search),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
const ui=(props:Partial<Parameters<typeof Sidebar>[0]>={})=><NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
 <Sidebar isAdmin canApprove canAccessTeam onboardingAccess onboardingMaster onboardingRequisitionsAccess enabledModules={null} defaultCollapsed={false} {...props}/>
</NextIntlClientProvider>;
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');route.pathname='/';route.search='';});
it('Atelier ignores the Classic collapsed preference for the Ops/Strat switch',()=>{
 document.documentElement.setAttribute('data-ui-theme','atelier');render(ui({defaultCollapsed:true}));
 expect(screen.getByRole('group',{name:messages.nav.workspaceSwitch})).not.toHaveClass('flex-col');
});
describe.each(['classic','monolith','atelier'] as const)('%s Ops/Strata navigation',theme=>{
 it('keeps the general Reports destination shared when switching workspaces without granting employees reporting access',async()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);const user=userEvent.setup();const view=render(ui());
  expect(screen.getByRole('link',{name:messages.nav.reports})).toHaveAttribute('href','/reports');
  await user.click(screen.getByRole('button',{name:messages.nav.workspaceStrata}));
  expect(screen.getByRole('link',{name:messages.nav.reports})).toHaveAttribute('href','/reports');
  view.rerender(ui({isAdmin:false,canApprove:false,canAccessTeam:false}));
  expect(screen.queryByRole('link',{name:messages.nav.reports})).toBeNull();
 });
 it('switches workspace without navigation and keeps module collapse keyboard-operable',async()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);const user=userEvent.setup();render(ui());
  const strata=screen.getByRole('button',{name:messages.nav.workspaceStrata});
  await user.click(strata);expect(strata).toHaveAttribute('aria-pressed','true');expect(route.pathname).toBe('/');
  await user.click(screen.getByRole('button',{name:messages.nav.workspaceOps}));
  const people=screen.getByRole('button',{name:messages.nav.modulePeople});
  people.focus();await user.keyboard('{Enter}');expect(people).toHaveAttribute('aria-expanded','true');
  const panel=screen.getByRole('navigation',{name:messages.nav.modulePeople});
  expect(within(panel).getByRole('link',{name:messages.nav.personnelAdmin})).toHaveAttribute('href','/admin/personnel');
  expect(within(panel).getByText(messages.nav.sectionHR)).toBeInTheDocument();
  if(theme==='atelier'){
    const heading=within(panel).getByRole('heading',{name:messages.nav.sectionHR});
    expect(heading.tagName).toBe('H3');expect(heading).toHaveClass('atelier-subheading');
    expect(heading.closest('a,button')).toBeNull();
  }
  if(theme==='classic'||theme==='atelier'){fireEvent.keyDown(document,{key:'Escape'});expect(people).toHaveFocus();}
  else{people.focus();await user.keyboard(' ');}
  expect(people).toHaveAttribute('aria-expanded','false');
  expect(screen.queryByRole('navigation',{name:messages.nav.modulePeople})).toBeNull();
 });
 it('reopens the newly visited module and keeps the shared gear reachable',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);route.pathname='/reports';route.search='cat=master';
  const view=render(ui());expect(screen.getByRole('button',{name:messages.nav.workspaceStrata})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:messages.nav.workforceInsights})).toBeEnabled();
  route.pathname='/admin/organization';route.search='';view.rerender(ui());
  expect(screen.getByRole('button',{name:messages.nav.workspaceOps})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:messages.nav.modulePeople})).toBeEnabled();
  const section=document.querySelector<HTMLButtonElement>('button[aria-controls="nav-section-systemConfiguration"]');
  if(section?.getAttribute('aria-expanded')==='false')fireEvent.click(section);
  const gears=screen.getAllByRole('button',{name:messages.nav.systemConfiguration}).filter(button=>button.hasAttribute('aria-controls')&&button.getAttribute('aria-controls')!=='nav-section-systemConfiguration');
  expect(gears).toHaveLength(1);const gear=gears[0];
  if(gear.getAttribute('aria-expanded')!=='true')fireEvent.click(gear);
  const panel=document.getElementById(gear.getAttribute('aria-controls')!);expect(panel).not.toBeNull();
  expect(within(panel!).getByRole('link',{name:messages.nav.systemLabels})).toHaveAttribute('href','/admin/settings/system-labels');
 });
 it('offers only self-service Payroll to employees and keeps current-link ownership out of My Profile',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);route.pathname='/me/payslip';route.search='';
  render(ui({isAdmin:false,canApprove:false,canAccessTeam:false,onboardingAccess:false,onboardingMaster:false,onboardingRequisitionsAccess:false}));
  const payroll=screen.getByRole('button',{name:messages.nav.payroll});
  if(payroll.getAttribute('aria-expanded')!=='true')fireEvent.click(payroll);
  const panel=screen.getByRole('navigation',{name:messages.nav.payroll});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/me/payslip','/me/tax-relief','/me/tp3','/me/ea']);
  expect(within(panel).getByRole('link',{name:messages.nav.myPayslips})).toHaveAttribute('aria-current','page');
  expect(screen.getByRole('link',{name:messages.nav.myWorkspace})).not.toHaveAttribute('aria-current');
  expect(screen.queryByRole('button',{name:messages.nav.systemConfiguration})).toBeNull();
 });
 it('hides unavailable module workspaces and preserves testing entitlement plus employee preview exclusion',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  render(ui({isAdmin:false,canApprove:false,canAccessTeam:false,onboardingAccess:false,onboardingMaster:false,onboardingRequisitionsAccess:false,enabledModules:[]}));
  expect(screen.queryByRole('group',{name:messages.nav.workspaceSwitch})).toBeNull();
  expect(screen.queryByRole('link',{name:messages.nav.mobilePreview})).toBeNull();
  const inbox=screen.getByRole('button',{name:messages.nav.inbox});fireEvent.click(inbox);
  expect(screen.queryByRole('link',{name:messages.nav.mySystemTesting})).toBeNull();
  expect(screen.queryByRole('link',{name:messages.nav.approvals})).toBeNull();
  expect(screen.getByRole('link',{name:messages.nav.myTasks})).toHaveAttribute('href','/tasks');
 });
 it('admits a named Attendance participant to the inbox without granting manager navigation',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  const props={isAdmin:false,canApprove:false,canAccessTeam:false,hasAssignedAttendanceApproval:true,onboardingAccess:false,onboardingMaster:false,onboardingRequisitionsAccess:false,enabledModules:['attendance']};
  const view=render(ui(props));
  fireEvent.click(screen.getByRole('button',{name:messages.nav.inbox}));
  expect(screen.getByRole('link',{name:messages.nav.approvals})).toHaveAttribute('href','/approvals');
  const people=screen.queryByRole('button',{name:messages.nav.modulePeople});
  if(people)fireEvent.click(people);
  expect(screen.queryByRole('link',{name:messages.nav.myTeam})).toBeNull();
  expect(screen.queryByRole('button',{name:messages.nav.systemConfiguration})).toBeNull();
  view.rerender(ui({...props,hasAssignedAttendanceApproval:false}));
  const inbox=screen.getByRole('button',{name:messages.nav.inbox});
  if(inbox.getAttribute('aria-expanded')!=='true')fireEvent.click(inbox);
  expect(screen.queryByRole('link',{name:messages.nav.approvals})).toBeNull();
 });
 it('adds and removes only the approval destination for a current ordinary-user assignment',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  const props={isAdmin:false,canApprove:false,canAccessTeam:false,hasAssignedApproval:true,onboardingAccess:false,onboardingMaster:false,onboardingRequisitionsAccess:false,enabledModules:['leave']};
  const view=render(ui(props));fireEvent.click(screen.getByRole('button',{name:messages.nav.inbox}));
  expect(screen.getByRole('link',{name:messages.nav.approvals})).toHaveAttribute('href','/approvals');
  expect(screen.queryByRole('link',{name:messages.nav.personnelAdmin})).toBeNull();
  expect(screen.queryByRole('link',{name:messages.nav.myTeam})).toBeNull();
  view.rerender(ui({...props,hasAssignedApproval:false}));
  expect(screen.queryByRole('link',{name:messages.nav.approvals})).toBeNull();
  expect(screen.getByRole('link',{name:messages.nav.myTasks})).toHaveAttribute('href','/tasks');
 });
});
