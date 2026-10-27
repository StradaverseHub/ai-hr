import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
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
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,720);});
const box=(element:Element)=>element.getBoundingClientRect();
function mount(messages:typeof en|typeof ta=en){
 document.documentElement.setAttribute('data-ui-theme','atelier');document.body.style.margin='0';
 return render(<NextIntlClientProvider locale={messages===ta?'ta':'en'} messages={messages}>
  <div data-app-shell className="flex" style={{height:'100dvh'}}>
   <Sidebar isAdmin canApprove defaultCollapsed={false} enabledModules={null}/>
   <div data-app-content className="flex min-w-0 flex-1 flex-col"><main data-testid="working-page">Working page</main></div>
  </div>
 </NextIntlClientProvider>);
}
describe('Atelier navigation remains reachable in actual compact CSS',()=>{
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
  render(<NextIntlClientProvider locale="en" messages={en}><Sidebar isAdmin={false} canApprove={false} defaultCollapsed={false} enabledModules={null}/></NextIntlClientProvider>);
  const toggle=screen.getByRole('button',{name:en.nav.workspaceSwitch});fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button',{name:en.nav.payroll}));
  const panel=screen.getByRole('navigation',{name:en.nav.payroll});
  expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/me/payslip','/me/tax-relief','/me/tp3','/me/ea']);
  fireEvent.click(within(panel).getByRole('link',{name:en.nav.myPayslips}));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('navigation',{name:en.nav.payroll})).toBeNull();
 });
 it.each([768,1280])('keeps the existing navigation track and working page separate at %ipx',async width=>{
  await page.viewport(width,900);mount();
  expect(screen.queryByRole('button',{name:en.nav.workspaceSwitch})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.nav.modulePeople}));
  const panel=screen.getByRole('navigation',{name:en.nav.modulePeople});
  const content=screen.getByTestId('working-page');
  expect(box(panel).width).toBeGreaterThan(200);
  expect(box(panel).right).toBeLessThanOrEqual(box(content).left+.5);
  expect(box(content).right).toBeLessThanOrEqual(width+.5);
 });
});
