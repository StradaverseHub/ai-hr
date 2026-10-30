import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {UiThemeProvider} from '../components/ui-theme-context';
import type {UiTheme} from '../lib/ui-theme';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
import {Sidebar} from '../components/sidebar';
import {V9Workspace} from '../app/lifecycle/v9/workspace';
const permissions={onboarding:true,offboarding:true,administration:true};
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
function sidebar(theme:UiTheme='classic', allowed=permissions){
 document.documentElement.setAttribute('data-ui-theme',theme);
 render(<UiThemeProvider theme={theme}><NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin onboardingAccess onboardingV9Access onboardingV9Navigation={allowed} onboardingMaster defaultCollapsed={false} enabledModules={['lifecycle']}/></NextIntlClientProvider></UiThemeProvider>);
 const trigger=screen.getByRole('button',{name:'On/Off Boarding'});
 if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger);
 return screen.getByRole('navigation',{name:'On/Off Boarding'});
}
it.each(['classic','monolith','atelier'] as const)('renders the requested three-level hierarchy in the existing %s sidebar',theme=>{
 const menu=sidebar(theme), nav=within(menu);
 expect(nav.getAllByRole('button').map(button=>button.textContent?.trim())).toEqual(['Onboarding','Offboarding','Configuration']);
 expect(nav.getAllByRole('link').map(link=>[link.textContent?.trim(),link.getAttribute('href')])).toEqual([
  ['New Joiners','/lifecycle/v9'],['Checklist Management','/lifecycle/v9?view=onbChecklists'],
  ['Leavers','/lifecycle/v9?view=leavers'],['Offboarding checklists','/lifecycle/v9?view=offChecklists'],
  ['Templates','/lifecycle/v9?view=templates'],['Workflows','/lifecycle/v9?view=workflows'],
  ['Onboarding & Offboarding Settings','/lifecycle/v9?view=settings'],['Assignment Groups','/lifecycle/v9?view=groups'],['Module Access','/lifecycle/v9?view=access'],
 ]);
 for(const label of ['Onboarding & IT','My onboarding & offboarding','Requisitions','All requisitions'])expect(nav.queryByText(label)).not.toBeInTheDocument();
 const onboarding=nav.getByRole('button',{name:'Onboarding'});fireEvent.click(onboarding);
 expect(onboarding).toHaveAttribute('aria-expanded','false');expect(nav.queryByRole('link',{name:'Checklist Management'})).not.toBeInTheDocument();
 expect(nav.getByRole('link',{name:'Leavers'})).toBeVisible();fireEvent.click(onboarding);expect(nav.getByRole('link',{name:'Checklist Management'})).toBeVisible();
});
it('keeps an offboarding-only reader out of onboarding and configuration navigation',()=>{
 const nav=within(sidebar('classic',{onboarding:false,offboarding:true,administration:false}));
 expect(nav.getAllByRole('button').map(button=>button.textContent?.trim())).toEqual(['Offboarding']);
 expect(nav.getAllByRole('link').map(link=>link.textContent?.trim())).toEqual(['Leavers','Offboarding checklists']);
});
it('does not advertise lifecycle navigation without its module entitlement',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin onboardingV9Access onboardingV9Navigation={permissions} defaultCollapsed={false} enabledModules={[]}/></NextIntlClientProvider>);
 expect(screen.queryByRole('button',{name:'On/Off Boarding'})).not.toBeInTheDocument();
});
function workspace(view:'templates'|'onbChecklists'|'leavers', access=permissions){
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
