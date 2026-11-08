/** Public fictional expectation codec controls; no file custody, issuer or native proof. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {projectNavigationFixtureBindings} from '../scripts/performance/navigation-fixture-bindings';
import {NAVIGATION_EXPECTED_INPUT_LIMIT,projectNavigationExpectedInputs,navigationExpectedInputBytes,parseNavigationExpectedInputBytes} from '../scripts/performance/navigation-expected-inputs';
import {validateNavigationScenarioPlan} from '../scripts/performance/navigation-protocol';
import {fictionalNavigationFixture,navigationFixtureUuid as uuid} from './helpers/navigation-fixture';
const plan=validateNavigationScenarioPlan(JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8')));
const identity={candidateSha:'a'.repeat(40),controllerSha:'b'.repeat(40),runId:123,attempt:1 as const,buildId:'fictional-build-123'};
function packet(){return projectNavigationExpectedInputs(projectNavigationFixtureBindings(fictionalNavigationFixture()),plan,identity);}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v),'utf8').digest('hex');
function forgedBytes(value:any){value.source.fixtureSha256=hash(value.actorInputs);return Buffer.from(JSON.stringify(value)+'\n');}
it('round-trips one public canonical format with exact four expected actors and independently bound source/build/fixture identity',()=>{
 const value=packet(),bytes=navigationExpectedInputBytes(value,plan),read=parseNavigationExpectedInputBytes(bytes,plan,value.source);
 expect(read).toEqual(value);expect(read.actorInputs.map(row=>row.actorIndex)).toEqual([0,1,2,4]);expect(read.source.fixtureSha256).toBe(hash(read.actorInputs));
 expect(read.actorInputs.map(row=>row.roleLabel)).toEqual(['groupHR','companyHR','manager','employee']);
 expect(read.actorInputs.map(row=>row.history.kind)).toEqual(['none','saved','none','saved']);
 expect(read.actorInputs.map(row=>row.rosterScope.length)).toEqual([250,50,0,0]);
 expect(read.actorInputs.map(row=>row.routeTargets.length)).toEqual([14,14,12,12]);expect(bytes.byteLength).toBeLessThan(NAVIGATION_EXPECTED_INPUT_LIMIT);
});
it('exports only minimal expected fields and fictional employment route IDs, never private fixture authentication/identity/grant values',()=>{
 const text=Buffer.from(navigationExpectedInputBytes(packet(),plan)).toString('utf8');
 for(const privateValue of ['NEVER_EXPORT','userId','personId','tenantId','companyId','token','password','secret','credential','principal','grants','DATABASE_URL','GITHUB','__Host-aihr_internal'])expect(text).not.toContain(privateValue);
 expect(text).toContain(uuid(1));expect(text).toContain('PERF Person 0000');
 const source=readFileSync(new URL('../scripts/performance/navigation-expected-inputs.ts',import.meta.url),'utf8');
 expect(source).not.toMatch(/from ['"]node:(?:fs|path|child_process)['"]|process\.env|readFile|openSync|WeakMap|fixture\.json/);
});
it('rejects duplicate/missing/reordered/extra actors and wrong expected role/name/code labels without inferring authority',()=>{
 for(const edit of [(v:any)=>v.actorInputs.pop(),(v:any)=>v.actorInputs.push(v.actorInputs[0]),(v:any)=>{v.actorInputs[1]=v.actorInputs[0];},
  (v:any)=>v.actorInputs.reverse(),(v:any)=>{v.actorInputs[0].roleLabel='employee';},(v:any)=>{v.actorInputs[1].actorName='PERF Person 0004';},
  (v:any)=>{v.actorInputs[1].actorEmployeeCode='PERF0004';}]){
  const v=packet();edit(v);expect(()=>parseNavigationExpectedInputBytes(forgedBytes(v),plan,v.source)).toThrow();
 }
});
it('rejects wrong route pairs, free targets, opaque history, unknown/private fields and source-type widening',()=>{
 for(const edit of [(v:any)=>{v.actorInputs[0].routeTargets[0].href='/unreviewed';},(v:any)=>v.actorInputs[0].routeTargets.push({destinationId:'free',href:'https://external.invalid'}),
  (v:any)=>{v.actorInputs[1].history={kind:'none'};},(v:any)=>{v.actorInputs[0].history={kind:'saved',firstSavedHistoryTitle:'PERF saved 0 root 00'};},
  (v:any)=>{v.actorInputs[1].history.firstSavedHistoryTitle='Foreign saved title';},(v:any)=>{v.actorInputs[0].principal={grants:[]};},
  (v:any)=>{v.source.candidateSha=[v.source.candidateSha];},(v:any)=>{v.source.attempt='1';},(v:any)=>{v.source.privatePath='/private/fixture.json';}]){
  const v=packet();edit(v);expect(()=>parseNavigationExpectedInputBytes(forgedBytes(v),plan,v.source)).toThrow();
 }
});
it('refuses incomplete/duplicate/foreign or cross-actor conflicting roster expectations while retaining every original scoped identity',()=>{
 for(const edit of [(v:any)=>v.actorInputs[0].rosterScope.pop(),(v:any)=>{v.actorInputs[0].rosterScope[1]=v.actorInputs[0].rosterScope[0];},
  (v:any)=>{v.actorInputs[0].rosterScope[0].expectedName='PERF Person 0250';},(v:any)=>{v.actorInputs[1].rosterScope[0].employmentId=uuid(999999);v.actorInputs[1].rosterScope.sort((a:any,b:any)=>a.employmentId.localeCompare(b.employmentId));},
  (v:any)=>{v.actorInputs[0].rosterScope[0].employmentId=[v.actorInputs[0].rosterScope[0].employmentId];},(v:any)=>{v.actorInputs[2].rosterScope=[v.actorInputs[0].rosterScope[0]];}]){
  const v=packet();edit(v);expect(()=>parseNavigationExpectedInputBytes(forgedBytes(v),plan,v.source)).toThrow();
 }
});
it('accounts for the existing preflight-only reward employment as one named-unavailable expected route ID without a population change',()=>{
 const f=fictionalNavigationFixture();f.tenants[0].rewardDraft={companyId:f.tenants[0].companies[2].companyId,employmentId:uuid(999999)};
 const v=projectNavigationExpectedInputs(projectNavigationFixtureBindings(f),plan,identity);
 expect(v.actorInputs[0].activeHeadcount).toBe('251');expect(v.actorInputs[0].rosterScope).toHaveLength(251);
 expect(v.actorInputs[0].rosterScope.filter(row=>row.expectedName===null)).toEqual([{employmentId:uuid(999999),expectedName:null}]);
 expect(v.actorInputs[1].activeHeadcount).toBe('50');expect(v.actorInputs[1].rosterScope).toHaveLength(50);
 expect(parseNavigationExpectedInputBytes(navigationExpectedInputBytes(v,plan),plan,v.source)).toEqual(v);
});
it('binds exact source/build/run and public-manifest digest expectations while disclosing no private fixture hash',()=>{
 const v=packet(),bytes=navigationExpectedInputBytes(v,plan);
 for(const changed of [{candidateSha:'c'.repeat(40)},{controllerSha:'d'.repeat(40)},{runId:124},{buildId:'other-build'},{fixtureSha256:'0'.repeat(64)}])expect(()=>parseNavigationExpectedInputBytes(bytes,plan,{...v.source,...changed})).toThrow();
 const changed=packet();changed.actorInputs[0].activeHeadcount='251';expect(()=>parseNavigationExpectedInputBytes(Buffer.from(JSON.stringify(changed)+'\n'),plan,v.source)).toThrow();
 expect(v.source.fixtureSha256).not.toBe(hash(fictionalNavigationFixture()));
});
it('rejects noncanonical/duplicate JSON fields, invalid UTF8/BOM, oversized bytes and copied authority flags',()=>{
 const v=packet(),bytes=Buffer.from(navigationExpectedInputBytes(v,plan)),text=bytes.toString('utf8');
 for(const altered of [Buffer.from(JSON.stringify(v,null,2)+'\n'),Buffer.from(text.replace('"version":1','"version":1,"version":1')),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]),Buffer.from([0xff]),Buffer.alloc(NAVIGATION_EXPECTED_INPUT_LIMIT+1)])expect(()=>parseNavigationExpectedInputBytes(altered,plan,v.source)).toThrow();
 const copy=JSON.parse(text);copy.releaseAuthorized=true;expect(()=>parseNavigationExpectedInputBytes(Buffer.from(JSON.stringify(copy)+'\n'),plan,v.source)).toThrow();
 // A JSON copy of valid public data still parses; it acquires no issuer/session capability.
 expect(parseNavigationExpectedInputBytes(Buffer.from(JSON.stringify(JSON.parse(text))+'\n'),plan,v.source)).toEqual(v);
 expect(v).not.toHaveProperty('authority');expect(v).not.toHaveProperty('releaseAuthorized');
});
