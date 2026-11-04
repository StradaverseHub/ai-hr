/** Real controls with a synthetic scheduler snapshot; no host command or production access. */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup,fireEvent,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {RUNNERS,type RunnerSnapshot} from '../lib/runner-control-model';
import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const router=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:en,namespace})}));
vi.mock('../app/admin/scheduled-actions/actions',()=>({configureRunnerAction:vi.fn(async()=>({ok:true,error:null}))}));
import {RunnerInventory} from '../app/admin/scheduled-actions/runner-inventory';
const snapshot=(environment:'staging'|'production'='staging'):RunnerSnapshot=>({environment,checkedAt:'2026-11-01T15:00:00Z',runners:RUNNERS.map(row=>({id:row.id,managed:true,installed:true,hold:environment==='production'&&['backups','replacement-holidays'].includes(row.id),note:'Synthetic acceptance fixture',enabled:row.id!=='reviews',running:false,health:row.id==='reviews'?'failed':'success',lastRun:'Sun 2026-11-01 03:00:00 +08',nextRun:'Mon 2026-11-02 03:00:00 +08',schedule:row.frequency==='interval'?'5min after completion':row.frequency==='continuous'?null:row.frequency==='monthly'?'*-*-01 02:00:00 Asia/Kuala_Lumpur':row.frequency==='yearly'?'*-04-01 03:00:00 Asia/Kuala_Lumpur':'*-*-* 03:00:00 Asia/Kuala_Lumpur',revision:'a'.repeat(64)}))});
async function view(value:RunnerSnapshot|null,canControl:boolean){const element=await RunnerInventory({snapshot:value,canControl});return render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);}
afterEach(cleanup);
describe('runner control inventory',()=>{
 it('shows all purposes and result destinations while keeping configured activation separate from health',async()=>{
  await view(snapshot(),true);
  // Twenty runners: AI v2 P2-2a adds the Pre-salary loop's tick.
  expect(screen.getAllByRole('heading',{level:3})).toHaveLength(20);
  fireEvent.click(screen.getByRole('button',{name:'Refresh status'}));expect(router.refresh).toHaveBeenCalled();
  expect(screen.getByText('Failed')).toBeInTheDocument();expect(screen.getByText('Disabled')).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Replacement holidays and calendars'})).toBeNull();
  expect(screen.getByText('Replacement holidays and calendars')).toBeInTheDocument();
  expect(screen.queryByText('AI administration and run history below')).toBeNull();
  const summary=screen.getAllByText('Configure runner')[1];fireEvent.click(summary);
  // Capture expanded actual form controls; static browser fixture does not claim authenticated mutation.
  summary.closest('details')?.setAttribute('open','');
  await captureAiReviewScreenshots(document.body.innerHTML,'en','runner-controls','real components; synthetic scheduler snapshot; no live operation','atelier');
  await captureAiReviewScreenshots(document.body.innerHTML,'en','runner-controls-dark','real components; synthetic scheduler snapshot; no live operation','atelier','dark');
 },60000);
 it('offers no write controls to customer administrators',async()=>{
  await view(snapshot(),false);expect(screen.getByRole('link',{name:'Replacement holidays and calendars'})).toHaveAttribute('href','/admin/holidays/replacements');
  expect(screen.getByRole('link',{name:'Run history below'})).toHaveAttribute('href','#recent-run-history');
  expect(screen.queryByText('Configure runner')).toBeNull();expect(screen.queryByRole('button',{name:'Save configuration'})).toBeNull();
 });
 it('keeps production replacement holidays and backups held even in an otherwise commissioned snapshot',async()=>{
  await view(snapshot('production'),true);
  expect(screen.getAllByText('On hold')).toHaveLength(2);
  const held=screen.getByRole('heading',{name:'Replacement holidays'}).parentElement!.parentElement!.parentElement!;
  expect(within(held).getByText('Enabled')).toBeInTheDocument();expect(within(held).getByText('On hold')).toBeInTheDocument();
  // Twenty runners, two held in production (AI v2 P2-2a adds the Pre-salary loop's tick).
  expect(screen.getAllByText('Configure runner')).toHaveLength(18);
 });
 it('qualifies observed unmanaged services without claiming an absent service means an external cron is off',async()=>{
  const value=snapshot();value.runners[0].managed=false;
  await view(value,true);
  expect(screen.getByText('Enabled · systemd')).toBeInTheDocument();expect(screen.getByText('Not managed here')).toBeInTheDocument();
 });
 it('reports an unavailable controller without pretending runners are disabled',async()=>{
  await view(null,true);
  expect(screen.getByText(en.runnerControl.controllerMissing)).toBeInTheDocument();expect(screen.queryByText('Disabled')).toBeNull();expect(screen.queryByText('Configure runner')).toBeNull();
 });
});
