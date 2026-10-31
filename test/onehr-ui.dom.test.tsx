vi.mock('../app/(app)/performance/assessment-rewrite-actions',()=>({rewriteAssessmentFieldAction:vi.fn()}));
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import { emptyTalentActions } from '../packs/performance/onehr/talent-model';
import framework from '../packs/performance/onehr/framework.json';
import { todayInKualaLumpur } from '../lib/hr-date';
const ports=vi.hoisted(()=>({calibration:vi.fn(),person:vi.fn(),session:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('next/navigation',async importActual=>({...await importActual<typeof import('next/navigation')>(),useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../lib/scope',()=>({scopedSession:ports.session}));
// D-P1-32 PT-X2: the session page reads the Calibration strip's gate facts; none here, so the strip draws nothing.
vi.mock('../packs/performance/service',()=>({getOnehrCalibration:ports.calibration,getPerformanceAreaFacts:async()=>({performanceOn:false,items:[],ownFeedbackReport:'none'})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentCalibrationPersonAction:ports.person,assessmentTalentPersonAction:vi.fn().mockResolvedValue({error:'No person frame in this fixture.'}),assessmentTalentInsightAction:vi.fn().mockResolvedValue({pending:true,source:null,data:null}),saveCalibrationBandAction:vi.fn(),assessmentInsightAction:vi.fn(),onehrReviewAction:vi.fn(),agreeDepartmentAction:vi.fn(),onehrCalibrationAction:vi.fn(),onehrFeedbackAction:vi.fn(),onehrDraftAction:vi.fn(),saveAssessmentDraftAction:vi.fn(),saveAssessmentKpiSettingAction:vi.fn().mockResolvedValue({revision:2})}));
vi.mock('../app/(app)/performance/actions',()=>({uploadAttachmentAction:vi.fn()}));
import CalibrationPage from '../app/(app)/performance/assessment/calibration/[sessionId]/page';
import { AssessmentCalibrationView } from '../app/(app)/performance/onehr/calibration-view';
import { KpiEditor } from '../app/(app)/performance/onehr/kpi-editor';
import { OnehrReviewView } from '../app/(app)/performance/onehr/review-view';
import { ItemNavigator } from '../app/(app)/performance/workspace/item-navigator';
const show=(element:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
/** Every element of `type` in a returned element tree, walking props.children (the page wraps the view, PT-X2). */
function elementsOf(node:React.ReactNode,type:unknown):React.ReactElement[]{
 if(Array.isArray(node))return node.flatMap(child=>elementsOf(child,type));
 if(!React.isValidElement(node))return [];
 const el=node as React.ReactElement<{children?:React.ReactNode}>;
 return el.type===type?[el]:elementsOf(el.props.children,type);
}
async function calibrationScreen(){
 const page=await CalibrationPage({params:Promise.resolve({sessionId:'session'}),searchParams:Promise.resolve({})});
 // Since D-P1-32 PT-X2 the page is the Calibration strip above the view; the view itself is still the one screen.
 const views=elementsOf(page,AssessmentCalibrationView);
 expect(views).toHaveLength(1);
 return AssessmentCalibrationView(views[0]!.props as Parameters<typeof AssessmentCalibrationView>[0]);
}
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue({s:{tenantId:'tenant'}});});
afterEach(cleanup);

describe('OneHR native workflow controls',()=>{
 it('reads edits made before the phone navigator mounts and tracks subsequent target changes',()=>{
  const items=[{id:'kpi-first',title:'Original',meta:'50%',done:true,fields:[],setting:true}];
  const widget=<form data-assessment-draft><input name="kpiId" value="first" readOnly/><input name="first.mechanism" value="A" readOnly/><input name="first.method" value="more" readOnly/><label>Title<input name="first.title" defaultValue="Current wording"/></label><label>Weight<input name="first.weight" defaultValue="40"/></label>{[0,1,2,3,4].map(i=><label key={i}>Rate {i}<input name={`first.rate.${i}`} defaultValue={i===4?'':String(i)}/></label>)}</form>;
  const ui=show(widget);ui.rerender(<NextIntlClientProvider locale="en" messages={en}>{widget}<ItemNavigator title="Setting" items={items}/></NextIntlClientProvider>);
  expect(screen.getByText('0 of 1 complete')).toBeTruthy();expect(screen.getByText('Current wording')).toBeTruthy();expect(screen.getByText('40%')).toBeTruthy();
  fireEvent.input(screen.getByLabelText('Rate 4'),{target:{value:'4'}});expect(screen.getByText('1 of 1 complete')).toBeTruthy();
 });
 it('adds KPIs with the company-configured B mechanism',()=>{
  show(<KpiEditor reviewId="review" revision={1} kpis={[]} moderators={[{id:'manager',name:'Manager'}]} reviewerEmploymentId="manager" mechanism="B" labels={en.onehr as unknown as Record<string,string>}/>);
  fireEvent.click(screen.getByRole('button',{name:en.onehr.addKpi}));
  expect(document.querySelector('input[name$=".mechanism"]')?.getAttribute('value')).toBe('B');
  expect(screen.getByLabelText(en.onehr.target)).toBeTruthy();
  expect(screen.queryByRole('option',{name:en.onehr.mechanismA})).toBeNull();
 });
 it('generates library thresholds without losing other unsaved fields and omits the unused excellence multiplier',()=>{
  const id=crypto.randomUUID(),libraryId=crypto.randomUUID(),managerId=crypto.randomUUID(),k={id,libraryId,title:'Delivery',description:'Original wording',weightBp:10000,unit:'units',moderatorEmploymentId:managerId,scoring:{mechanism:'A' as const,method:'more' as const,target:100,rates:[80,90,100,110,120] as [number,number,number,number,number]},setting:'draft' as const,settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false};
  show(<KpiEditor reviewId={crypto.randomUUID()} revision={1} kpis={[k]} moderators={[{id:managerId,name:'Manager'}]} reviewerEmploymentId={managerId} mechanism="A" labels={en.onehr as unknown as Record<string,string>} library={[{id:libraryId,revision:1,title:'Delivery',description:'Original wording',category:'',unit:'units',weightBp:10000,scoring:k.scoring,spread:{rate:[80,90,100,110,120]}}]}/>);
  fireEvent.change(screen.getByLabelText(en.onehr.description),{target:{value:'Retain my unsaved wording'}});fireEvent.change(screen.getByLabelText(en.onehr.target),{target:{value:'250'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.generateTargets}));
  expect((screen.getByLabelText(`${en.onehr.threshold} 3`) as HTMLInputElement).value).toBe('250');expect((screen.getByLabelText(`${en.onehr.threshold} 1`) as HTMLInputElement).value).toBe('200');expect((screen.getByLabelText(en.onehr.description) as HTMLTextAreaElement).value).toBe('Retain my unsaved wording');
  cleanup();show(<KpiEditor reviewId={crypto.randomUUID()} revision={1} kpis={[]} moderators={[]} reviewerEmploymentId={null} mechanism="B" variant="excellence" labels={en.onehr as unknown as Record<string,string>}/>);fireEvent.click(screen.getByRole('button',{name:en.onehr.addKpi}));expect(screen.queryByLabelText(en.onehr.multiple)).toBeNull();expect(screen.getByLabelText(en.onehr.excellence)).toBeTruthy();
 });
 it('keeps a locked performance axis visible while leaving only potential editable',async()=>{
  ports.calibration.mockResolvedValue({session:{name:'BU review',tier:'bu',revision:2,performanceLockedAt:'now',potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},axes:{pm:true,pot:true},units:[],modules:{pm:true,tm:true},reference:null,rows:[{canWrite:{pm:true,pot:true},talent:{revision:0,promotionEligible:false,standingReason:null},name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:'High',currentPerformance:'ME',currentPotential:'High',entry:{...emptyTalentActions(),id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:'now',potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:''}}]});
  show(await calibrationScreen());
  expect(screen.queryByLabelText(en.onehr.performance)).toBeNull();expect(screen.getByLabelText(en.onehr.potential)).toBeTruthy();
  for(const select of screen.getAllByLabelText(en.onehr.assessmentAxis))expect((select as HTMLSelectElement).value).toBe('potential');
  expect(ports.session).toHaveBeenCalledOnce();
 });
 it('renders only the selected Dept/BU calibration axis inside the source CAL workspace',async()=>{
  const v={session:{name:'Department review',tier:'hod',revision:2,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},axes:{pm:true,pot:true},units:[],modules:{pm:true,tm:true},reference:null,rows:[{canWrite:{pm:true,pot:true},talent:{revision:0,promotionEligible:false,standingReason:null},name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:'High',currentPerformance:'ME',currentPotential:'High',entry:{...emptyTalentActions(),id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:''}}]};
  ports.person.mockResolvedValue({...v,row:v.rows[0],held:{lines:[],focus:null,requestId:null,navigation:false}});
  show(await AssessmentCalibrationView({v:v as unknown as Parameters<typeof AssessmentCalibrationView>[0]['v'],embedded:true,axis:'potential'}));
  expect(ports.person).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Employee'}));
  expect(screen.queryByLabelText(en.onehr.performance)).toBeNull();expect(await screen.findByLabelText(en.onehr.potential)).toBeTruthy();expect(screen.queryByText(en.onehr.talentGrid)).toBeNull();
  expect(screen.queryByLabelText(en.onehr.assessmentAxis)).toBeNull();const axisInputs=Array.from(document.querySelectorAll<HTMLInputElement>('input[name=axis]'));expect(axisInputs.length).toBeGreaterThan(0);expect(axisInputs.every(input=>input.value==='potential')).toBe(true);
 });
 it('renders the actual BG workspace Talent Box and opens both axes from its grid',async()=>{
  const v={session:{id:'session',name:'BG review',tier:'bg',revision:2,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},axes:{pm:true,pot:true},units:[],modules:{pm:true,tm:true},reference:null,rows:[{companyId:'company',canWrite:{pm:true,pot:true},talent:{revision:0,promotionEligible:false,standingReason:null},name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:'High',currentPerformance:'ME',currentPotential:'High',entry:{...emptyTalentActions(),id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:''}}]};
  ports.person.mockResolvedValue({...v,row:v.rows[0],held:{lines:[],focus:null,requestId:null,navigation:false}});
  show(await AssessmentCalibrationView({v:v as unknown as Parameters<typeof AssessmentCalibrationView>[0]['v'],embedded:true,axis:'both'}));
  expect(screen.queryByRole('button',{name:en.onehr.lockCalibration})).toBeNull();
  expect(screen.queryByRole('button',{name:'15'})).toBeNull();fireEvent.click(within(screen.getByRole('region',{name:en.onehr.talentBoard.title})).getByRole('button',{name:'Employee'}));
  expect(await screen.findByRole('region',{name:'Employee'})).toBeTruthy();expect(screen.getByRole('tab',{name:'Summary'})).toBeTruthy();expect(await screen.findByLabelText(en.onehr.performance)).toBeTruthy();expect(screen.getByLabelText(en.onehr.potential)).toBeTruthy();
 });
 it('passes the current development allowance to the actual editable-plan suggestion control',async()=>{
  const v={policy:defaultPolicy(framework),drafts:[],careerRoutes:[],moderators:[],choices:[],kpis:[],competencies:[],peers:[],attachments:[],evidence:[],attachmentLinks:[],kpiLibrary:[],reviewId:'review',revision:1,cycle:{id:'cycle',name:'Annual',status:'open'},admin:false,self:true,manager:false,moderator:false,planReviewer:false,planRemarkWriter:false,finalized:false,canApproveSettingIds:[],canModerateIds:[],careerProfile:null,planYear:Number(todayInKualaLumpur().slice(0,4))+1,plans:[],aiEnabled:true,aiFeatures:{pm:true,tc:true,idp:true,review:true,calib:true,"360":true},developmentQuota:{remaining:0,limit:5}};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v'],section:'idp'}));
  expect((screen.getByRole('button',{name:en.onehr.developmentSuggestions.generate}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('status').textContent).toContain('0 of 5');
 });
 it('keeps talent decisions separate from an open calibration',async()=>{
  ports.calibration.mockResolvedValue({session:{name:'Group review',tier:'group',revision:2,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},cycle:{name:'Annual'},axes:{pm:true,pot:false},units:[],modules:{pm:true,tm:false},reference:null,rows:[{canWrite:{pm:true,pot:true},talent:{revision:0,promotionEligible:false,standingReason:null},name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:null,currentPerformance:'ME',currentPotential:null,entry:{...emptyTalentActions(),id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:'',pip:false,promotion:false,specialReward:false}}]});
  show(await calibrationScreen());
  expect(screen.queryByLabelText(en.onehr.promotion)).toBeNull();expect(screen.queryByLabelText(en.onehr.specialReward)).toBeNull();expect(screen.queryByLabelText(en.onehr.potential)).toBeNull();
  expect(document.querySelector('input[name="confirmTalentDecisions"]')).toBeNull();
 });
 it('offers setting approval to the matrix reviewer whose chain step is pending',async()=>{
  const policy=defaultPolicy(framework);policy.modules={pm:true,tm:false,idp:false,evidence:false};
  const v={careerRoutes:[],profile:null,profileMatch:null,drafts:[],attachmentLinks:[],kpiLibrary:[],companyId:'company',anonymousFeedback:null,selfRemark:'',competencySelfRemark:'',competencyManagerRemark:'',calculatedPerformance:null,planReviewer:false,reviewId:'review',name:'Employee',cycle:{id:'cycle',name:'Annual',status:'open'},policy,grade:'12',revision:1,self:false,manager:false,admin:false,moderator:true,mechanism:'A',viewerUserId:'matrix',reviewerEmploymentId:'manager',canApproveSettingIds:['kpi'],canModerateIds:[],moderators:[],kpis:[{id:'kpi',title:'Assigned objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},setting:'proposed',settingRemark:'',approvalChain:[],actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}],competencies:[],competencyStatus:'pending',resultsSubmitted:false,managerPerformance:null,managerScore:null,managerRemark:'',potential:null,finalized:false,result:null,plans:[],planYear:Number(todayInKualaLumpur().slice(0,4))+1,feedbackReport:[],peers:[],choices:[],attachments:[],aiEnabled:false,aiFeatures:{pm:false,tc:false,idp:false,review:false,calib:false,"360":false},evidence:[]};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v']}));
  expect(screen.getByRole('button',{name:en.onehr.approve})).toBeTruthy();expect(screen.getByRole('button',{name:en.onehr.return})).toBeTruthy();
  expect(screen.queryByText(en.onehr.developmentPlan)).toBeNull();
 });
 it('renders the career conversation label as text and keeps co-reviewer overall feedback readonly',async()=>{
  const v={policy:defaultPolicy(framework),drafts:[],careerRoutes:[],moderators:[],choices:[],kpis:[],competencies:[],peers:[],attachments:[],evidence:[],attachmentLinks:[],kpiLibrary:[],reviewId:'review',revision:1,cycle:{id:'cycle',name:'Annual',status:'open'},admin:false,self:false,manager:false,moderator:true,planReviewer:true,planRemarkWriter:false,finalized:false,canApproveSettingIds:[],canModerateIds:[],careerProfile:null,planYear:2027,plans:[{id:'plan',planYear:2027,revision:1,status:'shared',career:{aspiration:'Learn facilitation',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:crypto.randomUUID(),area:'Facilitation',dueOn:'',onJob:'Lead the workshop',fromOthers:'',formalLearning:'',status:'not_started',managerComment:'Add a retrospective after the workshop.'}],managerComment:'Line manager owns this feedback',conversation:'',conversationHeldOn:null}]};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v'],section:'idp'}));
  expect(screen.getByLabelText(en.onehr.careerConversation)).toBeTruthy();
  expect((within(screen.getByLabelText(en.onehr.careerConversation).closest('form')!).getByLabelText(en.onehr.managerComment) as HTMLTextAreaElement).readOnly).toBe(true);
  expect(screen.getByText(en.onehr.planRemarkOwnerHelp)).toBeTruthy();
  expect(screen.queryByText('onehr.conversation')).toBeNull();expect(screen.getAllByText(/Add a retrospective after the workshop\./).some(node=>node.tagName==='P')).toBe(true);
 });
 it('offers each release before finalization and explains the working result',async()=>{
  const v={policy:defaultPolicy(framework),drafts:[],careerRoutes:[],moderators:[],choices:[],kpis:[],competencies:[],plans:[],peers:[],attachments:[],evidence:[],attachmentLinks:[],kpiLibrary:[],reviewId:'review',revision:1,cycle:{id:'cycle',name:'Annual',status:'open'},admin:true,self:false,manager:false,moderator:false,finalized:false,canApproveSettingIds:[],canModerateIds:[],result:{id:'review',digest:null,interim:true,performance:'ME',potential:null,talent:null,performanceReleased:true,potentialReleased:false,talentReleased:false,feedbackReleased:false}};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v'],section:'admin'}));
  expect(screen.getAllByRole('button',{name:en.onehr.release})).toHaveLength(3);
  expect(screen.getByRole('button',{name:en.onehr.revoke})).toBeTruthy();
  expect(screen.getByText(en.onehr.interimReleaseHelp)).toBeTruthy();
  expect(document.querySelectorAll('input[name="component"]')).toHaveLength(4);
 });
 it('renders quarterly status choices instead of numeric result submission',async()=>{
  const policy=defaultPolicy(framework);policy.kind='quarterly';policy.modules={pm:true,tm:false,idp:false,evidence:false};
  const v={careerRoutes:[],profile:null,profileMatch:null,drafts:[],attachmentLinks:[],kpiLibrary:[],companyId:'company',anonymousFeedback:null,selfRemark:'',competencySelfRemark:'',competencyManagerRemark:'',calculatedPerformance:null,planReviewer:false,reviewId:'review',name:'Employee',cycle:{id:'cycle',name:'Quarterly',status:'open'},policy,grade:'12',revision:1,self:true,manager:false,admin:false,moderator:false,mechanism:'A',viewerUserId:'subject',reviewerEmploymentId:'manager',canApproveSettingIds:[],canModerateIds:[],moderators:[],kpis:[{id:'kpi',title:'Agreed objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},setting:'approved',settingRemark:'',approvalChain:[],actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}],competencies:[],competencyStatus:'pending',resultsSubmitted:false,managerPerformance:null,managerScore:null,managerRemark:'',potential:null,finalized:false,result:null,plans:[],planYear:Number(todayInKualaLumpur().slice(0,4)),feedbackReport:[],peers:[],choices:[],attachments:[],aiEnabled:false,aiFeatures:{pm:false,tc:false,idp:false,review:false,calib:false,"360":false},evidence:[]};
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v']}));
  expect(screen.getByLabelText(en.onehr.quarterlyCheckIn)).toBeTruthy();expect(screen.getByRole('option',{name:en.onehr.checkInAnswers.at_risk})).toBeTruthy();
  expect(screen.queryByRole('button',{name:en.onehr.submitResults})).toBeNull();expect(screen.queryByLabelText(en.onehr.actual)).toBeNull();
  cleanup();policy.kind='year_end';policy.modules.evidence=true;
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v'],section:'pm'}));
  const file=screen.getByLabelText(en.onehr.evidenceFile) as HTMLInputElement;
  const upload=document.getElementById('kpi-file-kpi') as HTMLFormElement,result=document.querySelector('form[data-assessment-draft]') as HTMLFormElement;
  expect(file.form).toBe(upload);expect(result.contains(file)).toBe(true);expect(new FormData(result).has('file')).toBe(false);
  expect(result.querySelector('form')).toBeNull();expect(screen.getByText(en.onehr.evidenceFiles.limits)).toBeTruthy();

 });
 it('renders evidence and nominations without reviving the generic rating form',async()=>{
  const policy=defaultPolicy(framework);policy.modules={pm:false,tm:false,idp:false,evidence:true};
  const v={careerRoutes:[],profile:null,profileMatch:null,drafts:[],attachmentLinks:[],kpiLibrary:[],companyId:'company',anonymousFeedback:null,selfRemark:'',competencySelfRemark:'',competencyManagerRemark:'',calculatedPerformance:null,planReviewer:false,reviewId:'review',name:'Employee',cycle:{id:'cycle',name:'Annual',status:'open'},policy,grade:'12',revision:1,self:true,manager:false,admin:false,moderator:false,mechanism:'A',viewerUserId:'subject',reviewerEmploymentId:'manager',canApproveSettingIds:[],canModerateIds:[],moderators:[],kpis:[],competencies:[],competencyStatus:'pending',resultsSubmitted:false,managerPerformance:null,managerScore:null,managerRemark:'',potential:null,finalized:false,result:null,plans:[],planYear:Number(todayInKualaLumpur().slice(0,4))+1,feedbackReport:[],peers:[],choices:[],attachments:[],aiEnabled:false,aiFeatures:{pm:false,tc:false,idp:false,review:false,calib:false,"360":false},evidence:[{id:'evidence',kind:'delivery',body:'Delivered the release.',occurredOn:todayInKualaLumpur(),state:'shared',authorUserId:'manager',responses:[{userId:'manager',stance:'endorse',note:'Verified delivery',at:new Date().toISOString()}]}]};
  v.evidence.push({...v.evidence[0],id:'own-evidence',kind:'recognition',authorUserId:'subject',body:'Prepared supporting proof.',responses:[]});
  show(await OnehrReviewView({v:v as unknown as Parameters<typeof OnehrReviewView>[0]['v']}));
  expect(screen.getByText('Delivered the release.')).toBeTruthy();expect(screen.getByLabelText(en.onehr.evidenceResponse)).toBeTruthy();expect(screen.getByLabelText(en.onehr.correctsEvidence)).toBeTruthy();expect(screen.getByLabelText(en.onehr.evidenceFile)).toBeTruthy();
  expect(document.querySelector('input[name="overallRating"]')).toBeNull();
  cleanup();
  const skillView={...v,competencySelfSections:{},competencyManagerSections:{},policy:{...policy,modules:{...policy.modules,tm:true}},competencies:[{id:'analysis-3',principle:'Analysis',text:'Analyse current work',skillTitle:'Analysis',skillLevel:3,future:false,self:null,manager:null,selfRemark:'',managerRemark:''},{id:'analysis-4',principle:'Analysis',text:'Lead an analysis',skillTitle:'Analysis',skillLevel:4,future:true,self:null,manager:null,selfRemark:'',managerRemark:''}]};
  show(await OnehrReviewView({v:skillView as unknown as Parameters<typeof OnehrReviewView>[0]['v'],section:'tm'}));
  expect(screen.getByRole('group',{name:'Analysis Level 3'})).toBeTruthy();expect(screen.getByRole('group',{name:'Analysis Level 4'})).toBeTruthy();
  expect(screen.getByText(en.onehr.competencyScope.current)).toBeTruthy();expect(screen.getByText(en.onehr.competencyScope.future)).toBeTruthy();

 });
});
