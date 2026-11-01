import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import '../app/globals.css';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams()}));
vi.mock('../components/intent-link',async()=>{
 const React=await import('react');
 function BrowserLink({prefetch,...props}:any){return React.createElement('a',{...props,onClick:(event:any)=>{event.preventDefault();props.onClick?.(event);}},props.children);}
 return {default:BrowserLink,IntentLink:BrowserLink};
});
const {Sidebar}=await import('../components/sidebar');
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');document.body.style.margin='';await page.viewport(1280,720);});
const expectedDestinations=[
 '/lifecycle/v9','/lifecycle/v9?view=onbChecklists','/lifecycle/v9?view=leavers',
 '/lifecycle/v9?view=offChecklists','/lifecycle/v9?view=templates','/lifecycle/v9?view=workflows',
 '/lifecycle/v9?view=settings','/lifecycle/v9?view=groups','/lifecycle/v9?view=access',
];
function mount(){
 document.documentElement.setAttribute('data-ui-theme','classic');document.body.style.margin='0';
 render(<NextIntlClientProvider locale="en" messages={en}><div className="flex h-dvh">
  <Sidebar isAdmin={false} defaultCollapsed={false} onboardingV9Access onboardingV9Navigation={{onboarding:true,offboarding:true,administration:true}} enabledModules={['lifecycle']}/>
  <main className="min-w-0 flex-1">Working page</main>
 </div></NextIntlClientProvider>);
}
describe('Classic V9 flyout is reachable within the real phone viewport',()=>{
 it.each([false,true].flatMap(dark=>[{width:320,height:560},{width:390,height:844},{width:639,height:844},{width:640,height:844},{width:1280,height:844}].map(size=>({dark,...size}))))('keeps every destination reachable at $width × $height (dark=$dark)',async({dark,width,height})=>{
  await page.viewport(width,height);document.documentElement.classList.toggle('dark',dark);mount();
  if(width<640)fireEvent.click(document.querySelector<HTMLButtonElement>('[data-mobile-navigation-toggle]')!);
  const trigger=screen.getByRole('button',{name:en.nav.moduleOnboarding});
  fireEvent.click(trigger);
  const nav=screen.getByRole('navigation',{name:en.nav.moduleOnboarding});
  const panel=nav.parentElement!;
  const links=within(nav).getAllByRole('link');
  expect(links.map(link=>link.getAttribute('href'))).toEqual(expectedDestinations);
  await waitFor(()=>expect(document.activeElement).toBe(links[0]));
  const bounds=panel.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width+.5);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(height+.5);
  for(const link of links){
   link.scrollIntoView({block:'nearest'});
   const r=link.getBoundingClientRect(), n=nav.getBoundingClientRect();
   expect(r.width).toBeGreaterThan(100);
   expect(r.left).toBeGreaterThanOrEqual(bounds.left);
   expect(r.right).toBeLessThanOrEqual(bounds.right);
   expect(r.top).toBeGreaterThanOrEqual(n.top-.5);
   expect(r.bottom).toBeLessThanOrEqual(n.bottom+.5);
   expect(link.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))).toBe(true);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if(width<640){
   const close=within(panel).getByRole('button',{name:en.common.close});
   expect(close.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
   expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
   fireEvent.click(close);
  }else{
   expect(bounds.width).toBeCloseTo(256,0);
   expect(bounds.left).toBeGreaterThanOrEqual(document.querySelector('[data-app-sidebar]')!.getBoundingClientRect().right);
   expect(within(panel).queryByRole('button',{name:en.common.close})).toBeNull();
   fireEvent.keyDown(document,{key:'Escape'});
  }
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole('navigation',{name:en.nav.moduleOnboarding})).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('link',{name:en.nav.newJoiners}));
  expect(screen.queryByRole('navigation',{name:en.nav.moduleOnboarding})).toBeNull();
 });
});
