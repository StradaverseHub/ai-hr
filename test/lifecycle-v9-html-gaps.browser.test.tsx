import {afterEach,expect,it,vi} from 'vitest';
import {page,userEvent} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {UiThemeProvider} from '../components/ui-theme-context';
import {v9HtmlWorkspace} from './helpers/v9-html-fixture';
import type {V9WorkspaceView} from '../lib/lifecycle-v9-navigation';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/onboarding-workspace.css';
import '../app/lifecycle/v9/workspace.css';
const saves=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch,...props}:any)=>React.createElement('a',props,props.children)};});
vi.mock('../components/user-menu',()=>({UserMenu:()=> <button>Account menu</button>}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:saves,setupV9:vi.fn()}));
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),saveOnboardingConfig:vi.fn(),saveOnboardingChecklistTasks:vi.fn(),writeOnboardingNote:vi.fn(),setupOnboarding:vi.fn(),loadOnboardingTask:vi.fn(),markOnboardingSeen:vi.fn()}));
const {V9Workspace}=await import('../app/lifecycle/v9/workspace');
afterEach(async()=>{cleanup();vi.clearAllMocks();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');await page.viewport(1280,720);});
function workspace(theme:'classic'|'monolith'|'atelier',view:V9WorkspaceView) {
 return <UiThemeProvider theme={theme}><NextIntlClientProvider locale="en" messages={messages}><div data-app-content className="p-6"><V9Workspace navigation="global" initialView={view} companyScope={['alpha','beta']} viewer={{name:'Fictional HR',employeeCode:null,employed:false}} initial={v9HtmlWorkspace()}/></div></NextIntlClientProvider></UiThemeProvider>;
}
function contrast(a:string,b:string) {
 const luminance=(s:string)=>{const rgb=s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
for(const theme of ['classic','monolith','atelier'] as const)for(const dark of [false,true])for(const mobile of [false,true]) {
 it(`repairs reference details, keyboard sections, notice and duplicate chrome in ${theme} ${dark?'dark':'light'} ${mobile?'mobile':'desktop'}`,async()=>{
  await page.viewport(mobile?390:1512,mobile?844:805);document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.toggle('dark',dark);
  const view=render(workspace(theme,'leavers'));
  const notice=screen.getByText('Start a case from the employee record, review the checklist and confirm the case to begin assignments and workflows.');
  await expect.poll(()=>contrast(getComputedStyle(notice).color,getComputedStyle(notice).backgroundColor)).toBeGreaterThanOrEqual(4.5);
  console.info('V9_NOTICE_CONTRAST '+JSON.stringify({theme,dark,mobile,foreground:getComputedStyle(notice).color,background:getComputedStyle(notice).backgroundColor,ratio:contrast(getComputedStyle(notice).color,getComputedStyle(notice).backgroundColor)}));
  for(const route of ['joiners','leavers','onbChecklists','offChecklists','templates','workflows','settings','groups','access'] as const){view.rerender(workspace(theme,route));expect(document.querySelector('.v9-toolbar')).toBeNull();expect(screen.queryByRole('combobox',{name:'Company'})).toBeNull();expect(screen.queryByRole('button',{name:'Account menu'})).toBeNull();expect(document.documentElement.scrollWidth).toBeLessThanOrEqual((mobile?390:1512)+1);}
  for(const route of ['onbChecklists','offChecklists'] as const){
   view.rerender(workspace(theme,route));const details=screen.getByRole('region',{name:'Checklist details'}),name=within(details).getByRole('textbox',{name:'Checklist name'}),duplicate=within(details).getByRole('button',{name:'Duplicate'}),owner=within(details).getByRole('button',{name:'Change owner'});
   const n=name.getBoundingClientRect(),d=duplicate.getBoundingClientRect(),o=owner.getBoundingClientRect();
   expect(n.width).toBeGreaterThan(200);expect(d.width).toBeGreaterThan(50);
   if(!mobile){expect(Math.abs(n.top-d.top)).toBeLessThan(2);expect(d.left-n.right).toBeGreaterThanOrEqual(15);expect(d.left-n.right).toBeLessThanOrEqual(17);expect(o.left).toBeGreaterThan(d.right);expect(o.top).toBeLessThan(n.top);}
   else {for(const rect of [n,d,o]){expect(rect.left).toBeGreaterThanOrEqual(0);expect(rect.right).toBeLessThanOrEqual(391);}expect(d.top).toBeGreaterThan(n.bottom);}
   const rules=screen.getByRole('button',{name:'Assignment rules'}),tasks=screen.getByRole('button',{name:'Tasks'});
   expect(rules.getAttribute('aria-expanded')).toBe('false');expect(tasks.getAttribute('aria-expanded')).toBe('true');
   rules.focus();await userEvent.keyboard('{Enter}');expect(rules.getAttribute('aria-expanded')).toBe('true');expect(screen.getByText(/Population preview/)).toBeVisible();
   tasks.focus();await userEvent.keyboard(' ');expect(tasks.getAttribute('aria-expanded')).toBe('false');expect(screen.queryAllByRole('textbox',{name:'Task name'})).toHaveLength(0);
   await userEvent.keyboard('{Enter}');expect(tasks.getAttribute('aria-expanded')).toBe('true');expect(screen.getAllByRole('textbox',{name:'Task name'}).length).toBeGreaterThan(0);
   rules.focus();await userEvent.keyboard('{Enter}');expect(rules.getAttribute('aria-expanded')).toBe('false');
   console.info('V9_CHECKLIST_GEOMETRY '+JSON.stringify({theme,dark,mobile,route,name:n.toJSON(),duplicate:d.toJSON(),owner:o.toJSON()}));
   // Fictional derived fixture only, never labelled as staging or the reference artifact.
   name.focus();const shot=await page.screenshot({base64:true,path:`../.vitest-attachments/v9-html-gaps-${theme}-${dark?'dark':'light'}-${mobile?'mobile':'desktop'}-${route}.png`,animations:'disabled',scale:'css'});console.info('V9_HTML_GAPS_SCREENSHOT '+JSON.stringify({theme,dark,mobile,route,fixture:'fictional-derived-not-staging',base64:shot.base64}));
  }
  expect(saves).not.toHaveBeenCalled();
 });
}
