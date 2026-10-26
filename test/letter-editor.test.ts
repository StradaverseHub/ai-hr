import {it,expect} from 'vitest';
import {letterDocumentFromEditor,letterDocumentToEditor} from '../lib/letter-editor';
import {renderLetterDocument,type LetterDocument,type LetterField} from '../lib/letter-model';
const fields:LetterField[]=[{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},{key:'allowance',label:'Allowance',description:'Configured amount',kind:'currency',source:'custom.currency',required:false,editable:true,sensitive:true}];
const document:LetterDocument={version:1,language:'en',blocks:[{type:'heading',level:2,content:[{type:'text',text:'Fictional letter',marks:['bold']}]},{type:'paragraph',content:[{type:'text',text:'Dear ',marks:['italic']},{type:'field',key:'employeeName',marks:['underline']},{type:'text',text:'\nPlease review.'}]},{type:'list',ordered:true,items:[[{type:'text',text:'First'}],[{type:'text',text:'Second',marks:['bold','italic']}]]},{type:'table',rows:[[[{type:'text',text:'Name'}],[{type:'field',key:'employeeName'}]]]},{type:'if',condition:{type:'present',field:'allowance'},then:[{type:'paragraph',content:[{type:'field',key:'allowance'}]}],otherwise:[]}]};
it('round trips supported rich content and typed conditional blocks without changing saved values',()=>{
 const before=JSON.stringify(document),editor=letterDocumentToEditor(document,fields),result=letterDocumentFromEditor(editor,fields,'en');expect(result).toEqual(document);expect(JSON.stringify(document)).toBe(before);
 expect(renderLetterDocument(result,fields,{employeeName:{kind:'text',value:'Fictional Employee'},allowance:{kind:'currency',value:'1200.50',currency:'MYR'}},{allowSensitive:true})).toEqual(renderLetterDocument(document,fields,{employeeName:{kind:'text',value:'Fictional Employee'},allowance:{kind:'currency',value:'1200.50',currency:'MYR'}},{allowSensitive:true}));
});
it('rejects unknown fields and executable, external or unsupported editor content instead of silently dropping it',()=>{
 for(const block of [{type:'html',text:'<script>alert(1)</script>'},{type:'image',attrs:{src:'https://foreign.fixture.test/track'}},{type:'paragraph',content:[{type:'text',text:'Link',marks:[{type:'link',attrs:{href:'javascript:alert(1)'}}]}]},{type:'paragraph',content:[{type:'letterField',attrs:{key:'unknownField'}}]}])expect(()=>letterDocumentFromEditor({type:'doc',content:[block]},fields,'en')).toThrow();
 expect(()=>letterDocumentFromEditor({type:'doc',content:[{type:'letterConditional',attrs:{condition:{type:'javascript',code:'true'}},content:[{type:'letterBranch',attrs:{branch:'then'},content:[]},{type:'letterBranch',attrs:{branch:'otherwise'},content:[]}]}]},fields,'en')).toThrow();
});
it('does not accept unsupported table spans, unknown attributes, altered numbering or condition branch order',()=>{
 const editor=letterDocumentToEditor(document,fields);editor.content![3].content![0].content![0].attrs!.colspan=2;expect(()=>letterDocumentFromEditor(editor,fields,'en')).toThrow('mergedOrSizedCell');
 const numbered=letterDocumentToEditor(document,fields);numbered.content![2].attrs!.start=3;expect(()=>letterDocumentFromEditor(numbered,fields,'en')).toThrow('listNumbering');
 const branches=letterDocumentToEditor(document,fields);branches.content![4].content!.reverse();expect(()=>letterDocumentFromEditor(branches,fields,'en')).toThrow('branch');
 const attributes=letterDocumentToEditor(document,fields);attributes.content![0].attrs!.onclick='alert(1)';expect(()=>letterDocumentFromEditor(attributes,fields,'en')).toThrow('attributes');
});
it('bounds recursive content before adapting it and refuses cycles',()=>{
 const recursive:any={type:'paragraph',content:[]};recursive.content.push(recursive);expect(()=>letterDocumentFromEditor({type:'doc',content:[recursive]},fields,'en')).toThrow('cyclic');
 let content:any={type:'paragraph',content:[]};for(let index=0;index<40;index++)content={type:'letterConditional',attrs:{condition:{type:'present',field:'employeeName'}},content:[content]};expect(()=>letterDocumentFromEditor({type:'doc',content:[content]},fields,'en')).toThrow('limit');
});
