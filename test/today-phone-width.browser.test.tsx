/** Today's pieces at phone width in a real browser with the app's own CSS: one column, nothing wider than the screen.
 * Presentational pieces only (no session, no HR data); the content is long on purpose. The earlier Today's sections
 * (TodaySection, TodayNote) were retired with the old dashboard on 12 Nov 2026; this now draws the Ask bar and the
 * panels every current Today page uses (components/today/employee/panel.tsx). */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render} from '@testing-library/react';
import {CalendarCheck} from 'lucide-react';
import {ProposalCard} from '../components/ai-centre/proposal-card';
import {TodayAsk} from '../components/today/today-ask';
import {Panel,PanelLink} from '../components/today/employee/panel';
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
  <div className="grid grid-cols-1 items-start gap-6">
   <Panel id="today-needs" title="Needs you">
    <ul className="m-0 list-none p-0"><li><ProposalCard tone="decide" icon={<CalendarCheck/>} title={LONG} meta={['From approvals','Received Nov 3, 2026']} href="/approvals" cta="Open"/></li></ul>
   </Panel>
   <Panel id="today-handled" title="Handled for you">
    <p className="m-0 text-sm">Answered 46 employee questions. In the last 7 days, for the companies in your current scope. Questions on sensitive matters go to your HR team.</p>
   </Panel>
   <Panel id="today-watching" title="Watching">
    <p className="m-0 text-sm">3 CP22 or CP22A notifications need filing. 1 is overdue. Due within 7 days, from the statutory compliance worklist.</p>
    <PanelLink href="/payroll/statutory-forms">Open the statutory forms</PanelLink>
   </Panel>
  </div>
 </div></main>);
}

describe('Today at phone width',()=>{
 it.each(['classic','atelier'] as const)('%s at 390px: one column, nothing wider than the screen',async(theme)=>{
  await page.viewport(390,844);
  const view=mount(theme);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  const sections=[...view.container.querySelectorAll('[data-today-panel]')].map(el=>el.getBoundingClientRect());
  expect(sections).toHaveLength(3);
  // Stacked: the same left edge, each below the one before.
  for(let i=1;i<sections.length;i++){expect(Math.abs(sections[i].left-sections[0].left)).toBeLessThan(1);expect(sections[i].top).toBeGreaterThanOrEqual(sections[i-1].bottom);}
  for(const el of view.container.querySelectorAll('[data-today] *'))expect(el.getBoundingClientRect().right,el.tagName).toBeLessThanOrEqual(390+0.5);
 });
});
