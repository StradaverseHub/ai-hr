/** ADR-0170 §3.12, step 5c — the model comparison report and its recommendation rule, over fictional probe
 * outputs shaped like test/assistant-model-ceiling.eval.test.ts's AIHR_ASSISTANT_MODEL_CEILING line. */
import {describe,expect,it} from 'vitest';
import {HARD_GATES,compareRuns,renderComparison,summariseRun,type ProbeOutput,type ProbeRun} from '../core/improvement/compare';
import {parseProbe} from '../scripts/teras/compare-models';

type Tally={turns:number;met:number;missed:number;failed:number;byCategory:Record<string,{turns:number;met:number;missed:number;failed:number}>};
const tally=(rows:Record<string,[number,number,number?]>):Tally=>{const byCategory=Object.fromEntries(Object.entries(rows).map(([name,[turns,met,failed=0]])=>[name,{turns,met,missed:turns-met-failed,failed}]));
 const sum=(key:'turns'|'met'|'missed'|'failed')=>Object.values(byCategory).reduce((total,row)=>total+row[key],0);
 return{turns:sum('turns'),met:sum('met'),missed:sum('missed'),failed:sum('failed'),byCategory};};
function probe(change:{model?:string;variant?:string;original?:Record<string,[number,number,number?]>;step4?:Record<string,[number,number,number?]>;usd?:number;steps?:number;
 breaches?:number;links?:number;overclaims?:number;sensitive?:number|null;blank?:number;errors?:number}={}):ProbeOutput{
 const original=tally(change.original??{action:[6,6],negative:[4,4],guidance:[10,9]}),passes=3,turns=original.turns+(change.step4?tally(change.step4).turns:0);
 return{variant:change.variant??'teras_harness_v5',model:change.model??'fictional/model-a',spentUsd:Number(((change.usd??0.0005)*turns*passes).toFixed(4)),calls:turns*passes*2,
  stability:{repeats:passes,behaviour:{reviewedIdeals:{original:{perPass:[original,original,original]},...(change.step4?{step4:{perPass:Array(passes).fill(tally(change.step4))}}:{})}},
   blankReplies:change.blank??0,errors:[]},
  context:{inventedLinks:Array(change.links??0).fill('/x'),overclaims:Array(change.overclaims??0).fill('claim')},
  ...(change.sensitive===null?{}:{sensitive:{findings:Array(change.sensitive??0).fill('finding'),rows:30}}),
  negativeGateBreaches:Array(change.breaches??0).fill({turn:'x'}),
  ledger:Array.from({length:turns*passes},(_,index)=>({usd:change.usd??0.0005,steps:change.steps??2,...(index<(change.errors??0)?{error:'provider_400'}:{})}))};
}
const run=(label:string,output:ProbeOutput,wallSeconds:number|null=600):ProbeRun=>({label,output,wallSeconds});

describe('summary',()=>{
 it('scores groups and categories summed over passes, and reads cost and latency',()=>{
  const summary=summariseRun(run('a',probe({step4:{explanation:[4,3]}})));
  expect(summary.groups.original).toMatchObject({turns:60,met:57});
  expect(summary.groups.original.byCategory.guidance).toEqual({turns:30,met:27,rate:0.9});
  expect(summary.groups.step4).toMatchObject({turns:12,met:9});
  expect(summary.cost).toEqual({spentUsd:0.036,turns:72,usdPerTurn:0.0005});
  expect(summary.latency).toEqual({providerCallsPerTurn:2,p95ProviderCalls:2,wallSeconds:600,secondsPerTurn:Number((600/(72/3+10)).toFixed(2))});
  expect(Object.values(summary.gates).every(gate=>gate.result==='pass')).toBe(true);
 });
});

describe('recommendation rule',()=>{
 const current=run('current',probe());
 it('adopts an equal or better candidate within cost',()=>{
  const report=compareRuns(current,run('candidate',probe({model:'fictional/model-b',original:{action:[6,6],negative:[4,4],guidance:[10,10]}})));
  expect(report.recommendation).toBe('adopt');expect(report.behaviour.deltaPoints).toBe(5);
 });
 it('rejects any hard-gate failure, whatever the behaviour',()=>{
  const changes:NonNullable<Parameters<typeof probe>[0]>[]=[{breaches:1},{links:1},{overclaims:2},{sensitive:1},{blank:1},{errors:4},{original:{action:[6,6],negative:[4,3,1],guidance:[10,10]}}];
  for(const change of changes){
   const report=compareRuns(current,run('candidate',probe(change)));
   expect(report.recommendation,JSON.stringify(change)).toBe('reject');expect(report.reasons.some(reason=>reason.startsWith('hard gate'))).toBe(true);
  }
  expect(HARD_GATES).toHaveLength(7);
 });
 it('rejects a candidate that does not measure a hard gate',()=>{
  const report=compareRuns(current,run('candidate',probe({sensitive:null})));
  expect(report.recommendation).toBe('reject');expect(report.reasons).toContain('hard gate sensitive_findings: candidate did not measure it');
 });
 it('asks for review on a small behaviour drop or a cost jump, and rejects a large drop',()=>{
  const big={action:[60,60],negative:[40,40],guidance:[100,100]} as Record<string,[number,number]>;
  const base=run('current',probe({original:big}));
  expect(compareRuns(base,run('c',probe({original:{...big,guidance:[100,99]}}))).recommendation).toBe('review');
  expect(compareRuns(base,run('c',probe({original:{...big,guidance:[100,90]}}))).recommendation).toBe('reject');
  const pricey=compareRuns(base,run('c',probe({original:big,usd:0.001})));
  expect([pricey.recommendation,pricey.costRatio]).toEqual(['review',2]);
 });
 it('scores only groups both runs measured',()=>{
  const report=compareRuns(current,run('candidate',probe({step4:{explanation:[4,1]}})));
  expect([report.commonGroups,report.onlyCandidate,report.recommendation]).toEqual([['original'],['step4'],'adopt']);
 });
});

describe('report input and output',()=>{
 it('parses a job log line and its wall time, and renders plain text with the recommendation first',()=>{
  const output=probe();
  const log=`2026-11-01T14:47:25Z noise\n2026-11-01T14:47:25Z AIHR_ASSISTANT_MODEL_CEILING ${JSON.stringify(output)}\n2026-11-01T14:47:26Z \u001b[32m✓\u001b[39m runs every corpus in repeated concurrent passes under a hard spend cap \u001b[33m 578909\u001b[2mms\u001b[22m`;
  const parsed=parseProbe(log,'41302596155');
  expect([parsed.label,parsed.wallSeconds,parsed.output.model]).toEqual(['41302596155',579,'fictional/model-a']);
  expect(parseProbe(JSON.stringify(output),'bare').wallSeconds).toBeNull();
  expect(()=>parseProbe('{"ledger":[]}','bad')).toThrow('bad is not a probe output.');
  const text=renderComparison(compareRuns(parsed,run('candidate',probe({breaches:1}))));
  expect(text.split('\n').slice(0,5)).toEqual(['MODEL COMPARISON REPORT','Current:   41302596155: fictional/model-a, teras_harness_v5, 3 passes','Candidate: candidate: fictional/model-a, teras_harness_v5, 3 passes','','RECOMMENDATION: REJECT']);
  expect(text).toContain('- negative_gate_breaches: pass (0) -> fail (1)');
  expect(text).toContain('A person decides whether to switch');
 });
});
