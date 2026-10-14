import { describe,expect,it } from 'vitest';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { assessmentReminderWork,type ReminderWorkGraph } from '../packs/performance/onehr/reminder-work';

const now=new Date(),open=new Date(now.getTime()-60_000).toISOString(),close=new Date(now.getTime()+60_000).toISOString();
function graph():ReminderWorkGraph{
 return {
  cycle:{id:'cycle',name:'Annual assessment',companyId:null,periodEnd:now.toISOString().slice(0,10),policy:defaultPolicy(framework)},
  actors:[{userId:'employee',personId:'employee-person',name:'Employee',employmentIds:['employee-job'],cycleAdmin:false},{userId:'manager',personId:'manager-person',name:'Manager',employmentIds:['manager-job','matrix-job'],cycleAdmin:false},{userId:'outsider',personId:'outsider-person',name:'Other manager',employmentIds:['other-job'],cycleAdmin:false}],
  reviews:[{id:'review',companyId:'company',employmentId:'employee-job',personId:'employee-person',name:'Employee',reviewerEmploymentId:'manager-job',moderatorIds:['manager-job','matrix-job'],frozen:false,facts:{kpis:[{hrOwned:false,setting:'approved',locked:false,moderatorEmploymentId:'matrix-job',approvalChain:[{employmentId:'matrix-job',at:null}],checkIn:false}],competenciesAssigned:true,competencyStatus:'submitted',resultsSubmitted:true,managerPerformance:null,planStatus:'shared'}}],
  panels:[{id:'feedback',employmentId:'manager-job',reviewId:'review'}],sessions:[],
 };
}
const companies=new Set(['company']);
describe('current per-login assessment reminder summary',()=>{
 it('combines own, team and feedback tasks once per login across multiple employments',()=>{
  const g=graph();g.reviews.push({...g.reviews[0],id:'manager-review',employmentId:'manager-job',personId:'manager-person',name:'Manager',reviewerEmploymentId:'other-job',moderatorIds:['other-job'],facts:{...g.reviews[0].facts,resultsSubmitted:false,competencyStatus:'pending',planStatus:'closed'}});
  const recipients=assessmentReminderWork(g,companies,now),manager=recipients.find(r=>r.userId==='manager')!;
  expect(manager.tasks.map(t=>t.key)).toEqual(['own_results','own_competency','feedback','team_results','team_competency','team_plan']);
  expect(manager.tasks.find(t=>t.key==='team_results')).toEqual({key:'team_results',count:1,closesAt:null,people:['Employee']});
  expect(manager.employmentIds).toEqual(['manager-job','matrix-job']);
  expect(recipients.find(r=>r.userId==='outsider')).toBeUndefined();
 });
 it('checks the current approval step and exclusive window cutoff without notifying a later approver',()=>{
  const g=graph(),kpi=g.reviews[0].facts.kpis[0];g.panels=[];g.reviews[0].facts.competenciesAssigned=false;g.reviews[0].facts.planStatus='closed';
  kpi.setting='proposed';kpi.approvalChain=[{employmentId:'other-job',at:null},{employmentId:'manager-job',at:null}];g.reviews[0].moderatorIds.push('other-job');
  g.cycle.policy.windows.pm_setting_approve={opensAt:open,closesAt:close};
  expect(assessmentReminderWork(g,companies,now).map(r=>r.userId)).toEqual(['outsider']);
  kpi.settingApprovals=[{action:'approved'}];
  expect(assessmentReminderWork(g,companies,now).map(r=>r.userId)).toEqual(['manager']);
  expect(assessmentReminderWork(g,companies,new Date(close))).toEqual([]);
 });
 it('keeps IDP review after a rating freeze but suppresses PM, TC and feedback',()=>{
  const g=graph();g.reviews[0].frozen=true;
  expect(assessmentReminderWork(g,companies,now)).toMatchObject([{userId:'manager',tasks:[{key:'team_plan'}]}]);
  expect(assessmentReminderWork(g,companies,now)[0].tasks).toHaveLength(1);
  g.reviews[0].facts.planStatus='closed';expect(assessmentReminderWork(g,companies,now)).toEqual([]);
 });
 it('honors company grants and cycle module switches without treating a group cycle as a universal grant',()=>{
  const g=graph();expect(assessmentReminderWork(g,new Set(),now)).toEqual([]);
  g.cycle.policy.modules={pm:false,tm:false,idp:false,evidence:false,calibration:false};
  expect(assessmentReminderWork(g,companies,now)).toEqual([]);
 });
 it('omits own setting and locked career work, with team names capped while retaining the real count',()=>{
  const g=graph();g.panels=[];
  g.reviews[0].facts={...g.reviews[0].facts,kpis:[{...g.reviews[0].facts.kpis[0],setting:'draft'}],resultsSubmitted:false,competencyStatus:'pending',planStatus:null};
  expect(assessmentReminderWork(g,companies,now).find(r=>r.userId==='employee')?.tasks.map(t=>t.key)).toEqual(['own_competency']);
  g.reviews=[];
  for(let n=0;n<5;n++)g.reviews.push({...graph().reviews[0],id:`review-${n}`,personId:`person-${n}`,name:`Person ${n}`});
  const task=assessmentReminderWork(g,companies,now).find(r=>r.userId==='manager')!.tasks.find(t=>t.key==='team_results')!;
  expect(task).toMatchObject({count:5,people:['Person 0','Person 1','Person 2']});
 });
 it('hides a BG reviewer own assessment while keeping their pending colleague feedback',()=>{
  const g=graph();g.reviews[0].facts.resultsSubmitted=false;g.reviews[0].facts.competencyStatus='pending';
  g.sessions=[{id:'bg',companyId:'company',tier:'bg',reviewerUserIds:['employee'],adminUserIds:[],lockedAt:null,performanceLockedAt:null,potentialLockedAt:null,entries:[{reviewId:'review',companyId:'company',personId:'employee-person',employmentId:'employee-job',performanceLocked:false,performanceReady:true}]}];
  expect(assessmentReminderWork(g,companies,now).find(r=>r.userId==='employee')).toBeUndefined();
  g.reviews.push({...g.reviews[0],id:'other-review',personId:'other-person',employmentId:'other-job'});
  g.panels.push({id:'other-feedback',employmentId:'employee-job',reviewId:'other-review'});
  expect(assessmentReminderWork(g,companies,now).find(r=>r.userId==='employee')?.tasks).toEqual([{key:'feedback',count:1,closesAt:null}]);
 });
 it('derives Group completion per person and independent HOD axes without emailing self-cohort names',()=>{
  const g=graph();g.reviews=[];g.panels=[];
  const entry={reviewId:'review',companyId:'company',personId:'employee-person',employmentId:'employee-job',performanceLocked:true,performanceReady:true};
  g.sessions=[{id:'group',companyId:null,tier:'group',reviewerUserIds:['manager'],adminUserIds:[],lockedAt:null,performanceLockedAt:null,potentialLockedAt:null,entries:[entry]},{id:'hod',companyId:'company',tier:'hod',reviewerUserIds:['manager'],adminUserIds:[],lockedAt:null,performanceLockedAt:'confirmed',potentialLockedAt:null,entries:[entry,{...entry,reviewId:'own',personId:'manager-person'}]}];
  expect(assessmentReminderWork(g,companies,now).find(r=>r.userId==='manager')?.tasks).toEqual([{key:'hod_potential',count:1,closesAt:null}]);
  g.sessions[0].entries.push({...entry,reviewId:'remaining',performanceLocked:false});
  expect(assessmentReminderWork(g,companies,now).find(r=>r.userId==='manager')?.tasks.map(t=>t.key)).toEqual(['hod_potential','group_performance']);
 });
});
