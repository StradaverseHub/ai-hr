/** Versioned delivery contracts. No model-authored risk/authority field is accepted. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const POLICY='aihr-delivery/v1';
export const REPOSITORY='StradaverseHub/ai-hr';
export const REPOSITORY_ID=1333414856;
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function exact(v,keys){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.slice().sort(),'Unexpected or missing contract field');}
export function strings(xs,{nonempty=true}={}){assert(Array.isArray(xs)&&(!nonempty||xs.length)&&xs.every(x=>typeof x==='string'&&x.length>0)&&new Set(xs).size===xs.length);return xs;}
export function verifyPlan(p){
 exact(p,['policy','candidate','base','controller','policyDigest','tree','profile','reasons','changed','checks','inputSets','inventory','fingerprint']);
 assert(p.policy===POLICY&&sha(p.candidate)&&sha(p.base)&&sha(p.controller)&&digest(p.policyDigest)&&sha(p.tree));
 assert(['scoped','broad'].includes(p.profile));strings(p.changed);strings(p.reasons,{nonempty:false});strings(p.inventory);
 assert(Array.isArray(p.checks)&&p.checks.length>0&&new Set(p.checks.map(c=>c.id)).size===p.checks.length);
 const covered=[];
 for(const c of p.checks){exact(c,['id','kind','files','inputSet','inputs','reuse','key']);strings(c.files);assert(['test','browser-chromium','browser-firefox','browser-webkit','compiler','build','migration','controller'].includes(c.kind));assert(['never','exact-inputs'].includes(c.reuse));assert(digest(c.inputs)&&digest(c.inputSet)&&Object.hasOwn(p.inputSets,c.inputSet));assert(hash(p.inputSets[c.inputSet])===c.inputSet);assert(c.id===c.kind+'-'+hash(c.files).slice(0,16));assert(c.key===hash({policy:POLICY,policyDigest:p.policyDigest,kind:c.kind,files:c.files,inputs:c.inputs}));if(c.kind==='test')covered.push(...c.files);else if(c.kind.startsWith('browser-'))covered.push(...c.files.map(p=>p+'::'+c.kind.slice(8)));}
 assert.deepEqual(covered.slice().sort(),p.inventory.slice().sort(),'Every test must have exactly one evidence owner');
 const {fingerprint,...body}=p;assert(fingerprint===hash(body));return p;
}
export function buildPlan({candidate,base,controller,policyDigest,tree,profile,reasons,changed,checks,inventory}){
 const inputSets={};const normalized=checks.map(({kind,files,inputs,inputFiles='*',reuse='never'})=>{const descriptor=inputFiles==='*'?'*':strings(inputFiles).slice().sort();const inputSet=hash(descriptor);inputSets[inputSet]=descriptor;files=strings(files).slice().sort();const id=kind+'-'+hash(files).slice(0,16);return {id,kind,files,inputSet,inputs,reuse,key:hash({policy:POLICY,policyDigest,kind,files,inputs})};});
 const body={policy:POLICY,candidate,base,controller,policyDigest,tree,profile,reasons:reasons.slice().sort(),changed:changed.slice().sort(),checks:normalized,inputSets,inventory:inventory.slice().sort()};return verifyPlan({...body,fingerprint:hash(body)});
}
/** Evidence reuse preserves original provenance; no previous commit is relabelled current. */
export function selectWork(plan,observations,{now=Date.now(),maxAgeMs=86400000}={}){
 verifyPlan(plan);assert(Number.isFinite(now)&&Number.isFinite(maxAgeMs)&&maxAgeMs>0&&maxAgeMs<=86400000);
 const run=[],reuse=[];
 for(const c of plan.checks){
  if(plan.profile==='broad'||c.reuse==='never'){run.push(c);continue;}
  const candidates=observations.filter(o=>o.report.key===c.key&&o.report.result==='passed'&&o.report.policy===POLICY&&o.report.policyDigest===plan.policyDigest&&o.report.inputDigest===c.inputs&&o.report.check===c.id&&o.verifiedAt<=now&&now-o.verifiedAt<=maxAgeMs);
  // Caller must load observations through authenticateEvidence, never a PR-supplied cache JSON.
  if(candidates.length)reuse.push({check:c.id,key:c.key,observation:candidates.sort((a,b)=>b.verifiedAt-a.verifiedAt)[0]});else run.push(c);
 }
 return {run,reuse};
}
export function verifyReport(check,report){
 exact(report,['policy','candidate','controller','policyDigest','check','key','inputDigest','result','files','assertions','skipped']);
 assert(report.policy===POLICY&&digest(report.policyDigest)&&sha(report.candidate)&&sha(report.controller)&&report.check===check.id&&report.key===check.key&&report.inputDigest===check.inputs);
 assert(report.result==='passed'&&report.skipped===0&&Number.isSafeInteger(report.assertions)&&report.assertions>0);assert.deepEqual(report.files,check.files);return report;
}
export function verifyCoverage(plan,observations){
 verifyPlan(plan);assert(Array.isArray(observations)&&observations.length===plan.checks.length,'Complete non-overlapping evidence required');const seen=new Set();
 for(const o of observations){const c=plan.checks.find(c=>c.id===o.report.check);assert(c&&!seen.has(c.id));seen.add(c.id);verifyReport(c,o.report);if(c.reuse==='never')assert(o.report.candidate===plan.candidate,'Volatile/opaque check cannot inherit a different source');assert(o.report.policyDigest===plan.policyDigest,'Foreign policy inputs');}
 return {policy:POLICY,candidate:plan.candidate,controller:plan.controller,plan:plan.fingerprint,evidence:observations.map(o=>hash({report:o.report,producer:o.producer})).sort(),result:'passed'};
}
