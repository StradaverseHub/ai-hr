import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES } from '../lib/ai/features';
import { MODULE_CATALOG, SETTING_CATALOG } from '../packs/catalog';
const read=(p:string)=>readFileSync(p,'utf8');
const walk=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):/\.(ts|tsx)$/.test(e.name)?[join(p,e.name)]:[]);
const coreCallers:Record<string,string>={'core/assistant.ts':'hr_assistant','core/feedback.ts':'feedback_planning','core/input-triage.ts':'claims_triage','core/pay-rule-ai.ts':'pay_rule_draft','core/payroll-anomaly-narrate.ts':'payroll_explanation','core/payroll-hypothesis.ts':'payroll_hypotheses','core/performance.ts':'performance_pm','core/readiness-nudge.ts':'readiness_reminders','core/report-ai.ts':'report_insight'};
describe('complete AI management inventory and boundary',()=>{
 it('registers every production AI workload caller and keeps providers behind the shared gateway',()=>{
  const coreFound:string[]=[];let packCalls=0;
  for(const file of [...walk('core'),...walk('packs'),...walk('app')]){
   const src=read(file),tree=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
   let calls=0;
   const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['generateDraft','readImage','converse'].includes(node.expression.text))calls++;ts.forEachChild(node,visit);};visit(tree);
   for(const statement of tree.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier))expect(['openai','@anthropic-ai/sdk','@google/genai']).not.toContain(statement.moduleSpecifier.text);
   if(!calls)continue;
   if(file.startsWith('core/')){coreFound.push(file);expect(coreCallers[file],`${file} needs a registered capability`).toBeTruthy();expect(src).toContain(`resolveActiveAiConfig(tx, ctx, '${coreCallers[file]}')`);}
   else{expect(file.startsWith('packs/performance/onehr/'),`${file} needs a governed configuration seam`).toBe(true);expect(src).toContain('assessmentAiConfigTx');packCalls+=calls;}
  }
  expect(coreFound.sort()).toEqual(Object.keys(coreCallers).sort());expect(packCalls).toBeGreaterThan(15);
  const config=read('core/ai-config.ts');expect(config.match(/governedAiConfig\(/g)?.length).toBe(2);
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
