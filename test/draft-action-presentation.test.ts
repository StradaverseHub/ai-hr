import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {draftActivationMessageKey,draftActivationFieldLabels,draftFailureReference,DRAFT_ACTIVATION_MESSAGE_KEYS,DRAFT_ACTIVATION_FIELD_PRESENTATION} from '../lib/draft-activation-presentation';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
function ownerLiterals(name:string){
  const source=ts.createSourceFile('employee-draft.ts',read('core/employee-draft.ts'),ts.ScriptTarget.Latest,true);
  const values:ts.Expression[]=[];
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name)node.initializer&&values.push(node.initializer);node.forEachChild(visit);};visit(source);
  const value=values[0];
  if(!value)throw new Error('Missing canonical Draft owner declaration: '+name);
  const unwrap=(value:ts.Expression):ts.Expression=>ts.isAsExpression(value)||ts.isSatisfiesExpression(value)?unwrap(value.expression):value;
  const item=unwrap(value);
  const strings=(value:ts.Expression)=>{const array=unwrap(value);if(!ts.isArrayLiteralExpression(array))throw new Error('Expected a finite owner vocabulary');return array.elements.map(element=>{if(!ts.isStringLiteral(element))throw new Error('Expected an owner token');return element.text;});};
  if(ts.isArrayLiteralExpression(item))return strings(item);
  if(!ts.isObjectLiteralExpression(item))throw new Error('Expected canonical tab owner');
  return Object.fromEntries(item.properties.map(property=>{if(!ts.isPropertyAssignment(property))throw new Error('Expected tab property');return [property.name.getText(source),strings(property.initializer)];}));
}
describe('safe Draft action presentation',()=>{
  it('covers exact finite owner codes and field pointers without another validation authority',()=>{
    expect(Object.keys(DRAFT_ACTIVATION_MESSAGE_KEYS)).toEqual(ownerLiterals('DRAFT_ACTIVATION_CODES'));
    const owner=ownerLiterals('DRAFT_ACTIVATION_FIELDS_BY_TAB') as Record<string,string[]>;
    for(const [tab,fields] of Object.entries(owner))expect(Object.keys(DRAFT_ACTIVATION_FIELD_PRESENTATION[tab as keyof typeof DRAFT_ACTIVATION_FIELD_PRESENTATION]).sort()).toEqual([...fields].sort());
  });
  it('resolves every validation message and known field label in all six real catalogs',()=>{
    for(const locale of ['en','ms','ta','th','vi','zh']){
      const messages=JSON.parse(read('messages/'+locale+'.json'));
      const resolve=(key:string)=>key.split('.').reduce((value,part)=>value?.[part],messages);
      for(const key of Object.values(DRAFT_ACTIVATION_MESSAGE_KEYS))expect(typeof resolve(key),locale+':'+key).toBe('string');
      for(const [tab,group] of Object.entries(DRAFT_ACTIVATION_FIELD_PRESENTATION))for(const field of Object.keys(group)){
        const labels=draftActivationFieldLabels([{tab,field}],resolve,'full_time');
        expect(labels,locale+':'+tab+':'+field).toHaveLength(1);expect(labels[0].label).not.toContain('undefined');
      }
      for(const employmentType of ['contract','intern'])expect(draftActivationFieldLabels([{tab:'job',field:'provisionalEndOn'}],resolve,employmentType)).toHaveLength(1);
    }
  });
  it('never renders unknown codes, field tokens, diagnostic text or malformed references',()=>{
    expect(draftActivationMessageKey('SELECT secret FROM employee')).toBe(DRAFT_ACTIVATION_MESSAGE_KEYS.invalid_data);
    expect(draftActivationFieldLabels([{tab:'job',field:'SELECT payroll'},{tab:'private',field:'salary'},{tab:'__proto__',field:'constructor'}],()=>{throw new Error('Must not resolve unknown input');},'full_time')).toEqual([]);
    expect(draftFailureReference('DRAFT-A1B2C3D4')).toBe('DRAFT-A1B2C3D4');
    for(const unsafe of ['SQL relation error','DRAFT-<script>','DRAFT-A1B2C3D4\nSELECT secret',null])expect(draftFailureReference(unsafe)).toBeNull();
  });
  it('keys the mounted wizard to its actual Draft and has no raw error-message renderer',()=>{
    expect(read('app/(app)/admin/personnel/new/page.tsx')).toContain('key={draft.id}');
    const source=ts.createSourceFile('wizard.tsx',read('app/(app)/admin/personnel/new/wizard.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const raw:ts.Node[]=[];const visit=(node:ts.Node)=>{if(ts.isPropertyAccessExpression(node)&&node.name.text==='message')raw.push(node);node.forEachChild(visit);};visit(source);expect(raw).toEqual([]);
  });
});
