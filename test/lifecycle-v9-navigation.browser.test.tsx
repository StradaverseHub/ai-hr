import {afterEach,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {UiThemeProvider} from '../components/ui-theme-context';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/onboarding-workspace.css';
import '../app/lifecycle/v9/workspace.css';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams('view=templates'),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../components/intent-link',async()=>{
 const React=await import('react');
 function BrowserLink({prefetch,...props}:any){return React.createElement('a',{...props,onClick:(event:any)=>{event.preventDefault();props.onClick?.(event);}},props.children);}
 return {default:BrowserLink,IntentLink:BrowserLink};
});
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch,...props}:any)=>React.createElement('a',props,props.children)};});
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),saveOnboardingConfig:vi.fn(),saveOnboardingChecklistTasks:vi.fn(),writeOnboardingNote:vi.fn(),setupOnboarding:vi.fn(),loadOnboardingTask:vi.fn(),markOnboardingSeen:vi.fn()}));
const {RequestRecords}=await import('../app/lifecycle/v9/request-records');
const {useState}=await import('react');
const {Sidebar}=await import('../components/sidebar');
const {V9Workspace,ChecklistEditor}=await import('../app/lifecycle/v9/workspace');
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');await page.viewport(1280,720);});
it.each(['classic','monolith','atelier'] as const)('keeps AIHR %s chrome and the same V9 hierarchy/content sections in a real browser',async theme=>{
 await page.viewport(1440,1000);document.documentElement.setAttribute('data-ui-theme',theme);
 const permissions={onboarding:true,offboarding:true,administration:true};
 render(<UiThemeProvider theme={theme}><NextIntlClientProvider locale="en" messages={messages}>
  <div data-app-shell className="flex" style={{height:'100dvh'}}>
   <Sidebar isAdmin onboardingAccess onboardingV9Access onboardingV9Navigation={permissions} onboardingMaster defaultCollapsed={false} enabledModules={['lifecycle']}/>
   <div data-app-content className="flex min-w-0 flex-1 flex-col p-6"><V9Workspace navigation="global" initialView="templates" viewer={{name:'Fictional HR',employeeCode:null,employed:false}} initial={{config:v9Defaults(),cases:[],actor:{id:'fictional-hr',name:'Fictional HR'},canConfigure:true,personnelWritableKeys:[],permissions,options:{users:[],companies:[],employees:[],labels:{},leaveTypes:[]}}}/></div>
  </div>
 </NextIntlClientProvider></UiThemeProvider>);
 const trigger=screen.getByRole('button',{name:'On/Off Boarding'});if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger);
 const nav=within(screen.getByRole('navigation',{name:'On/Off Boarding'}));
 expect(nav.getAllByRole('button').map(button=>button.textContent?.trim())).toEqual(['Onboarding','Offboarding','Configuration']);
 expect(nav.getAllByRole('link')).toHaveLength(9);
 expect(nav.getByRole('link',{name:'Templates'}).getAttribute('aria-current')).toBe('page');
 expect(screen.queryByRole('navigation',{name:'Onboarding and offboarding'})).toBeNull();
 const workspace=document.querySelector('.v9-workspace-global') as HTMLElement;
 expect(workspace.hasAttribute('data-area-theme')).toBe(false);
 const palette=document.createElement('div');palette.style.backgroundColor='var(--card)';palette.style.color='var(--foreground)';workspace.appendChild(palette);
 const documents=screen.getByRole('region',{name:'Document templates'}),emails=screen.getByRole('region',{name:'Email templates'});
 expect(getComputedStyle(documents).backgroundColor).toBe(getComputedStyle(palette).backgroundColor);
 await expect.poll(() => getComputedStyle(workspace).color).toBe(getComputedStyle(palette).color);palette.remove();
 expect(documents.getBoundingClientRect().top).toBeLessThan(emails.getBoundingClientRect().top);
 expect(Math.abs(documents.getBoundingClientRect().left-emails.getBoundingClientRect().left)).toBeLessThan(1);
 expect(screen.getByRole('button',{name:'New template'}).getBoundingClientRect().right).toBeLessThanOrEqual(documents.getBoundingClientRect().right+1);
 // Derived fictional UI proof only. This is NOT a screenshot of staging or the reference HTML.
 const shot=await page.screenshot({path:`../.vitest-attachments/v9-navigation-${theme}.png`,animations:'disabled',base64:true,scale:'css'});
 console.info('V9_DERIVED_NAV_SCREENSHOT '+JSON.stringify({theme,fixture:'fictional',base64:shot.base64}));
 fireEvent.keyDown(document,{key:'Escape'});
});

function ChecklistFixture(){
 const [config,setConfig]=useState(()=>{const c=v9Defaults();c.checklists=[{id:'fixture-checklist',name:'Fictional clearance',module:'off',ownerUserId:'fictional-hr',rules:{caseType:['Resignation']},tasks:[]}];return c;});
 const [selected,select]=useState('fixture-checklist');
 return <div className="v9-workspace v9-workspace-global"><ChecklistEditor config={config} module="off" selected={selected} select={select} actor={{id:'fictional-hr',name:'Fictional HR'}} users={[{id:'fictional-hr',name:'Fictional HR'}]} editable edit={change=>setConfig(old=>{const next=structuredClone(old);change(next);return next;})}/></div>;
}
it.each(['classic','monolith','atelier'] as const)('keeps checklist controls and filtered CSV usable in %s at mobile width and dark mode',async theme=>{
 await page.viewport(390,844);document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.add('dark');
 const view=render(<ChecklistFixture/>);
 const newButton=screen.getByRole('button',{name:'New checklist'}),card=screen.getByRole('button',{name:/Fictional clearance/});
 expect(newButton.getBoundingClientRect().top).toBeLessThan(card.getBoundingClientRect().top);
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391);
 fireEvent.click(screen.getByRole('button',{name:'Duplicate'}));expect(screen.getByRole('textbox',{name:'Checklist name'})).toHaveValue('Copy of Fictional clearance');
 fireEvent.click(screen.getByRole('button',{name:'Delete checklist'}));expect(screen.getByRole('alertdialog',{name:'Confirm checklist deletion'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('alertdialog')).toBeNull();
 const shot=await page.screenshot({path:`../.vitest-attachments/v9-checklist-${theme}-dark-mobile.png`,animations:'disabled',base64:true,scale:'css'});console.info('V9_DERIVED_NAV_SCREENSHOT '+JSON.stringify({theme,view:'checklist',mode:'dark',fixture:'fictional',base64:shot.base64}));
 view.unmount();render(<div className="v9-workspace"><RequestRecords cases={[]} native={null} labels={{}} company="" search="" openCase={()=>{}}/></div>);
 fireEvent.click(screen.getByRole('button',{name:'Export (CSV)'}));expect(screen.getByRole('textbox',{name:'Request records CSV'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Download CSV'}).getBoundingClientRect().right).toBeLessThanOrEqual(391);
});
