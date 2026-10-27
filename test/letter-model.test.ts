import {describe,expect,it} from 'vitest';
import {renderLetterDocument,parseLetterValue,validateLetterDocument,validateLetterFields,usedLetterFields,type LetterField,type LetterDocument} from '../lib/letter-model';
const fields:LetterField[]=[{key:'employeeName',label:'Employee',description:'Canonical employee name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},{key:'allowance',label:'Allowance',description:'Explicit letter amount',kind:'currency',source:'custom.currency',required:false,editable:true,sensitive:true},{key:'startDate',label:'Start date',description:'Employment start',kind:'date',source:'employment.hiredOn',required:true,editable:false,sensitive:false}];
const document:LetterDocument={version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear ',marks:['bold']},{type:'field',key:'employeeName'}]},{type:'if',condition:{type:'present',field:'allowance'},then:[{type:'table',rows:[[[{type:'text',text:'Allowance'}],[{type:'field',key:'allowance'}]]]}],otherwise:[]}]};
const values={employeeName:{kind:'text' as const,value:'Fictional Employee'},allowance:{kind:'currency' as const,value:'1200.50',currency:'MYR'}};
describe('versionable deterministic letter templates',()=>{
 it('resolves typed merge values and conditional rich text without mutating the template',()=>{
  const before=JSON.stringify(document),rendered=renderLetterDocument(document,fields,values,{allowSensitive:true});expect(JSON.stringify(document)).toBe(before);expect(rendered.document.blocks[0]).toEqual({type:'paragraph',content:[{type:'text',text:'Dear ',marks:['bold']},{type:'text',text:'Fictional Employee'}]});expect(JSON.stringify(rendered.document.blocks[1])).toContain('MYR 1,200.50');expect(rendered.usedFields).toEqual(['allowance','employeeName']);
 });
 it('identifies unknown, mandatory and confidential values; missing optional conditions produce no invented allowance',()=>{
  expect(()=>validateLetterDocument({...document,blocks:[{type:'paragraph',content:[{type:'field',key:'unknownField'}]}]},fields)).toThrow('unknownField: unknownField');
  expect(()=>renderLetterDocument(document,fields,{...values,employeeName:null},{allowSensitive:true})).toThrow('missingField: employeeName');
  expect(()=>renderLetterDocument(document,fields,values,{allowSensitive:false})).toThrow('confidential: allowance');
  expect(renderLetterDocument(document,fields,{...values,allowance:null},{allowSensitive:true}).document.blocks).toHaveLength(1);
 });

 it('shares typed form validation and refuses merge expansion beyond the authored resource bound',()=>{
  expect(parseLetterValue({kind:'currency',value:'12.345',currency:'KWD'},'amount')).toEqual({kind:'currency',value:'12.345',currency:'KWD'});
  expect(()=>parseLetterValue({kind:'currency',value:'12.345',currency:'MYR'},'amount')).toThrow('invalid: amount');
  expect(()=>parseLetterValue({kind:'date',value:'2024-02-30'},'date')).toThrow('invalid: date');
  const repeated:LetterDocument={version:1,language:'en',blocks:[{type:'paragraph',content:Array.from({length:40},()=>({type:'field' as const,key:'employeeName'}))}]};
  expect(()=>renderLetterDocument(repeated,fields,{employeeName:{kind:'text',value:'x'.repeat(10000)}},{allowSensitive:true})).toThrow('limit: document');
 });
 it('limits field mappings and editable data to the supported canonical sources',()=>{
  expect(()=>validateLetterFields([{...fields[0],source:'SELECT salary FROM compensation'}])).toThrow('invalid: fields');expect(()=>validateLetterFields([{...fields[0],editable:true}])).toThrow('invalid: employeeName');expect(()=>validateLetterFields([{...fields[1],sensitive:false}])).toThrow('invalid: allowance');
 });
 it('does not accept HTML nodes, event handlers, external images or arbitrary expressions',()=>{
  for(const block of [{type:'html',html:'<script>alert(1)</script>'},{type:'image',src:'https://external.invalid/track'},{type:'paragraph',content:[],onclick:'alert(1)'},{type:'if',condition:{type:'javascript',code:'true'},then:[],otherwise:[]}])expect(()=>validateLetterDocument({...document,blocks:[block]},fields)).toThrow('invalid: document');
 });
 it('uses exact typed comparisons, refuses mixed currencies, and inventories field dependencies in hidden branches',()=>{
  const conditional:LetterDocument={version:1,language:'en',blocks:[{type:'if',condition:{type:'greater',field:'allowance',value:{kind:'currency',currency:'MYR',value:'1200.49'}},then:[{type:'paragraph',content:[{type:'text',text:'Eligible'}]}],otherwise:[{type:'paragraph',content:[{type:'field',key:'startDate'}]}]}]};
  expect(JSON.stringify(renderLetterDocument(conditional,fields,values,{allowSensitive:true}).document)).toContain('Eligible');expect(usedLetterFields(conditional)).toEqual(['allowance','startDate']);expect(()=>renderLetterDocument(conditional,fields,{...values,allowance:{kind:'currency',value:'1200.50',currency:'SGD'}},{allowSensitive:true})).toThrow('invalid: allowance');
 });
 it('formats valid dates by letter language and preserves the entity currency precision',()=>{
  const template:LetterDocument={version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'field',key:'startDate'},{type:'field',key:'allowance'}]}]};
  const result=renderLetterDocument(template,fields,{startDate:{kind:'date',value:'2024-02-29'},allowance:{kind:'currency',value:'12.345',currency:'KWD'}},{allowSensitive:true});expect(JSON.stringify(result)).toContain('29 February 2024');expect(JSON.stringify(result)).toContain('KWD 12.345');expect(()=>renderLetterDocument(template,fields,{startDate:{kind:'date',value:'2024-02-30'}},{allowSensitive:true})).toThrow('invalid: startDate');
 });
 it('bounds recursive documents before validation and accepts repeated non-cyclic content values',()=>{
  const recursive:any={type:'if',condition:{type:'present',field:'employeeName'},then:[],otherwise:[]};recursive.then.push(recursive);expect(()=>validateLetterDocument({...document,blocks:[recursive]},fields)).toThrow('invalid: cyclic document');
  const text={type:'text' as const,text:'Repeated'};expect(validateLetterDocument({...document,blocks:[{type:'paragraph',content:[text,text]}]},fields).blocks).toHaveLength(1);
 });
});
