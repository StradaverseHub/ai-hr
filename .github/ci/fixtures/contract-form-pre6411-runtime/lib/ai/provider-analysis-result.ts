/** Deterministic analysis adjudicator. Model prose is never rendered as HR truth.
 * AI chooses useful source-backed observations and comparisons; this owner verifies them and writes
 * sentences from current protected facts. No new values, identities, causal claims or ratings. */
import {AiGatewayError} from './types';
import {PROVIDER_ANALYSIS_CHANGE_BANDS} from './provider-analysis-bands';
const labels:Readonly<Record<string,string>>=Object.freeze({active_workforce:'active employments',joiners:'joiners',departures:'departures',vacancies:'vacancies',onboarding_completion:'onboarding completion',scheduled_hours:'scheduled hours',attendance_consistency:'attendance consistency',lateness_frequency:'lateness frequency',absence_frequency:'absence frequency',overtime_hours:'overtime hours',leave_taken:'leave taken',leave_pending:'pending leave',leave_coverage:'leave coverage',leave_cancellation_volume:'leave cancellations',payroll_cost:'payroll cost',base_pay_cost:'base pay',headcount:'headcount',overtime_cost:'overtime cost',employer_contribution_cost:'employer contribution cost',variable_pay_cost:'variable pay cost',expense_total:'expense total',claim_volume:'claim volume',processing_time:'processing time',returned_claim_share:'returned claim share',review_completion:'review completion',goal_progress:'goal progress',development_plan_completion:'development plan completion',feedback_participation:'feedback participation',budget_utilisation:'budget utilisation',proposal_volume:'proposal volume',open_workload:'open workload',overdue_workload:'overdue workload',completed_workload:'completed workload',handoff_volume:'handoff volume',approval_wait_time:'approval wait time'});
const changes:Readonly<Record<string,string>>=Object.freeze({decrease_over_25_percent:'fell by more than 25%',decrease_10_to_25_percent:'fell by 10–25%',decrease_5_to_10_percent:'fell by 5–10%',decrease_up_to_5_percent:'fell by up to 5%',unchanged:'was unchanged',increase_up_to_5_percent:'rose by up to 5%',increase_5_to_10_percent:'rose by 5–10%',increase_10_to_25_percent:'rose by 10–25%',increase_over_25_percent:'rose by more than 25%'});
const refuse=():never=>{throw new AiGatewayError('The protected analysis could not be verified.');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))return refuse();return value as Record<string,unknown>;}
function array(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||value.length>max)return refuse();return value;}
type Fact={cohort:string;metric:string;change:string};
const cohortName=(cohort:string)=>'Cohort '+cohort.slice(-1).toUpperCase();
/** Source JSON is the exact closed projection already captured before admission, never user text. */
export function adjudicatePrivateAnalysisResult(raw:string,projectionJson:string):string{
 try{
  if(typeof raw!=='string'||raw.length>16000)return refuse();
  const source=JSON.parse(projectionJson) as {purpose:string;cohorts:{cohort:string;metrics:{metric:string;changeBand:string}[]}[]};
  if(source.purpose!=='aggregate_comparison_analysis'||!Array.isArray(source.cohorts))return refuse();
  const facts=new Map<string,Fact>();for(const cohort of source.cohorts)for(const metric of cohort.metrics){if(!/^cohort_[a-d]$/.test(cohort.cohort)||!Object.hasOwn(labels,metric.metric)||!Object.hasOwn(changes,metric.changeBand))return refuse();facts.set(cohort.cohort+'|'+metric.metric,{cohort:cohort.cohort,metric:metric.metric,change:metric.changeBand});}
  const ref=(value:unknown)=>{const point=object(value,['cohort','metric']);if(typeof point.cohort!=='string'||typeof point.metric!=='string')return refuse();return facts.get(point.cohort+'|'+point.metric)??refuse();};
  const root=object(JSON.parse(raw),['observations','comparisons']),lines:string[]=[],seen=new Set<string>();
  for(const observation of array(root.observations,8)){const fact=ref(observation),key='o:'+fact.cohort+'|'+fact.metric;if(seen.has(key))return refuse();seen.add(key);lines.push(`${cohortName(fact.cohort)}: ${labels[fact.metric]} ${changes[fact.change]} compared with the previous period.`);}
  for(const item of array(root.comparisons,8)){
   const comparison=object(item,['left','right','relationship']),left=ref(comparison.left),right=ref(comparison.right),relation=comparison.relationship;
   if(left===right||typeof relation!=='string'||!['higher_change','lower_change','same_range'].includes(relation))return refuse();
   const order=(value:string)=>(PROVIDER_ANALYSIS_CHANGE_BANDS as readonly string[]).indexOf(value),difference=order(left.change)-order(right.change);
   if(relation==='higher_change'?difference<=0:relation==='lower_change'?difference>=0:difference!==0)return refuse();
   const key='c:'+left.cohort+'|'+left.metric+'|'+right.cohort+'|'+right.metric;if(seen.has(key))return refuse();seen.add(key);
   const a=`${labels[left.metric]} in ${cohortName(left.cohort)}`,b=`${labels[right.metric]} in ${cohortName(right.cohort)}`;
   lines.push(relation==='same_range'?(left.change==='unchanged'?`${a} and ${b} were both unchanged.`:`${a} and ${b} fall within the same change range; their exact changes may differ.`):`The percentage change in ${a} was ${relation==='higher_change'?'higher':'lower'} than in ${b}.`);
  }
  if(lines.length===0)return refuse();return lines.join('\n\n');
 }catch{return refuse();}
}
