/** Static registered-entry/owner trace. Never publishes a capability or attests runtime acceptance. */
import ts from 'typescript';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),tracked=execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split('\n');
const names=tracked.filter(path=>/\.[cm]?[jt]sx?$/.test(path)&&!path.startsWith('test/')&&!path.startsWith('node_modules/'));
const modules=new Map(),policies=new Map();
const resolveImport=(path,spec)=>{if(!spec.startsWith('.')&&!spec.startsWith('@/'))return null;const stem=spec.startsWith('@/')?resolve(root,spec.slice(2)):resolve(root,dirname(path),spec);const found=['','.ts','.tsx','/index.ts','/index.tsx'].map(suffix=>stem+suffix).find(name=>existsSync(name)&&/\.[jt]sx?$/.test(name));return found?relative(root,found):null;};
for(const path of tracked.filter(path=>/^db\/migrations\/\d.*\.sql$/.test(path)).sort()){
 const text=readFileSync(path,'utf8'),events=[];
 for(const match of text.matchAll(/(?:CREATE|ALTER) POLICY\s+([a-z_][a-z0-9_]*)\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)\b([^;]*);/gi))events.push({at:match.index,match,drop:false});
 for(const match of text.matchAll(/DROP POLICY\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)\b[^;]*;/gi))events.push({at:match.index,match,drop:true});
 for(const event of events.sort((a,b)=>a.at-b.at)){const match=event.match,table=match[2],key=table+':'+match[1];if(event.drop){policies.delete(key);continue;}policies.set(key,{table,policy:match[1],source:path,owners:[...new Set([...match[3].matchAll(/app\.([a-z][a-z0-9_]*)\s*\(/g)].map(x=>'app.'+x[1]))]});}

}
for(const path of names){
 const text=readFileSync(path,'utf8'),ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true),symbols=new Map(),imports=new Map(),stars=[];
 for(const node of ast.statements){
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
   const source=resolveImport(path,node.moduleSpecifier.text),clause=node.importClause;if(!source||!clause)continue;
   if(clause.name)imports.set(clause.name.text,{path:source,name:'default'});
   if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))imports.set(clause.namedBindings.name.text,{path:source,name:'*'});
   if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const binding of clause.namedBindings.elements)imports.set(binding.name.text,{path:source,name:binding.propertyName?.text??binding.name.text});
  }
  if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){const source=resolveImport(path,node.moduleSpecifier.text);if(!source)continue;if(node.exportClause&&ts.isNamedExports(node.exportClause))for(const e of node.exportClause.elements)imports.set(e.name.text,{path:source,name:e.propertyName?.text??e.name.text});else stars.push(source);}
  if(ts.isFunctionDeclaration(node))symbols.set(node.name?.text??'default',node);
  if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer&&(ts.isArrowFunction(d.initializer)||ts.isFunctionExpression(d.initializer)))symbols.set(d.name.text,node);
 }
 modules.set(path,{path,text,ast,symbols,imports,stars,server:ast.statements.some(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use server')});
}
function lookup(path,name,seen=new Set()){
 const key=path+'#'+name;if(seen.has(key))return null;seen.add(key);const m=modules.get(path);if(!m)return null;
 if(m.symbols.has(name))return {m,name,node:m.symbols.get(name)};
 const imported=m.imports.get(name);if(imported)return lookup(imported.path,imported.name,seen);
 for(const source of m.stars){const found=lookup(source,name,seen);if(found)return found;}return null;
}
function trace(path,name,seen=new Set()){
 const found=lookup(path,name);if(!found)return {owners:[],tables:[],boundaries:[path+'#'+name]};const {m,node}=found,key=m.path+'#'+found.name;
 if(seen.has(key))return {owners:[],tables:[],boundaries:[]};seen.add(key);if(seen.size>600)return {owners:[],tables:[],boundaries:[key+':trace-bound']};
 const text=node.getText(m.ast),owners=[...text.matchAll(/app\.([a-z][a-z0-9_]*)\s*\(/g)].map(x=>'app.'+x[1]),tables=[],boundaries=[];
 const visit=n=>{
  if(ts.isCallExpression(n)){
   const target=n.expression.getText(m.ast);
   if(/(?:assertWorkforce|require[A-Z]|scoped(?:Admin|Session)|[Pp]ermission|[Aa]uthoriz|assert.*Access)/.test(target))owners.push(m.path+':'+target);
   if(ts.isPropertyAccessExpression(n.expression)&&['from','insert','update','delete'].includes(n.expression.name.text)&&n.arguments[0])tables.push(n.arguments[0].getText(m.ast));
   let dependency;
   if(ts.isIdentifier(n.expression)){dependency=m.imports.get(n.expression.text);if(!dependency&&m.symbols.has(n.expression.text))dependency={path:m.path,name:n.expression.text};}
   else if(ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)){const imported=m.imports.get(n.expression.expression.text);if(imported?.name==='*')dependency={path:imported.path,name:n.expression.name.text};}
   if(dependency){const next=trace(dependency.path,dependency.name,seen);owners.push(...next.owners);tables.push(...next.tables);boundaries.push(...next.boundaries);}
  }ts.forEachChild(n,visit);
 };visit(node);return {owners:[...new Set(owners)].sort(),tables:[...new Set(tables)].sort(),boundaries:[...new Set(boundaries)].sort()};
}
const surfaces=[];
for(const m of modules.values()){
 const route=/^app\/(?:.*\/)?(?:page|route)\.tsx?$/.test(m.path),mobile=m.path.startsWith('mobile/'),agent=/lib\/ai\/(?:agent-action-registry|module-jobs|assistant-tool-catalogue)/.test(m.path);
 if(!route&&!m.server&&!mobile&&!agent)continue;
 for(const [name,node]of m.symbols){if(!route&&!node.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword))continue;const proof=trace(m.path,name);surfaces.push({path:m.path,entry:name,line:m.ast.getLineAndCharacterOfPosition(node.getStart(m.ast)).line+1,surface:route?'route':m.server?'server-action':agent?'agent-job':'mobile',...proof});}
}
// Registered literal actions are public entries even when they are not exported functions.
for(const m of modules.values()){
 const visit=n=>{
  if(ts.isCallExpression(n)&&n.expression.getText(m.ast)==='defineAgentAction'&&n.arguments[0]&&ts.isObjectLiteralExpression(n.arguments[0])){
   const fields=Object.fromEntries(n.arguments[0].properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(m.ast),p.initializer]));
   if(fields.id&&fields.service){const [path,name]=fields.service.text.split('#');surfaces.push({path:m.path,entry:fields.id.text,line:m.ast.getLineAndCharacterOfPosition(n.getStart(m.ast)).line+1,surface:'registered-assistant-action',service:fields.service.text,subject:fields.subject?.text,...trace(path,name)});}
  }
  if(m.path==='lib/ai/module-jobs.ts'&&ts.isVariableDeclaration(n)&&n.name.getText(m.ast)==='MODULE_JOBS'){
   let init=n.initializer;while(init&&(ts.isAsExpression(init)||ts.isSatisfiesExpression(init)))init=init.expression;
   if(init&&ts.isArrayLiteralExpression(init))for(const job of init.elements)if(ts.isArrayLiteralExpression(job))surfaces.push({path:m.path,entry:job.elements[0].text,line:m.ast.getLineAndCharacterOfPosition(job.getStart(m.ast)).line+1,surface:'registered-module-job',...trace('core/workspace-module-jobs.ts','loadCanonicalModuleJob')});
  }
  ts.forEachChild(n,visit);
 };visit(m.ast);
}
const meta=modules.get('lib/permissions.ts'),screens=[];
const walk=n=>{if(ts.isObjectLiteralExpression(n)){const fields=Object.fromEntries(n.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(meta.ast),p.initializer]));if(fields.screenKey&&fields.routes&&ts.isArrayLiteralExpression(fields.routes))screens.push({screenKey:fields.screenKey.text,href:fields.href?.text,guard:fields.guard?.text,routes:fields.routes.elements.map(x=>x.text)});}ts.forEachChild(n,walk);};walk(meta.ast);
for(const screen of screens){screen.entries=surfaces.filter(row=>screen.routes.some(route=>row.path==='app'+(route==='/'?'':route)+'/page.tsx'||row.path==='app'+(route==='/'?'':route)+'/page.ts'));screen.nativeOwners=[...new Set(screen.entries.flatMap(row=>row.owners))].sort();screen.tables=[...new Set(screen.entries.flatMap(row=>row.tables))].sort();screen.status=screen.nativeOwners.length?'owner-traced-not-runtime-attested':'requires-owner-trace';}
surfaces.sort((a,b)=>a.path.localeCompare(b.path)||a.line-b.line);screens.sort((a,b)=>a.screenKey.localeCompare(b.screenKey));
const output=JSON.stringify({kind:'SOURCE_INVENTORY_NOT_ENFORCEMENT_ATTESTATION',registeredScreens:screens.length,registeredEntries:surfaces.length,screens,surfaces,policyOwners:[...policies.values()].sort((a,b)=>(a.table+a.policy).localeCompare(b.table+b.policy))},null,2)+'\n',path='docs/access-action-binding-inventory.json';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Action binding inventory stale');}else writeFileSync(path,output);
process.stdout.write(JSON.stringify({screens:screens.length,entries:surfaces.length,screenGaps:screens.filter(row=>row.status==='requires-owner-trace').map(row=>row.screenKey)})+'\n');
