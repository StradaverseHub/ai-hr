import {aiBoundaryViolations} from '../scripts/ai-caller-drift';
import {guardFiles} from '../scripts/gate-affected-plan';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
 'core/ai-workforce-analysis.ts':{features:['report_insight'],seams:[/resolveActiveAiConfig\(tx,fresh,'report_insight'\)/,/authorizeSourceTx\(tx,current,selected\)/,/generatePrivateAiAnalysis\(configuration,/]},
 'core/ai-governance.ts':{features:AI_FEATURES.map(feature=>feature.id),seams:[/const issued=issuedConfigurations.get\(configuration\)/,/prepareProviderAnalysis\(binding,source\)/,/bindProviderPrivacyRequest\(next,/,/generateDraft\(prepared.configuration,prepared.args\)/]},
 'core/assistant-import.ts':{features:['hr_assistant'],seams:[/const FEATURE\s*=\s*'hr_assistant'/,/resolveActiveAiConfig\(tx,\s*ctx,\s*FEATURE\)/,/withAiAdmissionCheck\(cfg,FEATURE/]},
 'lib/ai/provider-protocol.ts':{features:['provider_evaluation'],seams:[/if \(configuration\.provider !== 'openrouter' \|\| !configuration\.governance\) return unavailable\(\);/,/return await governance\.run\(request, async/],issuedBy:'core/ai-provider-readiness.ts',issuerImport:"from '../lib/ai/provider-protocol'"},
 'core/assistant-conversation-harness.ts':{features:['module_agent_evaluation'],seams:[/withAiAdmissionLifecycle\(cfg,\s*'module_agent_evaluation'/],issuedBy:'core/module-agent-releases.ts'},
 'core/module-agent-prompt-harness.ts':{features:['module_agent_evaluation'],seams:[/withAiAdmissionLifecycle\(cfg,\s*'module_agent_evaluation'/],issuedBy:'core/module-agent-releases.ts'},
 'core/module-agent-releases.ts':{features:['module_agent_evaluation','module_agent_planning'],seams:[/governedAiConfig\([^()]*'module_agent_evaluation'\)/,/governedAiConfig\([^()]*'module_agent_planning'\)/,/withAiAdmissionLifecycle\([^,()]*,\s*'module_agent_planning'/]},
 'core/personnel-import-assistance.ts':{features:['personnel_import_mapping'],seams:[/const FEATURE\s*=\s*'personnel_import_mapping'/,/resolveActiveAiConfig\(tx,\s*ctx,\s*FEATURE\)/]},
};
// Shared Performance provider seam: it resolves no configuration of its own and admits every call under the
// calling Performance feature. Its call sites ARE provider call sites, so each is held to the same rule as a
// direct call (a Performance pack file that resolves through assessmentAiConfigTx); the seam shows its admission.
const performanceSeam={file:'packs/performance/onehr/provider-source-draft.ts',call:'generatePerformanceSourceDraft',admission:/withAiAdmissionCheck\(cfg,\s*`performance_\$\{feature\}`/};
describe('complete AI management inventory and boundary',()=>{
 it('registers every production AI workload caller and keeps providers behind the shared gateway',()=>{
  const coreFound:string[]=[];let packCalls=0;
  for(const file of [...walk('core'),...walk('packs'),...walk('app'),...walk('lib'),...walk('scripts')]){
   const src=read(file),tree=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
   let calls=0;const aliases=new Map<string,string>(),namespaces=new Set<string>();
   for(const statement of tree.statements)if(ts.isImportDeclaration(statement)&&statement.importClause?.namedBindings){
    const bindings=statement.importClause.namedBindings;
    if(ts.isNamedImports(bindings))for(const name of bindings.elements)aliases.set(name.name.text,(name.propertyName??name.name).text);
    else if(ts.isNamespaceImport(bindings)&&ts.isStringLiteral(statement.moduleSpecifier)&&/\/ai(?:\/index)?$/.test(statement.moduleSpecifier.text))namespaces.add(bindings.name.text);
   }
   const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)){
    const call=ts.isIdentifier(node.expression)?aliases.get(node.expression.text)??node.expression.text:ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&namespaces.has(node.expression.expression.text)?node.expression.name.text:'';
    if(['generateDraft','readImage','converse','generatePrivateAiAnalysis',performanceSeam.call].includes(call))calls++;
   }ts.forEachChild(node,visit);};visit(tree);
   expect(aiBoundaryViolations(file,src),file).toEqual([]);
   if(!calls)continue;
   if(file.startsWith('core/')||governedCallers[file]){coreFound.push(file);const governed=governedCallers[file];
    if(governed){
     for(const feature of governed.features)expect(AI_FEATURES.some(f=>f.id===feature),`${file}:${feature}`).toBe(true);
     for(const seam of governed.seams)expect(src,`${file} ${seam}`).toMatch(seam);
     if(governed.issuedBy){const issuer=read(governed.issuedBy);expect(issuer,`${governed.issuedBy} issues ${file}`).toContain(governed.issuerImport??`from './${file.slice('core/'.length,-'.ts'.length)}'`);
      for(const feature of governed.features)expect(issuer).toMatch(new RegExp(`governedAiConfig\\([^()]*'${feature}'\\)`));}
    }else{expect(coreCallers[file],`${file} needs a registered capability`).toBeTruthy();expect(src,`${file} resolves ${coreCallers[file]}`).toMatch(new RegExp(`resolveActiveAiConfig\\(tx,\\s*ctx,\\s*'${coreCallers[file]}'\\)`));}}
   else{expect(file.startsWith('packs/performance/onehr/'),`${file} needs a governed configuration seam`).toBe(true);if(file===performanceSeam.file)expect(src).toMatch(performanceSeam.admission);else {
     const imported=new Set<string>();let admission=false,shared=false;
     for(const statement of tree.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings))
      for(const binding of statement.importClause.namedBindings.elements){const name=(binding.propertyName??binding.name).text;if(name==='withAiAdmissionCheck'&&statement.moduleSpecifier.text.endsWith('core/ai-governance')||name===performanceSeam.call&&statement.moduleSpecifier.text==='./provider-source-draft')imported.add(binding.name.text);}
     const check=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&imported.has(node.expression.text)){if(node.expression.text===performanceSeam.call)shared=true;else admission=true;}ts.forEachChild(node,check);};check(tree);
     expect(admission||shared,`${file} must call an imported admission owner or the governed Performance wrapper`).toBe(true);
    }packCalls+=calls;}
  }
  expect(coreFound.sort()).toEqual([...Object.keys(coreCallers),...Object.keys(governedCallers)].sort());expect(packCalls).toBeGreaterThan(15);
  // Since the provider snapshot owner (ADR-0131, 64651f101) the tenant row and platform fallback are one
  // snapshot, so the active resolver issues exactly one governed configuration and nothing ungoverned.
  const config=read('core/ai-config.ts');expect(config.match(/governedAiConfig\(/g)?.length).toBe(1);
  expect(config).toMatch(/const snapshot\s*=\s*await resolveAiProviderSnapshotTx\(tx,\s*ctx\);\s*return snapshot\s*\?\s*governedAiConfig\(ctx,\s*snapshot,\s*feature\)\s*:\s*null;/);
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
