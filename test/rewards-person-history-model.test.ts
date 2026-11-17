import {describe,expect,it} from 'vitest';
import {calculateRewards} from '../packs/rewards/engine';
import {defaultPolicy,emptyFacts,emptyRecommendation,type RewardEntry} from '../packs/rewards/model';
import {rewardHistoryValues,rewardHistoryUploadFromCells,rewardHistoryUploadHeaders} from '../packs/rewards/person-history-model';

const employee=():RewardEntry=>({id:'entry',source:{employmentId:'employment',personId:'person',compensationId:'comp',employeeCode:'F100',name:'Fictional employee',grade:'12',gradeId:null,basicCents:500000,currency:'MYR',payMode:'monthly',hiredOn:'2020-01-01',confirmedOn:'2020-04-01',notice:false,lastPayChange:null,confirmationPayChange:false,performanceReviewId:null,performanceRating:null},facts:{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'},recommendation:emptyRecommendation()});
const cells=(...rows:string[][])=>[rewardHistoryUploadHeaders,...rows];
const row=['F100','2024','STAR','OU','8.25','412.50','12500.00','2.50','Annual'];
describe('Reward person history values',()=>{
 it('uses the engine’s actual increase and payment basic, not nominal bonus matrix months',()=>{
  const policy={...defaultPolicy(2026),patActual:100,patTarget:100,multiplierBp:10000,ranges:{'12':[300000,500000,700000] as [number,number,number]}};
  const calculated=calculateRewards([employee()],policy).rows[0];
  const result=rewardHistoryValues({...calculated,bonusBasicCents:1000000,bonusCents:750000});
  expect(result).toMatchObject({talent:'SCORE',performance:'ME',meritBp:450,totalIncreaseBp:450,incrementCents:22500,bonusCents:750000,bonusMonthsBp:7500,promoted:false,withheld:{}});
  expect(calculated.bonusMonthsBp).toBe(15000);
 });
 it('retains withheld markers and promotion independently of zero awards',()=>{
  const calculated=calculateRewards([employee()],{...defaultPolicy(2026),ranges:{'12':[300000,500000,700000] as [number,number,number]}}).rows[0];
  const recommendation={...calculated.recommendation,promotionGrade:'13',withhold:{bonus:'Fictional withheld bonus reason'}};
  expect(rewardHistoryValues({...calculated,recommendation,bonusCents:0})).toMatchObject({promoted:true,promotionGrade:'13',bonusCents:0,bonusMonthsBp:0,withheld:recommendation.withhold});
 });
 it('parses exact cents, percentage basis points and two-decimal bonus months',()=>{
  const result=rewardHistoryUploadFromCells(cells(row));
  expect(result.problems).toEqual([]);
  expect(result.rows).toEqual([{line:2,value:{employeeCode:'F100',year:2024,kind:'annual',talent:'STAR',performance:'OU',incrementBp:825,incrementCents:41250,bonusCents:1250000,bonusMonthsBp:25000}}]);
 });
 it('accepts the optional type column and treats an omitted type as annual',()=>{
  const result=rewardHistoryUploadFromCells([rewardHistoryUploadHeaders.slice(0,8),row.slice(0,8)]);
  expect(result.rows[0].value.kind).toBe('annual');
  expect(rewardHistoryUploadFromCells(cells([...row.slice(0,8),'Off-cycle'])).rows[0].value.kind).toBe('offcycle');
 });
 it('reports source lines for duplicate, negative, formula and invalid rating rows without accepting malformed money',()=>{
  const values=[row,[...row],row.map((value,i)=>i===5?'-1.00':value),row.map((value,i)=>i===6?'=100*2':value),row.map((value,i)=>i===2?'unknown':value)];
  const result=rewardHistoryUploadFromCells(cells(...values),[1,3,7,11,15,19]);
  expect(result.rows).toHaveLength(1);expect(result.problems.map(problem=>problem.line)).toEqual([7,11,15,19]);
 });
 it('rejects changed headings and over-precise amounts instead of rounding them',()=>{
  expect(()=>rewardHistoryUploadFromCells([['employee',...rewardHistoryUploadHeaders.slice(1)],row])).toThrow(/template/);
  expect(rewardHistoryUploadFromCells(cells(row.map((value,i)=>i===5?'10.001':value))).problems).toHaveLength(1);
 });
});
