import ts from 'typescript';
import { personnelFormMetadataIssue } from '../../lib/personnel-form-contract';
import type { PersonnelFieldDescriptor } from '../../lib/personnel-field-registry';
export type PersonnelSourceExemption={tag:string;name?:string;nameExpression?:string;context?:string;hidden?:boolean;occurrences?:number;reason:string};
export type PersonnelSourceIssue={line:number;message:string};
const CONTROL_TAGS=new Set(['input','select','textarea','DateField','Combobox','ProfileOptionSelect','ProfileOptionSelectControlled','IcDobAutofill','CurrencySelect','MultiSelectPopover']);
const ADAPTERS=new Set(['personnelInput','personnelControl','personnelFormName','personnelCarry','personnelPresence','personnelDisplay','personnelRadio','personnelWorkflowControl','personnelWorkflowInput','personnelWorkflowCarry','workforceMaintenanceControl','workforceMaintenanceInput']);
/** Inspect real JSX, including controlled draft controls. A registry count is never evidence of rendering. */
export function auditPersonnelFormSource(file:string,text:string,fields:readonly PersonnelFieldDescriptor[],options:{exemptions?:readonly PersonnelSourceExemption[];dynamicBindings?:Record<string,readonly string[]>;resolveImportSource?:(from:string,specifier:string)=>string|undefined}={}) {
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  // Resolve the renderer's actual named import and exported literal map/key array. Never exempt a binding
  // or maintain a second descriptor map; unknown modules/keys/nonliteral entries remain unresolved.
  const importedMaps=new Map<string,Readonly<Record<string,string>>>();
  const importedArrays=new Map<string,readonly string[]>();
  for(const node of source.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
    const imports=node.importClause?.namedBindings;if(!imports||!ts.isNamedImports(imports))continue;
    const moduleText=options.resolveImportSource?.(file,node.moduleSpecifier.text);if(moduleText===undefined)continue;
    const imported=ts.createSourceFile(node.moduleSpecifier.text,moduleText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    for(const binding of imports.elements){
      const exported=binding.propertyName?.text??binding.name.text;
      for(const statement of imported.statements)if(ts.isVariableStatement(statement)&&statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))for(const declaration of statement.declarationList.declarations){
        if(!ts.isIdentifier(declaration.name)||declaration.name.text!==exported||!declaration.initializer)continue;
        let value=declaration.initializer;while(ts.isAsExpression(value)||ts.isParenthesizedExpression(value)||ts.isSatisfiesExpression(value))value=value.expression;
        if(ts.isArrayLiteralExpression(value)&&value.elements.length&&value.elements.every(ts.isStringLiteralLike)){
          importedArrays.set(binding.name.text,value.elements.map(element=>(element as ts.StringLiteralLike).text));continue;
        }
        if(!ts.isObjectLiteralExpression(value))continue;
        const map:Record<string,string>={};let literal=true;
        for(const prop of value.properties){
          if(!ts.isPropertyAssignment(prop)||!(ts.isIdentifier(prop.name)||ts.isStringLiteralLike(prop.name))||!ts.isStringLiteralLike(prop.initializer)||Object.hasOwn(map,prop.name.text)){literal=false;break;}
          map[prop.name.text]=prop.initializer.text;
        }
        if(literal&&Object.keys(map).length)importedMaps.set(binding.name.text,map);
      }
    }
  }
  const issues:PersonnelSourceIssue[]=[];let controls=0;const usedExemptions=new Map<PersonnelSourceExemption,number>();
  const byId=new Map(fields.map(field=>[field.id,field]));
  const report=(node:ts.Node,message:string)=>issues.push({line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,message});
  const visitChildren=(node:ts.Node,fn:(child:ts.Node)=>void)=>{fn(node);node.forEachChild(child=>visitChildren(child,fn));};
  const enclosingFunction=(node:ts.Node):ts.Node=>{let p=node.parent;while(p&&!ts.isFunctionLike(p))p=p.parent;return p??source;};
  const declarations:ts.VariableDeclaration[]=[];
  const collect=(node:ts.Node)=>{if(ts.isVariableDeclaration(node))declarations.push(node);node.forEachChild(collect);};collect(source);
  const scopes=(node:ts.Node)=>{const out:ts.Node[]=[];let scope=enclosingFunction(node);while(scope!==source){out.push(scope);scope=enclosingFunction(scope);}out.push(source);return out;};
  const declaration=(name:string,node:ts.Node)=>{for(const scope of scopes(node)){const found=declarations.find(d=>enclosingFunction(d)===scope&&(ts.isIdentifier(d.name)?d.name.text===name:ts.isArrayBindingPattern(d.name)&&d.name.elements.some(e=>ts.isBindingElement(e)&&ts.isIdentifier(e.name)&&e.name.text===name)));if(found)return found;}return undefined;};
  const registryQuery=(node:ts.Node,bindings:Record<string,string>={})=>{
    const predicates:Record<string,string>={};
    const visit=(child:ts.Node)=>{if(ts.isBinaryExpression(child)&&child.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken&&ts.isPropertyAccessExpression(child.left)&&['owner','ownerField','formGroup'].includes(child.left.name.text)){const value=ts.isStringLiteralLike(child.right)?child.right.text:ts.isIdentifier(child.right)?bindings[child.right.text]:undefined;if(value)predicates[child.left.name.text]=value;}child.forEachChild(visit);};visit(node);
    return Object.keys(predicates).length?fields.filter(field=>Object.entries(predicates).every(([key,value])=>field[key as keyof PersonnelFieldDescriptor]===value)).map(field=>field.id):[];
  };
  const ids=(expression:ts.Expression,seen=new Set<ts.Node>(),argumentsByParameter:ReadonlyMap<ts.ParameterDeclaration,readonly string[]>=new Map()):readonly string[]=>{
    if(seen.has(expression))return [];seen=new Set(seen).add(expression);
    const exact=options.dynamicBindings?.[expression.getText(source)];if(exact)return exact;
    if(ts.isStringLiteralLike(expression))return [expression.text];
    if(ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isNonNullExpression(expression))return ids(expression.expression,seen,argumentsByParameter);
    if(ts.isConditionalExpression(expression))return [...ids(expression.whenTrue,seen,argumentsByParameter),...ids(expression.whenFalse,seen,argumentsByParameter)];
    if(ts.isArrayLiteralExpression(expression))return expression.elements.flatMap(e=>ts.isExpression(e)?ids(e,seen,argumentsByParameter):[]);
    if(ts.isObjectLiteralExpression(expression))return expression.properties.flatMap(p=>ts.isPropertyAssignment(p)?ids(p.initializer,seen,argumentsByParameter):[]);
    if(ts.isCallExpression(expression)&&ts.isIdentifier(expression.expression)){
      const d=declaration(expression.expression.text,expression),fn=d?.initializer;
      if(fn&&(ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))){
        const bound=new Map(argumentsByParameter);
        fn.parameters.forEach((parameter,index)=>{const argument=expression.arguments[index];if(argument)bound.set(parameter,ids(argument,seen,argumentsByParameter));});
        if(!ts.isBlock(fn.body))return ids(fn.body,seen,bound);
        const returns:ts.Expression[]=[];visitChildren(fn.body,node=>{if(ts.isReturnStatement(node)&&node.expression)returns.push(node.expression);});return returns.flatMap(value=>ids(value,seen,bound));
      }
    }
    if(ts.isIdentifier(expression)){
      const fn=enclosingFunction(expression);
      // A map callback may use only the finite literal keys actually supplied by its source array.
      if(ts.isFunctionLike(fn)&&ts.isCallExpression(fn.parent)&&fn.parent.arguments[0]===fn&&ts.isPropertyAccessExpression(fn.parent.expression)&&fn.parent.expression.name.text==='map'&&fn.parameters[0]&&ts.isIdentifier(fn.parameters[0].name)&&fn.parameters[0].name.text===expression.text){
        return ids(fn.parent.expression.expression,seen,argumentsByParameter);
      }

      if(ts.isFunctionLike(fn)){const parameter=fn.parameters.find(p=>ts.isIdentifier(p.name)&&p.name.text===expression.text);if(parameter&&argumentsByParameter.has(parameter))return argumentsByParameter.get(parameter)!;}
      if(ts.isFunctionLike(fn)){const index=fn.parameters.findIndex(p=>ts.isIdentifier(p.name)&&p.name.text===expression.text);if(index>=0&&ts.isVariableDeclaration(fn.parent)&&ts.isIdentifier(fn.parent.name)){const values:ts.Expression[]=[],ownerName=fn.parent.name.text;visitChildren(source,node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===ownerName&&node.arguments[index])values.push(node.arguments[index]);});return values.flatMap(value=>ids(value,seen,argumentsByParameter));}}
      const d=declaration(expression.text,expression);if(d?.initializer){
        if(ts.isArrayBindingPattern(d.name)&&ts.isElementAccessExpression(d.initializer)&&ts.isIdentifier(d.initializer.expression)){
          const index=d.name.elements.findIndex(e=>ts.isBindingElement(e)&&ts.isIdentifier(e.name)&&e.name.text===expression.text);
          const owner=declaration(d.initializer.expression.text,d.initializer);let map=owner?.initializer;if(map&&ts.isAsExpression(map))map=map.expression;
          if(map&&ts.isObjectLiteralExpression(map))return map.properties.flatMap(p=>ts.isPropertyAssignment(p)&&ts.isArrayLiteralExpression(p.initializer)&&p.initializer.elements[index]?ids(p.initializer.elements[index] as ts.Expression,seen,argumentsByParameter):[]);
        }
        return ids(d.initializer,seen,argumentsByParameter);
      }
      const shadowed=scopes(expression).some(scope=>ts.isFunctionLike(scope)&&scope.parameters.some(parameter=>ts.isIdentifier(parameter.name)&&parameter.name.text===expression.text));
      if(!d&&!shadowed)return importedArrays.get(expression.text)??[];
    }
    if(ts.isElementAccessExpression(expression)||ts.isPropertyAccessExpression(expression)){
      if(ts.isIdentifier(expression.expression)&&!declaration(expression.expression.text,expression)){
        const map=importedMaps.get(expression.expression.text);
        if(map){const keys=ts.isElementAccessExpression(expression)?expression.argumentExpression?ids(expression.argumentExpression,seen,argumentsByParameter):[]:[expression.name.text];return keys.length&&keys.every(key=>Object.hasOwn(map,key))?keys.map(key=>map[key]):[];}
      }
      if(ts.isPropertyAccessExpression(expression)&&expression.name.text==='id'){
        if(ts.isCallExpression(expression.expression)&&ts.isIdentifier(expression.expression.expression)){
          const call=expression.expression,d=declaration(call.expression.getText(source),call),fn=d?.initializer;
          if(fn&&(ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))){const bindings:Record<string,string>={};fn.parameters.forEach((p,i)=>{if(ts.isIdentifier(p.name)&&call.arguments[i]&&ts.isStringLiteralLike(call.arguments[i]))bindings[p.name.text]=(call.arguments[i] as ts.StringLiteral).text;});return registryQuery(fn,bindings);}
        }
        for(const scope of scopes(expression)){const found=registryQuery(scope);if(found.length)return found;}
        return [];
      }
      return ids(expression.expression,seen,argumentsByParameter);
    }
    return [];
  };
  const attribute=(node:ts.JsxOpeningLikeElement,name:string)=>node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)===name) as ts.JsxAttribute|undefined;
  const literalAttribute=(node:ts.JsxOpeningLikeElement,name:string)=>{const value=attribute(node,name)?.initializer;return value&&ts.isStringLiteral(value)?value.text:undefined;};
  const signature=(node:ts.JsxOpeningLikeElement)=>{
    const name=literalAttribute(node,'name');const raw=attribute(node,'name')?.initializer;
    let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isVariableDeclaration(owner)&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
    const context=owner&&'name' in owner&&owner.name?owner.name.getText(source):undefined;
    return {tag:node.tagName.getText(source),name,nameExpression:raw&&ts.isJsxExpression(raw)&&raw.expression?raw.expression.getText(source):undefined,context,hidden:literalAttribute(node,'type')==='hidden'};
  };
  const exemptionFor=(node:ts.JsxOpeningLikeElement)=>{const value=signature(node);return options.exemptions?.find(item=>item.tag===value.tag&&item.name===value.name&&item.nameExpression===value.nameExpression&&(item.context==null||item.context===value.context)&&(item.hidden==null||item.hidden===value.hidden));};
  const scan=(node:ts.Node)=>{
    if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) {
      const tag=node.tagName.getText(source);
      if(tag==='PersonnelField'&&attribute(node,'label'))report(node,'Personnel caption overrides its descriptor.');
      if(tag==='Field' && attribute(node,'label')) {
        let containsControl=false;
        if(ts.isJsxElement(node.parent))visitChildren(node.parent,child=>{if((ts.isJsxOpeningElement(child)||ts.isJsxSelfClosingElement(child))&&CONTROL_TAGS.has(child.tagName.getText(source))&&!exemptionFor(child))containsControl=true;});
        if(containsControl)report(node,'Personnel field presentation bypasses PersonnelField.');
      }
      if(CONTROL_TAGS.has(tag)) {
        controls++;
        const {name}=signature(node);
        const exempt=exemptionFor(node);
        if(exempt) {
          if(!exempt.reason.trim() || exempt.reason==='TODO')report(node,'Personnel control exemption lacks an owner reason.');
          usedExemptions.set(exempt,(usedExemptions.get(exempt)??0)+1);
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
            for(const id of resolved){const field=byId.get(id);if(!field?.form)report(expression,`Unknown Personnel form field: ${id}.`);else {const issue=personnelFormMetadataIssue(field);if(issue)report(expression,issue);}}
            // Canonical carry adapters are hidden transport identities, not controls with captions.
            // Still validate their exact descriptor above and their metadata below.
            const carryOnly=calls.length>0&&calls.every(call=>['personnelCarry','personnelPresence','personnelWorkflowCarry'].includes(call.expression.getText(source)));
            if(carryOnly)continue;
            let ancestor:ts.Node|undefined=node.parent;while(ancestor){if(ts.isJsxElement(ancestor)&&ancestor.openingElement.tagName.getText(source)==='PersonnelField'){
              const value=attribute(ancestor.openingElement,'fieldId')?.initializer;
              const captionIds=value&&ts.isStringLiteral(value)?[value.text]:value&&ts.isJsxExpression(value)&&value.expression?ids(value.expression):[];
              const captions=new Set(captionIds.map(id=>byId.get(id)?.labelKey));
              if(captionIds.length&&resolved.some(id=>!captionIds.includes(id)&&!captions.has(byId.get(id)?.labelKey)))report(node,'Personnel caption and control bind different facts.');
              break;
            }ancestor=ancestor.parent;}

          }
          if(calls.length)for(const prop of node.attributes.properties) {
            if(ts.isJsxAttribute(prop)&&['type','required','min','max','step'].includes(prop.name.getText(source)))report(prop,`Personnel ${prop.name.getText(source)} bypasses descriptor metadata.`);
            if(ts.isJsxSpreadAttribute(prop)) {
              const inspect=(value:ts.Expression)=>{if(ts.isParenthesizedExpression(value))inspect(value.expression);else if(ts.isConditionalExpression(value)){inspect(value.whenTrue);inspect(value.whenFalse);}else if(ts.isObjectLiteralExpression(value))for(const item of value.properties)if(ts.isPropertyAssignment(item)&&['name','type','required','min','max','step'].includes(item.name.getText(source))&&!(ts.isCallExpression(item.initializer)&&ts.isIdentifier(item.initializer.expression)&&ADAPTERS.has(item.initializer.expression.text)))report(item,'Personnel spread overrides descriptor '+item.name.getText(source)+'.');};
              inspect(prop.expression);
            }
          }
        }
      }
    }
    node.forEachChild(scan);
  };
  scan(source);
  for(const exemption of options.exemptions??[]){const count=usedExemptions.get(exemption)??0;if(!count)issues.push({line:1,message:`Stale Personnel control exemption: ${exemption.tag} ${exemption.name??exemption.nameExpression}.`});else if(exemption.occurrences!=null&&count!==exemption.occurrences)issues.push({line:1,message:`Personnel exemption occurrence changed: ${exemption.context}:${exemption.name??exemption.nameExpression} expected ${exemption.occurrences}, found ${count}.`});}
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
