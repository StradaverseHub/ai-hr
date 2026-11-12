/**
 * Reviewer dashboard ("Reviewing Team Rewards") presentation model. Pure and dependency-free: the service
 * supplies only authorized, released review values; nothing here confers a scope or authorizes a read.
 *
 * `RewardDashboardKind` is the Year-end cycle / Off-cycle switch (board b945f0cc): 'annual' is the year-end review,
 * 'offcycle' the off-cycle balances and requests. The saved preference keeps the last choice.
 */
export const REWARD_DASHBOARD_KINDS=['annual','offcycle'] as const;
export type RewardDashboardKind=typeof REWARD_DASHBOARD_KINDS[number];
export const REWARD_DASHBOARD_PLANS=['standard','h'] as const;
export type RewardDashboardPlan=typeof REWARD_DASHBOARD_PLANS[number];
export const REWARD_SALARY_COMPONENTS=['merit','promotion','special'] as const;
export type RewardSalaryComponent=typeof REWARD_SALARY_COMPONENTS[number];
export const REWARD_DASHBOARD_ALL='all';
const MAX_COMPANIES=500;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saved presentation choice. `companies: []` means All companies in the chosen Business unit. */
export type RewardDashboardPreference={version:2;kind:RewardDashboardKind;period:'monthly'|'annual';businessUnit:string;companies:string[]};
/** A review the viewer may see on the dashboard, released or still being prepared. */
export type RewardDashboardScopeUnit={id:string;businessUnitId:string;companyId:string};

type Decoded={kind:RewardDashboardKind;period:'monthly'|'annual';businessUnit:string|null;companies:string[];legacyUnit:string|null};
/**
 * Structural decode of a stored or submitted preference. Accepts the current shape and the earlier
 * single-review shape `{scope:<unit id>|'all',period}`; anything else falls back to defaults.
 */
export function decodeRewardDashboardPreference(raw:unknown):Decoded{
 const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const period=value.period==='annual'?'annual':'monthly';
 const kind=REWARD_DASHBOARD_KINDS.find(k=>k===value.kind)??'annual';
 const id=(v:unknown)=>typeof v==='string'&&UUID.test(v)?v.toLowerCase():null;
 if(value.version===2){
  const businessUnit=value.businessUnit===REWARD_DASHBOARD_ALL?REWARD_DASHBOARD_ALL:id(value.businessUnit);
  const list=Array.isArray(value.companies)?value.companies.slice(0,MAX_COMPANIES).map(id).filter((v):v is string=>!!v):[];
  return {kind,period,businessUnit,companies:[...new Set(list)].sort(),legacyUnit:null};
 }
 // Earlier single-review preference: a review id, or All for Group Rewards, CTRO and EC.
 if(value.scope===REWARD_DASHBOARD_ALL)return {kind,period,businessUnit:REWARD_DASHBOARD_ALL,companies:[],legacyUnit:null};
 return {kind,period,businessUnit:null,companies:[],legacyUnit:id(value.scope)};
}

/** The bounded, structurally valid value that is stored. Scope is re-checked on every read. */
export function storedRewardDashboardPreference(raw:unknown):RewardDashboardPreference{
 const d=decodeRewardDashboardPreference(raw);
 return {version:2,kind:d.kind,period:d.period,businessUnit:d.businessUnit??'',companies:d.companies};
}

/**
 * Intersects a saved choice with the reviews the viewer can see now. An unavailable Business unit falls back
 * to the first available one; companies outside the chosen unit are dropped; an emptied or complete company
 * selection becomes All companies. Only `allowAll` viewers (Group Rewards, CTRO, EC) may keep All business units.
 */
export function rewardDashboardPreference(raw:unknown,units:readonly RewardDashboardScopeUnit[],allowAll:boolean,legacy:readonly RewardDashboardScopeUnit[]=units):RewardDashboardPreference{
 const d=decodeRewardDashboardPreference(raw);
 const businessUnits=[...new Set(units.map(unit=>unit.businessUnitId))];
 let businessUnit=d.businessUnit,companies=d.companies;
 if(d.legacyUnit){
  const unit=legacy.find(u=>u.id===d.legacyUnit);
  businessUnit=unit?.businessUnitId??null;companies=unit?[unit.companyId]:[];
 }
 if(!(businessUnit===REWARD_DASHBOARD_ALL&&allowAll&&units.length>0)&&!businessUnits.includes(businessUnit??'')){
  businessUnit=businessUnits[0]??'';companies=[];
 }
 const inUnit=[...new Set(units.filter(unit=>businessUnit===REWARD_DASHBOARD_ALL||unit.businessUnitId===businessUnit).map(unit=>unit.companyId))];
 companies=companies.filter(id=>inUnit.includes(id));
 if(companies.length===inUnit.length)companies=[];
 return {version:2,kind:d.kind,period:d.period,businessUnit:businessUnit??'',companies};
}

/** Whether a review is inside the chosen Business unit and company selection. */
export function inRewardDashboardSelection(choice:Pick<RewardDashboardPreference,'businessUnit'|'companies'>,unit:Pick<RewardDashboardScopeUnit,'businessUnitId'|'companyId'>){
 return (choice.businessUnit===REWARD_DASHBOARD_ALL||unit.businessUnitId===choice.businessUnit)&&(!choice.companies.length||choice.companies.includes(unit.companyId));
}

/** Pill toggle: All companies clears the list; removing the last company returns to All companies. */
export function toggleRewardDashboardCompany(selected:readonly string[],companyId:string|null,available:readonly string[]){
 if(companyId===null)return [];
 const next=selected.includes(companyId)?selected.filter(id=>id!==companyId):[...selected,companyId];
 return next.length===0||available.every(id=>next.includes(id))?[]:[...next].sort();
}

/** Only salary is a recurring monthly amount. Bonus is a one-off award in both views. */
export function rewardSalaryDisplay(cents:number,period:'monthly'|'annual'){
 const value=cents*(period==='annual'?12:1);if(!Number.isSafeInteger(value))throw Error('Reward display exceeds supported amount.');return value;
}

export type RewardDashboardPlanBudget={used:readonly number[];pools:readonly number[];bonusUsedCents:number;bonusPoolCents:number};
/** One released, unrestricted review's own native budget. */
export type RewardDashboardFigureUnit={company:string;budgets:Record<RewardDashboardPlan,RewardDashboardPlanBudget>};
/** Combined bar. `shareBp` comes from the combined numerator and denominator; null when the pool is zero. */
export type RewardDashboardBar={used:number;pool:number;shareBp:number|null;balance:number;overCompanies:string[]};
export type RewardDashboardFigures={
 salary:Record<RewardDashboardPlan,Record<RewardSalaryComponent,RewardDashboardBar>>;
 bonus:Record<RewardDashboardPlan,RewardDashboardBar>;
};

const add=(a:number,b:number)=>{const n=a+b;if(!Number.isSafeInteger(n))throw Error('Reward dashboard total exceeds supported amount.');return n;};
function bar(parts:readonly {company:string;used:number;pool:number}[]):RewardDashboardBar{
 let used=0,pool=0;for(const part of parts){used=add(used,part.used);pool=add(pool,part.pool);}
 // Each company keeps its own budget: an overrun is judged per company before the figures are combined.
 const overCompanies=[...new Set(parts.filter(part=>part.used>part.pool).map(part=>part.company))].sort((a,b)=>a.localeCompare(b));
 return {used,pool,shareBp:pool>0?Math.round(used*10000/pool):null,balance:pool-used,overCompanies};
}
/** Adds the selected companies' own budgets. Standard and JG H stay separate. */
export function aggregateRewardDashboardFigures(units:readonly RewardDashboardFigureUnit[]):RewardDashboardFigures|null{
 if(!units.length)return null;
 const salary={} as RewardDashboardFigures['salary'],bonus={} as RewardDashboardFigures['bonus'];
 for(const plan of REWARD_DASHBOARD_PLANS){
  salary[plan]={} as Record<RewardSalaryComponent,RewardDashboardBar>;
  REWARD_SALARY_COMPONENTS.forEach((component,index)=>{
   salary[plan][component]=bar(units.map(unit=>({company:unit.company,used:unit.budgets[plan].used[index]??0,pool:unit.budgets[plan].pools[index]??0})));
  });
  bonus[plan]=bar(units.map(unit=>({company:unit.company,used:unit.budgets[plan].bonusUsedCents,pool:unit.budgets[plan].bonusPoolCents})));
 }
 return {salary,bonus};
}

/** One value when every selected review agrees, otherwise "varies". */
export function rewardDashboardCommon(values:readonly string[]):{value:string|null;varies:boolean}{
 const unique=[...new Set(values)];
 return unique.length===1?{value:unique[0],varies:false}:{value:null,varies:unique.length>1};
}
