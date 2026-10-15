import { describe,expect,it } from 'vitest';
import { assessmentProgress } from '../packs/performance/onehr/progress-model';
import { defaultPolicy,kpiSchema } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { randomUUID } from 'node:crypto';
const policy=defaultPolicy(framework),base={kpis:[],performanceConfirmed:false,resultsSubmitted:false,competencyStatus:'pending',competencyCount:2,panelCount:4,panelSubmitted:0,calibration:'none' as const,planStatus:null,policy};
describe('HR review completion states',()=>{
 it('distinguishes drafts and submissions from human-confirmed outcomes',()=>{
  expect(assessmentProgress(base)).toMatchObject({pm:{state:'pending',label:'not_set'},competency:{state:'pending'},feedback:{state:'pending'},calibration:{state:'pending'},career:{state:'pending'}});
  expect(assessmentProgress({...base,resultsSubmitted:true,competencyStatus:'submitted',panelSubmitted:2,calibration:'draft',planStatus:'shared'})).toMatchObject({pm:{state:'active'},competency:{state:'active'},feedback:{state:'active',completed:2,count:4},calibration:{state:'active'},career:{state:'active'}});
  expect(assessmentProgress({...base,performanceConfirmed:true,competencyStatus:'reviewed',panelSubmitted:4,calibration:'locked',planStatus:'closed'})).toMatchObject({pm:{state:'done'},competency:{state:'done'},feedback:{state:'done',label:'feedback_complete'},calibration:{state:'done'},career:{state:'done'}});
 });
 it('tracks the current planning year in a mid-year cycle when development planning is enabled',()=>{
  const result=assessmentProgress({...base,planStatus:'shared',policy:{...policy,kind:'mid_year'}});
  expect(result.career).toMatchObject({state:'active',label:'plan_shared'});
 });
 it('keeps disabled modules absent and quarterly check-ins separate from ratings',()=>{
  const k=kpiSchema.parse({id:randomUUID(),title:'Delivery',description:'',unit:'units',weightBp:10000,scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:null,setting:'approved',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false,checkIn:{answer:'nothing_yet',note:'',at:new Date().toISOString(),userId:randomUUID()}});
  expect(assessmentProgress({...base,kpis:[k],policy:{...policy,kind:'quarterly',modules:{pm:true,tm:false,idp:false,evidence:false}}})).toEqual({pm:{state:'done',label:'checked_in',count:1,completed:1}});
  expect(assessmentProgress({...base,policy:{...policy,modules:{pm:false,tm:false,idp:false,evidence:true}}})).toEqual({});
 });
});
