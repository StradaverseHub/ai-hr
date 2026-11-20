import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {hydrateRoot} from 'react-dom/client';
import {renderToString} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';
import {UiThemeProvider} from '../components/ui-theme-context';
import type {UiTheme} from '../lib/ui-theme';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9PersonnelPreview:vi.fn().mockResolvedValue({ok:true,values:{}}),readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
import {Sidebar} from '../components/sidebar';
import {V9Workspace} from '../app/lifecycle/v9/workspace';
const permissions={onboarding:true,offboarding:true,administration:true};
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
function sidebar(theme:UiTheme='classic', allowed:typeof permissions & {records?:boolean}=permissions){
 document.documentElement.setAttribute('data-ui-theme',theme);
 render(<UiThemeProvider theme={theme}><NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin onboardingAccess onboardingV9Access onboardingV9Navigation={allowed} onboardingMaster defaultCollapsed={false} enabledModules={['lifecycle']}/></NextIntlClientProvider></UiThemeProvider>);
 const trigger=screen.getByRole('button',{name:'On/Off Boarding'});
 if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger);
 return screen.getByRole('navigation',{name:'On/Off Boarding'});
}
it('opens the Lifecycle menu on the first click after the server-rendered rail becomes interactive', async()=>{
 const tree=<UiThemeProvider theme="classic"><NextIntlClientProvider locale="en" messages={messages}>
  <Sidebar isAdmin onboardingAccess onboardingV9Access onboardingV9Navigation={permissions} onboardingMaster defaultCollapsed={false} enabledModules={['lifecycle']}/>
 </NextIntlClientProvider></UiThemeProvider>;
 const host=document.createElement('div');
 host.innerHTML=renderToString(tree);
 document.body.append(host);
 const menu=()=>within(host).getByRole('button',{name:'On/Off Boarding'});
 let root:ReturnType<typeof hydrateRoot>|undefined;
 try{
  expect(menu()).toBeDisabled();
  expect(host.querySelector('[data-app-sidebar]')).toHaveAttribute('data-shell-navigation-ready','false');
  await act(async()=>{root=hydrateRoot(host,tree);});
  expect(menu()).toBeEnabled();
  expect(host.querySelector('[data-app-sidebar]')).toHaveAttribute('data-shell-navigation-ready','true');
  fireEvent.click(menu());
  expect(within(host).getByRole('link',{name:'Module Access'})).toHaveAttribute('href','/lifecycle/v9?view=access');
 }finally{
  await act(async()=>root?.unmount());
  host.remove();
 }
});

it.each(['classic','monolith','atelier'] as const)('renders the requested three-level hierarchy in the existing %s sidebar',theme=>{
 const menu=sidebar(theme), nav=within(menu);
 expect(nav.getAllByRole('button').map(button=>button.textContent?.trim())).toEqual(['Onboarding','Offboarding']);
 expect(nav.getAllByRole('link').map(link=>[link.textContent?.trim(),link.getAttribute('href')])).toEqual([
  ['New Joiners','/lifecycle/v9'],['Checklist Management','/lifecycle/v9?view=onbChecklists'],
  ['Leavers','/lifecycle/v9?view=leavers'],['Offboarding checklists','/lifecycle/v9?view=offChecklists'],
  ['Module Access','/lifecycle/v9?view=access'],
 ]);
 for(const label of ['Onboarding & IT','My onboarding & offboarding','Requisitions','All requisitions'])expect(nav.queryByText(label)).not.toBeInTheDocument();
 const onboarding=nav.getByRole('button',{name:'Onboarding'});fireEvent.click(onboarding);
 expect(onboarding).toHaveAttribute('aria-expanded','false');expect(nav.queryByRole('link',{name:'Checklist Management'})).not.toBeInTheDocument();
 expect(nav.getByRole('link',{name:'Leavers'})).toBeVisible();fireEvent.click(onboarding);expect(nav.getByRole('link',{name:'Checklist Management'})).toBeVisible();
});
it.each(['classic','monolith','atelier'] as const)('shows one Configuration destination per shared builder in the %s sidebar',theme=>{
 sidebar(theme);
 // The approved merge has one shared destination per builder, plus native-authorized On/Off Boarding settings.
 const automationTrigger=screen.getByRole('button',{name:messages.nav.moduleHrAutomation});
 if(automationTrigger.getAttribute('aria-expanded')!=='true')fireEvent.click(automationTrigger);
 const automation=within(screen.getByRole('navigation',{name:messages.nav.moduleHrAutomation}));
 expect(automation.getAllByRole('link').map(link=>[link.textContent?.trim(),link.getAttribute('href')])).toEqual([
  ['Workflows','/automation/workflows'],['Templates','/automation/templates'],['Assignment groups','/automation/groups'],
  ['Onboarding & Offboarding Settings','/lifecycle/v9?view=settings'],
 ]);
});
it('keeps an offboarding-only reader out of onboarding and configuration navigation',()=>{
 const nav=within(sidebar('classic',{onboarding:false,offboarding:true,administration:false}));
 expect(nav.getAllByRole('button').map(button=>button.textContent?.trim())).toEqual(['Offboarding']);
 expect(nav.getAllByRole('link').map(link=>link.textContent?.trim())).toEqual(['Leavers','Offboarding checklists']);
 expect(screen.queryByRole('button',{name:messages.nav.moduleHrAutomation})).not.toBeInTheDocument();
});
it('does not advertise lifecycle navigation without its module entitlement',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin onboardingV9Access onboardingV9Navigation={permissions} defaultCollapsed={false} enabledModules={[]}/></NextIntlClientProvider>);
 expect(screen.queryByRole('button',{name:'On/Off Boarding'})).not.toBeInTheDocument();
});
function workspace(view:'templates'|'onbChecklists'|'leavers'|'tasks'|'records', access=permissions){
 return <NextIntlClientProvider locale="en" messages={messages}><V9Workspace navigation="global" initialView={view} viewer={{name:'Fictional HR',employeeCode:null,employed:false}} initial={{config:v9Defaults(),cases:[],actor:{id:'fictional-hr',name:'Fictional HR'},canConfigure:true,personnelWritableKeys:[],permissions:access,options:{users:[],companies:[],employees:[],labels:{},leaveTypes:[]}}}/></NextIntlClientProvider>;
}
it('opens the requested V9 screen without a second sidebar and follows a changed deep link',()=>{
 const view=render(workspace('templates'));
 expect(screen.getByRole('heading',{name:'Templates',level:1})).toBeVisible();
 expect(screen.queryByRole('navigation',{name:'Onboarding and offboarding'})).not.toBeInTheDocument();
 expect(screen.queryByText('Kingdee AI HR')).not.toBeInTheDocument();
 view.rerender(workspace('onbChecklists'));expect(screen.getByRole('heading',{name:'Checklist Management',level:1})).toBeVisible();
});
it('does not select a forbidden configuration view from its URL',()=>{
 render(workspace('templates',{onboarding:false,offboarding:true,administration:false}));
 expect(screen.getByRole('heading',{name:'Leavers',level:1})).toBeVisible();
 expect(screen.queryByRole('heading',{name:'Templates',level:1})).not.toBeInTheDocument();
});

it.each([['tasks','Tasks'],['records','Request records']] as const)('retains the shared %s queue as a deep-link destination',(view,title)=>{render(workspace(view));expect(screen.getByRole('heading',{name:title,level:1})).toBeVisible();});

it('keeps Tasks and Request Records reachable through the shared Inbox, outside the exact module hierarchy',()=>{
 sidebar('classic',{...permissions,records:true});
 fireEvent.click(screen.getByRole('button',{name:messages.nav.inbox}));
 const inbox=within(screen.getByRole('navigation',{name:messages.nav.inbox}));
 expect(inbox.getByRole('link',{name:'Tasks'})).toHaveAttribute('href','/lifecycle/v9?view=tasks');
 expect(inbox.getByRole('link',{name:'Request Records'})).toHaveAttribute('href','/lifecycle/v9?view=records');
});
