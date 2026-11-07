import {TOPIC_TOOLS} from '../core/semantic-model/topic-tools';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join,normalize} from 'node:path';
import ts from 'typescript';
import {parseAiSource} from '../scripts/ai-caller-drift';
import {IMPORT_TARGETS} from '../lib/assistant-import';
import {AI_CENTRE_OPERATIONS} from '../lib/ai/centre-operations';
import {describe,expect,it} from 'vitest';
import {aiCentreFunctions,aiCentreReadKeys} from '../core/ai-centre-inventory';
import {AI_FEATURES} from '../lib/ai/features';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {registeredWorkers} from '../core/agent-registry/workers';
import {SEMANTIC_READS} from '../core/semantic-model/entities';
import {TERAS_READS} from '../core/semantic-model/generate';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';

describe('complete AI centre function inventory',()=>{
 it('covers features, actions, workers and every declared read with unique stable keys',()=>{
  const rows=aiCentreFunctions(),keys=new Set(rows.map(row=>row.key));
  expect(keys.size).toBe(rows.length);
  for(const feature of AI_FEATURES)expect(keys.has('feature:'+feature.id),feature.id).toBe(true);
  for(const worker of registeredWorkers())expect(keys.has('worker:'+worker.id),worker.id).toBe(true);
  for(const action of AGENT_ACTIONS)expect(keys.has('action:'+action.id),action.id).toBe(true);
  for(const tool of TOPIC_TOOLS)expect(keys.has('read:'+tool.name),tool.name).toBe(true);
  for(const read of [...SEMANTIC_READS,...TERAS_READS,...ASSISTANT_TOOL_CATALOGUE])expect(keys.has('read:'+read.name),read.name).toBe(true);
  for(const row of rows)expect(row.href).toBeTruthy();
 });
 it('binds every standalone draft or analysis operation to its declared child control',()=>{
  for(const operation of AI_CENTRE_OPERATIONS){
   expect(aiCentreReadKeys()).toContain('read:operation_'+operation.id);
   const source=readFileSync(operation.owner.split('#')[0],'utf8');
   if(operation.id.startsWith('assistant_import_')){
    expect(source).toContain("'read:operation_assistant_import_'+request.target");
    expect(IMPORT_TARGETS).toContain(operation.id.slice('assistant_import_'.length));
   }else expect(source).toContain("'read:operation_"+operation.id+"'");
  }
 });
 it('provides separate controls for all five explanation topics and preserves required services',()=>{
  const keys=aiCentreReadKeys();
  for(const name of ['explain_pay_difference','explain_payslip_statutory','explain_claim_limit','explain_leave_entitlement','explain_attendance_day'])expect(keys).toContain('read:'+name);
  for(const id of ['audit','privacy','validation'])expect(aiCentreFunctions().find(row=>row.key==='system:'+id)?.control).toBe('required');
  expect(keys).not.toContain('system:validation');
 });
});

const gatewaySeeds=new Map<string,ReadonlySet<string>>([
 ['lib/ai',new Set(['generateDraft','readImage','converse'])],
 ['core/ai-governance',new Set(['generatePrivateAiAnalysis','generatePrivateAiTaskAnalysis'])],
 ['packs/performance/onehr/provider-source-draft',new Set(['generatePerformanceNativeOutline','generatePerformanceSourceDraft'])],
 ['core/module-agent-prompt-harness',new Set(['executePromptHoldout'])],
 ['core/assistant-conversation-harness',new Set(['executeAssistantConversationHoldout'])],
 ['core/module-specialist-harness',new Set(['executeSpecialistHoldout'])],
 ['lib/ai/provider-protocol',new Set(['runProviderProtocolEvaluation'])],
]);
const moduleOwner=(file:string,spec:string)=>normalize(spec.startsWith('@/')?spec.slice(2):spec.startsWith('.')?join(dirname(file),spec):spec).replace(/\.[cm]?[jt]sx?$/,'').replace(/\/index$/,'');
/** Actual imported calls, including lazy aliases, are followed through private implementations.
 * A declared-operation -> string check alone cannot discover an omitted public entry point. */
function publicGatewayRoots(file:string,source:string):string[]{
 const tree=parseAiSource(file,source),aliases=new Set<string>(),namespaces=new Map<string,ReadonlySet<string>>();
 const bind=(owner:string,binding:ts.NamedImportBindings|ts.ObjectBindingPattern|undefined)=>{
  const accepted=gatewaySeeds.get(owner);if(!accepted||!binding)return;
  if(ts.isNamespaceImport(binding)){namespaces.set(binding.name.text,accepted);return;}
  for(const item of binding.elements){
   if(ts.isImportSpecifier(item)&&item.isTypeOnly)continue;
   const original=item.propertyName??item.name;
   if(ts.isIdentifier(item.name)&&(ts.isIdentifier(original)||ts.isStringLiteral(original))&&accepted.has(original.text))aliases.add(item.name.text);
  }
 };
 const lazy=(node:ts.Node)=>{
  if(ts.isVariableDeclaration(node)&&ts.isObjectBindingPattern(node.name)&&node.initializer){
   const value=ts.isAwaitExpression(node.initializer)?node.initializer.expression:node.initializer;
   if(ts.isCallExpression(value)&&(value.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(value.expression)&&value.expression.text==='require')&&value.arguments[0]&&ts.isStringLiteralLike(value.arguments[0]))bind(moduleOwner(file,value.arguments[0].text),node.name);
  }
  ts.forEachChild(node,lazy);
 };
 for(const node of tree.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&!node.importClause?.isTypeOnly)bind(moduleOwner(file,node.moduleSpecifier.text),node.importClause?.namedBindings);
 lazy(tree);
 const declarations=new Map<string,ts.Node>(),exports=new Map<string,string>();
 for(const node of tree.statements){
  const exported=ts.canHaveModifiers(node)&&ts.getModifiers(node)?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword)===true;
  if(ts.isFunctionDeclaration(node)&&node.name){if(node.body)declarations.set(node.name.text,node.body);if(exported)exports.set(node.name.text,node.name.text);}
  if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer)||ts.isObjectLiteralExpression(declaration.initializer))){declarations.set(declaration.name.text,declaration.initializer);if(exported)exports.set(declaration.name.text,declaration.name.text);}
  if(ts.isClassDeclaration(node)&&node.name){declarations.set(node.name.text,node);if(exported)exports.set(node.name.text,node.name.text);}
  if(ts.isExportDeclaration(node)&&!node.moduleSpecifier&&node.exportClause&&ts.isNamedExports(node.exportClause))for(const item of node.exportClause.elements)exports.set(item.name.text,(item.propertyName??item.name).text);
 }
 const edges=new Map<string,Set<string>>(),direct=new Set<string>();
 for(const [name,body] of declarations){
  const calls=new Set<string>();
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)){
    const expression=node.expression;
    if(ts.isIdentifier(expression)){if(aliases.has(expression.text))direct.add(name);if(declarations.has(expression.text))calls.add(expression.text);}
    else if(ts.isPropertyAccessExpression(expression)){
     if(ts.isIdentifier(expression.expression)&&namespaces.get(expression.expression.text)?.has(expression.name.text))direct.add(name);
     if(expression.name.text==='propose'&&source.includes('PolicyValueModel'))direct.add(name);
    }else if(ts.isElementAccessExpression(expression)&&ts.isIdentifier(expression.expression)&&namespaces.has(expression.expression.text)){
     if(!ts.isStringLiteralLike(expression.argumentExpression))throw Error('Unresolved gateway call: '+file+'#'+name);
     if(namespaces.get(expression.expression.text)!.has(expression.argumentExpression.text))direct.add(name);
    }
   }
   ts.forEachChild(node,visit);
  };
  visit(body);edges.set(name,calls);
 }
 const reaches=(name:string,seen=new Set<string>()):boolean=>{if(seen.has(name))return false;seen.add(name);return direct.has(name)||[...(edges.get(name)??[])].some(call=>reaches(call,seen));};
 return [...exports].filter(([,local])=>reaches(local)).map(([name])=>file+'#'+name).sort();
}
const productionFiles=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?productionFiles(join(directory,entry.name)):/\.[cm]?[jt]sx?$/.test(entry.name)?[join(directory,entry.name)]:[]);
const existingGatewayOwners:Readonly<Record<string,string>>={
 'core/assistant.ts#askAssistant':'feature:hr_assistant',
 'core/input-triage.ts#triagePendingClaims':'feature:claims_triage',
 'core/payroll-anomaly-narrate.ts#narrateVerdict':'feature:payroll_explanation',
 'core/payroll-hypothesis.ts#proposeHypotheses':'feature:payroll_hypotheses',
 'core/personnel-import-assistance.ts#assistPersonnelImportHeaders':'feature:personnel_import_mapping',
 'core/readiness-nudge.ts#sweepReadinessNudges':'feature:readiness_reminders',
};
/** Internal transport/read harnesses receive only trusted issued configuration. Their actual public
 * callers are independently discovered above and must have an operation or existing feature owner. */
const internalGatewayCarriers:Readonly<Record<string,string>>={
 'core/ai-governance.ts#generatePrivateAiAnalysis':'issued gateway configuration; all product callers remain discovered',
 'core/ai-governance.ts#generatePrivateAiTaskAnalysis':'issued gateway configuration; all product callers remain discovered',
 'core/assistant-conversation-harness.ts#executeAssistantConversationHoldout':'core/module-agent-releases.ts#evaluateConversationAgentCandidate',
 'core/module-agent-prompt-harness.ts#executePromptHoldout':'core/module-agent-releases.ts#evaluatePromptAgentCandidate',
 'packs/performance/onehr/provider-source-draft.ts#generatePerformanceNativeOutline':'protected native owners are independently discovered',
 'packs/performance/onehr/provider-source-draft.ts#generatePerformanceSourceDraft':'protected native owners are independently discovered',
 'core/teras-wiring/model-client.ts#gatewayModelClient':'core/teras-wiring/turn.ts#runConversationTurn',
 'core/handbook/provider-model.ts#gatewayPolicyValueModel':'core/handbook/policies.ts#readPolicyValues',
 'core/personnel-import-assistance.ts#reopenPersonnelImportHeaders':'explicit retained-result viewer; execute(ctx,value,true) never dispatches',
};

describe('discovered AI execution entry points',()=>{
 it('finds lazy aliases, exported arrows and private helpers, and refuses computed gateway calls',()=>{
  const source="export const run=async()=>inside(); async function inside(){const {generateDraft:send}=await import('../lib/ai');return send(config,args);} export function nativeView(){return 1;}";
  expect(publicGatewayRoots('core/fixture.ts',source)).toEqual(['core/fixture.ts#run']);
  expect(publicGatewayRoots('core/fixture.ts',"import * as model from '../lib/ai';export async function run(){return model.converse(config,args);}")).toEqual(['core/fixture.ts#run']);
  expect(()=>publicGatewayRoots('core/fixture.ts',"import * as model from '../lib/ai';export async function run(key:string){return model[key](config,args);}")).toThrow('Unresolved gateway call');
 });
 it('requires every actual public gateway root to have a registered control or explicit internal carrier',()=>{
  const operations=new Set(AI_CENTRE_OPERATIONS.map(operation=>operation.owner)),inventory=new Set(aiCentreFunctions().map(row=>row.key)),found:string[]=[];
  for(const file of ['core','packs','app'].flatMap(productionFiles)){
   const source=readFileSync(file,'utf8');
   if(!/lib\/ai|ai-governance|provider-source-draft|module-agent-prompt-harness|assistant-conversation-harness|module-specialist-harness|PolicyValueModel/.test(source))continue;
   for(const owner of publicGatewayRoots(file,source)){
    found.push(owner);
    if(operations.has(owner))continue;
    if(existingGatewayOwners[owner]){expect(inventory.has(existingGatewayOwners[owner]),owner).toBe(true);expect(source,owner+' retains its root activity').toContain('withAiCentreActivity');continue;}
    expect(internalGatewayCarriers[owner],owner+' is an unregistered AI function').toBeTruthy();
   }
  }
  // Pin the two forms missed by a static-import-only catalogue, not merely a lower-bound count.
  expect(found).toContain('packs/job-architecture/owner.ts#generateArchitectureAdvice');
  expect(found).toContain('packs/rewards/advisor.ts#generateRewardAdvisor');
  expect(readFileSync('core/handbook/provider-model.ts','utf8')).toContain("withAiCentreFunction(ctx,'read:operation_policy_values'");
  expect(readFileSync('core/personnel-import-assistance.ts','utf8')).toContain('return execute(ctx,value,true)');
  for(const target of IMPORT_TARGETS)expect(aiCentreReadKeys()).toContain('read:operation_assistant_import_'+target);
  // Static product metadata only: the requested complete inventory can be retained with CI evidence.
  console.info('AI_CENTRE_FUNCTION_INVENTORY='+JSON.stringify({functions:aiCentreFunctions(),operations:AI_CENTRE_OPERATIONS}));
 });
});
