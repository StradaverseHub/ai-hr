/** Source-only gateway boundary checks, shared by the inventory test and adversarial fixtures. */
import ts from 'typescript';
const sdks=new Set(['openai','@anthropic-ai/sdk','@google/genai']);
const sdkOwners=new Set(['lib/ai/providers/openai.ts','lib/ai/providers/anthropic.ts','lib/ai/providers/google.ts']);
const fetchOwners=new Set(['lib/ai/providers/openrouter.ts','lib/ai/providers/openrouter-transport.ts','lib/ai/spend-receipt.ts']);
const endpoint=/https?:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai|ai-gateway\.[^/\s'"]+)/i;
export function aiBoundaryViolations(file:string,source:string):string[]{
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),errors:string[]=[];
 const imports=new Map<string,string>();let hasFetch=false;
 function visit(node:ts.Node){
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
   const module=node.moduleSpecifier.text;
   if(sdks.has(module)&&!sdkOwners.has(file))errors.push('provider SDK outside adapter');
   const bindings=node.importClause?.namedBindings;
   if(bindings&&ts.isNamedImports(bindings))for(const name of bindings.elements)imports.set(name.name.text,(name.propertyName??name.name).text);
  }
  if(ts.isCallExpression(node)){
   const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
   if(/fetch/i.test(name))hasFetch=true;
   if(['require','import'].includes(node.expression.getText(tree))&&node.arguments.some(a=>ts.isStringLiteral(a)&&sdks.has(a.text))&&!sdkOwners.has(file))errors.push('provider SDK outside adapter');
   if((imports.get(name)??name)==='createUngovernedProbe'&&file!=='core/ai-config.ts'&&file!=='lib/ai/governance.ts')errors.push('probe capability outside connection test');
  }
  ts.forEachChild(node,visit);
 }visit(tree);
 if(hasFetch&&!fetchOwners.has(file)){
  const literals:string[]=[];
  const strings=(node:ts.Node)=>{if(ts.isStringLiteralLike(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node))literals.push(node.text);ts.forEachChild(node,strings);};strings(tree);
  if(literals.some(s=>endpoint.test(s))||(/\b(?:messages|contents|prompt)\s*:/.test(source)&&/\bmodel\s*:/.test(source)&&/Authorization|api[-_]?key/i.test(source)))errors.push('raw provider fetch outside gateway transport');
 }
 return [...new Set(errors)];
}
