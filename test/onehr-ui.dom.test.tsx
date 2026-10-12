import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
const ports=vi.hoisted(()=>({calibration:vi.fn(),session:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('../lib/scope',()=>({scopedSession:ports.session}));
vi.mock('../packs/performance/service',()=>({getOnehrCalibration:ports.calibration}));
vi.mock('../app/performance/onehr-actions',()=>({onehrReviewAction:vi.fn(),onehrCalibrationAction:vi.fn(),onehrFeedbackAction:vi.fn(),onehrDraftAction:vi.fn()}));
vi.mock('../app/performance/actions',()=>({uploadAttachmentAction:vi.fn()}));
import CalibrationPage from '../app/performance/onehr/calibration/[sessionId]/page';
import { KpiEditor } from '../app/performance/onehr/kpi-editor';
import { OnehrReviewView } from '../app/performance/onehr/review-view';
const show=(element:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue({s:{tenantId:'tenant'}});});
afterEach(cleanup);

describe('OneHR native workflow controls',()=>{
 it('adds KPIs with the company-configured B mechanism',()=>{
  show(<KpiEditor reviewId="review" revision={1} kpis={[]} moderators={[{id:'manager',name:'Manager'}]} reviewerEmploymentId="manager" mechanism="B" labels={en.onehr as unknown as Record<string,string>}/>);
  fireEvent.click(screen.getByRole('button',{name:en.onehr.addKpi}));
  expect(document.querySelector('input[name$=".mechanism"]')?.getAttribute('value')).toBe('B');
  expect(screen.getByLabelText(en.onehr.target)).toBeTruthy();
  expect(screen.queryByRole('option',{name:en.onehr.mechanismA})).toBeNull();
 });
 it('keeps a locked performance axis visible while leaving only potential editable',async()=>{
  ports.calibration.mockResolvedValue({session:{name:'BU review',tier:'bu',revision:2,performanceLockedAt:'now',potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},modules:{pm:true,tm:true},reference:null,rows:[{name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:'High',currentPerformance:'ME',currentPotential:'High',entry:{id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:'now',potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:''}}]});
  show(await CalibrationPage({params:Promise.resolve({sessionId:'session'}),searchParams:Promise.resolve({})}));
  expect(screen.queryByLabelText(en.onehr.performance)).toBeNull();expect(screen.getByLabelText(en.onehr.potential)).toBeTruthy();
  for(const select of screen.getAllByLabelText(en.onehr.assessmentAxis))expect((select as HTMLSelectElement).value).toBe('potential');
  expect(ports.session).toHaveBeenCalledOnce();
 });
 it('offers explicit talent decisions for the enabled performance-only assessment',async()=>{
  ports.calibration.mockResolvedValue({session:{name:'Group review',tier:'group',revision:2,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},modules:{pm:true,tm:false},reference:null,rows:[{name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:null,currentPerformance:'ME',currentPotential:null,entry:{id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:'',pip:false,promotion:false,specialReward:false}}]});
  show(await CalibrationPage({params:Promise.resolve({sessionId:'session'}),searchParams:Promise.resolve({})}));
  expect(screen.getByLabelText(en.onehr.promotion)).toBeTruthy();expect(screen.queryByLabelText(en.onehr.potential)).toBeNull();
  expect(document.querySelector('input[name="confirmTalentDecisions"]')).toBeTruthy();
 });
 it('renders evidence and nominations without reviving the generic rating form',async()=>{
  const policy=defaultPolicy(framework);policy.modules={pm:false,tm:false,idp:false,evidence:true};
  const v={reviewId:'review',name:'Employee',cycle:{id:'cycle',name:'Annual',status:'open'},policy,grade:'12',revision:1,self:true,manager:false,admin:false,moderator:false,mechanism:'A',viewerUserId:'subject',reviewerEmploymentId:'manager',canModerateIds:[],moderators:[],kpis:[],competencies:[],competencyStatus:'pending',resultsSubmitted:false,managerPerformance:null,managerScore:null,managerRemark:'',potential:null,finalized:false,result:null,plans:[],planYear:2027,feedbackReport:[],peers:[],choices:[],attachments:[],aiEnabled:false,evidence:[{id:'evidence',kind:'delivery',body:'Delivered the release.',occurredOn:'2026-10-12',state:'shared',authorUserId:'manager',responses:[{userId:'manager',stance:'endorse',note:'Verified delivery',at:'2026-10-12T00:00:00.000Z'}]}]};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v']}));
  expect(screen.getByText('Delivered the release.')).toBeTruthy();expect(screen.getByLabelText(en.onehr.evidenceResponse)).toBeTruthy();expect(screen.getByLabelText(en.onehr.correctsEvidence)).toBeTruthy();expect(screen.getByLabelText(en.onehr.attachmentFile)).toBeTruthy();
  expect(document.querySelector('input[name="overallRating"]')).toBeNull();
 });
});
