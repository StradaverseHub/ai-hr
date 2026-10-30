/** Source-only gateway boundary checks, shared by the inventory test and adversarial fixtures. */
import ts from 'typescript';
const sdks=new Set(['openai','@anthropic-ai/sdk','@google/genai']);
const sdkOwners=new Set(['lib/ai/providers/openai.ts','lib/ai/providers/anthropic.ts','lib/ai/providers/google.ts']);
const fetchOwners=new Set(['lib/ai/providers/openrouter.ts','lib/ai/providers/openrouter-transport.ts','lib/ai/spend-receipt.ts']);
const endpoint=/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai|ai-gateway\.[^/\s'"]+)/i;
export function aiBoundaryViolations(file:string,source:string):string[]{
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),errors:string[]=[];
 const testFile=file.startsWith('test/'),egressOwner=file==='lib/ai/index.ts',egressDefinition=file==='lib/ai/provider-egress.ts';
 const egressModule=(value:string)=>/(?:^|\/)provider-egress(?:\.[cm]?[jt]s)?$/.test(value);
 const privacyModule=(value:string)=>/(?:^|\/)provider-privacy-request(?:\.[cm]?[jt]s)?$/.test(value);
 const privacyOwners:Record<string,readonly string[]>={bindProviderPrivacyRequest:['core/ai-governance.ts'],transferProviderPrivacyRequest:['core/ai-governance.ts','lib/ai/governance.ts'],consumeProviderPrivacyRequest:['lib/ai/index.ts'],revokeProviderPrivacyRequest:['core/ai-governance.ts']};
 const privacyOutside=(name:string)=>Object.prototype.hasOwnProperty.call(privacyOwners,name)&&!privacyOwners[name].includes(file)&&file!=='lib/ai/provider-privacy-request.ts';
 const initializers=new Map<string,ts.Expression>(),loaders=new Set(['require']);
 const staticText=(node:ts.Expression,seen=new Set<string>()):string|null=>{
  if(ts.isStringLiteralLike(node))return node.text;
  if(ts.isParenthesizedExpression(node))return staticText(node.expression,seen);
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken){const left=staticText(node.left,seen),right=staticText(node.right,seen);return left===null||right===null?null:left+right;}
  if(ts.isIdentifier(node)&&!seen.has(node.text)){const value=initializers.get(node.text);if(value)return staticText(value,new Set([...seen,node.text]));}
  return null;
 };
 const imports=new Map<string,string>(),fetchAliases=new Set(['fetch']);let hasFetch=false;
 const aliases=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer){const init=node.initializer;initializers.set(node.name.text,init);if(ts.isIdentifier(init)&&loaders.has(init.text)||ts.isCallExpression(init)&&ts.isIdentifier(init.expression)&&init.expression.text==='createRequire')loaders.add(node.name.text);if(ts.isIdentifier(init)&&fetchAliases.has(init.text)||ts.isPropertyAccessExpression(init)&&init.name.text==='fetch')fetchAliases.add(node.name.text);}ts.forEachChild(node,aliases);};aliases(tree);
 function visit(node:ts.Node){
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
   const module=node.moduleSpecifier.text;
   if(sdks.has(module)&&!sdkOwners.has(file))errors.push('provider SDK outside adapter');
   if(/\/providers\/(?:anthropic|google|openai|openrouter|gateway)$/.test(module)&&file!=='lib/ai/index.ts')errors.push('provider adapter outside gateway');
   const bindings=node.importClause?.namedBindings;
   if(!testFile&&egressModule(module)&&!egressOwner&&!node.importClause?.isTypeOnly){
    const issuer=bindings&&ts.isNamedImports(bindings)?bindings.elements.some(name=>!name.isTypeOnly&&(name.propertyName??name.name).text==='withProviderEgressDispatch'):true;
    if(issuer)errors.push('provider egress issuer outside gateway');
   }
   if(!testFile&&privacyModule(module)&&!node.importClause?.isTypeOnly){
    const issuer=bindings&&ts.isNamedImports(bindings)?bindings.elements.some(name=>!name.isTypeOnly&&privacyOutside((name.propertyName??name.name).text)):true;
    if(issuer)errors.push('provider privacy issuer outside owner');
   }
   if(bindings&&ts.isNamedImports(bindings))for(const name of bindings.elements)imports.set(name.name.text,(name.propertyName??name.name).text);
  }
  if(!testFile&&ts.isExportDeclaration(node)&&!node.isTypeOnly){
   if(node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)&&egressModule(node.moduleSpecifier.text))errors.push('provider egress issuer re-export');
   if(node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)&&privacyModule(node.moduleSpecifier.text))errors.push('provider privacy issuer re-export');
   if(file!=='lib/ai/provider-privacy-request.ts'&&node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.some(item=>Object.prototype.hasOwnProperty.call(privacyOwners,imports.get((item.propertyName??item.name).text)??(item.propertyName??item.name).text)))errors.push('provider privacy issuer re-export');
   if(!egressDefinition&&node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.some(item=>(imports.get((item.propertyName??item.name).text)??(item.propertyName??item.name).text)==='withProviderEgressDispatch'))errors.push('provider egress issuer re-export');
  }
  if(ts.isCallExpression(node)){
   const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
   if(/fetch/i.test(name)||fetchAliases.has(name))hasFetch=true;
   const moduleLoader=loaders.has(name)||node.expression.kind===ts.SyntaxKind.ImportKeyword;
   if(!testFile&&moduleLoader){
    const modules=node.arguments.map(argument=>staticText(argument)).filter((value):value is string=>value!==null);
    if(modules.some(egressModule))errors.push('provider egress issuer outside gateway');
    if(modules.some(privacyModule))errors.push('provider privacy issuer outside owner');
   }
   if(!testFile&&privacyOutside(imports.get(name)??name))errors.push('provider privacy issuer outside owner');
   if(!testFile&&!egressOwner&&(imports.get(name)??name)==='withProviderEgressDispatch')errors.push('provider egress issuer outside gateway');
   if(['require','import'].includes(node.expression.getText(tree))&&node.arguments.some(a=>ts.isStringLiteral(a)&&sdks.has(a.text))&&!sdkOwners.has(file))errors.push('provider SDK outside adapter');
   if((imports.get(name)??name)==='createUngovernedProbe'&&file!=='core/ai-config.ts'&&file!=='lib/ai/governance.ts')errors.push('probe capability outside connection test');
  }
  ts.forEachChild(node,visit);
 }visit(tree);
 if(hasFetch&&!fetchOwners.has(file)){
  const literals:string[]=[];
  const strings=(node:ts.Node)=>{if(ts.isStringLiteralLike(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node))literals.push(node.text);ts.forEachChild(node,strings);};strings(tree);
  if(literals.some(s=>endpoint.test(s))||(/\b(?:messages|contents|prompt)\b/.test(source)&&/\bmodel\b/.test(source)&&/Authorization|api[-_]?key/i.test(source)))errors.push('raw provider fetch outside gateway transport');
 }
 return [...new Set(errors)];
}
