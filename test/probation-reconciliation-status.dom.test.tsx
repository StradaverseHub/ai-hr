import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ProbationReconciliationStatus} from '../app/lifecycle/probation/reconciliation-status';
import {PROBATION_INTAKE_REASONS,type ProbationReconciliationView} from '../lib/probation-reconciliation';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {readFileSync} from 'node:fs';
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
afterEach(cleanup);
const data:ProbationReconciliationView={total:26,offset:0,limit:25,lastSuccessfulCheck:'2026-11-18T02:00:00Z',checkStale:false,rows:[{employmentId:'11111111-1111-4111-8111-111111111111',employeeName:'Fictional Employee A',employeeCode:'FX001',companyId:'22222222-2222-4222-8222-222222222222',companyName:'Fictional Company A',grade:'17',reasons:['activation','form','route'],missingBusinessUnit:true}]};
const show=(over:Partial<ProbationReconciliationView>={})=>render(<NextIntlClientProvider locale="en" messages={en}><ProbationReconciliationStatus data={{...data,...over}} query="companyId=22222222-2222-4222-8222-222222222222"/></NextIntlClientProvider>);
describe('Probation no-case notice and reasons',()=>{
 it('opens the list with every hold, real fix routes and a separate missing-BU warning',()=>{
  show();const notice=screen.getByText('26 employees on Probation have no case');
  fireEvent.click(notice);
  const row=screen.getByText('Fictional Employee A').closest('tr')!;
  expect(row).toHaveTextContent('FX001');expect(row).toHaveTextContent('Fictional Company A');
  for(const text of ['Company not activated.','No published evaluation form for this grade.','No published signing route.','No Business Unit on the Personnel record.'])expect(within(row).getByText(text)).toBeVisible();
  for(const [label,path] of [['Intake and activation','intake'],['Form editor','forms'],['Approval routes','routes']])expect(within(row).getByRole('link',{name:label})).toHaveAttribute('href','/lifecycle/probation/'+path+'?company='+data.rows[0].companyId);
  expect(screen.getByRole('link',{name:'Next'})).toHaveAttribute('href',expect.stringContaining('intakeOffset=25'));
  expect(screen.getByText(/Last successful check/)).toHaveTextContent('10:00');
  expect(screen.queryByRole('status')).toBeNull();
 });
 it('shows an unverified/stale worker honestly and a view without a no-case notice after catch-up',()=>{
  show({total:0,rows:[],lastSuccessfulCheck:null,checkStale:true});
  expect(screen.getByRole('status')).toHaveTextContent('Personnel checks have not completed recently.');
  expect(screen.getByRole('region',{name:'Personnel checks'})).toHaveTextContent('No successful check recorded yet.');
  expect(document.querySelector('details')).toBeNull();
 });
 it('keeps SQL pages open and preserves the selected company',()=>{
  show({offset:25});expect(document.querySelector('details')).toHaveAttribute('open');
  expect(screen.getByRole('link',{name:'Previous'})).toHaveAttribute('href',expect.stringContaining('intakeOffset=0'));
  expect(screen.getByRole('link',{name:'Previous'})).toHaveAttribute('href',expect.stringContaining('companyId='+data.rows[0].companyId));
 });
 it.each(['light','dark'] as const)('captures the real discrepancy component on desktop and phone (%s)',async mode=>{
  show({offset:25});
  const style=['app/onboarding-workspace.css','app/lifecycle/v9/workspace.css','app/lifecycle/probation/probation.css','app/lifecycle/probation/tracker-parity.css'].map(path=>readFileSync(path,'utf8')).join('\n');
  const html='<style>'+style+'</style><div class="v9-workspace probation"><main class="pct">'+aiReviewDomHtml(document.body)+'</main></div>';
  await captureAiReviewScreenshots(html,'en',`feedback-probation-reconciliation-${mode}`,'Real no-case notice, scoped reasons and fix links; fictional data; not authenticated staging acceptance','atelier',mode);
 },120_000);
 it('has a translated label for every adjudication code in all supported locales',()=>{
  for(const locale of ['en','ms','zh','ta','th','vi']){
   const labels=JSON.parse(readFileSync('messages/'+locale+'.json','utf8')).probation.reconciliation;
   for(const reason of PROBATION_INTAKE_REASONS)expect(labels.reasons[reason],locale+':'+reason).toBeTruthy();
  }
 });
});
