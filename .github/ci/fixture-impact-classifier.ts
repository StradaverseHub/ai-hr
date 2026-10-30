/** Separately versioned finite fixture repair classifier. Shared v3 classifier remains unchanged. */
/** ADR-0114: deterministic impact selection. Unknown reach is evidence to broaden, never to skip. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import type { ChangedFile } from '../../scripts/gate-tier';
import { classifyFile,TEST_SETUP_FILES } from '../../scripts/gate-tier';
import { guardFiles,isTestFile } from '../../scripts/gate-affected-plan';
import { resolveSpecifier } from '../../scripts/gate-db-classify';

export const IMPACT_POLICY_VERSION=4;
export type Risk='low'|'moderate'|'high'|'unknown';
export type Classification={path:string;risk:Risk;reason:string;dependencies:string[];sourceHash:string|null;uncertainties:string[]};
export type ImpactPlan={policyVersion:number;tier:'impact'|'full';risk:Risk;classifications:Classification[];reasons:string[];changed:string[];run:string[];selection:Record<string,string[]>;browser:boolean;barrelMode:'module'|'diagnostic-symbols';fingerprint:string};
export type LearnedFailure={changed:string[];failed:string[]};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const PINNED_TIMING_WRITER_SHA='6595b52e11aeeea1c9836222fa34c083ffe987783b4a600a2c4a775921ad948a';
export const isPinnedTimingWriter=(path:string,text:string)=>path==='test/profile.ts'&&createHash('sha256').update(text).digest('hex')===PINNED_TIMING_WRITER_SHA;
const browserTest=(path:string)=>path.startsWith('test/')&&path.endsWith('.browser.test.tsx');
const code=(p:string)=>/\.[cm]?[jt]sx?$/.test(p);
const hardRoot=(p:string)=>p.startsWith('db/')||p.startsWith('scripts/')||p.startsWith('deploy/')||p.startsWith('localization/')
 ||p.startsWith('public/forms/')||p==='package.json'||/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml)$/.test(p)
 ||/^(next|vitest|tsconfig|eslint|postcss|tailwind)(\.|\/)/.test(p)||/^(middleware|proxy)\./.test(p)
 ||(TEST_SETUP_FILES as readonly string[]).includes(p)||/^lib\/(identity\/|permissions\.|authz\.|session\.|scope\.|request-origin\.)/.test(p)
 ||/^core\/(auth|admin|permissions|tenants?)(\.|-)/.test(p);
const financial=(p:string)=>/^core\/(attendance(\.|-clock\.|-rule\.|-recompute\.|-day-|-[a-z-]*calculat)|leave(\.|-)|comp(\.|-)|payroll(\.|-)|statutory(\.|-)|toil(\.|-)|bonus(\.|-))/.test(p)
 ||/^packs\/(payroll|rewards)\//.test(p)||p==='packs/attendance/day-adjustment.ts';

function syntax(path:string,text:string){return ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);}
function diagnosticsOnly(change:ChangedFile):boolean{
 if(change.status!=='M'||change.baseText==null||change.headText==null||!code(change.path))return false;
 const normalized=(text:string)=>{
  const file=syntax(change.path,text);
  if((file as ts.SourceFile&{parseDiagnostics:unknown[]}).parseDiagnostics.length)return null;
  const result=ts.transform(file,[(context)=>{
   const visit:ts.Visitor=(node)=>{
    if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&/Error$/.test(node.expression.text)
      &&node.arguments?.length&&ts.isStringLiteralLike(node.arguments[0])){
     return ts.factory.updateNewExpression(node,node.expression,node.typeArguments,[ts.factory.createStringLiteral('<diagnostic>'),...node.arguments.slice(1)]);
    }
    return ts.visitEachChild(node,visit,context);
   };return source=>ts.visitNode(source,visit) as ts.SourceFile;
  }]);
  try{return ts.createPrinter({removeComments:true}).printFile(result.transformed[0]);}finally{result.dispose();}
 };
 const before=normalized(change.baseText),after=normalized(change.headText);
 return before!==null&&before===after;
}

export function riskFor(change:ChangedFile):{risk:Risk;reason:string}{
 const p=change.path;
 if(hardRoot(p))return {risk:'high',reason:'database, security, financial jurisdiction or verification infrastructure'};
 if(p.startsWith('test/')&&change.status==='D')return {risk:'high',reason:'test removal requires full regression evidence'};
 if(diagnosticsOnly(change))return {risk:'low',reason:'AST proves only comments/formatting or Error diagnostic literals changed'};
 if(financial(p))return {risk:'high',reason:'attendance/pay/leave calculation or financial decision owner'};
 const old=classifyFile(change);
 if(old.allowed)return {risk:'low',reason:old.rule};
 if(code(p)&&/^(app|components|core|lib|packs|i18n)\//.test(p))return {risk:'moderate',reason:'product logic: select transitive consumers and mandatory invariants'};
 return {risk:'unknown',reason:'no verified rule for this file type or ownership boundary'};
}

type Module={deps:Set<string>;uncertainties:string[];readsSource:boolean};
function inspect(path:string,text:string,files:Map<string,string>):Module{
 const out:Module={deps:new Set(),uncertainties:[],readsSource:false};
 if(!code(path))return out;
 const sf=syntax(path,text);
 if((sf as ts.SourceFile&{parseDiagnostics:unknown[]}).parseDiagnostics.length)out.uncertainties.push('unparseable source');
 const add=(spec:string)=>{
  const found=spec==='server-only'&&files.has('test/stubs/server-only.ts')?'test/stubs/server-only.ts':resolveSpecifier(spec,path,p=>files.get(p)??null);
  if(found===null)out.uncertainties.push('unresolved local import '+spec);
  else if(found!==undefined)out.deps.add(found);
  if(/^(node:)?fs(\/promises)?$/.test(spec))out.readsSource=true;
 };
 const walk=(node:ts.Node)=>{
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))add(node.moduleSpecifier.text);
  if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression))add(node.moduleReference.expression.text);
  if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))add(node.argument.literal.text);
  if(ts.isCallExpression(node)){
   const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
   const mockCall=ts.isPropertyAccessExpression(node.expression)&&['vi','jest'].includes(node.expression.expression.getText(sf))&&['importActual','importMock','mock','doMock'].includes(name);
   if(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&name==='require')||mockCall){
    const argument=node.arguments[0];
    if(argument&&ts.isStringLiteralLike(argument))add(argument.text);
    else out.uncertainties.push('computed module load');
   }
   if(/^(readFile|readFileSync|readdir|readdirSync|glob|globSync)$/.test(name))out.readsSource=true;
  }
  ts.forEachChild(node,walk);
 };walk(sf);return out;
}

/** A process RSS monitor does not read repository bytes. This deliberately small proof rejects
 * aliases escaping as values, shadowed PID producers, other fs APIs and every unknown path. */
export function readsOnlyProcessStatus(path:string,text:string):boolean{
 const sf=syntax(path,text),readers=new Set<string>(),spawns=new Set<string>();let safe=true,reads=0;
 for(const statement of sf.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteralLike(statement.moduleSpecifier)){
  const spec=statement.moduleSpecifier.text,b=statement.importClause?.namedBindings;
  if(/^(node:)?fs(?:\/promises)?$/.test(spec)){
   if(!b||!ts.isNamedImports(b)||statement.importClause?.name){safe=false;continue;}
   for(const item of b.elements){if((item.propertyName??item.name).text!=='readFile'){safe=false;continue;}readers.add(item.name.text);}
  }
  if(/^(node:)?child_process$/.test(spec)&&b&&ts.isNamedImports(b))for(const item of b.elements)if((item.propertyName??item.name).text==='spawn')spawns.add(item.name.text);
 }
 const bindings=new Map<string,{count:number;spawn:boolean}>();
 const bind=(name:ts.BindingName|ts.PropertyName|undefined,spawn=false)=>{if(name&&ts.isIdentifier(name)){const old=bindings.get(name.text);bindings.set(name.text,{count:(old?.count??0)+1,spawn:spawn||old?.spawn===true});}};
 const scan=(n:ts.Node)=>{if(ts.isVariableDeclaration(n))bind(n.name,!!n.initializer&&ts.isVariableDeclarationList(n.parent)&&!!(n.parent.flags&ts.NodeFlags.Const)&&ts.isCallExpression(n.initializer)&&ts.isIdentifier(n.initializer.expression)&&spawns.has(n.initializer.expression.text));else if(ts.isParameter(n)||ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))bind(n.name);ts.forEachChild(n,scan);};scan(sf);
 if([...spawns].some(name=>bindings.has(name)))safe=false;
 const producers=new Set([...bindings].filter(([,v])=>v.spawn&&v.count===1).map(([name])=>name));
 const pid=(n:ts.Expression)=>ts.isPropertyAccessExpression(n)&&n.name.text==='pid'&&ts.isIdentifier(n.expression)&&bindings.get(n.expression.text)?.spawn===true&&bindings.get(n.expression.text)?.count===1;
 const external=(n:ts.Expression|undefined)=>!!n&&(ts.isStringLiteralLike(n)?/^\/proc\/(?:[1-9]\d*|self)\/status$/.test(n.text):ts.isTemplateExpression(n)&&n.head.text==='/proc/'&&n.templateSpans.length===1&&pid(n.templateSpans[0].expression)&&n.templateSpans[0].literal.text==='/status');
 const walk=(n:ts.Node)=>{
  if(ts.isExportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier)&&/^(node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text))safe=false;
  if(ts.isCallExpression(n)){
   const callee=ts.isIdentifier(n.expression)?n.expression.text:ts.isPropertyAccessExpression(n.expression)?n.expression.name.text:'';
   if((callee==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword)&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0])&&/^(node:)?fs(?:\/promises)?$/.test(n.arguments[0].text))safe=false;
   if(/^(readFile|readFileSync|readdir|readdirSync|glob|globSync)$/.test(callee)&&(!ts.isIdentifier(n.expression)||!readers.has(callee)))safe=false;
  }
  if(ts.isIdentifier(n)&&producers.has(n.text)&&!(ts.isVariableDeclaration(n.parent)&&n.parent.name===n)){
   if(!ts.isPropertyAccessExpression(n.parent)||n.parent.expression!==n)safe=false;
   else if(n.parent.name.text==='pid'){
    const access=n.parent,parent=access.parent;
    if(ts.isBinaryExpression(parent)&&parent.left===access&&parent.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&parent.operatorToken.kind<=ts.SyntaxKind.LastAssignment||ts.isDeleteExpression(parent)||ts.isPrefixUnaryExpression(parent)&&(parent.operator===ts.SyntaxKind.PlusPlusToken||parent.operator===ts.SyntaxKind.MinusMinusToken)||ts.isPostfixUnaryExpression(parent))safe=false;
   }
  }
  if(ts.isIdentifier(n)&&readers.has(n.text)){
   if(ts.isImportSpecifier(n.parent))return;
   if(!ts.isCallExpression(n.parent)||n.parent.expression!==n||!external(n.parent.arguments[0]))safe=false;else reads++;
  }
  ts.forEachChild(n,walk);
 };walk(sf);return safe&&readers.size>0&&reads>0;
}

/** Diagnostic strings cannot change module initialization. Only this proven case may bypass the
 * all-to-all edges introduced by pure re-export facades; namespace/dynamic consumers remain broad. */
function initializationFree(path:string,text:string,source=syntax(path,text)):boolean{
 let safe=true;
 const decorated=(node:ts.Node)=>ts.canHaveDecorators(node)&&!!ts.getDecorators(node)?.length;
 const walk=(node:ts.Node)=>{
  if(decorated(node))safe=false;
  if(ts.isFunctionLike(node)){
   if('name' in node&&node.name&&ts.isComputedPropertyName(node.name))safe=false;
   if(node.parameters.some(decorated))safe=false;
   return;
  }
  // These constructs can execute user code directly, through getters/coercion/iteration,
  // or through transpiled JSX/decorator helpers while the module is being evaluated.
  if(ts.isCallExpression(node)||ts.isNewExpression(node)||ts.isTaggedTemplateExpression(node)||ts.isAwaitExpression(node)
   ||ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)||ts.isBinaryExpression(node)
   ||ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node)||ts.isDeleteExpression(node)
   ||ts.isTemplateExpression(node)||ts.isComputedPropertyName(node)||ts.isObjectBindingPattern(node)||ts.isArrayBindingPattern(node)
   ||ts.isSpreadElement(node)||ts.isSpreadAssignment(node)||ts.isForOfStatement(node)||ts.isForInStatement(node)||ts.isThrowStatement(node)
   ||ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node))safe=false;
  ts.forEachChild(node,walk);
 };
 walk(source);return safe;
}
function diagnosticEdges(files:Map<string,string>,raw:Map<string,Module>):Map<string,Set<string>>{
 type Meta={pure:boolean;names:Set<string>;exports:{target:string;name:string|null;original:string|null}[];requests:Map<string,string[]|null>};
 const meta=new Map<string,Meta>(),initialization=new Map<string,boolean>();
 for(const [path,text]of files){
  if(!code(path)){meta.set(path,{pure:false,names:new Set(),exports:[],requests:new Map()});continue;}
  const sf=syntax(path,text),m:Meta={pure:false,names:new Set(),exports:[],requests:new Map()};
  const resolved=(spec:string)=>resolveSpecifier(spec,path,p=>files.get(p)??null);
  const request=(target:string,names:string[]|null)=>{const before=m.requests.get(target);m.requests.set(target,before===null||names===null?null:[...new Set([...(before??[]),...names])]);};
  initialization.set(path,!initializationFree(path,text,sf));
  m.pure=sf.statements.length>0&&sf.statements.every(st=>ts.isEmptyStatement(st)||ts.isInterfaceDeclaration(st)||ts.isTypeAliasDeclaration(st)
    ||(ts.isImportDeclaration(st)&&!!st.importClause?.isTypeOnly)||(ts.isExportDeclaration(st)&&!!st.moduleSpecifier));
  for(const st of sf.statements){
   if(ts.isImportDeclaration(st)&&st.moduleSpecifier&&ts.isStringLiteralLike(st.moduleSpecifier)){
    const target=resolved(st.moduleSpecifier.text);if(typeof target!=='string')continue;
    const clause=st.importClause;
    if(clause?.isTypeOnly){request(target,[]);continue;}
    if(!clause||clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings)){request(target,null);continue;}
    const names:string[]=[];if(clause.name)names.push('default');
    if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const e of clause.namedBindings.elements)if(!e.isTypeOnly)names.push((e.propertyName??e.name).text);
    request(target,names);
   }
   if(ts.isExportDeclaration(st)){
    if(st.moduleSpecifier&&ts.isStringLiteralLike(st.moduleSpecifier)){
     const target=resolved(st.moduleSpecifier.text);if(typeof target!=='string')continue;
     if(st.isTypeOnly){request(target,[]);continue;}
     if(st.exportClause&&ts.isNamedExports(st.exportClause)){
      const names:string[]=[];for(const e of st.exportClause.elements)if(!e.isTypeOnly){m.exports.push({target,name:e.name.text,original:(e.propertyName??e.name).text});names.push((e.propertyName??e.name).text);}request(target,names);
     }else{m.exports.push({target,name:null,original:null});request(target,null);}
    }else if(st.exportClause&&ts.isNamedExports(st.exportClause))for(const e of st.exportClause.elements)if(!e.isTypeOnly)m.names.add(e.name.text);
   }
   const modifiers=ts.canHaveModifiers(st)?ts.getModifiers(st):undefined;
   if(modifiers?.some(mod=>mod.kind===ts.SyntaxKind.ExportKeyword)){
    if(modifiers.some(mod=>mod.kind===ts.SyntaxKind.DefaultKeyword))m.names.add('default');
    if((ts.isFunctionDeclaration(st)||ts.isClassDeclaration(st)||ts.isEnumDeclaration(st)||ts.isInterfaceDeclaration(st)||ts.isTypeAliasDeclaration(st))&&st.name)m.names.add(st.name.text);
    if(ts.isVariableStatement(st))for(const d of st.declarationList.declarations)if(ts.isIdentifier(d.name))m.names.add(d.name.text);
   }
  }
  const loads=(node:ts.Node)=>{
   if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal)){
    const target=resolved(node.argument.literal.text);if(typeof target==='string')request(target,[]);
   }
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
    const argument=node.arguments[0];if(argument&&ts.isStringLiteralLike(argument)){
     const target=resolved(argument.text);if(typeof target==='string'){
      let parent:ts.Node=node.parent;if(ts.isAwaitExpression(parent))parent=parent.parent;
      if(ts.isVariableDeclaration(parent)&&ts.isObjectBindingPattern(parent.name)&&parent.name.elements.every(e=>!e.dotDotDotToken&&ts.isIdentifier(e.propertyName??e.name))){
       request(target,parent.name.elements.map(e=>(e.propertyName??e.name).getText(sf)));
      }else request(target,null);
     }
    }
   }
   ts.forEachChild(node,loads);
  };loads(sf);
  meta.set(path,m);
 }
 const all=(path:string,seen=new Set<string>()):Set<string>=>{
  const result=new Set([path]);if(seen.has(path))return result;seen.add(path);const m=meta.get(path);
  if(m?.pure)for(const e of m.exports)for(const p of all(e.target,seen))result.add(p);return result;
 };
 const named=(path:string,name:string,seen=new Set<string>()):Set<string>=>{
  if(seen.has(path+'#'+name))return new Set();seen.add(path+'#'+name);const m=meta.get(path);if(!m)return new Set();
  if(!m.pure){
   if(m.names.has(name))return new Set([path]);
   // A concrete module still owns its re-exported symbols and initialization dependencies.
   // Recognizing that name avoids an unrelated pure-facade namespace fallback.
   for(const e of m.exports)if((e.name===null||e.name===name)&&named(e.target,e.original??name,new Set(seen)).size)return new Set([path]);
   return new Set();
  }
  const result=new Set<string>();
  for(const e of m.exports)if(e.name===null||e.name===name){const providers=named(e.target,e.original??name,new Set(seen));if(providers.size){result.add(path);for(const p of providers)result.add(p);}}
  return result;
 };
 const initializers=(path:string)=>{
  const effects=new Set<string>(),seen=new Set<string>();
  const visit=(p:string)=>{if(seen.has(p))return;seen.add(p);if(initialization.get(p))effects.add(p);for(const dep of raw.get(p)?.deps??[])visit(dep);};
  visit(path);effects.delete(path);return effects;
 };
 const result=new Map<string,Set<string>>();
 for(const [path,module]of raw){
  // A facade evaluates every exported module, including setup in its transitive imports.
  // Keep those actual initialization owners even when unused named exports are bypassed.
  const m=meta.get(path);if(m?.pure){result.set(path,initializers(path));continue;}
  const deps=new Set(module.deps);
  for(const target of module.deps)if(meta.get(target)?.pure){
   const names=m?.requests.get(target);
   if(names===undefined||names===null){for(const p of all(target))deps.add(p);}
   else for(const name of names){const providers=named(target,name);for(const p of providers.size?providers:all(target))deps.add(p);}
  }
  result.set(path,deps);
 }
 return result;
}

/** Both old and new import edges matter for deletions, renames and removed dependencies. */
export function planImpact(changes:ChangedFile[],current:Map<string,string>,history:LearnedFailure[]=[],observeGraph?:(edges:ReadonlyMap<string,ReadonlySet<string>>)=>void,unchangedProcReads=true):ImpactPlan{
 const files=new Map(current);
 for(const c of changes)if(c.baseText!==null&&!files.has(c.path))files.set(c.path,c.baseText);
 const modules=new Map<string,Module>();
 for(const [path,text]of files){
  const m=inspect(path,text,files),before=changes.find(c=>c.path===path)?.baseText;
  if(before!=null&&before!==text){const old=inspect(path,before,files);for(const dep of old.deps)m.deps.add(dep);m.uncertainties.push(...old.uncertainties);m.readsSource||=old.readsSource;}
  modules.set(path,m);
 }
 const rawReverse=new Map<string,Set<string>>();
 for(const [path,m]of modules)for(const dep of m.deps){const callers=rawReverse.get(dep)??new Set();callers.add(path);rawReverse.set(dep,callers);}
 const productChanges=changes.filter(c=>code(c.path)&&!c.path.startsWith('test/'));
 const narrow=productChanges.length>0&&changes.every(c=>c.path.startsWith('test/')||c.path.endsWith('.md')||productChanges.includes(c))
  &&productChanges.every(c=>diagnosticsOnly(c)&&initializationFree(c.path,c.headText!)&&initializationFree(c.path,c.baseText!));
 const edges=narrow?diagnosticEdges(files,modules):new Map([...modules].map(([path,m])=>[path,m.deps]));
 observeGraph?.(edges);
 const reverse=new Map<string,Set<string>>();
 for(const [path,deps]of edges)for(const dep of deps){const callers=reverse.get(dep)??new Set();callers.add(path);reverse.set(dep,callers);}
 const consumers=(seed:string,graph=reverse)=>{
  const seen=new Set<string>(),queue=[seed];
  while(queue.length){const p=queue.pop()!;if(seen.has(p))continue;seen.add(p);for(const c of graph.get(p)??[])queue.push(c);}return [...seen].sort();
 };
 const all=[...current.keys()].filter(isTestFile).sort(),testSet=new Set(all),selection:Record<string,string[]>={};
 const select=(test:string,why:string)=>{if(testSet.has(test)){selection[test]??=[];if(!selection[test].includes(why))selection[test].push(why);}};
 const classifications:Classification[]=changes.map(c=>{
  const verdict=riskFor(c),m=modules.get(c.path),reach=consumers(c.path),tests=reach.filter(p=>testSet.has(p));
  for(const t of tests)select(t,'transitive import consumer of '+c.path);
  if(isTestFile(c.path))select(c.path,'changed test');
  const uncertainties=m?.uncertainties??[];
  if(uncertainties.length) return {path:c.path,risk:'unknown',reason:'changed module has unresolved reach',dependencies:[...(m?.deps??[])].sort(),sourceHash:c.headText==null?null:digest(c.headText),uncertainties};
  if((verdict.risk==='moderate'||(diagnosticsOnly(c)&&!classifyFile(c).allowed)||(code(c.path)&&c.path.startsWith('test/')&&!isTestFile(c.path)&&!browserTest(c.path)))&&tests.length===0)return {path:c.path,risk:'unknown',reason:'no executable test consumer establishes this module’s coverage',dependencies:[...(m?.deps??[])].sort(),sourceHash:c.headText==null?null:digest(c.headText),uncertainties:['no behavioral consumer']};
  return {path:c.path,...verdict,dependencies:[...(m?.deps??[])].sort(),sourceHash:c.headText==null?null:digest(c.headText),uncertainties};
 });
 // A source-reading or computed-load test cannot be excluded merely because its dependency is absent
 // from a static import graph. Include it and all of its test consumers, regardless of filename.
 for(const [path,m]of modules){
  const unchanged=!changes.some(c=>c.path===path);
  const externalOnly=unchanged&&(isPinnedTimingWriter(path,files.get(path)??'')||(unchangedProcReads&&readsOnlyProcessStatus(path,files.get(path)??'')));
  if((m.readsSource&&!externalOnly)||m.uncertainties.length)for(const t of consumers(path,rawReverse))select(t,'source reading or uncertain module reach through '+path);
 }
 for(const t of guardFiles(all))select(t,'mandatory repository invariant');
 for(const t of all)if(/(?:rls|scope|tenant|permission|authz|privesc|invitation)/i.test(posix.basename(t)))select(t,'mandatory access/tenant invariant');
 for(const observation of history)if(observation.changed.some(p=>changes.some(c=>c.path===p)))for(const t of observation.failed)select(t,'failure observed for a changed module in prior verification');
 const reasons=classifications.filter(c=>c.risk==='high'||c.risk==='unknown').map(c=>c.path+': '+c.reason);
 if(!changes.length)reasons.push('empty diff has no impact evidence');
 const risk:Risk=!changes.length||classifications.some(c=>c.risk==='unknown')?'unknown':classifications.some(c=>c.risk==='high')?'high':classifications.some(c=>c.risk==='moderate')?'moderate':'low';
 const run=Object.keys(selection).sort();for(const r of Object.values(selection))r.sort();
 const body={barrelMode:narrow?'diagnostic-symbols' as const:'module' as const,policyVersion:IMPACT_POLICY_VERSION,tier:reasons.length?'full' as const:'impact' as const,risk,classifications,reasons,changed:changes.map(c=>c.path).sort(),run,selection,browser:changes.some(c=>/\.(tsx|css)$/.test(c.path)||c.path.startsWith('public/'))};
 return {...body,fingerprint:digest(body)};
}
