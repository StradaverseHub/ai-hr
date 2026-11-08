import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parseTrackedSourceInventory,groupsFromClassifierOutput,buildPlanFromObservedSources} from '../.github/ci/plan-observed.mjs';
import {classifyPdfToolSources,inspectPdfToolScopeFromTracked,validatePdfToolScope,PDF_TOOL_CONSUMERS} from '../.github/ci/pdf-tool-scope.mjs';
import {singletonSources,singletonDescriptor} from '../.github/ci/singleton-protocol.mjs';
import {CI_POLICY} from '../.github/ci/policy-version.mjs';
import {CI_EXECUTION} from '../.github/ci/manifest.mjs';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const paths=[...PDF_TOOL_CONSUMERS,'lib/borang-8a-pdf.ts','lib/borang-8b-pdf.ts','lib/cp21-fields.ts','lib/cp22a-fields.ts'];
const sources=()=>paths.map(path=>({path,bytes:readFileSync(path)}));
const census=()=>classifyPdfToolSources(sources());
type Observations={sha:string;controller:string;migrationBase:null;runtime:{node:string;platform:string;arch:string};suite:string[];groups:{nodb:string[];db:string[]};browsers:string[];pdfTooling:ReturnType<typeof census>;singletonSourceHashes:Record<string,Record<string,string>>};
const observations=():Observations=>({sha:'a'.repeat(40),controller:'b'.repeat(40),migrationBase:null,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},suite:['test/a.test.ts','test/b.test.ts'],groups:{nodb:['test/a.test.ts','test/b.test.ts'],db:[]},browsers:['test/a.browser.test.tsx'],pdfTooling:census(),singletonSourceHashes:{}});
const record=(path:string,mode='100644',stage='0',blob='a'.repeat(40))=>`${mode} ${blob} ${stage}\t${path}\0`;
describe('complete observed normal plan reconstruction without admission authority',()=>{
 it('preserves every regular tracked row, object and executable mode in a frozen complete inventory',()=>{
  const raw=Buffer.from(record('a.txt')+record('test/z.test.ts','100755'));
  expect(parseTrackedSourceInventory(raw)).toEqual([{path:'a.txt',mode:'100644',blob:'a'.repeat(40)},{path:'test/z.test.ts',mode:'100755',blob:'a'.repeat(40)}]);
  const rows=parseTrackedSourceInventory(raw);expect(Object.isFrozen(rows)&&rows.every(Object.isFrozen)).toBe(true);
 });
 it('refuses truncated, duplicate, reordered, conflict, symlink, submodule and malformed tracked observations',()=>{
  for(const raw of ['',record('a').slice(0,-1),record('a')+record('a'),record('b')+record('a'),record('a','100644','1'),record('a','120000'),record('a','160000'),record('../a'),record('/a'),record('a\\b'),record('a','100644','0','g'.repeat(40)),record('a')+'\0'])expect(()=>parseTrackedSourceInventory(Buffer.from(raw))).toThrow();
  expect(()=>parseTrackedSourceInventory(Buffer.from([0xff,0]))).toThrow();
 });
 it('enforces the whole eight MiB inventory cap without truncating its late rows',()=>{
  const last='z'.repeat(8*1024**2),raw=Buffer.from(record('a')+record(last));expect(raw.length).toBeGreaterThan(8*1024**2);expect(()=>parseTrackedSourceInventory(raw)).toThrow();
 });
 it('preserves the actual normal classifier field interpretation and exact complete partition',()=>{
  const suite=['test/a.test.ts','test/b.test.ts'];expect(groupsFromClassifierOutput(suite,'NODB\ttest/a.test.ts\tfirst\tcontinued\nDB\ttest/b.test.ts\tsecond\n')).toEqual({nodb:[suite[0]],db:[suite[1]]});
  for(const output of ['','NODB\ttest/a.test.ts\n','NODB\ttest/a.test.ts\nDB\ttest/a.test.ts\n','UNKNOWN\ttest/a.test.ts\nDB\ttest/b.test.ts','NODB\ttest/foreign.test.ts\nDB\ttest/b.test.ts'])expect(()=>groupsFromClassifierOutput(suite,output)).toThrow();
 });
 it('shares the complete PDF classifier through the supplied tracked inventory without hidden reads',()=>{
  const rows=sources(),tree=new Map(rows.map(row=>[row.path,row.bytes])),tracked=[...paths,'README.md','core/clean.ts'].sort(),read:string[]=[];
  const scope=inspectPdfToolScopeFromTracked(tracked,(path:string)=>{read.push(path);return tree.get(path)??Buffer.from('export const clean=true;');});
  expect(read).toEqual(tracked.filter(path=>path!=='README.md'));expect(scope.referenceSources).toEqual(census().referenceSources);expect(scope.scannedSources).toBe(paths.length+1);expect(scope.referenceFingerprint).toBe(census().referenceFingerprint);
 });
 it('refuses unknown PDF references, missing audited sources and unsafe complete tracked names',()=>{
  const tree=new Map(sources().map(row=>[row.path,row.bytes]));
  expect(()=>inspectPdfToolScopeFromTracked([...paths,'core/new.ts'],(path:string)=>tree.get(path)??Buffer.from('pdf'+'info'))).toThrow();
  expect(()=>inspectPdfToolScopeFromTracked(paths.slice(1),(path:string)=>tree.get(path))).toThrow();
  for(const tracked of [[],[...paths,paths[0]],[...paths,'../escape.ts'],[...paths,'/absolute'],[...paths,'x\0y']])expect(()=>inspectPdfToolScopeFromTracked(tracked,(path:string)=>tree.get(path))).toThrow();
 });
 it('checks complete PDF census identity, ordering, byte-pinned comments and recomputed fingerprint',()=>{
  const good=census();expect(validatePdfToolScope(good)).toBe(good);
  for(const mutate of [(x:any)=>x.referenceSources.reverse(),(x:any)=>x.referenceSources.pop(),(x:any)=>x.referenceSources.find((row:any)=>row.kind==='byte-pinned-comment-only').sha256='0'.repeat(64),(x:any)=>x.referenceFingerprint='0'.repeat(64),(x:any)=>x.scannedSources=1,(x:any)=>x.extra=true]){const bad=clone(good);mutate(bad);expect(()=>validatePdfToolScope(bad)).toThrow();}
 });
 it('reconstructs the entire normal body and deterministic units from actual-shaped complete observations',()=>{
  const input=observations(),plan=buildPlanFromObservedSources(input),body={schemaVersion:2,policyVersion:CI_POLICY,sha:input.sha,controller:input.controller,migrationBase:null,runtime:input.runtime,execution:CI_EXECUTION,pdfTooling:input.pdfTooling,singletonSources:{},suite:input.suite,units:[{id:'nodb-'+sha(JSON.stringify(input.suite)).slice(0,16),kind:'nodb',files:input.suite,pdfTools:false},...['chromium','firefox','webkit'].map(engine=>({id:'browser-'+engine,kind:'browser',engine,files:input.browsers,pdfTools:false}))]};
  expect(plan).toEqual({...body,fingerprint:sha(JSON.stringify(body))});expect(plan).not.toHaveProperty('releaseAuthorized');expect(input).toEqual(observations());
 });
 it('requires every current singleton source digest and refuses coherent omissions, extras and invalid digests',()=>{
  const input=observations(),file='test/notification-worker-lifecycle.test.ts',descriptor=singletonDescriptor(file),unit={id:'db-'+sha(JSON.stringify({file,descriptor})).slice(0,16),kind:'db',files:[file],pdfTools:false,singleton:descriptor};
  input.suite=[file];input.groups={db:[file],nodb:[]};input.singletonSourceHashes={[unit.id]:Object.fromEntries(singletonSources(unit).map((path:string)=>[path,'a'.repeat(64)]))};
  expect(buildPlanFromObservedSources(input).units[0]).toEqual(unit);
  for(const mutate of [(x:any)=>delete x.singletonSourceHashes[unit.id],(x:any)=>delete x.singletonSourceHashes[unit.id]['vitest.config.ts'],(x:any)=>x.singletonSourceHashes[unit.id].extra='a'.repeat(64),(x:any)=>x.singletonSourceHashes[unit.id]['vitest.config.ts']='bad']){const bad=clone(input);mutate(bad);expect(()=>buildPlanFromObservedSources(bad)).toThrow();}
 });
 it('rejects an incomplete partition, altered source identity or missing runtime field before publishing a plan',()=>{
  for(const mutate of [(x:any)=>x.groups.nodb.pop(),(x:any)=>x.groups.db.push(x.suite[0]),(x:any)=>x.sha='bad',(x:any)=>delete x.runtime.arch,(x:any)=>x.singletonSourceHashes.extra={}]){const bad=observations();mutate(bad);expect(()=>buildPlanFromObservedSources(bad)).toThrow();}
 });
});
