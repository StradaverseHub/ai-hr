import {describe,it,expect} from 'vitest';
import {aggregateRewardDashboardFigures,decodeRewardDashboardPreference,inRewardDashboardSelection,rewardDashboardCommon,rewardDashboardPreference,rewardSalaryDisplay,storedRewardDashboardPreference,toggleRewardDashboardCompany,type RewardDashboardFigureUnit} from '../packs/rewards/dashboard-model';

const BU1='11111111-1111-4111-8111-111111111111',BU2='22222222-2222-4222-8222-222222222222';
const C1='aaaaaaaa-0000-4000-8000-000000000001',C2='aaaaaaaa-0000-4000-8000-000000000002',C3='aaaaaaaa-0000-4000-8000-000000000003';
const U1='bbbbbbbb-0000-4000-8000-000000000001',U2='bbbbbbbb-0000-4000-8000-000000000002',U3='bbbbbbbb-0000-4000-8000-000000000003';
const units=[{id:U1,businessUnitId:BU1,companyId:C1},{id:U2,businessUnitId:BU1,companyId:C2},{id:U3,businessUnitId:BU2,companyId:C3}];

describe('Rewards dashboard preference (356ae8c1)',()=>{
 it('decodes the earlier single-review preference into its Business unit and company',()=>{
  expect(rewardDashboardPreference({scope:U2,period:'annual'},units,false)).toEqual({version:2,kind:'annual',period:'annual',businessUnit:BU1,companies:[C2]});
  expect(rewardDashboardPreference({scope:'all'},units,true)).toMatchObject({businessUnit:'all',companies:[]});
  // A removed legacy review falls back to the first available Business unit, All companies.
  expect(rewardDashboardPreference({scope:'bbbbbbbb-0000-4000-8000-00000000dead'},units,false)).toMatchObject({businessUnit:BU1,companies:[]});
 });
 it('never gives ordinary reviewers All business units and drops ids outside live scope',()=>{
  expect(rewardDashboardPreference({version:2,businessUnit:'all',companies:[]},units,false).businessUnit).toBe(BU1);
  const foreign='cccccccc-0000-4000-8000-000000000009';
  expect(rewardDashboardPreference({version:2,businessUnit:foreign,companies:[C1]},units,false)).toMatchObject({businessUnit:BU1,companies:[]});
  // Companies from another Business unit are dropped when the unit changes.
  expect(rewardDashboardPreference({version:2,businessUnit:BU2,companies:[C1,C3]},units,false)).toMatchObject({businessUnit:BU2,companies:[]});
  expect(rewardDashboardPreference({version:2,businessUnit:BU1,companies:[C2,foreign]},units,false)).toMatchObject({businessUnit:BU1,companies:[C2]});
  expect(rewardDashboardPreference({version:2,businessUnit:'all'},[],true)).toMatchObject({businessUnit:'',companies:[]});
 });
 it('canonicalizes a complete company selection to All companies',()=>{
  expect(rewardDashboardPreference({version:2,businessUnit:BU1,companies:[C1,C2]},units,false).companies).toEqual([]);
  expect(rewardDashboardPreference({version:2,businessUnit:'all',companies:[C1,C3]},units,true).companies).toEqual([C1,C3]);
 });
 it('stores only a bounded structural value',()=>{
  expect(storedRewardDashboardPreference({version:2,period:'weekly',businessUnit:'<script>',companies:[C2,'x',C2,C1.toUpperCase(),{}]})).toEqual({version:2,kind:'annual',period:'monthly',businessUnit:'',companies:[C1,C2]});
  expect(decodeRewardDashboardPreference(null)).toEqual({kind:'annual',period:'monthly',businessUnit:null,companies:[],legacyUnit:null});
  expect(decodeRewardDashboardPreference({version:2,companies:Array.from({length:900},()=>C1)}).companies).toEqual([C1]);
 });
 it('toggles company pills and returns to All companies',()=>{
  expect(toggleRewardDashboardCompany([],C1,[C1,C2,C3])).toEqual([C1]);
  expect(toggleRewardDashboardCompany([C1],C2,[C1,C2,C3])).toEqual([C1,C2]);
  expect(toggleRewardDashboardCompany([C1],C1,[C1,C2])).toEqual([]);
  expect(toggleRewardDashboardCompany([C1],C2,[C1,C2])).toEqual([]);
  expect(toggleRewardDashboardCompany([C1,C2],null,[C1,C2,C3])).toEqual([]);
  expect(inRewardDashboardSelection({businessUnit:BU1,companies:[]},units[1])).toBe(true);
  expect(inRewardDashboardSelection({businessUnit:BU1,companies:[C1]},units[1])).toBe(false);
  expect(inRewardDashboardSelection({businessUnit:'all',companies:[]},units[2])).toBe(true);
 });
});

const plan=(used:number[],pools:number[],bonusUsedCents:number,bonusPoolCents:number)=>({used,pools,bonusUsedCents,bonusPoolCents});
describe('Rewards dashboard figures (81a7b286)',()=>{
 it('adds independent company budgets, derives shares from totals and names each company over its own pool',()=>{
  const a:RewardDashboardFigureUnit={company:'Fictional Beta',budgets:{standard:plan([60000,0,500],[50000,10000,1000],100,1000),h:plan([0,0,0],[0,0,0],0,0)}};
  const b:RewardDashboardFigureUnit={company:'Fictional Alpha',budgets:{standard:plan([10000,2000,300],[50000,10000,1000],3000,2000),h:plan([700,0,0],[0,0,0],0,0)}};
  const f=aggregateRewardDashboardFigures([a,b])!;
  // Combined merit is within the combined pool, yet Beta exceeds its own merit pool.
  expect(f.salary.standard.merit).toEqual({used:70000,pool:100000,shareBp:7000,balance:30000,overCompanies:['Fictional Beta']});
  expect(f.salary.standard.promotion).toEqual({used:2000,pool:20000,shareBp:1000,balance:18000,overCompanies:[]});
  expect(f.salary.standard.special).toEqual({used:800,pool:2000,shareBp:4000,balance:1200,overCompanies:[]});
  expect(f.bonus.standard).toEqual({used:3100,pool:3000,shareBp:10333,balance:-100,overCompanies:['Fictional Alpha']});
  // Zero pools stay zero with no percentage; spending against a zero pool is an overrun.
  expect(f.salary.h.merit).toEqual({used:700,pool:0,shareBp:null,balance:-700,overCompanies:['Fictional Alpha']});
  expect(f.bonus.h).toEqual({used:0,pool:0,shareBp:null,balance:0,overCompanies:[]});
  expect(aggregateRewardDashboardFigures([])).toBeNull();
 });
 it('refuses totals beyond the supported amount',()=>{
  const big:RewardDashboardFigureUnit={company:'X',budgets:{standard:plan([Number.MAX_SAFE_INTEGER,0,0],[0,0,0],0,0),h:plan([0,0,0],[0,0,0],0,0)}};
  expect(()=>aggregateRewardDashboardFigures([big,big])).toThrow(/supported amount/);
 });
 it('reports one cycle or snapshot only when every selected review agrees',()=>{
  expect(rewardDashboardCommon(['2026-11-04','2026-11-04'])).toEqual({value:'2026-11-04',varies:false});
  expect(rewardDashboardCommon(['2026-11-04','2026-10-01'])).toEqual({value:null,varies:true});
  expect(rewardDashboardCommon([])).toEqual({value:null,varies:false});
 });
 it('annualizes recurring salary with checked arithmetic',()=>{
  expect(rewardSalaryDisplay(12345,'monthly')).toBe(12345);expect(rewardSalaryDisplay(12345,'annual')).toBe(148140);
  expect(()=>rewardSalaryDisplay(Number.MAX_SAFE_INTEGER,'annual')).toThrow();
 });
});
