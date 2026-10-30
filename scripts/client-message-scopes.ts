/** Conservative source inventory. Unknown client translation usage keeps the complete catalog. */
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,relative,dirname,extname} from 'node:path';
import ts from 'typescript';
export type MessageScope={prefixes:string[]|null;unknown:string[]};
export type ClientMessageScopes={version:1;shared:MessageScope;segments:Record<string,MessageScope>};
export function computeClientMessageScopes(root:string):ClientMessageScopes{
 root=resolve(root);
 const files=new Map<string,ts.SourceFile>();
 const source=(file:string)=>{let value=files.get(file);if(!value){value=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);files.set(file,value);}return value;};
 const local=(file:string,name:string)=>{
  const stem=name.startsWith('@/')?join(root,name.slice(2)):name.startsWith('.')?resolve(dirname(file),name):null;
  if(!stem||relative(root,stem).startsWith('..'))return null;
  return [stem,stem+'.ts',stem+'.tsx',stem+'.js',stem+'.jsx',join(stem,'index.ts'),join(stem,'index.tsx')]
   .find(path=>existsSync(path)&&statSync(path).isFile()&&/\.[jt]sx?$/.test(path))??null;
 };
 function literal(file:string,node:ts.Expression,depth=0):string|undefined{
  if(depth>5)return;
  if(ts.isStringLiteralLike(node))return node.text;
  if(ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node))return literal(file,node.expression,depth+1);
  if(!ts.isIdentifier(node))return;
  for(const statement of source(file).statements){
   if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
    if(ts.isIdentifier(declaration.name)&&declaration.name.text===node.text&&declaration.initializer)return literal(file,declaration.initializer,depth+1);
   }
   if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)){
    const bindings=statement.importClause?.namedBindings;
    if(bindings&&ts.isNamedImports(bindings))for(const item of bindings.elements)if(item.name.text===node.text){
     const imported=local(file,statement.moduleSpecifier.text);
     if(imported)return literal(imported,ts.factory.createIdentifier(item.propertyName?.text??item.name.text),depth+1);
    }
   }
  }
 }
 function scope(entries:string[]):MessageScope{
  const seen=new Set<string>(),prefixes=new Set<string>(),unknown=new Set<string>();
  const walk=(file:string,inClient=false)=>{
   const key=file+':'+inClient;if(seen.has(key))return;seen.add(key);
   const ast=source(file),directives=ast.statements.filter(ts.isExpressionStatement).map(node=>ts.isStringLiteral(node.expression)?node.expression.text:'');
   if(inClient&&directives.includes('use server'))return;
   const client=inClient||directives.includes('use client'),hooks=new Set(['useTranslations']),messagesHooks=new Set(['useMessages']);
   for(const statement of ast.statements){
    if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)){
     const clause=statement.importClause;if(clause?.isTypeOnly)continue;
     const named=clause?.namedBindings;
     if(named&&ts.isNamedImports(named)){
      if(!clause?.name&&named.elements.every(item=>item.isTypeOnly))continue;
      if(statement.moduleSpecifier.text==='next-intl')for(const item of named.elements){
       const imported=item.propertyName?.text??item.name.text;
       if(imported==='useTranslations')hooks.add(item.name.text);
       if(imported==='useMessages')messagesHooks.add(item.name.text);
      }
     }
     const dependency=local(file,statement.moduleSpecifier.text);if(dependency)walk(dependency,client);
    }else if(ts.isExportDeclaration(statement)&&!statement.isTypeOnly&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)){
     const dependency=local(file,statement.moduleSpecifier.text);if(dependency)walk(dependency,client);
    }
   }
   const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)){
     if(client&&ts.isIdentifier(node.expression)&&hooks.has(node.expression.text)){
      const value=node.arguments[0]?literal(file,node.arguments[0]):undefined;
      if(value)prefixes.add(value);else unknown.add(relative(root,file));
     }
     if(client&&ts.isIdentifier(node.expression)&&messagesHooks.has(node.expression.text)
       &&relative(root,file)!=='components/route-message-provider.tsx')unknown.add(relative(root,file));
     if(node.expression.kind===ts.SyntaxKind.ImportKeyword){
      const argument=node.arguments[0];
      if(argument&&ts.isStringLiteralLike(argument)){const dependency=local(file,argument.text);if(dependency)walk(dependency,client);}
      else if(client)unknown.add(relative(root,file));
     }
    }
    ts.forEachChild(node,visit);
   };visit(ast);
  };
  entries.forEach(file=>walk(file));
  const ordered=[...prefixes].sort();
  return {prefixes:unknown.size?null:ordered.filter(value=>!ordered.some(parent=>parent!==value&&value.startsWith(parent+'.'))),unknown:[...unknown].sort()};
 }
 const app=join(root,'app');
 const shared=scope(['layout.tsx','loading.tsx','error.tsx','global-error.tsx','not-found.tsx'].map(name=>join(app,name)).filter(existsSync));
 const entries=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?entries(join(dir,entry.name)):/\.[jt]sx?$/.test(entry.name)?[join(dir,entry.name)]:[]);
 const segments:Record<string,MessageScope>={};
 if(existsSync(join(app,'page.tsx')))segments['']=scope([join(app,'page.tsx')]);
 for(const entry of readdirSync(app,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.isDirectory()&&!/^[(_@]/.test(entry.name)&&entry.name!=='api')segments[entry.name]=scope(entries(join(app,entry.name)));
 }
 return {version:1,shared,segments};
}
