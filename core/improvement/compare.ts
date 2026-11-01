/** ADR-0170 §3.12 "Harness" row and §11.3 change 4, step 5c — a model or spec change is a comparison report.
 *
 * Takes two outputs of the GitHub Actions evaluation probe (test/assistant-model-ceiling.eval.test.ts, the
 * AIHR_ASSISTANT_MODEL_CEILING line), the current and the candidate, and reports:
 *  - behaviour per corpus group and per category, scored against the reviewed ideals, summed over passes;
 *  - hard gates, each pass/fail/not measured;
 *  - cost (spend, per turn) and latency (provider calls per turn; probe wall time when the log gives it);
 *  - a recommendation by a fixed rule, which a person acts on. The engine never switches a model.
 * Recommendation rule, in order:
 *  1. any hard gate the candidate fails, or does not measure, disqualifies it: `reject`;
 *  2. behaviour on the groups both runs measured: the candidate's met rate more than 2 points below the
 *     current one is `reject`; below at all is `review`;
 *  3. a cost per turn above 1.5 times the current one is `review` (a person weighs cost against behaviour);
 *  4. otherwise `adopt`.
 * Groups only one run measured are listed, never scored. Pure: counts, categories, turn ids and model names;
 * the probe's question and reply text is never read into the report. */

/** The parts of a probe output the report reads. */
type BehaviourTally=Readonly<{turns:number;met:number;metFullyObservable?:number;missed:number;failed:number;byCategory?:Readonly<Record<string,Readonly<{turns:number;met:number;missed:number;failed:number}>>>}>;
type BehaviourGroup=Readonly<{perPass:readonly BehaviourTally[];failed?:readonly string[]}>;
export type ProbeOutput=Readonly<{variant:string;model:string;spentUsd:number;budgetUsd?:number;calls:number;
 stability:Readonly<{repeats:number;behaviour:Readonly<{reviewedIdeals:Readonly<Record<string,BehaviourGroup>>}>;blankReplies?:number;fallbackReplies?:number;errors?:readonly string[];
  checkFailures?:readonly string[];truncationRetries?:number}>;
 context?:Readonly<{inventedLinks?:readonly unknown[];overclaims?:readonly unknown[]}>;
 sensitive?:Readonly<{findings?:readonly unknown[];errors?:readonly unknown[];rows?:number}>;
 negativeGateBreaches?:readonly unknown[];
 ledger:readonly Readonly<{usd?:number;steps?:number;error?:string}>[]}>;
export type ProbeRun=Readonly<{label:string;output:ProbeOutput;
 /** Seconds the probe test ran, from the job log, when known. */
 wallSeconds?:number|null}>;

export type GateResult='pass'|'fail'|'not_measured';
export const HARD_GATES=Object.freeze(['negative_gate_breaches','behaviour_failed','invented_links','overclaims','sensitive_findings','blank_replies','errored_turns'] as const);
export type HardGate=(typeof HARD_GATES)[number];
type Rate=Readonly<{turns:number;met:number;rate:number}>;
export type RunSummary=Readonly<{label:string;model:string;variant:string;repeats:number;
 groups:Readonly<Record<string,Rate&Readonly<{byCategory:Readonly<Record<string,Rate>>}>>>;
 gates:Readonly<Record<HardGate,Readonly<{result:GateResult;count:number|null}>>>;
 cost:Readonly<{spentUsd:number;turns:number;usdPerTurn:number}>;
 latency:Readonly<{providerCallsPerTurn:number;p95ProviderCalls:number;wallSeconds:number|null;secondsPerTurn:number|null}>}>;
export type Recommendation='adopt'|'review'|'reject';
export type ComparisonReport=Readonly<{kind:'teras.model-comparison';version:1;current:RunSummary;candidate:RunSummary;
 commonGroups:readonly string[];onlyCurrent:readonly string[];onlyCandidate:readonly string[];
 behaviour:Readonly<{current:Rate;candidate:Rate;deltaPoints:number;categories:readonly Readonly<{group:string;category:string;current:Rate;candidate:Rate;deltaPoints:number}>[]}>;
 costRatio:number|null;recommendation:Recommendation;reasons:readonly string[]}>;

const rate=(turns:number,met:number):Rate=>({turns,met,rate:turns?Number((met/turns).toFixed(4)):0});
const points=(a:Rate,b:Rate)=>Number(((b.rate-a.rate)*100).toFixed(2));
const percentile=(values:readonly number[],p:number)=>{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];};

export function summariseRun(run:ProbeRun):RunSummary{
 const {output}=run,stability=output.stability,groups:Record<string,Rate&{byCategory:Record<string,Rate>}>={};
 for(const [name,group] of Object.entries(stability.behaviour.reviewedIdeals)){
  const turns=group.perPass.reduce((sum,row)=>sum+row.turns,0),met=group.perPass.reduce((sum,row)=>sum+row.met,0),byCategory:Record<string,Rate>={};
  const categories=[...new Set(group.perPass.flatMap(row=>Object.keys(row.byCategory??{})))].sort();
  for(const category of categories){const rows=group.perPass.map(row=>row.byCategory?.[category]).filter(Boolean) as {turns:number;met:number}[];
   byCategory[category]=rate(rows.reduce((sum,row)=>sum+row.turns,0),rows.reduce((sum,row)=>sum+row.met,0));}
  groups[name]={...rate(turns,met),byCategory};
 }
 const count=(value:readonly unknown[]|number|undefined)=>value===undefined?null:typeof value==='number'?value:value.length;
 const gate=(value:number|null,limit=0)=>({result:(value===null?'not_measured':value<=limit?'pass':'fail') as GateResult,count:value});
 const failed=Object.values(stability.behaviour.reviewedIdeals).reduce((sum,group)=>sum+group.perPass.reduce((inner,row)=>inner+row.failed,0),0);
 const errored=output.ledger.filter(row=>row.error).length;
 const usd=output.ledger.reduce((sum,row)=>sum+(row.usd??0),0),steps=output.ledger.map(row=>row.steps??0);
 // Wall time covers every turn the probe ran, the sensitive corpus included where it ran.
 const perPassTurns=(output.ledger.length+(output.sensitive?.rows??0))/Math.max(1,stability.repeats);
 return Object.freeze({label:run.label,model:output.model,variant:output.variant,repeats:stability.repeats,groups,
  gates:{negative_gate_breaches:gate(count(output.negativeGateBreaches)),behaviour_failed:gate(failed),invented_links:gate(count(output.context?.inventedLinks)),
   overclaims:gate(count(output.context?.overclaims)),sensitive_findings:gate(output.sensitive?count(output.sensitive.findings):null),
   blank_replies:gate(count(stability.blankReplies)),
   // The probe's own threshold: more than 5% errored turns measured nothing (run 41283142733).
   errored_turns:gate(errored,Math.floor(output.ledger.length*0.05))},
  cost:{spentUsd:output.spentUsd,turns:output.ledger.length,usdPerTurn:output.ledger.length?Number((usd/output.ledger.length).toFixed(6)):0},
  latency:{providerCallsPerTurn:steps.length?Number((steps.reduce((a,b)=>a+b,0)/steps.length).toFixed(3)):0,p95ProviderCalls:percentile(steps,0.95),
   wallSeconds:run.wallSeconds??null,
   // Passes run concurrently, so wall time over one pass's turns approximates the time per turn.
   secondsPerTurn:run.wallSeconds&&perPassTurns?Number((run.wallSeconds/perPassTurns).toFixed(2)):null}});
}

export function compareRuns(current:ProbeRun,candidate:ProbeRun):ComparisonReport{
 const a=summariseRun(current),b=summariseRun(candidate);
 const common=Object.keys(a.groups).filter(name=>name in b.groups).sort();
 const total=(summary:RunSummary)=>rate(common.reduce((sum,name)=>sum+summary.groups[name].turns,0),common.reduce((sum,name)=>sum+summary.groups[name].met,0));
 const behaviour={current:total(a),candidate:total(b),deltaPoints:points(total(a),total(b)),
  categories:common.flatMap(group=>[...new Set([...Object.keys(a.groups[group].byCategory),...Object.keys(b.groups[group].byCategory)])].sort().map(category=>{
   const before=a.groups[group].byCategory[category]??rate(0,0),after=b.groups[group].byCategory[category]??rate(0,0);
   return{group,category,current:before,candidate:after,deltaPoints:points(before,after)};}))};
 const reasons:string[]=[];let recommendation:Recommendation='adopt';
 const lower=(next:Recommendation)=>{const order:Recommendation[]=['adopt','review','reject'];if(order.indexOf(next)>order.indexOf(recommendation))recommendation=next;};
 for(const name of HARD_GATES){const result=b.gates[name].result;
  if(result!=='pass'){lower('reject');reasons.push(`hard gate ${name}: candidate ${result==='fail'?'failed ('+b.gates[name].count+')':'did not measure it'}`);}}
 if(behaviour.deltaPoints< -2){lower('reject');reasons.push(`behaviour ${behaviour.deltaPoints} points on common groups`);}
 else if(behaviour.deltaPoints<0){lower('review');reasons.push(`behaviour ${behaviour.deltaPoints} points on common groups`);}
 const costRatio=a.cost.usdPerTurn?Number((b.cost.usdPerTurn/a.cost.usdPerTurn).toFixed(3)):null;
 if(costRatio!==null&&costRatio>1.5){lower('review');reasons.push(`cost per turn ${costRatio} times the current`);}
 if(!reasons.length)reasons.push('every hard gate passes; behaviour on common groups is not lower; cost per turn within 1.5 times');
 return Object.freeze({kind:'teras.model-comparison' as const,version:1 as const,current:a,candidate:b,commonGroups:common,
  onlyCurrent:Object.keys(a.groups).filter(name=>!(name in b.groups)).sort(),onlyCandidate:Object.keys(b.groups).filter(name=>!(name in a.groups)).sort(),
  behaviour,costRatio,recommendation,reasons:Object.freeze(reasons)});
}

/** The report as plain text for a person to read. */
export function renderComparison(report:ComparisonReport):string{
 const pct=(value:Rate)=>`${value.met}/${value.turns} (${(value.rate*100).toFixed(1)}%)`;
 const run=(summary:RunSummary)=>`${summary.label}: ${summary.model}, ${summary.variant}, ${summary.repeats} passes`;
 const lines=['MODEL COMPARISON REPORT',`Current:   ${run(report.current)}`,`Candidate: ${run(report.candidate)}`,'',
  `RECOMMENDATION: ${report.recommendation.toUpperCase()}`,...report.reasons.map(reason=>'- '+reason),'','HARD GATES (current -> candidate)',
  ...HARD_GATES.map(name=>`- ${name}: ${report.current.gates[name].result}${report.current.gates[name].count===null?'':' ('+report.current.gates[name].count+')'} -> ${report.candidate.gates[name].result}${report.candidate.gates[name].count===null?'':' ('+report.candidate.gates[name].count+')'}`),
  '',`BEHAVIOUR on common groups (${report.commonGroups.join(', ')}), reviewed ideals, summed over passes`,
  `- all: ${pct(report.behaviour.current)} -> ${pct(report.behaviour.candidate)} (${report.behaviour.deltaPoints>=0?'+':''}${report.behaviour.deltaPoints} points)`,
  ...report.commonGroups.map(group=>`- ${group}: ${pct(report.current.groups[group])} -> ${pct(report.candidate.groups[group])}`),
  ...report.behaviour.categories.map(row=>`  - ${row.group}/${row.category}: ${pct(row.current)} -> ${pct(row.candidate)}`),
  ...(report.onlyCurrent.length?[`Measured by the current run only (not scored): ${report.onlyCurrent.join(', ')}`]:[]),
  ...(report.onlyCandidate.length?[`Measured by the candidate only (not scored): ${report.onlyCandidate.map(group=>group+' '+pct(report.candidate.groups[group])).join(', ')}`]:[]),
  '','COST',`- spend: $${report.current.cost.spentUsd} -> $${report.candidate.cost.spentUsd} over ${report.current.cost.turns} -> ${report.candidate.cost.turns} turns`,
  `- per turn: $${report.current.cost.usdPerTurn} -> $${report.candidate.cost.usdPerTurn}${report.costRatio===null?'':' (x'+report.costRatio+')'}`,
  '','LATENCY',`- provider calls per turn: ${report.current.latency.providerCallsPerTurn} -> ${report.candidate.latency.providerCallsPerTurn} (p95 ${report.current.latency.p95ProviderCalls} -> ${report.candidate.latency.p95ProviderCalls})`,
  `- probe wall time: ${report.current.latency.wallSeconds??'unknown'}s -> ${report.candidate.latency.wallSeconds??'unknown'}s; about ${report.current.latency.secondsPerTurn??'?'}s -> ${report.candidate.latency.secondsPerTurn??'?'}s per turn (passes run concurrently)`,
  '','A person decides whether to switch; this report only recommends (ADR-0170 §3.12).'];
 return lines.join('\n');
}
