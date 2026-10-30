import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
const h=vi.hoisted(()=>({progress:vi.fn()}));
vi.mock('../packs/performance/onehr/progress-service',()=>({getAssessmentProgress:h.progress}));
import {performanceAnalysisSourceTx} from '../packs/performance/onehr/analysis-source';
const company='10000000-0000-4000-8000-000000000001',cycle='20000000-0000-4000-8000-000000000001';
const ctx={tenantId:'30000000-0000-4000-8000-000000000001'} as SessionContext;
function transaction(cycles:unknown[],people:unknown[]){
 const queue=[cycles,people];
 const tx={select:vi.fn(()=>{const result=queue.shift();const query={from:vi.fn(),innerJoin:vi.fn(),where:vi.fn(),orderBy:vi.fn(),limit:vi.fn(),then:undefined as unknown};
  for(const key of ['from','innerJoin','where','orderBy','limit'] as const)query[key].mockReturnValue(query);
  query.then=(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve(result).then(resolve,reject);return query;})};
 return tx as unknown as Tx;
}
beforeEach(()=>vi.clearAllMocks());
describe('real native PM progress adoption',()=>{
 it('uses native progress state and same transaction without exposing names/grades or deriving ratings',async()=>{
  const tx=transaction([{id:cycle}],[{reviewId:'review-a',personId:'person-a'},{reviewId:'review-b',personId:'person-b'}]);
  h.progress.mockResolvedValue({filter:{module:'pm'},rows:[{reviewId:'review-a',name:'NAME_SENTINEL',grade:'PRIVATE_GRADE',cells:{pm:{state:'done'}}},{reviewId:'review-b',name:'NAME_SENTINEL_2',cells:{pm:{state:'active'}}}]});
  const source=await performanceAnalysisSourceTx(tx,ctx,[company],cycle);
  expect(h.progress).toHaveBeenCalledWith(ctx,cycle,{module:'pm',state:'all',companyId:company},tx);
  expect(source).toEqual({selection:cycle,rows:[{personId:'person-a',conditions:{review_completion:true}},{personId:'person-b',conditions:{review_completion:false}}]});
  expect(JSON.stringify(source)).not.toMatch(/NAME_SENTINEL|PRIVATE_GRADE|grade|rating/);
 });
 it('refuses module fallback rather than relabelling competency as performance',async()=>{
  h.progress.mockResolvedValue({filter:{module:'competency'},rows:[]});
  await expect(performanceAnalysisSourceTx(transaction([{id:cycle}],[]),ctx,[company])).rejects.toThrow('PM progress is unavailable');
 });
 it('refuses unknown selected cycle, empty scope and missing person mapping',async()=>{
  await expect(performanceAnalysisSourceTx(transaction([],[]),ctx,[company],cycle)).rejects.toThrow('authorized assessment cycle');
  await expect(performanceAnalysisSourceTx(transaction([],[]),ctx,[])).rejects.toThrow('company scope');
  h.progress.mockResolvedValue({filter:{module:'pm'},rows:[{reviewId:'review-a',cells:{pm:{state:'done'}}}]});
  await expect(performanceAnalysisSourceTx(transaction([{id:cycle}],[]),ctx,[company],cycle)).rejects.toThrow('Incomplete PM population');
 });
});
