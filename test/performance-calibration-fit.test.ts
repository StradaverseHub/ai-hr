import {expect,it} from 'vitest';
import {z} from 'zod';
import golden from './fixtures/onehr/calibration-fit-golden.json';
import {calibrationFit,performanceFitCase,potentialFitCase,performanceFitReasons,potentialFitReasons,performanceFitPerson,potentialFitPerson,type PerformanceFitPerson,type PotentialFitPerson} from '../packs/performance/onehr/calibration-fit-model';
import {pmBands,potentialBands} from '../packs/performance/onehr/model';
it('matches 320 isolated source curve fits, including repeated moves, ties, immovable people and unmet tolerances',()=>{
 expect(golden).toHaveLength(320);for(const [i,g] of golden.entries()){
  const counts=z.record(z.string(),z.number()).parse(g.counts),target=z.record(z.string(),z.number()).parse(g.target);
  const policy={curveToleranceMode:'people' as const,curveTolerancePeople:g.tolerance,curveTolerancePct:10};
  const result=g.axis==='performance'?calibrationFit(pmBands,counts,g.people as PerformanceFitPerson[],target,policy,g.n,performanceFitCase,performanceFitReasons):calibrationFit(potentialBands,counts,g.people as PotentialFitPerson[],target,policy,g.n,potentialFitCase,potentialFitReasons);
  expect(result,`source case ${i}`).toEqual(g.expected);
 }
});
it('weights submitted evidence and locked moderation without manufacturing a cached insight',()=>{
 const base={...(golden[5].people[0] as PerformanceFitPerson),id:'p',name:'Nadia',band:'ME' as const,score:100,remark:'short remark',verdict:null,mod_down:[{kpi:'Delivery',from:'150',to:'100',why:'Reconciled scope'}],mod_up:[],files:0,n_why:1,why_flag:'disputed'};
 const plain=performanceFitPerson(base);expect(plain).toMatchObject({J:.19999999999999998,D:.5,M:-.2,words:2});
 const read=performanceFitPerson({...base,verdict:'well_justified'});expect(read.J).toBe(1);expect(read.M).toBe(-.2);
 const pot=potentialFitPerson({id:'p',name:'Nadia',band:'Mid',raw:15,max:30,basis:'combined',self_band:'High',lm_band:'Low',remark:'A short reflection'});expect(pot).toMatchObject({score:2.5,mod:2,words:3,D:.1});
});
