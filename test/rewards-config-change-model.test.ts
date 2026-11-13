/** Board 60f1fdcd: the pure change-summary contract. No database. */
import {describe,expect,it} from 'vitest';
import {assertRewardConfigReviewed,rewardConfigLines,rewardConfigSummary,rewardConfigSummaryDigest,RewardConfigReviewError} from '../packs/rewards/config-change-model';

describe('Rewards configuration change summary',()=>{
 const summary=rewardConfigSummary({area:'pat',itemLabel:'PAT 2026 · Fictional Co',
  lines:[{key:'b',label:'Actual PAT',before:null,after:'11000.00'},{key:'a',label:'Target PAT',before:'10000.00',after:'12000.00'}],
  affected:[{reviewId:'r2',label:'Zeta 2026',stage:'bg',consequence:'recalculation-required'},{reviewId:'r1',label:'Alpha 2026',stage:'draft',consequence:'repriced'}],
  highImpact:['released-pat','released-pat']});
 it('orders lines and reviews, counts every change and de-duplicates the high-impact reasons',()=>{
  expect(summary.lines.map(l=>l.key)).toEqual(['a','b']);
  expect(summary.affected.map(a=>a.label)).toEqual(['Alpha 2026','Zeta 2026']);
  expect(summary.changedCount).toBe(2);expect(summary.highImpact).toEqual(['released-pat']);
 });
 it('digests content, not key order',()=>{
  const reordered=JSON.parse(JSON.stringify({highImpact:summary.highImpact,affected:summary.affected,lines:summary.lines,changedCount:summary.changedCount,itemLabel:summary.itemLabel,area:summary.area}));
  expect(rewardConfigSummaryDigest(reordered)).toBe(rewardConfigSummaryDigest(summary));
  expect(rewardConfigSummaryDigest({...summary,lines:[{...summary.lines[0],after:'12000.01'},summary.lines[1]]})).not.toBe(rewardConfigSummaryDigest(summary));
 });
 it('requires a reason on every save and the reviewed digest on a high-impact save',()=>{
  expect(()=>assertRewardConfigReviewed(summary,{reason:'too short',digest:rewardConfigSummaryDigest(summary)})).toThrow(RewardConfigReviewError);
  expect(()=>assertRewardConfigReviewed(summary,{reason:'Actual PAT confirmed by finance'})).toThrow(/Review the summary again/);
  expect(()=>assertRewardConfigReviewed(summary,{reason:'Actual PAT confirmed by finance',digest:'0'.repeat(64)})).toThrow(/Review the summary again/);
  expect(assertRewardConfigReviewed(summary,{reason:'  Actual PAT confirmed by finance  ',digest:rewardConfigSummaryDigest(summary)})).toBe('Actual PAT confirmed by finance');
  const ordinary=rewardConfigSummary({area:'salary',itemLabel:'Group Standard 2026',lines:[]});
  expect(assertRewardConfigReviewed(ordinary,{reason:'Draft structure for next year'})).toBe('Draft structure for next year');
 });
 it('bounds the displayed lines while keeping the full count',()=>{
  const many=rewardConfigSummary({area:'pat',itemLabel:'PAT',lines:Array.from({length:250},(_,i)=>({key:String(i).padStart(3,'0'),label:'Cell '+i,before:null,after:String(i)}))});
  expect(many.lines).toHaveLength(200);expect(many.changedCount).toBe(250);
 });
 it('lists only values that differ',()=>{
  expect(rewardConfigLines({a:'1',b:'2',c:null},{a:'1',b:'3',c:'4'},key=>key.toUpperCase())).toEqual([{key:'b',label:'B',before:'2',after:'3'},{key:'c',label:'C',before:null,after:'4'}]);
  expect(rewardConfigLines(null,{a:'1'},key=>key)).toEqual([{key:'a',label:'a',before:null,after:'1'}]);
 });
});
