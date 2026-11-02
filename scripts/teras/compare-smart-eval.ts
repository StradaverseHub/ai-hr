/** "Make it smart" step 2 (NOVERI-AI-CENTRE-HANDOFF §5): the model comparison for the AI Centre evaluation.
 *
 *   node scripts/teras/compare-smart-eval.ts RUN.json [RUN.json …] [--baseline openai/gpt-6-luna] [--examples id,id,…] [--json]
 *
 * Each RUN.json is the assistant-smart-eval.json evidence file of one run of test/assistant-smart-eval.eval.test.ts (the
 * focused-development-evidence artifact: gh run download RUN_ID -n focused-development-evidence). Runs of the same model
 * are pooled. Prints a Markdown report on stdout, or the report as JSON with --json:
 *  - per model: the five dimensions and the overall score (0-100), good answers, cost per question, latency p50 and p95,
 *    refusals (expected and not), errors, fallbacks and deterministic safety faults;
 *  - per factor of the owner's "it feels dumb" (facts, capability, doing, privacy wording, brevity, language, safety);
 *  - model or design: how much of the baseline's lost score the best model recovers, overall and per factor, and the
 *    questions no model answers well (a design limit, not a model one);
 *  - side-by-side example answers.
 * Reads files only; fetches nothing, writes nothing, switches no model. A person decides. Runs with Node's own type
 * stripping (Node 22.18 or later) or with node --import tsx; it has no runtime imports outside Node. */
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import type {Dimension,JudgeVerdict,SmartEvalFactor,SmartEvalKind,SmartEvalLocale,SmartEvalRole,TurnScore} from '../../core/improvement/smart-eval-score';

const DIMS:readonly Dimension[]=['correctness','usefulness','doing','clarity','safety'];
const FACTORS:readonly SmartEvalFactor[]=['facts','capability','doing','privacy_wording','brevity','language','safety'];
/** One answer as the evaluation writes it. */
export type SmartEvalRow=Readonly<{pass:number;conversation:string;turn:string;role:SmartEvalRole;locale:SmartEvalLocale;kind:SmartEvalKind;factor:SmartEvalFactor;
 source:'reconstructed'|'journey'|'owner';issues?:readonly string[];question:string;reply:string;error?:string;mode:string|null;
 /** The pre-read gate: 'open', or why private reads were closed for the turn (a named other person, a sensitive topic …). */
 gate?:string;fallback:boolean;budgetExhausted:string|null;
 suggestion:string|null;proposals:readonly string[];reads:readonly string[];steps:number;usd:number;inputTokens:number;outputTokens:number;wallMs:number;truncated:number;
 firstAttemptCheckFailures:readonly string[];fixedReply:string|null;verdict:JudgeVerdict|null;judgeUsd:number;judgeError?:string;score:TurnScore}>;
export type SmartEvalOutput=Readonly<{kind:'teras.smart-eval';version:1;model:string;allowedProviders:readonly string[];path:string;
 spec:Readonly<{version:number;digest:string}>;judge:Readonly<{model:string;version:number;reasoningEffort:string;seed:number;promptDigest:string}>;
 set:Readonly<{turns:number;digest:string}>;today:string;budgetUsd:number;spentUsd:Readonly<{model:number;judge:number;total:number}>;
 passes:readonly Readonly<{pass:number;complete:boolean;skipped?:string}>[];rows:readonly SmartEvalRow[];runId?:string}>;

const mean=(values:readonly number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const pct=(value:number|null)=>value===null?null:Math.round(value*1000)/10;
/** Nearest-rank percentile. */
export const percentile=(values:readonly number[],p:number)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1))];};
/** A refusal: the model chose to refuse, or the harness refused without the model. A sensitive-topic route is a referral. */
const refused=(row:SmartEvalRow)=>row.mode==='refuse'||row.fixedReply==='harm_refusal'||row.fixedReply==='override_refusal';
const GOOD=0.75;

export type RunSummary=Readonly<{model:string;runs:readonly string[];passes:number;questions:number;answers:number;scored:number;unjudged:number;complete:boolean;
 dims:Readonly<Record<Dimension,number|null>>;overall:number|null;good:Readonly<{count:number;of:number}>;
 byFactor:Readonly<Record<string,number|null>>;byRole:Readonly<Record<string,number|null>>;byLocale:Readonly<Record<string,number|null>>;bySource:Readonly<Record<string,number|null>>;
 cost:Readonly<{modelUsd:number;judgeUsd:number;modelUsdPerQuestion:number|null;judgeUsdPerQuestion:number|null}>;
 latency:Readonly<{p50Ms:number|null;p95Ms:number|null;meanSteps:number|null}>;
 refusals:Readonly<{expected:number;expectedOf:number;unexpected:number}>;
 errors:Readonly<{errored:number;fallbacks:number;budgetExhausted:number;truncationRetries:number;judgeFailures:number}>;
 safetyFaults:number;findings:Readonly<Record<string,number>>;
 /** Mean overall per question id, over passes. */
 perQuestion:Readonly<Record<string,number|null>>}>;

/** One model's summary over the complete passes of its runs. Rows of an incomplete pass are left out. */
export function summariseSmartRun(outputs:readonly SmartEvalOutput[]):RunSummary{
 const model=outputs[0]?.model??'';
 if(outputs.some(output=>output.model!==model))throw Error('Runs of different models cannot be pooled.');
 const rows=outputs.flatMap((output,index)=>{const complete=new Set(output.passes.filter(pass=>pass.complete).map(pass=>pass.pass));
  return output.rows.filter(row=>complete.has(row.pass)).map(row=>({...row,pass:index*100+row.pass}));});
 const passes=new Set(rows.map(row=>row.pass)).size,questions=new Set(rows.map(row=>row.turn)).size;
 const scored=rows.filter(row=>row.score.overall!==null);
 const avg=(subset:readonly SmartEvalRow[],pick:(row:SmartEvalRow)=>number|null)=>pct(mean(subset.map(pick).filter((value):value is number=>value!==null)));
 const group=(key:(row:SmartEvalRow)=>string)=>{const out:Record<string,number|null>={};for(const name of [...new Set(scored.map(key))].sort())out[name]=avg(scored.filter(row=>key(row)===name),row=>row.score.overall);return out;};
 const dims={} as Record<Dimension,number|null>;for(const dimension of DIMS)dims[dimension]=avg(scored,row=>row.score.dims[dimension]);
 const findings:Record<string,number>={};for(const row of rows)for(const finding of row.score.findings)findings[finding.check]=(findings[finding.check]??0)+1;
 const modelUsd=rows.reduce((sum,row)=>sum+row.usd,0),judgeUsd=rows.reduce((sum,row)=>sum+row.judgeUsd,0),answered=rows.filter(row=>!row.error);
 const perQuestion:Record<string,number|null>={};for(const id of [...new Set(rows.map(row=>row.turn))])perQuestion[id]=avg(scored.filter(row=>row.turn===id),row=>row.score.overall);
 const expected=rows.filter(row=>row.kind==='refuse');
 return Object.freeze({model,runs:outputs.map(output=>output.runId??''),passes,questions,answers:rows.length,scored:scored.length,unjudged:rows.length-scored.length,
  complete:outputs.every(output=>output.passes.some(pass=>pass.complete)),
  dims:Object.freeze(dims),overall:avg(scored,row=>row.score.overall),good:Object.freeze({count:scored.filter(row=>(row.score.overall??0)>=GOOD).length,of:rows.length}),
  byFactor:Object.freeze(group(row=>row.factor)),byRole:Object.freeze(group(row=>row.role)),byLocale:Object.freeze(group(row=>row.locale)),bySource:Object.freeze(group(row=>row.source)),
  cost:Object.freeze({modelUsd:Number(modelUsd.toFixed(4)),judgeUsd:Number(judgeUsd.toFixed(4)),modelUsdPerQuestion:rows.length?Number((modelUsd/rows.length).toFixed(5)):null,judgeUsdPerQuestion:rows.length?Number((judgeUsd/rows.length).toFixed(5)):null}),
  latency:Object.freeze({p50Ms:percentile(answered.map(row=>row.wallMs),0.5),p95Ms:percentile(answered.map(row=>row.wallMs),0.95),meanSteps:mean(answered.map(row=>row.steps))}),
  refusals:Object.freeze({expected:expected.filter(refused).length,expectedOf:expected.length,unexpected:rows.filter(row=>row.kind!=='refuse'&&refused(row)).length}),
  errors:Object.freeze({errored:rows.filter(row=>row.error).length,fallbacks:rows.filter(row=>row.fallback).length,budgetExhausted:rows.filter(row=>row.budgetExhausted).length,
   truncationRetries:rows.reduce((sum,row)=>sum+row.truncated,0),judgeFailures:rows.filter(row=>!row.error&&!row.verdict).length}),
  safetyFaults:rows.filter(row=>row.score.safetyFault).length,findings:Object.freeze(findings),perQuestion:Object.freeze(perQuestion)});
}

export type ComparisonReport=Readonly<{baseline:string;best:string|null;models:readonly RunSummary[];
 /** Share of the baseline's lost score (100 − baseline) the best model recovers. Low means the rest is design. */
 recovered:Readonly<{overall:number|null;byFactor:Readonly<Record<string,number|null>>;byDimension:Readonly<Record<string,number|null>>}>;
 /** Questions no model answers well (best mean overall below GOOD): limited by the design, not the model. */
 designLimited:readonly Readonly<{id:string;best:number|null;factor:string}>[];
 judges:readonly string[];sets:readonly string[];specs:readonly string[]}>;

const recover=(base:number|null,best:number|null)=>base===null||best===null?null:base>=100?null:Math.round(((best-base)/(100-base))*1000)/10;
/** Compare models. The baseline is the named model, or the first run's. The best is the highest overall among the rest. */
export function compareSmartRuns(outputs:readonly SmartEvalOutput[],baselineModel?:string):ComparisonReport{
 const byModel=new Map<string,SmartEvalOutput[]>();for(const output of outputs)byModel.set(output.model,[...(byModel.get(output.model)??[]),output]);
 const models=[...byModel.values()].map(summariseSmartRun);
 const baseline=baselineModel??outputs[0]?.model??'',base=models.find(row=>row.model===baseline);
 if(!base)throw Error('No run of the baseline model '+baseline+'.');
 const rest=models.filter(row=>row.model!==baseline&&row.overall!==null).sort((a,b)=>(b.overall??0)-(a.overall??0)),best=rest[0]??null;
 const byFactor:Record<string,number|null>={},byDimension:Record<string,number|null>={};
 for(const factor of FACTORS)if(factor in base.byFactor)byFactor[factor]=recover(base.byFactor[factor],best?.byFactor[factor]??null);
 for(const dimension of DIMS)byDimension[dimension]=recover(base.dims[dimension],best?.dims[dimension]??null);
 const factorOf=new Map(outputs.flatMap(output=>output.rows.map(row=>[row.turn,row.factor] as const)));
 const ids=[...new Set(outputs.flatMap(output=>output.rows.map(row=>row.turn)))];
 const designLimited=ids.map(id=>{const scores=models.map(row=>row.perQuestion[id]).filter((value):value is number=>value!==null&&value!==undefined);
  return{id,best:scores.length?Math.max(...scores):null,factor:factorOf.get(id)??''};}).filter(row=>row.best!==null&&row.best<GOOD*100);
 return Object.freeze({baseline,best:best?.model??null,models:Object.freeze(models),recovered:Object.freeze({overall:recover(base.overall,best?.overall??null),byFactor:Object.freeze(byFactor),byDimension:Object.freeze(byDimension)}),
  designLimited:Object.freeze(designLimited),judges:[...new Set(outputs.map(output=>output.judge.model+' v'+output.judge.version+' '+output.judge.promptDigest.slice(0,12)))],
  sets:[...new Set(outputs.map(output=>output.set.digest.slice(0,12)+' ('+output.set.turns+' turns)'))],specs:[...new Set(outputs.map(output=>'v'+output.spec.version+' '+output.spec.digest.slice(0,12)))]});
}

const cell=(value:number|null|undefined,suffix='')=>value===null||value===undefined?'–':String(value)+suffix;
const ms=(value:number|null)=>value===null?'–':(value/1000).toFixed(1)+' s';
const usd=(value:number|null)=>value===null?'–':'$'+(value<0.01?value.toFixed(5):value.toFixed(3));
const clip=(text:string,length:number)=>{const flat=text.replace(/\s*\n\s*/g,' / ').trim();return flat.length>length?flat.slice(0,length-1)+'…':flat;};
/** Questions whose answers differ most between models, for the side-by-side examples. */
export function pickExamples(report:ComparisonReport,count:number):readonly string[]{
 const ids=Object.keys(report.models[0]?.perQuestion??{});
 return ids.map(id=>{const scores=report.models.map(row=>row.perQuestion[id]).filter((value):value is number=>value!==null&&value!==undefined);
  return{id,spread:scores.length?Math.max(...scores)-Math.min(...scores):0};}).sort((a,b)=>b.spread-a.spread||a.id.localeCompare(b.id)).slice(0,count).map(row=>row.id);
}
/** The Markdown report. `examples` are question ids; the first pass of each model's first run supplies the answer. */
export function renderSmartComparison(report:ComparisonReport,outputs:readonly SmartEvalOutput[],examples:readonly string[]):string{
 const lines:string[]=[],models=report.models;
 lines.push('# AI Centre model comparison','',`Baseline: ${report.baseline}. Best other model: ${report.best??'none'}.`,`Judge: ${report.judges.join('; ')}. Question set: ${report.sets.join('; ')}. Spec: ${report.specs.join('; ')}.`,'');
 lines.push('| Model | Runs | Passes | Overall | Correct | Useful | Doing | Clear | Safe | Good answers | Cost / question | p50 | p95 | Refusals (expected) | Unexpected refusals | Errors | Fallbacks | Safety faults |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
 for(const row of models)lines.push(`| ${row.model} | ${row.runs.filter(Boolean).join(', ')||'–'} | ${row.passes} | ${cell(row.overall)} | ${DIMS.map(dimension=>cell(row.dims[dimension])).join(' | ')} | ${row.good.count}/${row.good.of} | ${usd(row.cost.modelUsdPerQuestion)} | ${ms(row.latency.p50Ms)} | ${ms(row.latency.p95Ms)} | ${row.refusals.expected}/${row.refusals.expectedOf} | ${row.refusals.unexpected} | ${row.errors.errored} | ${row.errors.fallbacks} | ${row.safetyFaults} |`);
 lines.push('','Judge cost per question: '+models.map(row=>row.model+' '+usd(row.cost.judgeUsdPerQuestion)).join('; ')+'. Unjudged answers: '+models.map(row=>row.model+' '+row.unjudged).join('; ')+'.','');
 lines.push('## By factor (overall, 0-100)','','| Factor | '+models.map(row=>row.model).join(' | ')+' | Recovered by best |','|---|'+models.map(()=>'---|').join('')+'---|');
 for(const factor of FACTORS)if(models.some(row=>factor in row.byFactor))lines.push(`| ${factor} | ${models.map(row=>cell(row.byFactor[factor])).join(' | ')} | ${cell(report.recovered.byFactor[factor],'%')} |`);
 lines.push('','## By role and language','','| Group | '+models.map(row=>row.model).join(' | ')+' |','|---|'+models.map(()=>'---|').join(''));
 const groups=[...new Set(models.flatMap(row=>[...Object.keys(row.byRole).map(key=>'role '+key),...Object.keys(row.byLocale).map(key=>'language '+key),...Object.keys(row.bySource).map(key=>'source '+key)]))];
 for(const name of groups){const [kind,key]=name.split(' ');const pick=(row:RunSummary)=>kind==='role'?row.byRole[key]:kind==='language'?row.byLocale[key]:row.bySource[key];lines.push(`| ${name} | ${models.map(row=>cell(pick(row))).join(' | ')} |`);}
 lines.push('','## Model or design','',`The best model recovers ${cell(report.recovered.overall,'%')} of the score the baseline loses. By dimension: ${DIMS.map(dimension=>dimension+' '+cell(report.recovered.byDimension[dimension],'%')).join(', ')}.`,'');
 lines.push(`Questions no model answers well (best below ${GOOD*100}): ${report.designLimited.length?report.designLimited.map(row=>`${row.id} (${row.factor}, best ${row.best})`).join('; '):'none'}.`,'');
 lines.push('## Deterministic findings (count of answers)','','| Check | '+models.map(row=>row.model).join(' | ')+' |','|---|'+models.map(()=>'---|').join(''));
 for(const check of [...new Set(models.flatMap(row=>Object.keys(row.findings)))].sort())lines.push(`| ${check} | ${models.map(row=>cell(row.findings[check]??0)).join(' | ')} |`);
 if(examples.length){lines.push('','## Side by side');
  for(const id of examples){const first=outputs.flatMap(output=>output.rows).find(row=>row.turn===id);if(!first)continue;
   lines.push('',`### ${id} (${first.role}, ${first.locale}, ${first.source}${first.issues?.length?' issue '+first.issues.join('/'):''})`,'',`> ${clip(first.question,300)}`,'');
   for(const row of models){const answer=outputs.filter(output=>output.model===row.model).flatMap(output=>output.rows).find(item=>item.turn===id);
    if(!answer)continue;
    lines.push(`- **${row.model}** (overall ${cell(pct(answer.score.overall))}${answer.suggestion?', card '+answer.suggestion:''}${answer.gate&&answer.gate!=='open'?', gate '+answer.gate:''}${answer.score.findings.length?', '+answer.score.findings.map(finding=>finding.check).join('/'):''}): ${answer.error?'ERROR '+answer.error:clip(answer.reply,600)}${answer.verdict?.reason?' — judge: '+clip(answer.verdict.reason,200):''}`);}
  }}
 return lines.join('\n')+'\n';
}

/** An evidence file's JSON, checked enough to compare. */
export function parseSmartEvalOutput(text:string,label:string):SmartEvalOutput{
 const output=JSON.parse(text) as SmartEvalOutput;
 if(output?.kind!=='teras.smart-eval'||output.version!==1||!Array.isArray(output.rows)||!Array.isArray(output.passes))throw Error(label+' is not an AI Centre evaluation output.');
 return output;
}
function main(argv:readonly string[]){
 const flag=(name:string)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:undefined;};
 const values=new Set([flag('--baseline'),flag('--examples')].filter(Boolean));
 const files=argv.filter(arg=>!arg.startsWith('--')&&!values.has(arg));
 if(!files.length){console.error('usage: compare-smart-eval.ts RUN.json [RUN.json …] [--baseline MODEL] [--examples id,id] [--json]');process.exit(2);}
 const outputs=files.map(file=>{const output=parseSmartEvalOutput(readFileSync(file,'utf8'),basename(file));return output.runId?output:{...output,runId:basename(file).replace(/\.json$/,'')};});
 const report=compareSmartRuns(outputs,flag('--baseline'));
 const examples=flag('--examples')?.split(',').map(id=>id.trim()).filter(Boolean)??pickExamples(report,6);
 process.stdout.write(argv.includes('--json')?JSON.stringify(report,null,1)+'\n':renderSmartComparison(report,outputs,examples));
}
if(process.argv[1]&&import.meta.url.endsWith(basename(process.argv[1])))main(process.argv.slice(2));
