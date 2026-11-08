/** One closed PUBLIC fictional expectation format. Parsing/copying this data never
 * authenticates a fixture, source, principal, session, file descriptor or issuer.
 * No file/path/env/Git/database/session reader or admission capability lives here. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performanceFixtureCalendar} from './fixture-workload.mjs';
import {fixtureNavigationActor,validateNavigationScenarioPlan,type NavigationFixtureTextBindings,type NavigationScenarioPlan} from './navigation-protocol';
export const NAVIGATION_EXPECTED_INPUT_LIMIT=2*1024*1024;
export const NAVIGATION_EXPECTED_ACTORS=[0,1,2,4]as const;
export type NavigationExpectedSource={candidateSha:string;controllerSha:string;runId:number;attempt:1;buildId:string;fixtureSha256:string};
type History={kind:'none'}|{kind:'saved';firstSavedHistoryTitle:string};
type ActorInput={actorIndex:number;roleLabel:string;actorName:string;actorEmployeeCode:string;firstCompanyPersonName:string;activeHeadcount:string;
 historicalPayrollMonth:string;seedToday:string;seedMonth:string;history:History;rosterScope:{employmentId:string;expectedName:string|null}[];routeTargets:{destinationId:string;href:string}[]};
export type NavigationExpectedInputs={version:1;kind:'EXPECTED_FICTIONAL_NAVIGATION_INPUTS';source:NavigationExpectedSource;actorInputs:ActorInput[]};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
function closed(value:any,keys:readonly string[]):void{
 assert(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'),'Closed fictional expected-input fields required');
}
function source(value:any):NavigationExpectedSource{
 closed(value,['candidateSha','controllerSha','runId','attempt','buildId','fixtureSha256']);
 assert(typeof value.candidateSha==='string'&&typeof value.controllerSha==='string'&&typeof value.fixtureSha256==='string'&&/^[a-f0-9]{40}$/.test(value.candidateSha)&&/^[a-f0-9]{40}$/.test(value.controllerSha)&&/^[a-f0-9]{64}$/.test(value.fixtureSha256)
  &&Number.isSafeInteger(value.runId)&&value.runId>0&&value.attempt===1&&typeof value.buildId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.buildId),'Fictional expected source identity differs');
 return {candidateSha:value.candidateSha,controllerSha:value.controllerSha,runId:value.runId,attempt:1,buildId:value.buildId,fixtureSha256:value.fixtureSha256};
}
function routes(plan:NavigationScenarioPlan,index:number){
 const role=fixtureNavigationActor(index).role,map=new Map<string,string>();
 for(const row of plan.scenarios.filter(row=>row.role===role)){
  assert(!map.has(row.destinationId)||map.get(row.destinationId)===row.href,'Fictional destination has ambiguous addresses');map.set(row.destinationId,row.href);
 }
 return [...map].sort(([a],[b])=>lexical(a,b)).map(([destinationId,href])=>({destinationId,href}));
}
function actor(value:any,index:number,plan:NavigationScenarioPlan):ActorInput{
 closed(value,['actorIndex','roleLabel','actorName','actorEmployeeCode','firstCompanyPersonName','activeHeadcount','historicalPayrollMonth','seedToday','seedMonth','history','rosterScope','routeTargets']);
 const expected=fixtureNavigationActor(index),cases=plan.scenarios.filter(row=>row.role===expected.role);
 assert(value.actorIndex===index&&value.roleLabel===expected.role&&value.actorName===expected.name&&value.actorEmployeeCode==='PERF'+String(index).padStart(4,'0')
  &&value.firstCompanyPersonName==='PERF Person '+String(Math.floor(index/50)*50).padStart(4,'0'),'Fictional expected actor allocation differs');
 assert(typeof value.seedToday==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value.seedToday)&&value.seedMonth===value.seedToday.slice(0,7)
  &&value.historicalPayrollMonth===performanceFixtureCalendar(value.seedToday).historicalMonth,'Fictional expected dates differ');
 assert(cases.length>0,'Fictional expected actor has no source scenarios');
 const population=expected.role==='groupHR'?250:50,extra=index===0?1:0;
 assert(value.activeHeadcount===String(population)||extra===1&&value.activeHeadcount===String(population+1),'Fictional expected population differs');
 const needsHistory=cases.some(row=>row.checks.some(check=>'expected'in check&&check.expected==='$fixture.firstSavedHistoryTitle'));
 closed(value.history,needsHistory?['kind','firstSavedHistoryTitle']:['kind']);
 assert(value.history.kind===(needsHistory?'saved':'none')&&(!needsHistory||value.history.firstSavedHistoryTitle===`PERF saved ${index} root 00`),'Fictional expected history differs');
 const history:History=needsHistory?{kind:'saved',firstSavedHistoryTitle:value.history.firstSavedHistoryTitle}:{kind:'none'};
 const needsRoster=cases.some(row=>row.checks.some(check=>check.kind==='fixture-roster-rows'));
 assert(Array.isArray(value.rosterScope)&&value.rosterScope.length<=(needsRoster?population+extra:0),'Fictional expected roster exceeds its source obligation');
 const rosterScope:ActorInput['rosterScope']=[],ids=new Set<string>(),names=new Set<string>();let nulls=0,last='';
 const first=expected.role==='groupHR'?Math.floor(index/250)*250:Math.floor(index/50)*50;
 const expectedNames=new Set(Array.from({length:population},(_,i)=>fixtureNavigationActor(first+i).name));
 for(const row of value.rosterScope){
  closed(row,['employmentId','expectedName']);assert(typeof row.employmentId==='string'&&UUID.test(row.employmentId)&&!ids.has(row.employmentId)&&(!last||lexical(last,row.employmentId)<0),'Fictional expected roster identity differs');
  if(row.expectedName===null)nulls++;else{assert(expectedNames.has(row.expectedName)&&!names.has(row.expectedName),'Fictional expected roster name differs');names.add(row.expectedName);}
  ids.add(row.employmentId);last=row.employmentId;rosterScope.push({employmentId:row.employmentId,expectedName:row.expectedName});
 }
 assert(nulls<=extra&&(!needsRoster||names.size===population&&value.rosterScope.length===Number(value.activeHeadcount)),'Fictional expected roster incomplete');
 const routeTargets=routes(plan,index);
 assert(JSON.stringify(value.routeTargets)===JSON.stringify(routeTargets),'Fictional expected route targets differ');
 return {actorIndex:index,roleLabel:expected.role,actorName:expected.name,actorEmployeeCode:value.actorEmployeeCode,firstCompanyPersonName:value.firstCompanyPersonName,
  activeHeadcount:value.activeHeadcount,historicalPayrollMonth:value.historicalPayrollMonth,seedToday:value.seedToday,seedMonth:value.seedMonth,history,rosterScope,routeTargets};
}
/** Digest ONLY the canonical public actor-input manifest. Never the private fixture,
 * authentication/grant fields, their values, or a substitute serialized authority. */
function normalize(value:any,planValue:NavigationScenarioPlan):NavigationExpectedInputs{
 const plan=validateNavigationScenarioPlan(planValue);closed(value,['version','kind','source','actorInputs']);
 assert(value.version===1&&value.kind==='EXPECTED_FICTIONAL_NAVIGATION_INPUTS'&&Array.isArray(value.actorInputs)&&value.actorInputs.length===4,'Fictional expected-input envelope differs');
 const actorInputs=NAVIGATION_EXPECTED_ACTORS.map((index,i)=>actor(value.actorInputs[i],index,plan)),identity=source(value.source);
 assert(identity.fixtureSha256===sha(JSON.stringify(actorInputs)),'Public fictional fixture digest differs');
 const byName=new Map<string,string>(),byId=new Map<string,string|null>();
 for(const row of actorInputs.flatMap(actor=>actor.rosterScope)){
  assert(!byId.has(row.employmentId)||byId.get(row.employmentId)===row.expectedName,'Fictional expected roster identity has conflicting names');byId.set(row.employmentId,row.expectedName);
  if(row.expectedName!==null){assert(!byName.has(row.expectedName)||byName.get(row.expectedName)===row.employmentId,'Fictional expected roster name has conflicting identities');byName.set(row.expectedName,row.employmentId);}
 }
 assert(new Set(actorInputs.map(row=>row.seedToday)).size===1,'Fictional expected actor dates differ');
 return {version:1,kind:'EXPECTED_FICTIONAL_NAVIGATION_INPUTS',source:identity,actorInputs};
}
/** Pure projection from already checked constructor expectations; no issuer. */
export function projectNavigationExpectedInputs(bindings:ReadonlyMap<number,Readonly<NavigationFixtureTextBindings>>,planValue:NavigationScenarioPlan,identity:Omit<NavigationExpectedSource,'fixtureSha256'>):NavigationExpectedInputs{
 closed(identity,['candidateSha','controllerSha','runId','attempt','buildId']);const plan=validateNavigationScenarioPlan(planValue);
 const actorInputs=NAVIGATION_EXPECTED_ACTORS.map(index=>{
  const row=bindings.get(index);assert(row,'Fictional expected actor input missing');const expected=fixtureNavigationActor(index),cases=plan.scenarios.filter(row=>row.role===expected.role);
  const needsHistory=cases.some(row=>row.checks.some(check=>'expected'in check&&check.expected==='$fixture.firstSavedHistoryTitle'));
  const needsRoster=cases.some(row=>row.checks.some(check=>check.kind==='fixture-roster-rows'));
  return actor({actorIndex:index,roleLabel:expected.role,actorName:row.actorName,actorEmployeeCode:row.actorEmployeeCode,firstCompanyPersonName:row.firstCompanyPersonName,
   activeHeadcount:row.activeHeadcount,historicalPayrollMonth:row.historicalPayrollMonth,seedToday:row.seedToday,seedMonth:row.seedMonth,
   history:needsHistory?{kind:'saved',firstSavedHistoryTitle:row.firstSavedHistoryTitle}:{kind:'none'},
   rosterScope:needsRoster?Object.entries(row.rosterScope).sort(([a],[b])=>lexical(a,b)).map(([employmentId,expectedName])=>({employmentId,expectedName})):[],routeTargets:routes(plan,index)},index,plan);
 });
 return normalize({version:1,kind:'EXPECTED_FICTIONAL_NAVIGATION_INPUTS',source:{...identity,fixtureSha256:sha(JSON.stringify(actorInputs))},actorInputs},plan);
}
/** Canonical bytes reject ambiguous duplicate JSON fields/encodings/order. These
 * bytes remain public expectations even when they round-trip successfully. */
export function navigationExpectedInputBytes(value:NavigationExpectedInputs,plan:NavigationScenarioPlan):Uint8Array{
 const bytes=Buffer.from(JSON.stringify(normalize(value,plan))+'\n','utf8');assert(bytes.length<=NAVIGATION_EXPECTED_INPUT_LIMIT,'Fictional expected-input byte bound exceeded');return bytes;
}
export function parseNavigationExpectedInputBytes(bytes:Uint8Array,plan:NavigationScenarioPlan,expected:NavigationExpectedSource):NavigationExpectedInputs{
 assert(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=NAVIGATION_EXPECTED_INPUT_LIMIT,'Bounded fictional expected-input bytes required');
 const copy=Buffer.from(bytes),text=new TextDecoder('utf-8',{fatal:true}).decode(copy),value=normalize(JSON.parse(text),plan);
 assert(JSON.stringify(value.source)===JSON.stringify(source(expected)),'Fictional expected source binding differs');
 assert(Buffer.from(navigationExpectedInputBytes(value,plan)).equals(copy),'Canonical fictional expected-input encoding required');return value;
}
