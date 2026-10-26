/** Duration hints affect grouping only. Complete classifier membership remains authoritative. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const pathPattern=/^test\/[A-Za-z0-9_./-]+(?:\.test\.ts|\.dom\.test\.tsx)$/;
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function validateDurationHints(value){
 assert(value?.schemaVersion===1&&value.kind==='DURATION_HINTS_ONLY_NEVER_COVERAGE_OR_PASS','Unknown timing hint schema');
 assert(Number.isSafeInteger(value.unknownDurationMs)&&value.unknownDurationMs>0&&value.unknownDurationMs<=3600000,'Invalid unknown duration');
 assert(value.durationsMs&&typeof value.durationsMs==='object'&&!Array.isArray(value.durationsMs),'Missing duration hints');
 const entries=Object.entries(value.durationsMs);assert(entries.length>0&&entries.length<=100000,'Unbounded duration hint inventory');
 for(const [file,ms]of entries)assert(pathPattern.test(file)&&!file.split('/').some(p=>!p||p==='.'||p==='..')&&Number.isSafeInteger(ms)&&ms>0&&ms<=3600000,'Invalid duration hint');
 return Object.freeze({...value.durationsMs});
}
const bytes=readFileSync(new URL('./db-duration-hints.json',import.meta.url));
const profile=JSON.parse(bytes),hints=validateDurationHints(profile);
export const DB_SCHEDULING=Object.freeze({algorithm:'duration-balanced-v1',hintsSha256:createHash('sha256').update(bytes).digest('hex'),unknownDurationMs:profile.unknownDurationMs});
/** Stable longest-first bin packing; preserve the original ceil(N/maxFiles) job count and cap. */
export function balanceDatabaseFiles(files,maxFiles=64,durations=hints,unknownDurationMs=profile.unknownDurationMs){
 assert(Array.isArray(files)&&files.every(f=>typeof f==='string'&&pathPattern.test(f)&&!f.split('/').some(p=>!p||p==='.'||p==='..'))&&new Set(files).size===files.length,'Invalid complete DB inventory');
 assert(Number.isSafeInteger(maxFiles)&&maxFiles>0&&maxFiles<=64,'Invalid DB batch capacity');
 assert(Number.isSafeInteger(unknownDurationMs)&&unknownDurationMs>0&&unknownDurationMs<=3600000,'Invalid unknown-file duration');
 const cost=file=>{const ms=Object.hasOwn(durations,file)?durations[file]:unknownDurationMs;assert(Number.isSafeInteger(ms)&&ms>0&&ms<=3600000,'Invalid selected duration hint');return ms;};
 const sorted=files.slice().sort((a,b)=>cost(b)-cost(a)||compare(a,b));
 const bins=Array.from({length:Math.ceil(files.length/maxFiles)},(_,index)=>({index,files:[],cost:0}));
 for(const file of sorted){
  const bin=bins.filter(b=>b.files.length<maxFiles).sort((a,b)=>a.cost-b.cost||a.files.length-b.files.length||a.index-b.index)[0];
  assert(bin,'Missing DB scheduling capacity');bin.files.push(file);bin.cost+=cost(file);
 }
 // Expensive groups enter a constrained matrix first; every member is sorted before content hashing.
 return bins.sort((a,b)=>b.cost-a.cost||a.index-b.index).map(b=>b.files.sort(compare));
}
