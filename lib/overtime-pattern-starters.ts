/** Starting drafts for the canonical formula editor. These are not country rates or active policy.
 * In particular, a multiplier never supplies a statutory rest/holiday base-day payment leg. */
import type {OvertimePattern} from './overtime-pattern-model';
import {overtimeRefuse} from './overtime-pattern-schema';

export const OVERTIME_STARTERS=[
 {key:'ot15',name:'OT 1.5',multiplier:'1.5'},
 {key:'ot20',name:'OT 2.0',multiplier:'2'},
 {key:'ot30',name:'OT 3.0',multiplier:'3'},
 {key:'ot00',name:'OT 0.0',multiplier:'0'},
] as const;
export type OvertimeStarterKey=typeof OVERTIME_STARTERS[number]['key'];
export function overtimeStarter(key:unknown){return OVERTIME_STARTERS.find(item=>item.key===key)??null;}

/** HR still chooses accumulation and attribution before preparing any typed draft. Currency,
 * day eligibility, divisor and earning mapping stay incomplete until configured through the editor.
 * All four drafts (including zero) must pass the existing activation and transfer checks. */
export function prepareOvertimeStarter(key:OvertimeStarterKey,
 eligibilityBasis:OvertimePattern['eligibilityBasis'],durationAllocation:OvertimePattern['durationAllocation']):OvertimePattern{
 const starter=overtimeStarter(key);
 if(!starter||!['day','session'].includes(eligibilityBasis)||!['earliest','latest'].includes(durationAllocation))
  overtimeRefuse('invalid','starter','Choose a supported starter and explicit duration policies.');
 return {
  v:1,currency:{code:'',minorScale:0},definitions:[],eligibilityBasis,durationAllocation,
  eligibility:{id:'eligibility',type:'group',logic:'and',children:[]},
  eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],paymentCap:null,
  moneyRounding:{stage:'line',mode:'halfUp'},
  rates:[{id:'starter_rate',name:starter.name,description:'',priority:0,
   when:{id:'rate_eligibility',type:'group',logic:'and',children:[]},
   timeBand:null,accumulation:eligibilityBasis,tierMode:'marginal',
   tiers:[{id:'starter_tier',from:'0',to:null,mapping:{earningItemId:'',currency:''},
    payment:{method:'hourly',rate:{id:'hourly_rate',unit:'moneyPerHour',type:'hourlyRate',
     base:{id:'calculation_base',unit:'money',type:'field',field:'calculationBase'},
     divisorMinutes:{id:'hourly_divisor',unit:'minutes',type:'literal',value:''}},
     multiplier:{id:'rate_multiplier',unit:'scalar',type:'literal',value:starter.multiplier}}}]}],
 };
}
