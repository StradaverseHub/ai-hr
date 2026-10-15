import { describe, expect, it } from 'vitest';
import { agreementWords, personalFeedback, personalPlan, personalTrend } from '../packs/performance/onehr/personal-record-model';

describe('Source personal record publication rules',()=>{
 it('publishes manager remarks only on closure or after the planning year advances',()=>{
  const plan={status:'shared',planYear:2027,managerComment:'Draft manager remark',conversation:'Draft conversation',goals:[{id:'00000000-0000-4000-8000-000000000001',area:'Facilitation',dueOn:'',onJob:'Lead a workshop',fromOthers:'',formalLearning:'',status:'in_progress',managerComment:'Draft goal remark',progressNote:'Ran the first workshop'}]};
  const pending=personalPlan(plan,2027);expect(pending.managerComment).toBe('');expect(pending.conversation).toBe('Draft conversation');expect(pending.goals[0]).toMatchObject({managerComment:'',progressNote:'Ran the first workshop'});
  expect(personalPlan(plan,null).managerComment).toBe('');
  expect(personalPlan(plan,2028).goals[0].managerComment).toBe('Draft goal remark');
  expect(personalPlan({...plan,status:'closed'},2027).managerComment).toBe('Draft manager remark');
 });
 it('uses source agreement cutoffs and highlights at most two strongest and two weaker principles',()=>{
  expect([0,39,40,74,75,89,90,100].map(agreementWords)).toEqual(['few','few','some','some','most','most','consistent','consistent']);
  const report=personalFeedback({principles:[{principle:'A',agreementPct:90},{principle:'B',agreementPct:90},{principle:'C',agreementPct:75},{principle:'D',agreementPct:40}],statements:[{id:'s',text:'Observed behaviour',principle:'A',future:false,agreementPct:90}],comments:[],remarks:['Anonymous remark']})!;
  expect(report.strong.map(p=>p.principle)).toEqual(['A','B']);expect(report.grow.map(p=>p.principle)).toEqual(['D','C']);
  expect(report.statements).toEqual([{id:'s',text:'Observed behaviour',principle:'A',words:'consistent'}]);
  expect(JSON.stringify(report)).not.toContain('agreementPct');
 });
 it('does not reconstruct a legacy principle aggregate by averaging rounded statements',()=>{
  const report=personalFeedback({statements:[{id:'s',text:'Observed behaviour',principle:'A',future:false,agreementPct:67}],comments:[],remarks:[]})!;
  expect(report.strong).toEqual([]);expect(report.statements[0].words).toBe('some');
 });
 it('considers only the first six history rows before filtering and needs two released ratings',()=>{
  const rows=Array.from({length:7},(_,i)=>({id:String(i),name:`Cycle ${i}`,performance:i===0||i===6?'AE' as const:null,talent:null}));
  expect(personalTrend(rows)).toBeNull();rows[4].performance='AE';
  expect(personalTrend(rows)).toMatchObject({first:{id:'4'},last:{id:'0'},rows:[{id:'4'},{id:'0'}]});
 });
});
