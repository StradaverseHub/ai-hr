/** Useful current-state analysis without inventing a historical baseline. Counts stay local.
 * Every share is supported by distinct persons, not cases, rows, employments or monetary sums. */
import {privateRecord,privateList,privateCount,privateEnum,privateHash,privatePolicyRefusal} from './provider-policy-shape';
import {AiPrivacyGateError} from './provider-privacy-request';
import type {PrivateTaskDescriptor} from './provider-task-contract';
export const SNAPSHOT_ANALYSIS_CONTRACT='aggregate_snapshot_analysis_v1' as const;
export const SNAPSHOT_DOMAIN_METRICS=Object.freeze({attendance:['lateness_prevalence','absence_prevalence'],leave:['pending_request_share'],claims:['pending_claim_share'],performance:['review_completion'],rewards:['facts_verification_share'],organisation:['open_workload']} as const);
export const SNAPSHOT_LEVEL_BANDS=Object.freeze(['none','under_quarter','quarter_to_half','half_to_three_quarters','over_three_quarters','all'] as const);
const labels:Readonly<Record<string,string>>={lateness_prevalence:'people with late attendance',absence_prevalence:'people with recorded absences',pending_request_share:'people with pending leave requests',pending_claim_share:'people with pending claims',review_completion:'people with completed performance-module progress',facts_verification_share:'people with verified reward facts',open_workload:'people with open readiness work'};
const descriptions:Readonly<Record<string,string>>={none:'none',under_quarter:'up to a quarter',quarter_to_half:'more than a quarter and up to half',half_to_three_quarters:'more than half and up to three quarters',over_three_quarters:'more than three quarters, though not everyone',all:'everyone'};
const groupLabels=['cohort_a','cohort_b','cohort_c','cohort_d'] as const;
export function snapshotShareBand(numerator:number,denominator:number):typeof SNAPSHOT_LEVEL_BANDS[number]{
 if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||denominator<=0||numerator<0||numerator>denominator)return privatePolicyRefusal();
 if(numerator===0)return 'none';if(numerator===denominator)return 'all';const n=BigInt(numerator),d=BigInt(denominator);
 return n*BigInt('4')<=d?'under_quarter':n*BigInt('2')<=d?'quarter_to_half':n*BigInt('4')<=d*BigInt('3')?'half_to_three_quarters':'over_three_quarters';
}
function populationBand(value:number){return value<50?'20_to_49':value<100?'50_to_99':value<250?'100_to_249':value<500?'250_to_499':value<1000?'500_to_999':'1000_or_more';}
function source(payload:unknown){
 const root=privateRecord(payload,['version','domain','window','cohorts']);if(root.version!==1||root.window!=='current_snapshot'||typeof root.domain!=='string'||!Object.hasOwn(SNAPSHOT_DOMAIN_METRICS,root.domain))return privatePolicyRefusal();
 const domain=root.domain as keyof typeof SNAPSHOT_DOMAIN_METRICS,seen=new Set<string>();let expected:string|undefined;
 const cohorts=privateList(root.cohorts,4).map(item=>{
  const row=privateRecord(item,['cohort','population','metrics']),cohort=privateEnum(row.cohort,groupLabels),population=privateCount(row.population,20,1000000);if(seen.has(cohort))return privatePolicyRefusal();seen.add(cohort);const metricsSeen=new Set<string>();
  const metrics=privateList(row.metrics,8).map(item=>{
   const metric=privateRecord(item,['metric','support','numeratorPeople','slices']),code=privateEnum(metric.metric,SNAPSHOT_DOMAIN_METRICS[domain]),support=privateCount(metric.support,20,population),numeratorPeople=privateCount(metric.numeratorPeople,0,support);
   if(metricsSeen.has(code)||privateList(metric.slices,0).length!==0)return privatePolicyRefusal();metricsSeen.add(code);
   if(numeratorPeople>0&&numeratorPeople<5||support-numeratorPeople>0&&support-numeratorPeople<5)throw new AiPrivacyGateError('small_cohort');
   return Object.freeze({metric:code,support,numeratorPeople,slices:Object.freeze([])});
  });
  if(metrics.length===0)return privatePolicyRefusal();const keys=JSON.stringify([...metricsSeen].sort());if(expected!==undefined&&expected!==keys)return privatePolicyRefusal();expected=keys;
  return Object.freeze({cohort,population,metrics:Object.freeze(metrics)});
 });
 if(!cohorts.length)return privatePolicyRefusal();return Object.freeze({version:1,domain,window:'current_snapshot',cohorts:Object.freeze(cohorts)});
}
export const SNAPSHOT_ANALYSIS_DESCRIPTOR:PrivateTaskDescriptor=Object.freeze({features:['report_insight','hr_assistant'],operation:'draft',
 fingerprint(payload:unknown){return privateHash(source(payload));},capture(payload:unknown){
  const captured=source(payload),projected=Object.freeze({version:1,purpose:'aggregate_snapshot_analysis',domain:captured.domain,window:captured.window,
   cohorts:Object.freeze(captured.cohorts.map(cohort=>Object.freeze({cohort:cohort.cohort,populationBand:populationBand(cohort.population),metrics:Object.freeze(cohort.metrics.map(metric=>Object.freeze({metric:metric.metric,supportBand:populationBand(metric.support),levelBand:snapshotShareBand(metric.numeratorPeople,metric.support)})))})))});
  return Object.freeze({args:Object.freeze({system:'Compare only the supplied current-state shares. No historical trend or cause is known. Return JSON only: {"observations":[{"cohort":"cohort_a","metric":"a supplied metric"}],"comparisons":[{"left":{"cohort":"cohort_a","metric":"a supplied metric"},"right":{"cohort":"cohort_b","metric":"a supplied metric"},"relationship":"higher_share|lower_share|same_range"}]}. Choose at most three useful statements. Never identify people, invent values, assign ratings, or propose employment decisions.',prompt:JSON.stringify(projected),maxTokens:1024}),local:projected});
 }});
export function adjudicateSnapshotAnalysis(raw:string,local:unknown):string{
 try{
  if(typeof raw!=='string'||raw.length>16000)return privatePolicyRefusal();
  const projected=local as ReturnType<typeof SNAPSHOT_ANALYSIS_DESCRIPTOR.capture>['local'] & {cohorts:{cohort:string;metrics:{metric:string;levelBand:string}[]}[]};
  const facts=new Map<string,{cohort:string;metric:string;levelBand:string}>();for(const cohort of projected.cohorts)for(const metric of cohort.metrics)facts.set(cohort.cohort+'|'+metric.metric,{cohort:cohort.cohort,...metric});
  const lookup=(raw:unknown)=>{const ref=privateRecord(raw,['cohort','metric']);if(typeof ref.cohort!=='string'||typeof ref.metric!=='string')return privatePolicyRefusal();return facts.get(ref.cohort+'|'+ref.metric)??privatePolicyRefusal();};
  const root=privateRecord(JSON.parse(raw),['observations','comparisons']),observations=privateList(root.observations,3),comparisons=privateList(root.comparisons,3);if(!observations.length&&!comparisons.length||observations.length+comparisons.length>3)return privatePolicyRefusal();
  const lines:string[]=[],seen=new Set<string>(),name=(cohort:string)=>'Cohort '+cohort.slice(-1).toUpperCase();
  for(const item of observations){const fact=lookup(item),key='o:'+fact.cohort+'|'+fact.metric;if(seen.has(key)||!Object.hasOwn(labels,fact.metric))return privatePolicyRefusal();seen.add(key);
   lines.push(`${projected.cohorts.length>1?name(fact.cohort)+': ':''}${labels[fact.metric]} account for ${descriptions[fact.levelBand]} of the eligible group.`);}
  for(const item of comparisons){const ref=privateRecord(item,['left','right','relationship']),left=lookup(ref.left),right=lookup(ref.right),relation=ref.relationship;if(left===right||typeof relation!=='string'||!['higher_share','lower_share','same_range'].includes(relation))return privatePolicyRefusal();
   const order=(value:string)=>(SNAPSHOT_LEVEL_BANDS as readonly string[]).indexOf(value),diff=order(left.levelBand)-order(right.levelBand);if(relation==='higher_share'?diff<=0:relation==='lower_share'?diff>=0:diff!==0)return privatePolicyRefusal();
   const key='c:'+left.cohort+'|'+left.metric+'|'+right.cohort+'|'+right.metric;if(seen.has(key))return privatePolicyRefusal();seen.add(key);
   lines.push(relation==='same_range'?`The shares for ${labels[left.metric]} in ${name(left.cohort)} and ${labels[right.metric]} in ${name(right.cohort)} ${left.levelBand==='none'||left.levelBand==='all'?'are equal at the stated endpoint.':'fall within the same range; their exact values may differ.'}`:`The share for ${labels[left.metric]} in ${name(left.cohort)} is ${relation==='higher_share'?'higher':'lower'} than for ${labels[right.metric]} in ${name(right.cohort)}.`);
  }
  return lines.map(line=>line[0].toUpperCase()+line.slice(1)).join('\n\n');
 }catch{return privatePolicyRefusal();}
}
