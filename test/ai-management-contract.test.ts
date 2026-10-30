import {aiBoundaryViolations,parseAiSource} from '../scripts/ai-caller-drift';
import {guardFiles} from '../scripts/gate-affected-plan';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname,join,normalize } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES } from '../lib/ai/features';
import { MODULE_CATALOG, SETTING_CATALOG } from '../packs/catalog';
const read=(p:string)=>readFileSync(p,'utf8');
const walk=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):/\.(?:[cm]?[jt]sx?)$/.test(e.name)?[join(p,e.name)]:[]);
const coreCallers:Record<string,string>={'core/assistant.ts':'hr_assistant','core/feedback.ts':'feedback_planning','core/input-triage.ts':'claims_triage','core/pay-rule-ai.ts':'pay_rule_draft','core/payroll-anomaly-narrate.ts':'payroll_explanation','core/payroll-hypothesis.ts':'payroll_hypotheses','core/performance.ts':'performance_pm','core/readiness-nudge.ts':'readiness_reminders','core/report-ai.ts':'report_insight'};
// Callers whose provider configuration is issued for ONE named workload by a governed seam other than a
// literal resolveActiveAiConfig: the snapshot-governed module agent flows (governedAiConfig in the release
// owner, handed only to the two synthetic harnesses, which admit every call under that same feature) and the
// personnel import header assistant (resolveActiveAiConfig through its FEATURE constant). Every entry names
// registered features and must show each listed seam; an unregistered caller still fails above.
const governedCallers:Record<string,{features:readonly string[];seams:readonly RegExp[];issuedBy?:string;issuerImport?:string}>={
 // Shared closed analysis entrypoint: config feature stays server-issued; projection and native replay bind exact bytes.
 'core/ai-payroll-comparison-analysis.ts':{features:['payroll_explanation'],seams:[/resolveActiveAiConfig\(tx,ctx,'payroll_explanation'\)/,/executePayrollComparisonTx\(tx,current,/,/generatePrivateAiAnalysis\(configuration,/]},
 'core/ai-domain-analysis.ts':{features:['report_insight'],seams:[/resolveActiveAiConfig\(tx,await authorizeSourceTx\(tx,ctx,selected\),'report_insight'\)/,/generatePrivateAiTaskAnalysis\(configuration,'aggregate_snapshot_analysis_v1',/,/await authorizeSourceTx\(tx,current,selected\)/,/return domainAnalysisProjection\(selected.domain,source\)/]},
 'core/ai-workforce-analysis.ts':{features:['report_insight'],seams:[/resolveActiveAiConfig\(tx,fresh,'report_insight'\)/,/authorizeSourceTx\(tx,current,selected\)/,/generatePrivateAiAnalysis\(configuration,/]},
 'core/ai-governance.ts':{features:AI_FEATURES.map(feature=>feature.id),seams:[/const issued=issuedConfigurations.get\(configuration\)/,/prepareProviderAnalysis\(binding,source\)/,/bindProviderPrivacyRequest\(next,/,/generateDraft\(prepared.configuration,prepared.args\)/]},
 'core/assistant-import.ts':{features:['hr_assistant'],seams:[/const FEATURE\s*=\s*'hr_assistant'/,/resolveActiveAiConfig\(tx,\s*ctx,\s*FEATURE\)/,/withAiAdmissionCheck\(cfg,FEATURE/]},
 'lib/ai/provider-protocol.ts':{features:['provider_evaluation'],seams:[/if \(configuration\.provider !== 'openrouter' \|\| !configuration\.governance\) return unavailable\(\);/,/import \{preparePrivateAiTask,withAiRunObserver\} from '\.\.\/\.\.\/core\/ai-governance';/,/const cfg=withAiRunObserver\(configuration,\{/,/return preparePrivateAiTask\(cfg,id,async\(\)=>source\)/,/preparedCall\('synthetic_protocol_echo_v1',\{marker\}\)/,/preparedCall\('synthetic_protocol_tools_v1',\{marker,stage:'first',callId:null\}\)/,/preparedCall\('synthetic_protocol_tools_v1',\{marker,stage:'final',callId:call.id\}\)/],issuedBy:'core/ai-provider-readiness.ts',issuerImport:"from '../lib/ai/provider-protocol'"},
 'core/assistant-conversation-harness.ts':{features:['module_agent_evaluation'],seams:[/withAiAdmissionLifecycle\(cfg,\s*'module_agent_evaluation'/],issuedBy:'core/module-agent-releases.ts'},
 'core/module-agent-prompt-harness.ts':{features:['module_agent_evaluation'],seams:[/withAiAdmissionLifecycle\(cfg,\s*'module_agent_evaluation'/],issuedBy:'core/module-agent-releases.ts'},
 'core/module-agent-releases.ts':{features:['module_agent_evaluation','module_agent_planning'],seams:[/governedAiConfig\([^()]*'module_agent_evaluation'\)/,/governedAiConfig\([^()]*'module_agent_planning'\)/,/withAiAdmissionLifecycle\([^,()]*,\s*'module_agent_planning'/]},
 'core/personnel-import-assistance.ts':{features:['personnel_import_mapping'],seams:[/const FEATURE\s*=\s*'personnel_import_mapping'/,/resolveActiveAiConfig\(tx,\s*ctx,\s*FEATURE\)/]},
};
// Shared Performance provider seam: it resolves no configuration of its own and admits every call under the
// calling Performance feature. Its call sites ARE provider call sites, so each is held to the same rule as a
// direct call (a Performance pack file that resolves through assessmentAiConfigTx); the seam shows its admission.
const performanceSeam={file:'packs/performance/onehr/provider-source-draft.ts',calls:['generatePerformanceSourceDraft','generatePerformanceNativeOutline'],admission:/withAiAdmissionCheck\(cfg,\s*`performance_\$\{feature\}`/};
// Explicit workload ownership, not a lower-bound substitute. Shared/native wrappers still count
// at their actual callers; the native owner has two distinct protected transport call sites.
const performanceCallers:Record<string,number>={
 'packs/performance/onehr/admin-agent-service.ts':1,
 'packs/performance/onehr/ai.ts':1,
 'packs/performance/onehr/calibration-conversation.ts':1,
 'packs/performance/onehr/career-draft-service.ts':1,
 'packs/performance/onehr/competency-insight-service.ts':1,
 'packs/performance/onehr/development-suggestion-service.ts':1,
 'packs/performance/onehr/evidence-reading.ts':1,
 'packs/performance/onehr/feedback-conversation.ts':1,
 'packs/performance/onehr/guide-service.ts':1,
 'packs/performance/onehr/idp-fit-service.ts':1,
 'packs/performance/onehr/insight-service.ts':1,
 'packs/performance/onehr/potential-insight-service.ts':1,
 'packs/performance/onehr/provider-source-draft.ts':2,
 'packs/performance/onehr/record-insight-service.ts':1,
 'packs/performance/onehr/review-command-ai.ts':2,
 'packs/performance/onehr/rewrite-service.ts':1,
 'packs/performance/onehr/talent-insight-service.ts':1,
 'packs/performance/onehr/written-remarks-service.ts':1,
};
const analysisCalls=['generatePrivateAiAnalysis','generatePrivateAiTaskAnalysis'];
const workloadCalls=['generateDraft','readImage','converse',...analysisCalls,...performanceSeam.calls];
const importOwner=(file:string,specifier:string)=>{
 const path=normalize(specifier.startsWith('@/')?specifier.slice(2):specifier.startsWith('.')?join(dirname(file),specifier):specifier);
 return path==='lib/ai'||path==='lib/ai/index'?'lib/ai/index.ts':/\.[cm]?[jt]sx?$/.test(path)?path:path+'.ts';
};
function workloadSource(file:string,src:string){
 const tree=parseAiSource(file,src),aliases=new Map<string,{name:string;owner:string}>(),namespaces=new Map<string,string>();
 for(const statement of tree.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings){
  const owner=importOwner(file,statement.moduleSpecifier.text),bindings=statement.importClause.namedBindings;
  if(ts.isNamedImports(bindings))for(const name of bindings.elements)aliases.set(name.name.text,{name:(name.propertyName??name.name).text,owner});
  else if(ts.isNamespaceImport(bindings))namespaces.set(bindings.name.text,owner);
 }
 const calls:{name:string;owner?:string}[]=[];let admission=false,shared=false;
 const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)){
  const call:{name:string;owner?:string}|undefined=ts.isIdentifier(node.expression)?aliases.get(node.expression.text)??{name:node.expression.text}:
   ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&namespaces.has(node.expression.expression.text)?{name:node.expression.name.text,owner:namespaces.get(node.expression.expression.text)}:undefined;
  if(call){
   if(workloadCalls.includes(call.name))calls.push(call);
   if(call.name==='withAiAdmissionCheck'&&call.owner==='core/ai-governance.ts')admission=true;
   if(performanceSeam.calls.includes(call.name)&&call.owner===performanceSeam.file)shared=true;
  }
 }ts.forEachChild(node,visit);};visit(tree);
 return {calls,admission,shared};
}
function assertWorkloadOwner(file:string,src:string){
 const {calls,admission,shared}=workloadSource(file,src);
 expect(aiBoundaryViolations(file,src),file).toEqual([]);
 if(!calls.length)return {kind:null,count:0};
 for(const call of calls){
  const owner=performanceSeam.calls.includes(call.name)?performanceSeam.file:analysisCalls.includes(call.name)?'core/ai-governance.ts':'lib/ai/index.ts';
  expect(call.owner,`${file}:${call.name} must use its canonical imported owner`).toBe(owner);
 }
 if(file.startsWith('core/')||governedCallers[file]){
  const governed=governedCallers[file];
  if(governed){
   for(const feature of governed.features)expect(AI_FEATURES.some(f=>f.id===feature),`${file}:${feature}`).toBe(true);
   for(const seam of governed.seams)expect(src,`${file} ${seam}`).toMatch(seam);
   if(governed.issuedBy){const issuer=read(governed.issuedBy);expect(issuer,`${governed.issuedBy} issues ${file}`).toContain(governed.issuerImport??`from './${file.slice('core/'.length,-'.ts'.length)}'`);
    for(const feature of governed.features)expect(issuer).toMatch(new RegExp(`governedAiConfig\([^()]*'${feature}'\)`));}
  }else{expect(coreCallers[file],`${file} needs a registered capability`).toBeTruthy();expect(src,`${file} resolves ${coreCallers[file]}`).toMatch(new RegExp(`resolveActiveAiConfig\(tx,\s*ctx,\s*'${coreCallers[file]}'\)`));}
  return {kind:'core',count:calls.length};
 }
 expect(file.startsWith('packs/performance/onehr/'),`${file} needs a governed configuration seam`).toBe(true);
 expect(performanceCallers[file],`${file} needs a registered Performance caller`).toBe(calls.length);
 if(file===performanceSeam.file)expect(src).toMatch(performanceSeam.admission);
 else{
  expect(src,`${file} must resolve the actual Performance configuration`).toContain('assessmentAiConfigTx');
  expect(admission||shared,`${file} must call an imported admission owner or governed Performance wrapper`).toBe(true);
 }
 return {kind:'pack',count:calls.length};
}
describe('complete AI management inventory and boundary',()=>{
 it('registers every production AI workload caller and keeps providers behind the shared gateway',()=>{
  const coreFound:string[]=[],packFound:Record<string,number>={};let packCalls=0;
  for(const file of [...walk('core'),...walk('packs'),...walk('app'),...walk('lib'),...walk('scripts')]){
   const found=assertWorkloadOwner(file,read(file));
   if(found.kind==='core')coreFound.push(file);
   if(found.kind==='pack'){packFound[file]=found.count;packCalls+=found.count;}
  }
  expect(coreFound.sort()).toEqual([...Object.keys(coreCallers),...Object.keys(governedCallers)].sort());expect(packCalls).toBeGreaterThan(15);
  expect(packFound).toEqual(performanceCallers);expect(Object.keys(packFound)).toHaveLength(18);expect(packCalls).toBe(20);
  // Since the provider snapshot owner (ADR-0131, 64651f101) the tenant row and platform fallback are one
  // snapshot, so the active resolver issues exactly one governed configuration and nothing ungoverned.
  const config=read('core/ai-config.ts');expect(config.match(/governedAiConfig\(/g)?.length).toBe(1);
  expect(config).toMatch(/const snapshot\s*=\s*await resolveAiProviderSnapshotTx\(tx,\s*ctx\);\s*return snapshot\s*\?\s*governedAiConfig\(ctx,\s*snapshot,\s*feature\)\s*:\s*null;/);
 });
 it('sees calls after TypeScript generics and preserves canonical aliased and namespace wrapper ownership',()=>{
  const generic='const run=<T>(fn:()=>T):T=>fn();';
  const admin=workloadSource('packs/performance/onehr/admin-agent-service.ts',read('packs/performance/onehr/admin-agent-service.ts'));
  expect(admin.calls).toEqual([{name:'generateDraft',owner:'lib/ai/index.ts'}]);expect(admin.admission).toBe(true);
  expect(workloadSource('core/fixture.ts',`import {generateDraft as draft} from '../lib/ai'; ${generic} draft(cfg,args);`).calls).toEqual([{name:'generateDraft',owner:'lib/ai/index.ts'}]);
  expect(workloadSource('core/fixture.tsx',`import * as ai from '../lib/ai'; const view=<div/>; ai.converse(cfg,args);`).calls).toEqual([{name:'converse',owner:'lib/ai/index.ts'}]);
  expect(workloadSource('core/fixture.ts',"import {generatePrivateAiTaskAnalysis as analyse} from './ai-governance'; analyse(cfg,id,read);").calls).toEqual([{name:'generatePrivateAiTaskAnalysis',owner:'core/ai-governance.ts'}]);
  const file='packs/performance/onehr/idp-fit-service.ts';
  for(const call of performanceSeam.calls){
   const aliased=`import {${call} as draft} from './provider-source-draft'; import {assessmentAiConfigTx} from './ai-settings'; ${generic} draft(cfg,ctx,'idp',args,replay);`;
   expect(workloadSource(file,aliased).shared).toBe(true);expect(()=>assertWorkloadOwner(file,aliased)).not.toThrow();
   const namespaced=`import * as provider from './provider-source-draft'; import {assessmentAiConfigTx} from './ai-settings'; provider.${call}(cfg,ctx,'idp',args,replay);`;
   expect(workloadSource(file,namespaced).shared).toBe(true);expect(()=>assertWorkloadOwner(file,namespaced)).not.toThrow();
   expect(()=>assertWorkloadOwner(file,aliased.replace("from './provider-source-draft'","from './rogue'"))).toThrow();
   expect(()=>assertWorkloadOwner('packs/performance/onehr/unregistered.ts',aliased)).toThrow();
  }
  expect(()=>assertWorkloadOwner('core/unregistered.ts',"import {generatePrivateAiTaskAnalysis} from './ai-governance'; generatePrivateAiTaskAnalysis(cfg,id,read);")).toThrow();
  expect(()=>assertWorkloadOwner('app/unregistered.ts',"import {generateDraft} from '../lib/ai'; generateDraft(cfg,args);")).toThrow();
 });
 it('fails closed on malformed syntax and detects provider bypasses after a valid TypeScript generic',()=>{
  const generic='const run=<T>(fn:()=>T):T=>fn();';
  for(const [source,error] of [
   ["fetch('https://api.openai.com/v1/chat/completions',{method:'POST'});",'raw provider fetch outside gateway transport'],
   ["import OpenAI from 'openai';",'provider SDK outside adapter'],
   ["import {openaiAdapter} from '../lib/ai/providers/openai';",'provider adapter outside gateway'],
   ["import {createUngovernedProbe as bypass} from '../lib/ai/governance'; bypass(cfg,run);",'probe capability outside connection test'],
   ["import {withProviderEgressDispatch as bypass} from '../lib/ai/provider-egress'; bypass(cfg,request,send);",'provider egress issuer outside gateway'],
   ["import {bindProviderPrivacyRequest as bypass} from '../lib/ai/provider-privacy-request'; bypass(cfg,args);",'provider privacy issuer outside owner'],
  ])expect(aiBoundaryViolations('core/rogue.ts',generic+source)).toContain(error);
  for(const [file,source] of [['core/broken.ts','const broken=;'],['app/broken.tsx','const view=<div>']]){
   expect(()=>workloadSource(file,source)).toThrow('Unparseable AI source');expect(aiBoundaryViolations(file,source)).toEqual(['unparseable AI source']);
  }
 });
 it('rejects injected raw provider fetches and SDK imports in lib and scripts',()=>{
  for(const file of ['lib/rogue.ts','scripts/rogue.ts']){
   expect(aiBoundaryViolations(file,"const endpoint='https://api.openai.com/v1/chat/completions'; fetch(endpoint,{method:'POST'});" )).toContain('raw provider fetch outside gateway transport');
   expect(aiBoundaryViolations(file,"import OpenAI from 'openai';")).toContain('provider SDK outside adapter');
   expect(aiBoundaryViolations(file,"import {openaiAdapter} from '../lib/ai/providers/openai';")).toContain('provider adapter outside gateway');
   expect(aiBoundaryViolations(file,"const endpoint='https://'+'api.openai.com'+'/v1/chat/completions'; const f=fetch; f(endpoint,{body:JSON.stringify({model,messages}),headers:{Authorization:key}});")).toContain('raw provider fetch outside gateway transport');
   expect(aiBoundaryViolations(file,"const endpoint='https://'+'api.openai.com'+'/v1/chat/completions'; fetch(endpoint,{body:JSON.stringify({model,messages}),headers:{Authorization:key}});")).toContain('raw provider fetch outside gateway transport');
   expect(aiBoundaryViolations(file,"import {createUngovernedProbe as bypass} from './governance'; bypass(cfg,run);")).toContain('probe capability outside connection test');
   expect(aiBoundaryViolations(file,"globalThis.fetch(url,{headers:{Authorization:'Bearer '+apiKey},body:JSON.stringify({model:model,messages:messages})});")).toContain('raw provider fetch outside gateway transport');
  }
  expect(guardFiles(['test/ai-management-contract.test.ts','test/unrelated.test.ts'])).toEqual(['test/ai-management-contract.test.ts']);
 });
 it('keeps the SQL inventory, module catalogue and canonical switches consistent',()=>{
  // The live definition of a function is its LAST redefinition in journal (apply) order; 0568, 0621 and 0648 replaced ai_admit.
  const journal:string[]=JSON.parse(read('db/migrations/meta/_journal.json')).entries.map((e:{tag:string})=>`db/migrations/${e.tag}.sql`);
  const live=(marker:string)=>{const files=journal.filter(f=>read(f).includes(marker));expect(files.length,marker).toBeGreaterThan(0);return read(files.at(-1)!);};
  const guard=live('FUNCTION app.ai_control_policy_guard()'),admit=live('FUNCTION app.ai_admit('),context=live('FUNCTION app._ai_control_context(');
  expect(journal.filter(f=>read(f).includes('FUNCTION app.ai_admit(')).length).toBeGreaterThanOrEqual(2);
  // 0648 replaced ai_admit again; the live admission owns no feature list of its own and resolves the
  // feature through the live control context (0621), which refuses every unlisted feature.
  const admitAt=admit.lastIndexOf('FUNCTION app.ai_admit('),admitBody=admit.slice(admitAt,admit.indexOf('END $$',admitAt));
  expect(admitAt).toBeGreaterThanOrEqual(0);expect(admitBody.length).toBeGreaterThan(500);expect(admitBody).toContain('app._ai_control_context(wanted_feature,');
  for(const feature of AI_FEATURES){expect(context).toContain(`'${feature.id}'`);if(feature.module)expect(MODULE_CATALOG.some(m=>m.code===feature.module)).toBe(true);if(feature.setting)expect(SETTING_CATALOG.some(s=>s.key===feature.setting)).toBe(true);}
  for(const [source,marker,expected] of [[guard,'NEW.feature_id',AI_FEATURES.filter(f=>f.setting===null)],[context,'wanted_feature',AI_FEATURES]] as const){
   const lists=[...source.matchAll(new RegExp(`${marker.replace('.','\\.')} NOT IN \\(([^)]+)\\)`,'g'))];expect(lists,marker).toHaveLength(1);
   expect([...lists[0][1].matchAll(/'([^']+)'/g)].map(m=>m[1]).sort()).toEqual(expected.map(f=>f.id).sort());
  }
 });
 it('has every dynamic key in all six locales and describes reservations and shared attribution',()=>{
  for(const locale of ['en','ms','zh','vi','th','ta']){
   const data=JSON.parse(read(`messages/${locale}.json`)).aiManagement;
   for(const feature of AI_FEATURES)expect(data.features[feature.id],`${locale}:${feature.id}`).toBeTruthy();
   for(const [section,keys] of Object.entries({states:['ready','paused','module','provider','restricted'],runStates:['pending','completed','failed','blocked'],kinds:['assistant','agent','feature','platform'],operations:['draft','conversation','image'],reasons:['paused','daily_limit','monthly_limit'],levels:['near','at']}))for(const key of keys)expect(data[section][key],`${locale}:${section}.${key}`).toBeTruthy();
   expect(data.reservationHelp.length).toBeGreaterThan(30);expect(data.attribution.length).toBeGreaterThan(30);
  }
 });
});
