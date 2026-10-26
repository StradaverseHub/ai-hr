/** Labelled ignored copies preserve original registrations, assertions, hooks and timeouts. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {PROFILE_CASE,PROFILE_FILE} from './attendance-sql-profile.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=JSON.parse(readFileSync(new URL('./attendance-unclocked-cases.json',import.meta.url),'utf8'));
export const VISIBILITY='test/r395-visibility-equivalence.test.ts',PRINCIPAL='test/principal-snapshot-current.test.ts';
export const REUSED_CASE='plan reuse diagnostic preserves contexts and real mutations on one reserved connection';
const captureHook="beforeAll(migrateTestDb);afterAll(closeAll);";
function rootName(call,s,ts){
 if(ts.isIdentifier(call.expression)&&call.expression.text==='it')return 'it';
 if(ts.isCallExpression(call.expression)&&ts.isPropertyAccessExpression(call.expression.expression)&&call.expression.expression.name.text==='each'&&call.expression.expression.expression.getText(s)==='it')return 'each';
}
function registrations(s,ts){const found=[];function visit(n){if(ts.isCallExpression(n)&&rootName(n,s,ts)){found.push(n.getText(s));return;}ts.forEachChild(n,visit);}visit(s);return found;}
export function staticRegistry(text,ts){
 const source=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true),found=[];
 function body(nodes,parents=[]){for(const n of nodes){if(!ts.isExpressionStatement(n)||!ts.isCallExpression(n.expression))continue;
  const call=n.expression,kind=rootName(call,source,ts);
  if(call.expression.getText(source)==='describe'){assert(ts.isStringLiteral(call.arguments[0]));body(call.arguments[1].body.statements,[...parents,call.arguments[0].text]);}
  else if(kind){assert(ts.isStringLiteral(call.arguments[0]));const title=call.arguments[0].text;
   let values=[null];
   if(kind==='each'){
    const data=call.expression.arguments[0].getText(source);
    if(data==='[...Array(24).keys()]')values=Array.from({length:24},(_,i)=>i);
    else if(data==='Object.keys(MUTATIONS)')values=['hod','clamp','valid_to','terminated'];
    else assert.fail('Unknown diagnostic registration data: '+data);
   }
   for(const value of values)found.push([...parents,kind==='each'?title.replace(/%[is]/g,String(value)):title].join(' '));
  }
 }}body(source.statements);assert(found.length>0&&new Set(found).size===found.length);return found;
}
export function createPlanCopies(source,ts){
 const out=join(source,'.vitest-attachments');assert.equal(realpathSync(source),source);
 try{lstatSync(out);assert.fail('Dedicated ignored copy directory already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 mkdirSync(out,{mode:0o700});const sources={},files=[],registry={};
 for(const [label,path]of [['cash',PROFILE_FILE],['visibility',VISIBILITY],['principal',PRINCIPAL]]){
  const original=readFileSync(join(source,path),'utf8'),ast=ts.createSourceFile(path,original,ts.ScriptTarget.Latest,true),edits=[];
  function refuseDynamic(n){if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail('Unreviewed runtime dynamic import');ts.forEachChild(n,refuseDynamic);}refuseDynamic(ast);
  for(const n of ast.statements)if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
   const spec=n.moduleSpecifier.text;if(!spec.startsWith('.'))continue;
   const replacement=spec.startsWith('./')?'../test/'+spec.slice(2):spec;
   assert.equal(resolve(dirname(join(source,path)),spec),resolve(out,replacement),'Changed resolved import');
   if(spec!==replacement)edits.push({from:n.moduleSpecifier.getStart(ast),to:n.moduleSpecifier.end,value:JSON.stringify(replacement)});
  }
  let copy=original;for(const e of edits.sort((a,b)=>b.from-a.from))copy=copy.slice(0,e.from)+e.value+copy.slice(e.to);
  copy="import {installVisibilityPlan as __planInstall} from '../.github/ci/diagnostics/visibility-plan-prototype.mjs';\nimport {workerDb as __planWorkerDb} from '../test/db-names';\nconst __planExpectedDb=__planWorkerDb(process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID);\n"+copy;
  const q=label==='visibility'?'q':"(text:string,params:unknown[]=[])=>owner.client.unsafe(text,params as never[])";
  if(label==='visibility'){
   assert.equal(copy.split('  await setupOrg();').length,2);copy=copy.replace('  await setupOrg();',"  await __planInstall("+q+",'visibility',__planExpectedDb);\n  await setupOrg();");
   copy="import {exerciseReusedVisibilityConnection as __planExercise} from '../.github/ci/diagnostics/visibility-plan-controls.mjs';\nimport {E as __planIds} from '../test/r395-org';\n"+copy;
   copy+="\nit("+JSON.stringify(REUSED_CASE)+",async()=>{await __planExercise(pg,CONTEXTS,ALL_EMP,__planIds,__planExpectedDb);},120_000);\n";
  }else{
   assert.equal(copy.split(captureHook).length,2);copy=copy.replace(captureHook,"beforeAll(migrateTestDb);beforeAll(async()=>{await __planInstall("+q+","+JSON.stringify(label)+",__planExpectedDb);});afterAll(closeAll);");
  }
  const after=ts.createSourceFile(label+'.ts',copy,ts.ScriptTarget.Latest,true),beforeCalls=registrations(ast,ts),afterCalls=registrations(after,ts);
  assert.deepEqual(afterCalls.slice(0,beforeCalls.length),beforeCalls,'Original assertions/data/timeouts changed');assert.equal(afterCalls.length,beforeCalls.length+(label==='visibility'?1:0));
  const output='.vitest-attachments/plan-'+label+'.test.ts';writeFileSync(join(source,output),copy,{flag:'wx',mode:0o600});files.push(output);
  registry[output]=label==='cash'?names:staticRegistry(copy,ts);sources[path]={originalSha256:hash(original),copy:output,copySha256:hash(copy),originalRegistrations:beforeCalls.length,originalCallsAndAssertionsUnchanged:true,relativeImportsResolveIdentically:true,addedDiagnosticCases:label==='visibility'?1:0};
 }
 const selected=Object.values(registry).flat().filter(n=>n===PROFILE_CASE||n===REUSED_CASE||n.startsWith('canonical current principal snapshot foundation ')
  ||n.startsWith('r395 (i)/(ii) — ')||n.startsWith('r395 — non-vacuity: '));
 assert.equal(selected.filter(n=>n===PROFILE_CASE).length,1);assert.equal(selected.filter(n=>n===REUSED_CASE).length,1);assert(selected.length>=30);
 const pattern='^(?:'+selected.map(n=>n.replace(/[$.*+?^{}()|[\]\\]/g,'\\$&')).join('|')+')$';
 const config="import base from '../vitest.config';\nexport default {...base,test:{...base.test,projects:base.test.projects.filter(p=>p.test.name==='node').map(p=>({...p,test:{...p.test,include:"+JSON.stringify(files)+"}}))}};\n";
 const configPath='.vitest-attachments/plan.config.mts';writeFileSync(join(source,configPath),config,{flag:'wx',mode:0o600});
 return {files,registry,selected,pattern,configPath,sources,releaseAuthorized:false};
}
export function validatePlanSelection(result,source,proof){
 const registered=Object.values(proof.registry).flat();assert(result.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0&&(result.numTodoTests??0)===0);
 assert.equal(result.numTotalTests,registered.length);assert.equal(result.numPassedTests,proof.selected.length);assert.equal(result.numPendingTests,registered.length-proof.selected.length);
 assert(Array.isArray(result.testResults)&&result.testResults.length===proof.files.length);
 const seen=new Set();for(const suite of result.testResults){
  const file=suite.name.slice(source.length+1);assert(suite.name.startsWith(source+'/')&&proof.files.includes(file)&&!seen.has(file));seen.add(file);
  assert.equal(suite.status,'passed');assert.deepEqual(suite.assertionResults.map(a=>a.fullName).sort(),proof.registry[file].slice().sort());
  for(const a of suite.assertionResults)assert.equal(a.status,proof.selected.includes(a.fullName)?'passed':'skipped','Required selected case did not pass or unselected case executed');
 }
 return {registered:registered.length,selectedPassed:proof.selected.length,deliberatelyUnselected:registered.length-proof.selected.length,fullSuitePassed:false,releaseAuthorized:false};
}
