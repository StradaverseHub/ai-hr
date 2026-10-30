import {expect,it} from 'vitest';
import {adjudicatePrivateAnalysisResult} from '../lib/ai/provider-analysis-result';
const source=JSON.stringify({purpose:'aggregate_comparison_analysis',cohorts:[{cohort:'cohort_a',metrics:[{metric:'base_pay_cost',changeBand:'increase_5_to_10_percent'},{metric:'headcount',changeBand:'unchanged'}]},{cohort:'cohort_b',metrics:[{metric:'base_pay_cost',changeBand:'increase_up_to_5_percent'},{metric:'headcount',changeBand:'unchanged'}]}]});
const point=(cohort:string,metric:string)=>({cohort,metric});
const valid=()=>({observations:[point('cohort_a','base_pay_cost')],comparisons:[{left:point('cohort_a','base_pay_cost'),right:point('cohort_b','base_pay_cost'),relationship:'higher_change'}]});
it('produces useful checked period and cohort comparisons from closed facts without raw model wording',()=>{
 const text=adjudicatePrivateAnalysisResult(JSON.stringify(valid()),source);
 expect(text).toBe('Cohort A: base pay rose by 5–10% compared with the previous period.\n\nThe percentage change in base pay in Cohort A was higher than in base pay in Cohort B.');
});
it('compares different metrics and preserves uncertainty for matching ranges',()=>{
 const result={observations:[],comparisons:[{left:point('cohort_a','base_pay_cost'),right:point('cohort_a','headcount'),relationship:'higher_change'},{left:point('cohort_a','headcount'),right:point('cohort_b','headcount'),relationship:'same_range'}]};
 expect(adjudicatePrivateAnalysisResult(JSON.stringify(result),source)).toContain('were both unchanged');
});
it('refuses invented identities/values, unsupported comparisons, unknown references and raw narratives',()=>{
 const wrong=valid();wrong.comparisons[0].relationship='lower_change';
 const missing=valid();missing.observations=[point('cohort_c','base_pay_cost')];
 const equal=valid();equal.comparisons[0].relationship='same_range';
 for(const value of [wrong,missing,equal,{...valid(),explanation:'Private Person salary 999999'},{observations:[],comparisons:[]},'Private Person got a rating of 5',null])expect(()=>adjudicatePrivateAnalysisResult(JSON.stringify(value),source)).toThrow('could not be verified');
});
it('refuses duplicate selections and exact-equality claims disguised as the same qualitative range',()=>{
 const duplicate=valid();duplicate.observations.push(point('cohort_a','base_pay_cost'));
 expect(()=>adjudicatePrivateAnalysisResult(JSON.stringify(duplicate),source)).toThrow();
 const invented=valid();invented.comparisons[0].relationship='equal';expect(()=>adjudicatePrivateAnalysisResult(JSON.stringify(invented),source)).toThrow();
});

it('does not equate two nonzero changes inside the same coarse range',()=>{
 const similar=source.replace('increase_up_to_5_percent','increase_5_to_10_percent');const result=valid();result.comparisons[0].relationship='same_range';
 expect(adjudicatePrivateAnalysisResult(JSON.stringify(result),similar)).toContain('their exact changes may differ');
});
