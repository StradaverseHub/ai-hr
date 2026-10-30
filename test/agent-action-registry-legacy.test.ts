/** WP7 refactor equivalence. The registry replaced hand-written lists at base 7d397734d; this evaluates those
 * pre-registry sources (read from Git history, transpiled in memory, never written to the tree) and proves the
 * derived lists are unchanged for every legacy action. MODULE_AGENT_ACTIONS[module] and the module's handoffs
 * feed specialistNativeContractDigest, which binds promoted specialist releases (core/module-agent-releases.ts),
 * so they must stay byte-identical. A module whose action set has since changed is skipped automatically; a
 * deliberate, reviewed change to a legacy declaration replaces this test. Skipped only without Git history. */
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import {describe,expect,it} from 'vitest';
import {MODULE_AGENT_ACTIONS,parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {NATIVE_OUTCOME_ACTIONS,NATIVE_REVIEW_ACTIONS} from '../lib/ai/module-native-outcomes';
import {AGENT_ACTION_CATEGORY,AGENT_ACTION_TIER_CEILING} from '../lib/ai/agent-capability-inventory';
import {specialistNativeContractDigest} from '../lib/ai/module-specialists';
import {routingDigest} from '../lib/ai/module-agent-routing';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';

const ROOT=path.resolve(__dirname,'..'),BASE='7d397734dec939e21abb089ec4346dc4a61b4fdc';
function legacySource(file:string){try{return execFileSync('git',['show',`${BASE}:${file}`],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{return null;}}
const available=legacySource('lib/ai/module-agent-actions.ts')!==null;
type Exports=Record<string,unknown>;
/** CommonJS evaluation of one legacy file; its runtime imports resolve to the current modules unless overridden. */
async function evaluateLegacy(file:string,overrides:Record<string,Exports>={}):Promise<Exports>{
 const source=legacySource(file);if(source===null)throw Error(`Legacy ${file} unavailable`);
 const modules:Record<string,unknown>={...overrides};
 for(const match of source.matchAll(/^(?:import|export)\s+(?!type\b)[^'"=;]*from\s+'([^']+)';/gm)){
  const specifier=match[1]!;if(Object.hasOwn(modules,specifier))continue;
  const target=specifier.startsWith('.')?path.resolve(ROOT,path.dirname(file),specifier):specifier;
  modules[specifier]=await import(/* @vite-ignore */ target);
 }
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exported:Exports={},holder={exports:exported};
 new Function('require','module','exports',output)((specifier:string)=>{if(!Object.hasOwn(modules,specifier))throw Error(`Unmapped legacy import ${specifier}`);return modules[specifier];},holder,exported);
 return holder.exports;
}
type Declaration={actions:readonly {id:string}[]};
type Handoffs=(module:AgentModuleCode)=>unknown;
const outcome=(run:()=>unknown)=>{try{return JSON.stringify(run());}catch{return 'refused';}};

describe.skipIf(!available)('WP7 equivalence with the pre-registry hand lists (base 7d397734d)',()=>{
 it('derives byte-identical module declarations, human handoffs and specialist native-contract digests',async()=>{
  const legacyActions=await evaluateLegacy('lib/ai/module-agent-actions.ts');
  const legacyHandoffs=await evaluateLegacy('lib/ai/module-human-handoffs.ts',{'./module-agent-actions':legacyActions});
  const before=legacyActions.MODULE_AGENT_ACTIONS as Record<string,Declaration>,handoffs=legacyHandoffs.moduleHumanActionHandoffs as Handoffs;
  const ids=(row:Declaration)=>JSON.stringify(row.actions.map(action=>action.id).sort());
  let compared=0;
  for(const module of AGENT_MODULE_CODES){
   const legacy=before[module]!,current=MODULE_AGENT_ACTIONS[module];
   if(ids(legacy)!==ids(current))continue;compared++;
   expect(JSON.stringify(current),module).toBe(JSON.stringify(legacy));
   expect(JSON.stringify(moduleHumanActionHandoffs(module)),module).toBe(JSON.stringify(handoffs(module)));
   expect(specialistNativeContractDigest(module),module).toBe(routingDigest(['specialist-native-contract-v1',module,MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module),legacy,handoffs(module)]));
  }
  expect(compared).toBeGreaterThan(0);
 });

 it('keeps every legacy nomination, native outcome, review kind, tier ceiling and category',async()=>{
  const legacyActions=await evaluateLegacy('lib/ai/module-agent-actions.ts');
  const legacyNative=await evaluateLegacy('lib/ai/module-native-outcomes.ts'),legacyInventory=await evaluateLegacy('lib/ai/agent-capability-inventory.ts');
  const native=legacyNative.NATIVE_OUTCOME_ACTIONS as Record<string,unknown>,reviews=legacyNative.NATIVE_REVIEW_ACTIONS as readonly string[];
  const legacyIds=Object.keys(native);expect(legacyIds.length).toBeGreaterThanOrEqual(30);
  expect(Object.keys(NATIVE_OUTCOME_ACTIONS).filter(id=>legacyIds.includes(id))).toEqual(legacyIds);
  for(const id of legacyIds)expect((NATIVE_OUTCOME_ACTIONS as Record<string,unknown>)[id],id).toEqual(native[id]);
  expect(NATIVE_REVIEW_ACTIONS.filter(id=>reviews.includes(id))).toEqual([...reviews]);
  const tiers=legacyInventory.AGENT_ACTION_TIER_CEILING as Record<string,string>,categories=legacyInventory.AGENT_ACTION_CATEGORY as Record<string,string>;
  for(const id of legacyIds){
   expect((AGENT_ACTION_TIER_CEILING as Record<string,string>)[id],id).toBe(tiers[id]);
   expect((AGENT_ACTION_CATEGORY as Record<string,string>)[id],id).toBe(categories[id]);
  }
  const parseLegacy=legacyActions.parseModuleAgentActionNomination as (value:unknown)=>unknown;
  const candidates=[...legacyIds,...MODULE_AGENT_CAPABILITIES.map(row=>row[1]),'payroll.delete','leave.APPLY','constructor','__proto__'];
  let checked=0;
  for(const module of [...AGENT_MODULE_CODES,'future_module'])for(const action of candidates)for(const phase of ['read','explain','prepare','confirm','execute']){
   const value={module,action,phase};expect(outcome(()=>parseModuleAgentActionNomination(value)),JSON.stringify(value)).toBe(outcome(()=>parseLegacy(value)));checked++;
  }
  expect(checked).toBeGreaterThan(1000);
 });
});
