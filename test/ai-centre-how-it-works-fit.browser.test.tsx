/** Staging acceptance, 3 November 2026: on "How Noveri works" the Previous / Play / Next controls sat below the figure,
 * so pressing them meant scrolling the moving clockwork out of view. Real browser and the app's CSS, in the view's own
 * composition (tab bar, title, figure, step panel) inside a <main> as tall as the screen below the app's top bar. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import aiCentreEn from '../messages/ai-centre/en.json';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {PageHeader} from '../components/ui';
import {HowItWorks} from '../components/ai-centre/how-it-works';
import '../app/globals.css';
import '../app/atelier.css';

vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams('view=how'),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
const messages={...en,...aiCentreEn};
/** The app's top bar above <main> (approximately; the test keeps a margin rather than pinning it). */
const TOP_BAR=56;
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,844);});

async function mount(width:number,height:number){
 await page.viewport(width,height);document.body.style.margin='0';document.documentElement.setAttribute('data-ui-theme','atelier');
 const view=render(<NextIntlClientProvider locale="en" messages={messages}>
  <main style={{height:`${height-TOP_BAR}px`,marginTop:`${TOP_BAR}px`,overflowY:'auto'}}>
   <div className="mx-auto max-w-6xl space-y-6 px-4">
    <AiCentreTabs active="how" isAdmin />
    <PageHeader title="How Noveri works" description="Fictional description." />
    <HowItWorks />
   </div>
  </main>
 </NextIntlClientProvider>);
 await new Promise(resolve=>requestAnimationFrame(()=>resolve(null)));
 return {main:view.container.querySelector('main')!,controls:view.container.querySelector('[data-how-controls]')!,figure:view.container.querySelector('[data-clockwork-figure]'),tabs:view.container.querySelector('[data-ai-centre-tabs]')!};
}
const inside=(box:DOMRect,frame:DOMRect)=>box.top>=frame.top-.5&&box.bottom<=frame.bottom+.5;

describe('How it works fits the screen',()=>{
 it('1280x800: the whole figure and its controls are visible together, with the tab row', async()=>{
  const {main,controls,figure,tabs}=await mount(1280,800);
  const frame=main.getBoundingClientRect();
  expect(figure).not.toBeNull();
  expect(inside(figure!.getBoundingClientRect(),frame),'figure in view').toBe(true);
  expect(inside(controls.getBoundingClientRect(),frame),'controls in view').toBe(true);
  expect(inside(tabs.getBoundingClientRect(),frame),'tab row in view').toBe(true);
  expect(tabs.querySelector('a[aria-current="page"]')).toHaveAttribute('href','/assistant?view=how');
 });
 it('390x844: the step controls are visible without scrolling, with the tab row', async()=>{
  const {main,controls,tabs}=await mount(390,844);
  const frame=main.getBoundingClientRect();
  expect(inside(controls.getBoundingClientRect(),frame),'controls in view').toBe(true);
  expect(tabs.getBoundingClientRect().top).toBeGreaterThanOrEqual(frame.top-.5);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
 });
});
