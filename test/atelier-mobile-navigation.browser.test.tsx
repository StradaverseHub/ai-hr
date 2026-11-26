import {afterEach,describe,expect,it,vi} from 'vitest';
import {page,userEvent} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import ta from '../messages/ta.json';
import '../app/globals.css';
import '../app/atelier.css';

vi.mock('next/navigation',()=>({usePathname:()=>'/me/payslip',useSearchParams:()=>new URLSearchParams()}));
// Keep Next's router/prefetch adapter outside this actual Sidebar/CSS test.
// Mock the local ESM boundary so optimized CommonJS next/link interop is not rendered by Vite.
vi.mock('../components/intent-link',async()=>{
 const React=await import('react');
 function BrowserLink({prefetch,...props}:any){return React.createElement('a',{...props,onClick:(event:any)=>{event.preventDefault();props.onClick?.(event);}},props.children);}
 return {default:BrowserLink,IntentLink:BrowserLink};
});
const {Sidebar}=await import('../components/sidebar');
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');document.body.style.margin='';await page.viewport(1280,720);});
const box=(element:Element)=>element.getBoundingClientRect();
function mount(messages:typeof en|typeof ta=en,defaultCollapsed=false,security=false,passwordPolicy=false){
 document.documentElement.setAttribute('data-ui-theme','atelier');document.body.style.margin='0';
 const locale=messages===ta?'ta':'en';
 return render(<NextIntlClientProvider locale={locale} messages={withAiCentre(locale,messages)} onError={error=>{throw error;}}>
  <div data-app-shell className="flex" style={{height:'100dvh'}}>
   <Sidebar isAdmin canApprove canAdministerSecurity={security} canConfigureAccess={security} canProvisionUsers={security} canConfigurePasswordPolicy={passwordPolicy} defaultCollapsed={defaultCollapsed} enabledModules={null}/>
   <div data-app-content className="flex min-w-0 flex-1 flex-col"><main data-testid="working-page">Working page</main></div>
  </div>
 </NextIntlClientProvider>);
}
describe('Atelier navigation remains reachable in actual compact CSS',()=>{
 // Board 8fa0a31d — System Configuration and Security Center are two sections, each with its own icon, listing their
 // pages directly. The Security Center overview is no longer a row (it stays the section's breadcrumb landing).
 const securityHrefs=(passwordPolicy:boolean)=>['/admin/users/access',...(passwordPolicy?['/admin/security-center/password-policy']:[]),'/admin/users/function-access','/admin/users','/admin/users/create','/admin/users/invite'];
 it.each([false,true].flatMap(dark=>[320,390,768,1280].flatMap(width=>[false,true].map(passwordPolicy=>({dark,width,passwordPolicy})))))(
  'opens the Security Center section with its pages without moving the page at $width px (dark=$dark, policy=$passwordPolicy)',async({dark,width,passwordPolicy})=>{
  await page.viewport(width,900);document.documentElement.classList.toggle('dark',dark);mount(en,false,true,passwordPolicy);
  if(width<640)fireEvent.click(screen.getByRole('button',{name:en.nav.workspaceSwitch}));
  const system=screen.getByRole('button',{name:en.nav.systemConfiguration,expanded:false});
  const heading=screen.getByRole('button',{name:en.nav.securityCenter,expanded:false});
  // Exactly one control per name: no dropdown inside a section repeats the section's name.
  expect(screen.getAllByRole('button',{name:en.nav.systemConfiguration})).toEqual([system]);
  expect(screen.getAllByRole('button',{name:en.nav.securityCenter})).toEqual([heading]);
  // Each heading draws its own section icon beside the label, plus the open/closed chevron.
  expect(system.querySelectorAll('svg')).toHaveLength(2);expect(heading.querySelectorAll('svg')).toHaveLength(2);
  heading.scrollIntoView({block:'nearest'});
  const label=within(heading).getByText(en.nav.securityCenter),railNav=heading.closest('[data-atelier-navigation] nav')!;
  expect(box(heading).top).toBeGreaterThanOrEqual(box(railNav).top-.5);expect(box(heading).bottom).toBeLessThanOrEqual(box(railNav).bottom+.5);
  expect(box(label).width).toBeGreaterThan(60);expect(box(heading).left).toBeGreaterThanOrEqual(0);expect(box(heading).right).toBeLessThanOrEqual(width+.5);
  const content=screen.getByTestId('working-page'),before=box(content);
  fireEvent.click(label);
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  const section=screen.getByRole('navigation',{name:en.nav.securityCenter});
  expect(section.id).toBe('nav-section-securityCenter');
  expect(within(section).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(securityHrefs(passwordPolicy));
  expect(document.querySelector('a[href="/admin/security-center"]')).toBeNull();
  const after=box(content);expect([after.left,after.top,after.width,after.height]).toEqual([before.left,before.top,before.width,before.height]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const users=within(section).getByRole('link',{name:en.nav.users});users.scrollIntoView({block:'nearest'});
  expect(box(users).left).toBeGreaterThanOrEqual(0);expect(box(users).right).toBeLessThanOrEqual(width+.5);
  heading.focus();await userEvent.keyboard('{Enter}');
  await waitFor(()=>expect(heading.getAttribute('aria-expanded')).toBe('false'));
  expect(within(screen.getByRole('navigation',{name:en.nav.securityCenter})).queryAllByRole('link')).toHaveLength(0);
  await userEvent.keyboard('{Enter}');
  await waitFor(()=>expect(heading.getAttribute('aria-expanded')).toBe('true'));
  fireEvent.click(within(screen.getByRole('navigation',{name:en.nav.securityCenter})).getByRole('link',{name:en.nav.users}));
  if(width<640)expect(screen.getByRole('button',{name:en.nav.workspaceSwitch}).getAttribute('aria-expanded')).toBe('false');
 });
 it('shows each icon section as one trigger in the collapsed rail; it opens on click, not hover, and dismisses outside',async()=>{
  await page.viewport(1280,900);mount(en,true,true);
  for(const key of ['systemConfiguration','securityCenter'] as const){
   const section=document.querySelector<HTMLElement>(`[data-nav-section="${key}"]`)!;
   const triggers=within(section).getAllByRole('button');expect(triggers).toEqual([within(section).getByRole('button',{name:en.nav[key]})]);
   expect(triggers[0].getAttribute('title')).toBe(en.nav[key]);
   expect(box(triggers[0]).width).toBeLessThanOrEqual(64);
   expect(within(section).queryAllByRole('link')).toHaveLength(0);
  }
  const module=document.querySelector<HTMLElement>('[data-atelier-module="securityCenter"]')!;
  const trigger=within(module).getByRole('button',{name:en.nav.securityCenter});
  fireEvent.pointerEnter(module,{pointerType:'mouse'});
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  fireEvent.click(trigger);
  const panel=screen.getByRole('navigation',{name:en.nav.securityCenter});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(securityHrefs(false));
  await waitFor(()=>expect(document.activeElement).toBe(within(panel).getAllByRole('link')[0]));
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  const reopened=screen.getByRole('navigation',{name:en.nav.securityCenter});
  const backdrop=reopened.parentElement!.previousElementSibling;
  expect(backdrop).not.toBeNull();fireEvent.click(backdrop!);
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
 });
 it.each([320,390])('opens bounded navigation above the working page at %ipx and restores keyboard focus',async width=>{
  await page.viewport(width,844);mount(ta);
  const toggle=screen.getByRole('button',{name:ta.nav.workspaceSwitch});
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button',{name:ta.nav.modulePeople})).toBeNull();
  fireEvent.click(toggle);
  const people=screen.getByRole('button',{name:ta.nav.modulePeople});
  fireEvent.click(people);
  const panel=screen.getByRole('navigation',{name:ta.nav.modulePeople});
  await waitFor(()=>expect(within(panel).getAllByRole('link')[0]).toBe(document.activeElement));
  const navigation=document.getElementById('atelier-mobile-navigation')!;
  expect(box(navigation).left).toBeGreaterThanOrEqual(0);
  expect(box(navigation).right).toBeLessThanOrEqual(width+.5);
  expect(box(navigation).height).toBeLessThanOrEqual(844*.65+.5);
  expect(box(screen.getByTestId('working-page')).top).toBeGreaterThanOrEqual(box(navigation).bottom-.5);
  const links=within(panel).getAllByRole('link');
  expect(links.length).toBeGreaterThan(5);
  links[links.length-1].scrollIntoView({block:'nearest'});
  expect(box(links[links.length-1]).bottom).toBeLessThanOrEqual(box(panel).bottom+.5);
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(()=>expect(document.activeElement).toBe(people));
  fireEvent.keyDown(people,{key:'Escape'});
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(toggle);
  expect(screen.queryByRole('button',{name:ta.nav.modulePeople})).toBeNull();
 });
 it('closes the phone navigation after choosing an allowed destination without exposing HR-only links',async()=>{
  await page.viewport(390,844);document.documentElement.setAttribute('data-ui-theme','atelier');
  render(<NextIntlClientProvider locale="en" messages={withAiCentre('en',en)} onError={error=>{throw error;}}><Sidebar isAdmin={false} canApprove={false} defaultCollapsed={false} enabledModules={null}/></NextIntlClientProvider>);
  const toggle=screen.getByRole('button',{name:en.nav.workspaceSwitch});fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button',{name:en.nav.payroll}));
  const panel=screen.getByRole('navigation',{name:en.nav.payroll});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/me/payslip','/me/tax-relief','/me/tp3','/me/ea']);
  fireEvent.click(within(panel).getByRole('link',{name:en.nav.myPayslips}));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('navigation',{name:en.nav.payroll})).toBeNull();
 });
 // b953a339 — reversed from the r-board-eight layout, which put the panel BESIDE the rail as a second
 // in-flow column and so took its width from the page. The panel now floats over the page and the page
 // does not move.
 it.each([768,1280])('floats the sub-menu over the working page without resizing it at %ipx',async width=>{
  await page.viewport(width,900);mount();
  expect(screen.queryByRole('button',{name:en.nav.workspaceSwitch})).toBeNull();
  const content=screen.getByTestId('working-page'),before=box(content);
  fireEvent.click(screen.getByRole('button',{name:en.nav.modulePeople}));
  const panel=screen.getByRole('navigation',{name:en.nav.modulePeople});
  const after=box(content);
  expect(box(panel).width).toBeGreaterThan(200);
  expect([after.left,after.width]).toEqual([before.left,before.width]);
  expect(box(panel).right).toBeGreaterThan(after.left);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  // The rail stays visible beside it at tablet width too, so another module is one click away.
  expect(box(document.querySelector('[data-atelier-navigation]')!).width).toBeGreaterThan(0);
 });
 it('collapses to icons, gives the page the space, and still opens every sub-menu',async()=>{
  await page.viewport(1280,900);mount(en,false);
  const content=screen.getByTestId('working-page'),expanded=box(content);
  const collapse=screen.getByRole('button',{name:en.nav.collapse});
  fireEvent.click(collapse);
  expect(document.cookie).toContain('rail_collapsed=1');
  const rail=document.querySelector('[data-atelier-navigation]')!;
  // Wait for the width transition to finish: WebKit reports fractional widths mid-animation.
  await waitFor(()=>expect(Math.abs(box(rail).width-64)).toBeLessThan(.01));
  expect(box(content).width).toBeGreaterThan(expanded.width+150);
  const people=screen.getByRole('button',{name:en.nav.modulePeople});
  expect(people.getAttribute('title')).toBe(en.nav.modulePeople);
  expect(box(people).width).toBeLessThanOrEqual(64);
  const narrow=box(content);
  fireEvent.click(people);
  const panel=screen.getByRole('navigation',{name:en.nav.modulePeople});
  expect(within(panel).getAllByRole('link').length).toBeGreaterThan(0);
  expect([box(content).left,box(content).width]).toEqual([narrow.left,narrow.width]);
  fireEvent.keyDown(document,{key:'Escape'});
  fireEvent.click(screen.getByRole('button',{name:en.nav.expand}));
  expect(document.cookie).toContain('rail_collapsed=0');
  await waitFor(()=>expect(box(rail).width).toBeCloseTo(248,1));
 });
 it('ignores the collapsed setting on a phone, where the menu is full width',async()=>{
  await page.viewport(390,844);mount(en,true);
  fireEvent.click(screen.getByRole('button',{name:en.nav.workspaceSwitch}));
  const people=screen.getByRole('button',{name:en.nav.modulePeople});
  expect(box(document.querySelector('[data-atelier-navigation]')!).width).toBeGreaterThan(300);
  expect(within(people).getByText(en.nav.modulePeople).getBoundingClientRect().width).toBeGreaterThan(20);
 });
});
