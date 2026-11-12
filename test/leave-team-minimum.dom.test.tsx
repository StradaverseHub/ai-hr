/** Owner decision 12 November 2026 — the "minimum people present" as the approver and the administrator see it, rendered
 * from fictional views with the real components and the English catalogues.
 *
 *  - The recommendation panel (Approvals' detailed list and Manager Today's short failed-rule list) names each day
 *    below the minimum with how many of the team would be present, says when the minimum is met, and keeps the earlier
 *    wording when no minimum applies.
 *  - Company rules' card posts one company's id and box per form, to the action that saves it, with the plain label. */
import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';

vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const {enWithAiCentre:messages}=await import('./helpers/ai-centre-messages');
 return {getTranslations:async(namespace?:string)=>createTranslator({locale:'en',messages:messages as never,namespace:namespace as never}),getLocale:async()=>'en'};
});
const saveAction=vi.hoisted(()=>async(_fd:FormData)=>undefined);
vi.mock('@/app/admin/actions',()=>({setLeaveTeamMinimumAction:saveAction}));

import {RecommendationPanel} from '../components/ai-centre/leave-recommendation';
import {LeaveTeamMinimumCard} from '../app/admin/leave-config/company-rules/team-minimum-card';
import type {LeaveRecommendationView,TeamCoverageView} from '../app/assistant/centre/recommendation';

const wrap=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
afterEach(()=>cleanup());

const RECOMMENDER={kind:'recommender' as const,version:1};
/** The day as the panel formats it (next-intl's dateTime is Intl.DateTimeFormat with these options). */
const fmt=(date:string)=>new Intl.DateTimeFormat('en',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
function view(teamCoverage:TeamCoverageView|null|undefined,result:'pass'|'fail'|'unusual'):LeaveRecommendationView{
 return {kind:'recommendation',verdict:result==='pass'?'recommend_approve':'needs_review',
  failedRules:result==='fail'?[{check:'team_coverage',blocking:false,version:null}]:[],
  checks:[{check:'balance_covers',result:'pass',blocking:false,version:null},{check:'own_overlap',result:'pass',blocking:false,version:RECOMMENDER},
   {check:'team_coverage',result,blocking:false,version:RECOMMENDER},{check:'policy_limits',result:'pass',blocking:false,version:null}],
  recordId:null,teamCoverage};
}

describe('the recommendation names the days below the minimum',()=>{
 it('on the detailed list: each short day with how many would be present, and no blocking note',()=>{
  const {container}=wrap(<RecommendationPanel detail view={view({minimum:3,shortDays:[{date:'2026-11-18',present:2},{date:'2026-11-20',present:1}]},'fail')}/>);
  const row=container.querySelector('[data-check="team_coverage"]')!;
  expect(row.getAttribute('data-result')).toBe('fail');
  expect(row.textContent).toContain(`Approving this would leave fewer than 3 people of the team present on 2 days: ${fmt('2026-11-18')} (2 present) and ${fmt('2026-11-20')} (1 present).`);
  expect(row.textContent).not.toContain('A leave rule would refuse');
  expect(container.textContent).toContain('Needs your review');
 });
 it('on Manager Today\'s short list the failed rule is the same sentence, and long requests count the rest',()=>{
  const days=Array.from({length:9},(_,i)=>({date:`2026-12-${String(i+1).padStart(2,'0')}`,present:1}));
  const {container}=wrap(<RecommendationPanel view={view({minimum:2,shortDays:days},'fail')}/>);
  const rule=container.querySelector('[data-failed-rule="team_coverage"]')!;
  expect(rule.textContent).toContain(`Approving this would leave fewer than 2 people of the team present on 9 days: ${fmt('2026-12-01')} (1 present),`);
  expect(rule.textContent).toContain(`${fmt('2026-12-07')} (1 present)`);
  expect(rule.textContent).toContain('and 2 more days.');
  expect(rule.textContent).not.toContain(fmt('2026-12-08'));
 });
 it('says when the minimum is met, and keeps the earlier wording when no minimum applies',()=>{
  const met=wrap(<RecommendationPanel detail view={view({minimum:1,shortDays:[]},'pass')}/>);
  expect(met.container.querySelector('[data-check="team_coverage"]')!.textContent).toContain('At least 1 person of the team stay present on every day of this request.');
  cleanup();
  const none=wrap(<RecommendationPanel detail view={view(null,'unusual')}/>);
  expect(none.container.querySelector('[data-check="team_coverage"]')!.textContent).toContain('Others you can see are away on some of these dates.');
  cleanup();
  const absent=wrap(<RecommendationPanel view={{...view(undefined,'fail')}}/>);
  expect(absent.container.querySelector('[data-failed-rule="team_coverage"]')!.textContent).toContain('Team coverage on these dates');
 });
});

describe('Company rules: the minimum people present card',()=>{
 it('posts each company\'s id and box to the saving action, with the plain label and the current value',async()=>{
  const tree=await resolveServerTree(<LeaveTeamMinimumCard rows={[{companyId:'c0a80101-0000-4000-8000-000000000001',name:'Fictional Alpha Sdn Bhd',minimum:3},
   {companyId:'c0a80101-0000-4000-8000-000000000002',name:'Fictional Beta Sdn Bhd',minimum:null}]}/>);
  const {container,getAllByLabelText}=wrap(tree);
  expect(container.textContent).toContain('Minimum people present');
  const boxes=getAllByLabelText('Minimum people present on any day (leave the box empty for no minimum)') as HTMLInputElement[];
  expect(boxes.map(box=>[box.name,box.value,box.type])).toEqual([['minimum','3','number'],['minimum','','number']]);
  const forms=[...container.querySelectorAll('form[data-team-minimum-company]')];
  expect(forms).toHaveLength(2);
  for(const form of forms){
   const id=form.getAttribute('data-team-minimum-company')!;
   expect((form.querySelector('input[name="companyId"]') as HTMLInputElement).value).toBe(id);
   expect(form.querySelectorAll('input[name="minimum"]')).toHaveLength(1);
  }
 });
 it('says so when the administrator manages no company',async()=>{
  const {container}=wrap(await resolveServerTree(<LeaveTeamMinimumCard rows={[]}/>));
  expect(container.textContent).toContain('You do not manage the leave settings of any company.');
  expect(container.querySelector('form')).toBeNull();
 });
});
