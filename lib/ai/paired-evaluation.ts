/** Measured source-owned observations. Null means unknown, never a free/zero-cost run.
 * Timings describe observations; timer noise alone never establishes better canonical quality. */
export type MeasuredEvaluationCase=Readonly<{id:string;passed:boolean;securityFailure:boolean;elapsedMs:number;readCount:number;tokens:number|null;costCredits:number|null}>;
export function summarizeMeasuredCases(rows:readonly MeasuredEvaluationCase[]){
 const values=rows.map(row=>row.elapsedMs).sort((a,b)=>a-b),quantile=(q:number)=>values.length?values[Math.max(0,Math.ceil(values.length*q)-1)]:null;
 const sumKnown=(key:'tokens'|'costCredits')=>{if(!rows.length||rows.some(row=>row[key]===null))return null;const sum=rows.reduce((total,row)=>total+row[key]!,0);return Number.isFinite(sum)?sum:null;};
 return Object.freeze({cases:rows.length,correct:rows.filter(row=>row.passed).length,securityFailures:rows.filter(row=>row.securityFailure).length,
  readCount:rows.reduce((sum,row)=>sum+row.readCount,0),elapsedMs:rows.reduce((sum,row)=>sum+row.elapsedMs,0),p50Ms:quantile(.5),p95Ms:quantile(.95),tokens:sumKnown('tokens'),costCredits:sumKnown('costCredits')});
}
export function compareMeasuredQuality(baseline:readonly MeasuredEvaluationCase[],candidate:readonly MeasuredEvaluationCase[],required:number){
 const b=summarizeMeasuredCases(baseline),c=summarizeMeasuredCases(candidate),complete=b.cases===required&&c.cases===required&&new Set(baseline.map(row=>row.id)).size===required&&new Set(candidate.map(row=>row.id)).size===required&&JSON.stringify(baseline.map(row=>row.id).sort())===JSON.stringify(candidate.map(row=>row.id).sort());
 const qualityImproved=complete&&c.correct===required&&c.securityFailures===0&&c.correct>b.correct&&c.securityFailures<=b.securityFailures;
 return Object.freeze({complete,baseline:b,candidate:c,qualityImproved,resourceClaims: 'observations-only' as const});
}
/** Strict persisted-report shape. The caller separately authenticates the sealed source binding. */
export function captureMeasuredCases(value:unknown,ids:readonly string[]):readonly MeasuredEvaluationCase[]{
 if(!Array.isArray(value)||value.length!==ids.length)throw Error('Measured evidence unavailable.');
 const rows=value.map((row,index)=>{if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='costCredits,elapsedMs,id,passed,readCount,securityFailure,tokens'||row.id!==ids[index]||typeof row.passed!=='boolean'||typeof row.securityFailure!=='boolean'||typeof row.elapsedMs!=='number'||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||!Number.isSafeInteger(row.readCount)||row.readCount<0||row.readCount>4||(row.tokens!==null&&(!Number.isSafeInteger(row.tokens)||row.tokens<0||row.tokens>1e9))||(row.costCredits!==null&&(typeof row.costCredits!=='number'||!Number.isFinite(row.costCredits)||row.costCredits<0)))throw Error('Measured evidence unavailable.');return Object.freeze({...row}) as MeasuredEvaluationCase;});return Object.freeze(rows);
}
