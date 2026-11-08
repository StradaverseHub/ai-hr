/** Pure reconstruction from complete owned observations. Data is never admission authority. */
import assert from 'node:assert/strict';
import {singletonSources} from './singleton-protocol.mjs';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
import {assertEmployeeLifecycleSourceClosure} from './employee-lifecycle-sources.mjs';
import {validatePdfToolScope} from './pdf-tool-scope.mjs';
import {buildUnits,hash,CI_EXECUTION} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';
const fullSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const relative=value=>typeof value==='string'&&!value.includes('\0')&&!value.includes('\\')&&!value.startsWith('/')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
/** One COMPLETE `git ls-files --stage -z` observation, retaining every regular stage-0 entry. */
export function parseTrackedSourceInventory(raw){
 assert(raw instanceof Uint8Array&&raw.byteLength>0&&raw.byteLength<=8*1024**2,'Complete bounded tracked inventory required');
 const bytes=Buffer.from(raw),text=bytes.toString('utf8');assert(Buffer.from(text,'utf8').equals(bytes),'Tracked inventory must be lossless UTF-8');
 assert(text.endsWith('\0'),'Tracked inventory requires its actual final terminator');
 const seen=new Set(),rows=[];
 for(const record of text.slice(0,-1).split('\0')){
  const tab=record.indexOf('\t');assert(tab>0,'Malformed tracked inventory row');
  const match=/^(100644|100755) ([a-f0-9]{40}) 0$/.exec(record.slice(0,tab)),path=record.slice(tab+1);
  assert(match&&relative(path)&&!seen.has(path),'Unique regular stage-0 source required');
  if(rows.length)assert(Buffer.compare(Buffer.from(rows.at(-1).path),Buffer.from(path))<0,'Tracked inventory order differs from Git');
  seen.add(path);rows.push(Object.freeze({path,mode:match[1],blob:match[2]}));
 }
 return Object.freeze(rows);
}
/** Match the existing normal planner's actual line/field interpretation and exact partition. */
export function groupsFromClassifierOutput(suite,output){
 assert(Array.isArray(suite)&&suite.length&&new Set(suite).size===suite.length&&typeof output==='string','Complete classifier observations required');
 const groups={nodb:[],db:[]};
 for(const line of output.trim().split('\n')){
  const[kind,file]=line.split('\t');assert(['DB','NODB'].includes(kind)&&suite.includes(file),'Invalid classifier output');
  groups[kind==='DB'?'db':'nodb'].push(file);
 }
 assert.deepEqual([...groups.db,...groups.nodb].sort(),suite,'Classifier does not partition the suite exactly');
 return groups;
}
/** No Git, filesystem, classifier invocation or environment reads occur in this builder. */
export function buildPlanFromObservedSources({sha,controller,migrationBase,runtime,suite,groups,browsers,pdfTooling,singletonSourceHashes,migrationJournal}){
 assert(fullSha(sha)&&typeof controller==='string'&&controller.length>0&&(migrationBase===null||typeof migrationBase==='string'),'Complete source identity required');
 assert(runtime&&Object.keys(runtime).sort().join('|')==='arch|node|platform'&&Object.values(runtime).every(value=>typeof value==='string'&&value.length>0),'Complete observed runtime required');
 validatePdfToolScope(pdfTooling);
 const units=buildUnits(suite,groups,browsers),singletons=units.filter(unit=>unit.singleton);
 assert(singletonSourceHashes&&Object.getPrototypeOf(singletonSourceHashes)===Object.prototype,'Complete singleton source observations required');
 assert.deepEqual(Object.keys(singletonSourceHashes).sort(),singletons.map(unit=>unit.id).sort(),'Singleton source unit inventory differs');
 for(const unit of singletons){
  const sources=singletonSources(unit),hashes=singletonSourceHashes[unit.id];
  assert(hashes&&Object.getPrototypeOf(hashes)===Object.prototype);assert.deepEqual(Object.keys(hashes).sort(),sources,'Singleton source inventory differs');
  assert(Object.values(hashes).every(digest),'Singleton source digest differs');
  if(employeeLifecycleUnit(unit)){assert(migrationJournal,'Actual complete employee migration journal required');assertEmployeeLifecycleSourceClosure(sources,migrationJournal);}
 }
 const body={schemaVersion:2,policyVersion:CI_POLICY,sha,controller,migrationBase,runtime,execution:CI_EXECUTION,pdfTooling,singletonSources:singletonSourceHashes,suite,units};
 return{...body,fingerprint:hash(body)};
}
