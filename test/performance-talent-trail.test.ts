import { expect,it } from 'vitest';
import { talentBandTrail,potentialReviewReady } from '../packs/performance/onehr/talent-trail-model';
import golden from './fixtures/onehr/talent-trail-golden.json';
const base={self:{performance:'ME' as const,potential:'Low' as const},manager:{performance:'ME' as const,potential:'Mid' as const},decisions:[],current:{performance:'AE' as const,potential:'High' as const},adjusted:{performance:false,potential:false},sources:{performance:'bg',potential:'bg'}};
it('shows confirmed steps, waiting axes and the current seat without disclosing a lower-tier draft',()=>{
 const source={...base,adjusted:{performance:true,potential:false},decisions:[{tier:'hod' as const,performance:'OU' as const,potential:'Mid' as const,performanceLocked:false,potentialLocked:true},{tier:'bu' as const,performance:'BE' as const,potential:'Low' as const,performanceLocked:true,potentialLocked:false}]};
 expect(talentBandTrail(source,'performance')).toEqual([{tier:'self',band:'ME',state:'set'},{tier:'manager',band:'ME',state:'kept'},{tier:'hod',band:null,state:'wait'},{tier:'bu',band:'BE',state:'moved'},{tier:'you',band:'AE',state:'moved'}]);
 expect(talentBandTrail(source,'potential')).toEqual([{tier:'self',band:'Low',state:'set'},{tier:'manager',band:'Mid',state:'moved'},{tier:'hod',band:'Mid',state:'kept'},{tier:'bu',band:null,state:'wait'},{tier:'bg',band:'High',state:'moved'}]);
});
it('retains missing stages without inventing an assigned reviewer or a decision for a default pin',()=>{
 expect(talentBandTrail({...base,self:{performance:null,potential:null},manager:{performance:null,potential:null},sources:{performance:'default',potential:'default'}},'performance')).toEqual([{tier:'self',band:null,state:'none'},{tier:'manager',band:null,state:'none'},{tier:'hod',band:null,state:'na'},{tier:'bu',band:null,state:'na'}]);
});
it('matches all isolated source trails for missing, waiting, separately locked, kept and moved steps',()=>{
 for(const sample of golden.cases)for(const axis of ['performance','potential'] as const)expect(talentBandTrail(sample.source as Parameters<typeof talentBandTrail>[0],axis),`${sample.name}: ${axis}`).toEqual(sample.expected[axis]);
});
it('requires both valid feedback and reviewed assigned competencies for the manager potential step',()=>{
 for(const status of ['pending','submitted','reviewed']){
  expect(potentialReviewReady(false,false,status)).toBe(false);expect(potentialReviewReady(false,true,status)).toBe(false);
  expect(potentialReviewReady(true,false,status)).toBe(true);expect(potentialReviewReady(true,true,status)).toBe(status==='reviewed');
 }
});
