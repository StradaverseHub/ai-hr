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
 // Approved Security Center revision2 replaces the split landing-link/chevron with one module
 // trigger. The overview remains an explicit destination INSIDE the authorized flyout.
 it.each([false,true].flatMap(dark=>[320,390,768,1280].flatMap(width=>[false,true].map(passwordPolicy=>({dark,width,passwordPolicy})))))(
  'opens the full Security Center label without moving the page at $width px (dark=$dark, policy=$passwordPolicy)',async({dark,width,passwordPolicy})=>{
  await page.viewport(width,900);document.documentElement.classList.toggle('dark',dark);mount(en,false,true,passwordPolicy);
  if(width<640)fireEvent.click(screen.getByRole('button',{name:en.nav.workspaceSwitch}));
  fireEvent.click(screen.getByRole('button',{name:en.nav.systemConfiguration,expanded:false}));
  const module=document.querySelector<HTMLElement>('[data-atelier-module="securityCenter"]')!;
  const toggle=within(module).getByRole('button',{name:en.nav.securityCenter});
  toggle.scrollIntoView({block:'nearest'});
  const label=within(toggle).getByText(en.nav.securityCenter),chevron=toggle.querySelector('.atelier-chevron')!;
  const railNav=toggle.closest('nav')!;
  expect(box(toggle).top).toBeGreaterThanOrEqual(box(railNav).top-.5);expect(box(toggle).bottom).toBeLessThanOrEqual(box(railNav).bottom+.5);
  expect(within(module).queryByRole('link',{name:en.nav.securityCenter})).toBeNull();
  expect(box(toggle).width).toBeGreaterThan(120);expect(box(label).width).toBeGreaterThan(80);
  expect(box(toggle).left).toBeGreaterThanOrEqual(0);expect(box(toggle).right).toBeLessThanOrEqual(width+.5);
  expect(box(label).left).toBeGreaterThanOrEqual(box(toggle).left);expect(box(label).right).toBeLessThanOrEqual(box(chevron).left+.5);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const content=screen.getByTestId('working-page'),before=box(content);
  fireEvent.click(label); // The label opens the module; no separate chevron hit target is needed.
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const panel=screen.getByRole('navigation',{name:en.nav.securityCenter});
  const hrefs=['/admin/security-center','/admin/users/access','/admin/users/function-access','/admin/users/create','/admin/users/invite','/admin/users',...(passwordPolicy?['/admin/security-center/password-policy']:[])];
  const links=within(panel).getAllByRole('link');expect(links.map(link=>link.getAttribute('href'))).toEqual(hrefs);
  expect(within(panel).getByRole('link',{name:en.nav.securityCenter})).toHaveAttribute('href','/admin/security-center');
  expect(within(panel).queryByRole('link',{name:en.nav.passwordPolicy})!==null).toBe(passwordPolicy);
  await waitFor(()=>expect(document.activeElement).toBe(links[0]));
  const after=box(content);expect([after.left,after.top,after.width,after.height]).toEqual([before.left,before.top,before.width,before.height]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if(width<640){
   const navigation=document.getElementById('atelier-mobile-navigation')!;
   expect(box(navigation).left).toBeGreaterThanOrEqual(0);expect(box(navigation).right).toBeLessThanOrEqual(width+.5);
   expect(box(navigation).height).toBeLessThanOrEqual(900*.65+.5);
   expect(box(panel).left).toBeGreaterThanOrEqual(0);expect(box(panel).right).toBeLessThanOrEqual(width+.5);
   expect(after.top).toBeGreaterThanOrEqual(box(navigation).bottom-.5);
  }else{
   expect(box(panel).width).toBeGreaterThan(200);expect(box(panel).left).toBeGreaterThan(before.left);
  }
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(()=>expect(document.activeElement).toBe(toggle));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  await userEvent.keyboard('{Enter}');
  await waitFor(()=>expect(toggle.getAttribute('aria-expanded')).toBe('true'));
  const reopened=screen.getByRole('navigation',{name:en.nav.securityCenter});
  await waitFor(()=>expect(document.activeElement).toBe(within(reopened).getAllByRole('link')[0]));
  fireEvent.click(within(reopened).getByRole('link',{name:en.nav.securityCenter}));
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  if(width<640)expect(screen.getByRole('button',{name:en.nav.workspaceSwitch}).getAttribute('aria-expanded')).toBe('false');
 });
 it('opens Security Center on desktop mouse hover, keeps the trigger-to-panel gap open and dismisses outside',async()=>{
  await page.viewport(1280,900);mount(en,false,true);
  fireEvent.click(screen.getByRole('button',{name:en.nav.systemConfiguration,expanded:false}));
  const module=document.querySelector<HTMLElement>('[data-atelier-module="securityCenter"]')!;
  fireEvent.pointerEnter(module,{pointerType:'touch'});
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  fireEvent.pointerEnter(module,{pointerType:'mouse'});
  const panel=screen.getByRole('navigation',{name:en.nav.securityCenter});
  fireEvent.pointerLeave(module,{pointerType:'mouse'});fireEvent.pointerEnter(panel,{pointerType:'mouse'});
  expect(screen.getByRole('navigation',{name:en.nav.securityCenter})).toBe(panel);
  const backdrop=panel.parentElement!.previousElementSibling;
  expect(backdrop).not.toBeNull();fireEvent.click(backdrop!);
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  expect(within(module).getByRole('button',{name:en.nav.securityCenter}).getAttribute('aria-expanded')).toBe('false');
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
