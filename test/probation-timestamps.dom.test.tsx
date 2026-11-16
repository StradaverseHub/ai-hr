import {describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PartEditor} from '../app/lifecycle/probation/part-editor';
import {AutomationHistory} from '../app/lifecycle/probation/automation-history';
import {probationCaseFixture,fixtureManager} from './helpers/probation-case-fixture';
vi.mock('../app/lifecycle/probation/actions',()=>({saveDraft:vi.fn(),performReview:vi.fn(),adjudicateOfflineFinal:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const raw=/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

describe('Probation screens print readable times (L2)',()=>{
 it('shows a signature in the signing history as dd/mm/yyyy hh:mm in the HR timezone, never the raw instant',()=>{
  const{view,part}=probationCaseFixture(),p1=part(1);
  p1.state='pending_ack';p1.managerVisible=true;p1.managerSubmittedAt='2026-06-05T03:00:00.000Z';
  p1.signing={id:'signing',document:{tenantId:'tenant',companyId:view.record.companyId,subjectId:p1.id,subjectType:'probation',contentRevision:1,contentHash:'hash',route:p1.route,
   actions:[{id:'a1',stepId:'lm',contentRevision:1,contentHash:'hash',actorId:fixtureManager,actorPersonId:'person',actorName:'Fictional Manager',representedId:fixtureManager,role:'lm',at:'2026-11-16T04:11:38.493Z',action:'signed',comment:'',signature:{method:'typed',value:'Fictional Manager',consent:true}}]}};
  render(<NextIntlClientProvider locale="en" messages={messages}><PartEditor view={view} part={p1} actor={{id:'viewer',name:'Viewer'}}/></NextIntlClientProvider>);
  const history=screen.getByRole('heading',{name:messages.probation.caseView.form.signatures}).closest('section')!;
  expect(within(history).getByText('Fictional Manager · 16/11/2026 12:11')).toBeInTheDocument();
  expect(history.textContent).not.toMatch(raw);
 });
 it('prints workflow history times from database text the same way',()=>{
  render(<NextIntlClientProvider locale="en" messages={messages}><AutomationHistory runs={[{id:'run',trigger:'caseOpened',triggerLabel:'Case opened',status:'done',startedAt:'2026-11-16 12:11:54.756+08',updatedAt:'2026-11-16 12:12:00+08',failure:null,
   entries:[{at:'2026-11-16 12:11:55.001+08',kind:'sent',message:'Welcome message sent',recipients:2,unresolved:[]}]}]}/></NextIntlClientProvider>);
  const section=screen.getByRole('region',{name:messages.probation.automationHistory.title});
  expect(section.textContent).toContain('16/11/2026 12:11');expect(section.textContent).not.toMatch(raw);
 });
});
