import { describe,expect,it } from 'vitest';
import { defaultPolicy,type KPI } from '../packs/performance/onehr/model';
import { assessmentWorkWindowOpen,leaderPendingEntries,leaderWorkspaceParts,type CalibrationWorkEntry,reviewerModerationState,reviewWorkspaceParts } from '../packs/performance/onehr/workspace-model';
import framework from '../packs/performance/onehr/framework.json';
const policy=defaultPolicy(framework),open={lockedAt:null,performanceLockedAt:null,potentialLockedAt:null};
describe('source leader workspace views',()=>{
 it('separates Dept and BU Performance/Potential parts and tracks independent locks',()=>{
  expect(leaderWorkspaceParts(policy,'hod',{...open,performanceLockedAt:'confirmed'})).toEqual([{stage:'department_review',axis:'performance',module:'cal',state:'done'},{stage:'department_potential_review',axis:'potential',module:'cal',state:'open'}]);
  // OneHR's BU CEO has a Talent Box beside the two axis lists (P1 WP-D), only while both axes are on.
  expect(leaderWorkspaceParts(policy,'bu',open).map(p=>p.stage)).toEqual(['calibration','potential_calibration','talent_box']);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,tm:false}},'bu',open).map(p=>p.stage)).toEqual(['calibration']);
 });
 it('keeps BG combined and gives Group its PM table plus a both-axis Talent Box, without misclassifying them as employee PM',()=>{
  expect(leaderWorkspaceParts(policy,'bg',open)).toMatchObject([{module:'cal',stage:'talent_box',axis:'both'}]);
  expect(leaderWorkspaceParts(policy,'group',open)).toMatchObject([{module:'cal',stage:'group_calibration',axis:'performance'},{module:'cal',stage:'talent_box',axis:'both'}]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,tm:false}},'group',open)).toMatchObject([{stage:'group_calibration',axis:'performance'}]);
  expect(leaderWorkspaceParts(policy,'final',open).map(p=>p.stage)).toEqual(['group_calibration']);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'group',open)).toEqual([]);
 });
 it('omits disabled axes and every leader part outside year end',()=>{
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'bu',open)).toMatchObject([{axis:'potential'}]);
  expect(leaderWorkspaceParts({...policy,kind:'mid_year'},'hod',open)).toEqual([]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,calibration:false}},'bg',open)).toEqual([]);
 });
});

describe('shared current review work graph',()=>{
 const kpi={id:'delivery',hrOwned:false,setting:'approved',moderatorEmploymentId:'manager',approvalChain:[{employmentId:'manager',actual:null,remark:'',at:null}],locked:false} as KPI;
 const facts={kpis:[kpi],competenciesAssigned:true,competencyStatus:'submitted',resultsSubmitted:true,managerPerformance:null,planStatus:'shared'};
 it('projects the same manager tasks and cells for UI and actor-neutral reminder readers',()=>{
  expect(reviewWorkspaceParts(policy,facts,{self:false,manager:true,employmentIds:['manager']})).toMatchObject([{module:'pm',stage:'moderation',state:'open',cell:'pm_approve'},{module:'tm',state:'open',cell:'tc_approve'},{module:'idp',state:'open',cell:'idp_review'}]);
  expect(reviewWorkspaceParts(policy,facts,{self:false,manager:false,employmentIds:['outsider']}).filter(p=>p.module!=='idp').map(p=>p.state)).toEqual(['waiting']);
 });
 it('waits for current setting approvers and closes completed steps without trusting previous recipients',()=>{
  const proposed={...kpi,setting:'proposed',approvalChain:[{employmentId:'matrix',actual:null,remark:'',at:null},{employmentId:'manager',actual:null,remark:'',at:null}],settingApprovals:[]} as KPI;
  const work={...facts,kpis:[proposed]};
  expect(reviewWorkspaceParts(policy,work,{self:false,manager:true,employmentIds:['manager']})[0]).toMatchObject({stage:'setting',state:'waiting',cell:'pm_setting_approve'});
  expect(reviewWorkspaceParts(policy,work,{self:false,manager:false,employmentIds:['matrix']})[0].state).toBe('open');
  proposed.settingApprovals=[{employmentId:'matrix',action:'approved',remark:'',at:new Date().toISOString()}];
  expect(reviewWorkspaceParts(policy,work,{self:false,manager:true,employmentIds:['manager']})[0].state).toBe('open');
 });
 it('keeps the employee plan later while required assessments are unfinished and omits disabled modules',()=>{
  const work={...facts,planStatus:null,resultsSubmitted:false,competencyStatus:"pending"};
  expect(reviewWorkspaceParts(policy,work,{self:true,manager:false,employmentIds:['employee']}).find(p=>p.module==='idp')).toMatchObject({state:'later',locked:true});
  expect(reviewWorkspaceParts({...policy,modules:{pm:false,tm:false,idp:false,evidence:false}},work,{self:true,manager:false,employmentIds:['employee']})).toEqual([]);
 });
 it('uses the same exclusive window cutoff as the canonical writer, including the opening instant',()=>{
  const now=new Date(),opensAt=now.toISOString(),closesAt=new Date(now.getTime()+60_000).toISOString();
  const configured={...policy,windows:{pm_approve:{opensAt,closesAt}}};
  expect(assessmentWorkWindowOpen(configured,'pm_approve',new Date(now.getTime()-1))).toBe(false);
  expect(assessmentWorkWindowOpen(configured,'pm_approve',now)).toBe(true);
  expect(assessmentWorkWindowOpen(configured,'pm_approve',new Date(closesAt))).toBe(false);
 });
});

describe('reviewer worklist completion',()=>{
 const line=(id:string,steps:{employmentId:string;at:string|null}[],locked=false)=>({id,hrOwned:false,moderatorEmploymentId:steps[0]?.employmentId??null,approvalChain:steps,locked}) as KPI;
 it('finishes the current reviewer while another reviewer still owes a different KPI',()=>{
  const kpis=[line('mine',[{employmentId:'manager',at:'confirmed'}],true),line('theirs',[{employmentId:'matrix',at:null}])];
  expect(reviewerModerationState(kpis,['manager'])).toBe('done');
  expect(reviewerModerationState(kpis,['matrix'])).toBe('open');
  expect(reviewerModerationState(kpis,['outsider'])).toBe('waiting');
 });
 it('waits for a prior approver and marks a completed earlier step done without locking the whole chain',()=>{
  const kpi=line('shared',[{employmentId:'first',at:null},{employmentId:'second',at:null}]);
  expect(reviewerModerationState([kpi],['second'])).toBe('waiting');
  kpi.approvalChain![0].at='confirmed';
  expect(reviewerModerationState([kpi],['first'])).toBe('done');
  expect(reviewerModerationState([kpi],['second'])).toBe('open');
 });
 it('keeps an actionable remaining KPI open and ignores company-owned results',()=>{
  const first=line('first',[{employmentId:'manager',at:'confirmed'}],true),second=line('second',[{employmentId:'manager',at:null}]);
  expect(reviewerModerationState([first,second],['manager'])).toBe('open');
  second.hrOwned=true;expect(reviewerModerationState([first,second],['manager'])).toBe('done');
  expect(reviewerModerationState([second],['manager'])).toBe('waiting');
 });
});


describe('leader work completion from canonical locks',()=>{
 const entry:CalibrationWorkEntry={reviewId:'review',companyId:'company',employmentId:'job',personId:'person',performanceLocked:false,potentialLocked:false,performanceReady:true,frozen:false,decisions:[]};
 it('stops BG reminders after both unit axes are confirmed while retaining a pending independent axis',()=>{
  expect(leaderPendingEntries(policy,'bg','both',[{...entry,performanceLocked:true,potentialLocked:true}])).toEqual([]);
  expect(leaderPendingEntries(policy,'bg','both',[{...entry,performanceLocked:true}])).toHaveLength(1);
  expect(leaderPendingEntries({...policy,modules:{...policy.modules,tm:false}},'bg','both',[{...entry,performanceLocked:true}])).toEqual([]);
 });
 it('keeps the separate HOD department submission after person saves and respects downstream axis locks',()=>{
  const saved={...entry,performanceLocked:true,potentialLocked:true};
  expect(leaderPendingEntries(policy,'hod','performance',[saved])).toHaveLength(1);
  const downstream={...saved,decisions:[{tier:'bu' as const,performanceLocked:true,potentialLocked:false}]};
  expect(leaderPendingEntries(policy,'hod','performance',[downstream])).toEqual([]);
  expect(leaderPendingEntries(policy,'hod','potential',[downstream])).toHaveLength(1);
 });
 it('omits frozen people and waits for manager confirmation before Group review',()=>{
  expect(leaderPendingEntries(policy,'bg','both',[{...entry,frozen:true}])).toEqual([]);
  expect(leaderPendingEntries(policy,'group','performance',[{...entry,performanceReady:false}])).toEqual([]);
  expect(leaderPendingEntries(policy,'group','performance',[entry])).toHaveLength(1);
  expect(leaderPendingEntries(policy,'group','performance',[{...entry,performanceLocked:true}])).toEqual([]);
 });
});
