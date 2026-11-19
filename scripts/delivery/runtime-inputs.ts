/** Small explicit file-read proof. Anything outside this syntax remains non-reusable. */
import ts from 'typescript';
import {posix} from 'node:path';
export function runtimeInputs(path:string,text:string,files:Map<string,string>){
 if(!/\.[cm]?[jt]sx?$/.test(path))return {opaque:false,dependencies:[] as string[]};
 const sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,path.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const readers=new Set<string>(),dependencies=new Set<string>();let opaque=false;
 for(const st of sf.statements){
  if(ts.isImportDeclaration(st)&&ts.isStringLiteralLike(st.moduleSpecifier)){
   if(/^(?:node:)?child_process(?:\/|$)/.test(st.moduleSpecifier.text))opaque=true;
   if(/^(?:node:)?fs(?:\/|$)/.test(st.moduleSpecifier.text)){
    const b=st.importClause?.namedBindings;
    if(!b||!ts.isNamedImports(b)||st.importClause?.name){opaque=true;continue;}
    for(const item of b.elements){if(!['readFileSync','readFile'].includes((item.propertyName??item.name).text)){opaque=true;continue;}readers.add(item.name.text);}
   }
  }
 }
 const binding=(n:ts.Node)=>ts.isVariableDeclaration(n)||ts.isParameter(n)||ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n);
 const walk=(n:ts.Node)=>{
  if(binding(n)){const name=(n as ts.VariableDeclaration).name;if(name&&ts.isIdentifier(name)&&readers.has(name.text))opaque=true;}
  if(ts.isIdentifier(n)&&readers.has(n.text)){
   const importName=ts.isImportSpecifier(n.parent);
   if(!importName&&!(ts.isCallExpression(n.parent)&&n.parent.expression===n))opaque=true;
  }
  if(ts.isCallExpression(n)){
   if(ts.isIdentifier(n.expression)&&readers.has(n.expression.text)){
    const a=n.arguments[0];let target:string|undefined;
    if(a&&ts.isStringLiteralLike(a))target=posix.normalize(a.text);
    else if(a&&ts.isNewExpression(a)&&a.expression.getText(sf)==='URL'&&a.arguments?.length===2&&ts.isStringLiteralLike(a.arguments[0])&&a.arguments[1].getText(sf)==='import.meta.url')target=posix.normalize(posix.join(posix.dirname(path),a.arguments[0].text));
    if(target&&!target.startsWith('../')&&!posix.isAbsolute(target)&&files.has(target))dependencies.add(target);else opaque=true;
   }
   const name=n.expression.getText(sf);
   if((n.expression.kind===ts.SyntaxKind.ImportKeyword||name==='require')&&(!n.arguments[0]||!ts.isStringLiteralLike(n.arguments[0])))opaque=true;
   if(['fetch','eval','Function','Date.now','Math.random'].includes(name))opaque=true;
  }
  if(ts.isNewExpression(n)&&n.expression.getText(sf)==='Date'&&!n.arguments?.length)opaque=true;
  ts.forEachChild(n,walk);
 };walk(sf);return {opaque,dependencies:[...dependencies].sort()};
}
