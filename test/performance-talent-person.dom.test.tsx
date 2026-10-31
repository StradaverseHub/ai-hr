import React,{useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentTalentPersonAction:vi.fn(),saveAssessmentTalentRemarkAction:vi.fn(),assessmentTalentInsightAction:vi.fn(),assessmentInsightAction:vi.fn(),assessmentWrittenRemarksAction:vi.fn(),assessmentPotentialInsightAction:vi.fn(),assessmentIdpFitAction:vi.fn()}));
import {assessmentTalentPersonAction,saveAssessmentTalentRemarkAction,assessmentTalentInsightAction,assessmentIdpFitAction} from '../app/(app)/performance/onehr-actions';
import {TalentPerson,type TalentPersonTab} from '../app/(app)/performance/onehr/talent-person';
const frame={position:{performance:'ME' as const,potential:'Low' as const,performanceSource:'manager',potentialSource:'manager',movedFrom:null},facts:{kpis:{n:1,above:0,on:1,below:0},lm_pending:false,default:[],moved_from:null,plan:'Shared',top:['Service'],dev:['Leadership']},potential:{valid:true,top:[{name:'Service',label:'Seen by most'}],development:[{name:'Leadership',label:'Mixed'}],even:null,competencyStatus:'reviewed',competencies:[{name:'Technical delivery',demonstrated:true}]},plan:{status:'shared',goals:[{id:'goal',area:'Service recovery',dueOn:'2027-02-01',onJob:'Lead a recovery',fromOthers:'Observe a colleague',formalLearning:'Attend workshop'}],aspiration:'Regional service lead',aspirationLong:'Lead operations',mobility:'stay' as const,mobilityNote:'Local role',managerRemark:'Agreed support.'},remark:{remark:'',revision:0,locked:false}};
const person={id:'person',name:'Nadia',grade:'12',companyId:'company',company:'Unit',performance:'ME' as const,potential:'Low' as const,performanceSource:'manager',potentialSource:'manager',locked:false,journey:[],potentialPct:null};
function Show({id='person'}:{id?:string}){const [tab,setTab]=useState<TalentPersonTab>('summary');return <NextIntlClientProvider locale="en" messages={en}><TalentPerson key={id} reviewId={id} sessionId="bg" person={{...person,id}} tab={tab} onTab={setTab}><p>Decision controls</p></TalentPerson></NextIntlClientProvider>;}
beforeEach(()=>{vi.mocked(assessmentTalentPersonAction).mockReset().mockResolvedValue(frame);vi.mocked(assessmentTalentInsightAction).mockReset().mockResolvedValue({pending:true,source:null,data:null});vi.mocked(saveAssessmentTalentRemarkAction).mockReset().mockResolvedValue({revision:1});vi.mocked(assessmentIdpFitAction).mockReset().mockResolvedValue({status:'shared',canGenerate:true,pending:true,source:null,data:null});});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows the source four tabs and full shared plan without generating an insight on navigation',async()=>{
 render(<Show/>);expect(await screen.findByLabelText(en.onehr.talentPerson.remark)).toBeTruthy();expect(screen.getAllByRole('tab').map(e=>e.textContent)).toEqual(['Summary','Performance','Potential','Development plan']);
 fireEvent.click(screen.getByRole('button',{name:'Read Development plan →'}));expect(await screen.findByText('Service recovery')).toBeTruthy();expect(screen.getByText('Lead a recovery')).toBeTruthy();expect(screen.getByText('Observe a colleague')).toBeTruthy();expect(screen.getByText('Attend workshop')).toBeTruthy();expect(screen.getByText('Agreed support.')).toBeTruthy();expect(vi.mocked(assessmentIdpFitAction).mock.calls.every(([,generate])=>generate===false)).toBe(true);
 expect(await screen.findByRole('button',{name:en.onehr.insight.generate})).toBeTruthy();expect(assessmentIdpFitAction).toHaveBeenLastCalledWith('person',false,'bg');
 fireEvent.click(screen.getByRole('button',{name:en.onehr.insight.generate}));await waitFor(()=>expect(assessmentIdpFitAction).toHaveBeenLastCalledWith('person',true,'bg'));
 fireEvent.click(screen.getByRole('tab',{name:'Potential'}));expect(await screen.findByText('Technical delivery · Demonstrated')).toBeTruthy();expect(screen.queryByText('Agreed support.')).toBeNull();
});
it('flushes a pending remark before changing tabs and retains the page on a failed save',async()=>{
 render(<Show/>);const remark=await screen.findByLabelText(en.onehr.talentPerson.remark);fireEvent.change(remark,{target:{value:'Read their delivery evidence.'}});vi.mocked(saveAssessmentTalentRemarkAction).mockResolvedValueOnce({error:'Concurrent edit. Refresh.'});
 fireEvent.click(screen.getByRole('tab',{name:'Development plan'}));expect(await screen.findByText('Concurrent edit. Refresh.')).toBeTruthy();expect(screen.getByRole('tab',{name:'Summary'}).getAttribute('aria-selected')).toBe('true');
 expect(vi.mocked(saveAssessmentTalentRemarkAction).mock.calls[0][0].get('remark')).toBe('Read their delivery evidence.');expect(vi.mocked(saveAssessmentTalentRemarkAction).mock.calls[0][0].get('draftRevision')).toBe('0');
 fireEvent.change(remark,{target:{value:'Revised evidence.'}});fireEvent.click(screen.getByRole('tab',{name:'Development plan'}));expect(await screen.findByText('Service recovery')).toBeTruthy();expect(saveAssessmentTalentRemarkAction).toHaveBeenCalledTimes(2);
});
it('ignores a late person frame and displays locked remarks without an editor',async()=>{
 let finish!:(v:Awaited<ReturnType<typeof assessmentTalentPersonAction>>)=>void;vi.mocked(assessmentTalentPersonAction).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({...frame,remark:{remark:'Locked observation.',revision:2,locked:true},plan:null});
 const page=render(<Show/>);page.rerender(<Show id="other"/>);expect(await screen.findByText('Locked observation.')).toBeTruthy();await act(async()=>finish({...frame,remark:{remark:'Old person canary',revision:1,locked:false}}));expect(screen.queryByText('Old person canary')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
});

it('waits for a remark save before sending a lock and refuses the lock if that save fails',async()=>{
 const {AssessmentMutationForm}=await import('../app/(app)/performance/onehr/mutation-form'),{AssessmentDraftForm}=await import('../app/(app)/performance/onehr/draft-form');const lock=vi.fn(),save=vi.fn().mockResolvedValueOnce({error:'Conflicting edit'}).mockResolvedValueOnce({revision:1});
 render(<NextIntlClientProvider locale="en" messages={en}><AssessmentDraftForm revision={0} save={save} action={async()=>{}} labels={{saving:'Saving',saved:'Saved',privateDraft:'Shared BG note',failed:'Save failed'}}><textarea name="remark" aria-label="BG note"/></AssessmentDraftForm><AssessmentMutationForm action={lock}><button type="submit">Lock unit</button></AssessmentMutationForm></NextIntlClientProvider>);
 fireEvent.change(screen.getByLabelText('BG note'),{target:{value:'Preserve before lock'}});fireEvent.click(screen.getByRole('button',{name:'Lock unit'}));expect(await screen.findByText('Conflicting edit')).toBeTruthy();expect(lock).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('BG note'),{target:{value:'Reconciled remark'}});fireEvent.click(screen.getByRole('button',{name:'Lock unit'}));await waitFor(()=>expect(lock).toHaveBeenCalledOnce());expect(save).toHaveBeenCalledTimes(2);expect(save.mock.invocationCallOrder[1]).toBeLessThan(lock.mock.invocationCallOrder[0]);
});
