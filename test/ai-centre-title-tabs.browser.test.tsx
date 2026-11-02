/** Staging acceptance, 3 November 2026: on AI centre › Ask the page title ("Noveri") covered the bottom of the AI centre
 * tab row. Real browser and the app's own CSS, in the Ask page's layout (tab bar, then the grid holding the title, inside
 * the scrolling <main>); no session or HR data. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import aiCentreEn from '../messages/ai-centre/en.json';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {PageHeader} from '../components/ui';
import '../app/globals.css';
import '../app/atelier.css';

vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));

const messages={...en,...aiCentreEn};
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,844);});

async function mount(theme:'classic'|'atelier',width:number){
 await page.viewport(width,844);document.body.style.margin='0';document.documentElement.setAttribute('data-ui-theme',theme);
 const view=render(<NextIntlClientProvider locale="en" messages={messages}>
  <main style={{height:'640px',overflowY:'auto'}}>
   <div className="mx-auto max-w-7xl space-y-5">
    <AiCentreTabs active="ask" isAdmin />
    <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
     <section className="min-w-0 space-y-3 lg:order-2"><PageHeader title="Noveri" /><div style={{height:'2400px'}} /></section>
     <aside className="min-w-0 lg:order-1">Saved chats</aside>
    </div>
   </div>
  </main>
 </NextIntlClientProvider>);
 const main=view.container.querySelector('main')!,tabs=view.container.querySelector('[data-ai-centre-tabs]')!,header=view.container.querySelector('[data-page-header]')!;
 return {main,tabs,header};
}

describe('AI centre title and tab row',()=>{
 it.each([['classic',1280],['atelier',1280],['classic',390],['atelier',390]] as const)('%s at %ipx: the title never covers the tab row',async(theme,width)=>{
  const {main,tabs,header}=await mount(theme,width);
  // Not pinned, and no painted cover reaching up into the tabs (Atelier's 0 -2.5rem shadow did, before any scroll).
  expect(getComputedStyle(header).position).not.toBe('sticky');
  expect(getComputedStyle(header).boxShadow).toBe('none');
  expect(header.getBoundingClientRect().top).toBeGreaterThanOrEqual(tabs.getBoundingClientRect().bottom-.5);
  // Scrolled, the title moves with the page instead of sliding over the tabs.
  main.scrollTop=48;await new Promise(resolve=>requestAnimationFrame(()=>resolve(null)));
  expect(header.getBoundingClientRect().top).toBeGreaterThanOrEqual(tabs.getBoundingClientRect().bottom-.5);
  // Every tab label is whole inside the row.
  for(const link of tabs.querySelectorAll('a'))expect(link.getBoundingClientRect().bottom).toBeLessThanOrEqual(tabs.getBoundingClientRect().bottom+.5);
 });
 it('keeps an ordinary page title pinned (the owner\'s 30 October rule is unchanged elsewhere)',async()=>{
  await page.viewport(1280,844);document.documentElement.setAttribute('data-ui-theme','classic');
  const view=render(<NextIntlClientProvider locale="en" messages={messages}><main style={{height:'640px',overflowY:'auto'}}><div><PageHeader title="Payroll" /><div style={{height:'2400px'}} /></div></main></NextIntlClientProvider>);
  expect(getComputedStyle(view.container.querySelector('[data-page-header]')!).position).toBe('sticky');
 });
});
