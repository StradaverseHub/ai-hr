import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {classifyTestFiles} from '../scripts/gate-db-classify';
import {stageNames,canonicalJson} from '../scripts/gate-db-witness-protocol';
import {CLASSIFIER_WITNESS_PROFILES,CLASSIFIER_WITNESS_PHASES,CLASSIFIER_WITNESS_TIMING,CLASSIFIER_WITNESS_BYTES,CLASSIFIER_PROGRAMS,classifierWitnessUnit} from '../.github/ci/diagnostics/classifier-witness-profile.mjs';
import {replayClassifierGraph,verifyClassifierGraph,requireGraphMatchesClassifier,classifierResultRows} from '../.github/ci/diagnostics/classifier-witness-graph.mjs';
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const url=['DATA','BASE_URL'].join('');
function fixture(tree:Record<string,string>,suite:string[]){
 const probes=new Map<string,string|null>();
 const actual=classifyTestFiles(suite,path=>{const value=Object.hasOwn(tree,path)?tree[path]:null;probes.set(path,value);return value;});
 return{actual,entries:[...probes].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,text])=>({path,text}))};
}
describe('independent complete-source graph witness without native authority',()=>{
 it('owns exactly three deeply frozen distinct classifier rows and preserves the complete fixed phase schedules',()=>{
  expect(CLASSIFIER_WITNESS_PROFILES).toHaveLength(3);expect(new Set(CLASSIFIER_WITNESS_PROFILES.map(row=>row.file)).size).toBe(3);
  expect(Object.isFrozen(CLASSIFIER_WITNESS_PROFILES)&&CLASSIFIER_WITNESS_PROFILES.every(Object.isFrozen)).toBe(true);
  for(const purpose of ['semantic','cli-b','cli-c'] as const){const phases=CLASSIFIER_WITNESS_PHASES[purpose];expect(phases.map(row=>row.stage)).toEqual(stageNames(purpose));expect(phases.every(row=>Object.isFrozen(row)&&row.settlementMs===6000)).toBe(true);expect(phases.reduce((sum,row)=>sum+row.workMs+row.settlementMs,0)).toBe(purpose==='semantic'?218000:365000);}
  expect(CLASSIFIER_WITNESS_TIMING.caseMs).toBe(450000);expect(CLASSIFIER_WITNESS_TIMING.ownerMs).toBe(420000);expect(CLASSIFIER_WITNESS_BYTES.ledger).toBe(131072);expect(CLASSIFIER_WITNESS_BYTES.archiveMembers).toBe(100);
 });
 it('refuses a malformed known classifier capability rather than treating it as an unrelated unit',()=>{
  const unit={id:'nodb-example',kind:'nodb',files:[CLASSIFIER_WITNESS_PROFILES[0].file],singleton:{version:1,profile:CLASSIFIER_WITNESS_PROFILES[0].profile,workers:1,isolation:'job-host'}};
  expect(classifierWitnessUnit(unit)).toBe(true);expect(classifierWitnessUnit({files:['test/unrelated.test.ts']})).toBe(false);
  for(const mutation of [(x:any)=>x.kind='db',(x:any)=>x.files.push('test/unrelated.test.ts'),(x:any)=>x.singleton.workers=2,(x:any)=>x.singleton.isolation='job-postgres-cluster',(x:any)=>x.singleton.extra=true]){const bad=clone(unit);mutation(bad);expect(()=>classifierWitnessUnit(bad)).toThrow();}
 });
 it('pins the complete current algorithm and actual historical whole bodies without importing them as an oracle',()=>{
  const memo=JSON.parse(readFileSync('docs/qualification/db-classifier-request-reader-memo-inverse-20261108.json','utf8')),graph=JSON.parse(readFileSync('docs/qualification/db-classifier-complete-graph-inverse-20261108.json','utf8'));
  const sources={a:Buffer.from(graph.originalBase64,'base64'),b:Buffer.from(memo.files['scripts/gate-db-classify.ts'].originalBase64,'base64'),c:readFileSync('scripts/gate-db-classify.ts')};
  for(const engine of ['a','b','c']as const)expect(createHash('sha256').update(sources[engine]).digest('hex')).toBe(CLASSIFIER_PROGRAMS[engine].sha256);
 });
 it('closes a helper cycle from an independent late hazard and retains first-reason paths for both roots',()=>{
  const suite=['test/a.test.ts','test/b.test.ts'],data=fixture({'test/a.test.ts':"import './b';",'test/b.test.ts':"import './a.test'; import './late';",'test/b.ts':"import './a.test'; import './late';",'test/late.ts':`const marker='${url}';`},suite);
  const witness=requireGraphMatchesClassifier(suite,data.entries,data.actual);expect(witness.verdicts.map(row=>row.kind)).toEqual(['DB','DB']);expect(witness.verdicts.every(row=>row.reason==='test/late.ts: mentions a '+url)).toBe(true);expect(witness.witnesses.every(row=>row.nodeIds.length>1)).toBe(true);
 });
 it('keeps a harmless cycle clean without borrowing a provisional result from another root order',()=>{
  const suite=['test/a.test.ts','test/b.test.ts'],data=fixture({'test/a.test.ts':"import './b.test';",'test/b.test.ts':"import './a.test';"},suite),witness=requireGraphMatchesClassifier(suite,data.entries,data.actual);
  expect(witness.graph.hazardous).toEqual([]);expect(witness.verdicts.map(row=>row.kind)).toEqual(['NODB','NODB']);expect(witness.witnesses.every(row=>row.nodeIds.length===0)).toBe(true);
 });
 it('preserves text and opaque precedence over earlier textual imports and reports the native first rule',()=>{
  for(const [source,expected]of [[`import './missing'; const marker='${url}';`,'mentions a '+url],["import './missing'; import(variable);",'a dynamic import()/require() that is not a string literal']]as const){const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':source},suite),witness=requireGraphMatchesClassifier(suite,data.entries,data.actual);expect(witness.verdicts[0].reason).toBe('test/a.test.ts: '+expected);expect(witness.graph.resolvers).toEqual([]);}
 });
 it('retains duplicate stem probes and first-positive ESM source fallback without following product imports',()=>{
  const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':"import '../core/clean.js';",'core/clean.ts':`const ignored='${url}';`},suite),witness=requireGraphMatchesClassifier(suite,data.entries,data.actual),resolver=witness.graph.resolvers[0];
  expect(resolver.outcome).toBe('resolved');expect(data.entries[resolver.selectedSourceId!].path).toBe('core/clean.ts');expect(witness.graph.nodes).toHaveLength(1);expect(witness.verdicts[0].kind).toBe('NODB');expect(resolver.candidates.length).toBeGreaterThan(10);
 });
 it('refuses an unobserved resolver key instead of guessing null and rejects duplicate or reordered sealed entries',()=>{
  const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':"import './missing';"},suite),missing=data.entries.findIndex(row=>row.text===null);
  expect(()=>replayClassifierGraph(suite,data.entries.filter((_,index)=>index!==missing))).toThrow();expect(()=>replayClassifierGraph(suite,[...data.entries,data.entries[0]])).toThrow();expect(()=>replayClassifierGraph(suite,data.entries.slice().reverse())).toThrow();
 });
 it('independently detects forged hazard sets, resolver choices, helper edges and first reasons after canonical wire roundtrip',()=>{
  const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':"import './helper';",'test/helper.ts':`const marker='${url}';`},suite),expected=replayClassifierGraph(suite,data.entries);
  expect(verifyClassifierGraph(suite,data.entries,JSON.parse(canonicalJson(expected)))).toEqual(expected);
  for(const mutation of [(x:any)=>x.graph.hazardous=[],(x:any)=>x.graph.resolvers[0].selectedSourceId=null,(x:any)=>x.graph.nodes[0].steps[0].targetId=0,(x:any)=>x.verdicts[0].reason='invented',(x:any)=>x.witnesses[0].nodeIds.reverse()]){const bad=clone(expected);mutation(bad);expect(()=>verifyClassifierGraph(suite,data.entries,bad)).toThrow();}
 });
 it('requires the entire real batch partition and all first reasons rather than matched counts',()=>{
  const suite=['test/a.test.ts','test/b.test.ts'],data=fixture({'test/a.test.ts':'','test/b.test.ts':`const marker='${url}';`},suite);
  expect(classifierResultRows(suite,data.actual).map(row=>row.kind)).toEqual(['NODB','DB']);
  for(const result of [{...data.actual,db:[suite[0]],nodb:[suite[1]]},{...data.actual,nodb:[]},{...data.actual,why:new Map([[suite[0],'x']])},{...data.actual,db:[suite[1],suite[1]]}])expect(()=>requireGraphMatchesClassifier(suite,data.entries,result)).toThrow();
 });
 it('independently preserves the full direct-rule, driver-prefix, named-module and import-form matrix',()=>{
  const texts=[['migrate'+'TestDb(1)','calls migrate'+'TestDb('],['reset'+'Db()','calls reset'+'Db('],['with'+'Tenant(x)','calls with'+'Tenant('],[url,'mentions a '+url],["inject('worker"+'DbPrefix'+"')","inject('worker"+'DbPrefix'+"')"],['p'+'sql','mentions p'+'sql']];
  for(const [body,label]of texts){const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':body},suite);expect(requireGraphMatchesClassifier(suite,data.entries,data.actual).verdicts[0].reason).toBe('test/a.test.ts: '+label);}
  for(const driver of ['pg','postgres','drizzle-orm/postgres-js','drizzle-orm/node-postgres','drizzle-orm/pg-core'])for(const spec of [driver,driver+'/internal']){const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':`import '${spec}';`},suite);expect(requireGraphMatchesClassifier(suite,data.entries,data.actual).verdicts[0].reason).toBe('test/a.test.ts: imports '+spec);}
  for(const name of ['test/harness','test/global-setup','db/client','db/schema']){const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':`export * from '@/${name}';`,[name+'.ts']:''},suite);expect(requireGraphMatchesClassifier(suite,data.entries,data.actual).verdicts[0].reason).toBe('test/a.test.ts: imports '+name);}
  for(const expression of ["export type {X} from './h';","vi.importActual('./h');","vi.importMock('./h');","require('./h');"]){const suite=['test/a.test.ts'],data=fixture({'test/a.test.ts':expression,'test/h.ts':url},suite);expect(requireGraphMatchesClassifier(suite,data.entries,data.actual).verdicts[0].reason).toBe('test/h.ts: mentions a '+url);}
 });
 it('preserves the complete string beyond four MiB and a late hazard without a clean prefix exemption',()=>{
  const suite=['test/a.test.ts'],source=' '.repeat(4*1024*1024+1)+url,data=fixture({'test/a.test.ts':source},suite),witness=requireGraphMatchesClassifier(suite,data.entries,data.actual);
  expect(data.entries.find(row=>row.path===suite[0])!.text).toBe(source);expect(witness.verdicts[0]).toEqual({rootId:0,kind:'DB',reason:'test/a.test.ts: mentions a '+url});
 });

});
