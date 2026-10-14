import { describe,expect,it } from 'vitest';
import { defaultPolicy,type KPI } from '../packs/performance/onehr/model';
import { leaderWorkspaceParts,reviewerModerationState } from '../packs/performance/onehr/workspace-model';
import framework from '../packs/performance/onehr/framework.json';
const policy=defaultPolicy(framework),open={lockedAt:null,performanceLockedAt:null,potentialLockedAt:null};
describe('source leader workspace views',()=>{
 it('separates Dept and BU Performance/Potential parts and tracks independent locks',()=>{
  expect(leaderWorkspaceParts(policy,'hod',{...open,performanceLockedAt:'confirmed'})).toEqual([{stage:'department_review',axis:'performance',module:'cal',state:'done'},{stage:'department_potential_review',axis:'potential',module:'cal',state:'open'}]);
  expect(leaderWorkspaceParts(policy,'bu',open).map(p=>p.stage)).toEqual(['calibration','potential_calibration']);
 });
 it('keeps BG combined and Group performance-only without misclassifying them as employee PM',()=>{
  expect(leaderWorkspaceParts(policy,'bg',open)).toMatchObject([{module:'cal',stage:'talent_box',axis:'both'}]);
  expect(leaderWorkspaceParts(policy,'group',open)).toMatchObject([{module:'cal',axis:'performance'}]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'group',open)).toEqual([]);
 });
 it('omits disabled axes and every leader part outside year end',()=>{
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'bu',open)).toMatchObject([{axis:'potential'}]);
  expect(leaderWorkspaceParts({...policy,kind:'mid_year'},'hod',open)).toEqual([]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,calibration:false}},'bg',open)).toEqual([]);
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
