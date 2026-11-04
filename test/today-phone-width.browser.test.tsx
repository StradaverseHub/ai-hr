/** AI v2 Phase 1, W3 — Today's sections at phone width in a real browser with the app's own CSS: one column, nothing
 * wider than the screen. Presentational pieces only (no session, no HR data); the content is long on purpose. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render} from '@testing-library/react';
import {CalendarCheck} from 'lucide-react';
import {ProposalCard} from '../components/ai-centre/proposal-card';
import {TodayAsk} from '../components/today/today-ask';
import {TodayNote,TodaySection} from '../components/today/today-ui';
import '../app/globals.css';
import '../app/atelier.css';

vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,844);});

const LONG='Approve leave request · Fictional Nurul Aisyah binti Abdul Rahman Shahabuddin (Operations, Penang)';
function mount(theme:'classic'|'atelier'){
 document.body.style.margin='0';document.documentElement.setAttribute('data-ui-theme',theme);
 return render(<main style={{padding:'0 1rem'}}><div data-today="administrator" className="mx-auto w-full max-w-[72rem] min-w-0 space-y-8">
  <TodayAsk label="Ask AI Centre" placeholder="Ask AI Centre, or tell it what to do…" submitLabel="Ask" openingLabel="Opening AI Centre…" suggestionsLabel="Suggested questions"
   suggestions={['Apply for leave','Submit a claim','Why is my pay different?','Get an employment letter']}/>
  <div className="grid items-start gap-6 lg:grid-cols-3">
   <TodaySection id="today-needs-you" title="Needs you" count={1} empty={false} emptyText="Nothing needs you right now.">
    <li><ProposalCard tone="decide" icon={<CalendarCheck/>} title={LONG} meta={['From approvals','Received Nov 3, 2026']} href="/approvals" cta="Open"/></li>
   </TodaySection>
   <TodaySection id="today-done-for-you" title="Done for you" empty={false} emptyText="">
    <TodayNote kind="answeredOthers" label="Answered" title="Answered 46 employee questions" body="In the last 7 days, for the companies in your current scope. Questions on sensitive matters go to your HR team and are not counted here."/>
   </TodaySection>
   <TodaySection id="today-watching" title="Watching" count={1} empty={false} emptyText="">
    <TodayNote kind="deadlines" label="Deadline" title="3 CP22 or CP22A notifications need filing" body="1 is overdue. Due within 7 days, from the statutory compliance worklist." href="/payroll/statutory-forms" cta="Open statutory forms"/>
   </TodaySection>
  </div>
 </div></main>);
}

describe('Today at phone width',()=>{
 it.each(['classic','atelier'] as const)('%s at 390px: one column, nothing wider than the screen',async(theme)=>{
  await page.viewport(390,844);
  const view=mount(theme);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  const sections=[...view.container.querySelectorAll('[data-today-section]')].map(el=>el.getBoundingClientRect());
  expect(sections).toHaveLength(3);
  // Stacked: the same left edge, each below the one before.
  for(let i=1;i<sections.length;i++){expect(Math.abs(sections[i].left-sections[0].left)).toBeLessThan(1);expect(sections[i].top).toBeGreaterThanOrEqual(sections[i-1].bottom);}
  for(const el of view.container.querySelectorAll('[data-today] *'))expect(el.getBoundingClientRect().right,el.tagName).toBeLessThanOrEqual(390+0.5);
 });
 it('at 1280px the three sections sit side by side',async()=>{
  await page.viewport(1280,844);
  const view=mount('atelier');
  const tops=[...view.container.querySelectorAll('[data-today-section]')].map(el=>Math.round(el.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
 });
});
