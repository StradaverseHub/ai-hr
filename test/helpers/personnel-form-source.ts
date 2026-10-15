import ts from 'typescript';
import type { PersonnelFieldDescriptor } from '../../lib/personnel-field-registry';
export type PersonnelSourceExemption={tag:string;name:string;reason:string};
export type PersonnelSourceIssue={line:number;message:string};
const CONTROL_TAGS=new Set(['input','select','textarea','DateField','Combobox','ProfileOptionSelect','ProfileOptionSelectControlled']);
const ADAPTERS=new Set(['personnelInput','personnelControl','personnelFormName']);
/** Inspect real JSX, including controlled draft controls. A registry count is never evidence of rendering. */
export function auditPersonnelFormSource(file:string,text:string,fields:readonly PersonnelFieldDescriptor[],options:{exemptions?:readonly PersonnelSourceExemption[];dynamicBindings?:Record<string,readonly string[]>}={}) {
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const issues:PersonnelSourceIssue[]=[];let controls=0;const usedExemptions=new Set<string>();
  const byId=new Map(fields.map(field=>[field.id,field]));
  const report=(node:ts.Node,message:string)=>issues.push({line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,message});
  const visitChildren=(node:ts.Node,fn:(child:ts.Node)=>void)=>{fn(node);node.forEachChild(child=>visitChildren(child,fn));};
  const ids=(expression:ts.Expression):readonly string[]=>{
    if(ts.isStringLiteralLike(expression))return [expression.text];
    return options.dynamicBindings?.[expression.getText(source)]??[];
  };
  const attribute=(node:ts.JsxOpeningLikeElement,name:string)=>node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)===name) as ts.JsxAttribute|undefined;
  const literalAttribute=(node:ts.JsxOpeningLikeElement,name:string)=>{const value=attribute(node,name)?.initializer;return value&&ts.isStringLiteral(value)?value.text:undefined;};
  const scan=(node:ts.Node)=>{
    if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) {
      const tag=node.tagName.getText(source);
      if(tag==='Field' && attribute(node,'label')) {
        let containsControl=false;
        if(ts.isJsxElement(node.parent))visitChildren(node.parent,child=>{if((ts.isJsxOpeningElement(child)||ts.isJsxSelfClosingElement(child))&&CONTROL_TAGS.has(child.tagName.getText(source)))containsControl=true;});
        if(containsControl)report(node,'Personnel field presentation bypasses PersonnelField.');
      }
      if(CONTROL_TAGS.has(tag)) {
        controls++;
        const name=literalAttribute(node,'name');
        const exempt=options.exemptions?.find(item=>item.tag===tag&&item.name===name);
        if(exempt) {
          if(!exempt.reason.trim() || exempt.reason==='TODO')report(node,'Personnel control exemption lacks an owner reason.');
          usedExemptions.add(`${tag}|${name}`);
        } else {
          const calls:ts.CallExpression[]=[];
          for(const prop of node.attributes.properties)visitChildren(prop,child=>{if(ts.isCallExpression(child)&&ts.isIdentifier(child.expression)&&ADAPTERS.has(child.expression.text))calls.push(child);});
          const binding=attribute(node,'personnelFieldId')?.initializer;
          const expressions=calls.flatMap(call=>call.arguments[0]?[call.arguments[0]]:[]);
          if(binding&&ts.isJsxExpression(binding)&&binding.expression)expressions.push(binding.expression);
          if(!expressions.length)report(node,`Unbound Personnel control: ${tag}${name?' '+name:''}.`);
          for(const expression of expressions) {
            const resolved=ids(expression);
            if(!resolved.length)report(expression,`Unresolved Personnel binding: ${expression.getText(source)}.`);
            for(const id of resolved)if(!byId.get(id)?.form)report(expression,`Unknown Personnel form field: ${id}.`);
          }
          if(calls.length)for(const prop of node.attributes.properties) {
            if(ts.isJsxAttribute(prop)&&['type','required','min','step'].includes(prop.name.getText(source)))report(prop,`Personnel ${prop.name.getText(source)} bypasses descriptor metadata.`);
          }
        }
      }
    }
    node.forEachChild(scan);
  };
  scan(source);
  for(const exemption of options.exemptions??[])if(!usedExemptions.has(`${exemption.tag}|${exemption.name}`))issues.push({line:1,message:`Stale Personnel control exemption: ${exemption.tag} ${exemption.name}.`});
  if(!controls)issues.push({line:1,message:'Personnel source has no controls; the source inventory is empty.'});
  return {controls,issues};
}
/** Resolve declared descriptor references in mounted renderers, not every registry entry. */
export function personnelRenderedLabelKeys(file:string,text:string,fields:readonly PersonnelFieldDescriptor[]) {
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const declared=new Set<string>();const byId=new Map(fields.map(field=>[field.id,field]));
  const groups=new Set<string>();let usesAdapter=false;
  const scan=(node:ts.Node)=>{
    if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)==='PersonnelField')usesAdapter=true;
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='personnelFormLabel')usesAdapter=true;
    if(ts.isStringLiteralLike(node)&&byId.has(node.text)) {
      // Transport/control identities do not themselves render a caption (notably legacy numeric tax).
      const parent=node.parent;
      const identityOnly=ts.isCallExpression(parent)&&ts.isIdentifier(parent.expression)&&['personnelCarry','personnelPresence','personnelControl','personnelInput','personnelDisplay','personnelRadio','personnelFormName'].includes(parent.expression.text);
      if(!identityOnly)declared.add(node.text);
    }
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.name.text==='formGroup'&&ts.isStringLiteral(node.right))groups.add(node.right.text);
    node.forEachChild(scan);
  };
  scan(source);
  if(!usesAdapter)return new Set<string>();
  for(const field of fields)if(field.formGroup&&groups.has(field.formGroup))declared.add(field.id);
  return new Set([...declared].map(id=>byId.get(id)!.labelKey).filter(key=>key.startsWith('people.detail.')).map(key=>key.slice(14)));
}
