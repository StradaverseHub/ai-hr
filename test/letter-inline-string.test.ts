import {expect,it} from 'vitest';
import {letterInlineStringParts,letterInlineStringFromEditor,letterInlineStringToEditor} from '../lib/letter-inline-string';
const labels=new Map([['employee.name','Full name'],['resignation.lastDay','Last working day']]);
it('uses the Contract inline field vocabulary while saving canonical V9 single-brace keys and literal newlines',()=>{
 const json=letterInlineStringToEditor('Dear {Full name},\nYour last day is {resignation.lastDay}.',labels);
 expect(json.content?.[0].content).toEqual([{type:'text',text:'Dear '},{type:'letterField',attrs:{key:'employee.name'}},{type:'text',text:','},{type:'hardBreak'},{type:'text',text:'Your last day is '},{type:'letterField',attrs:{key:'resignation.lastDay'}},{type:'text',text:'.'}]);
 expect(letterInlineStringFromEditor(json,labels)).toBe('Dear {employee.name},\nYour last day is {resignation.lastDay}.');
});
it('preserves unknown and double-brace tokens literally and warns instead of inventing HR values',()=>{
 const text='Dear {unknown.value} {{employee.name}}';const parsed=letterInlineStringParts(text,labels);
 expect(parsed.unknown).toEqual(['{unknown.value}','{employee.name}']);expect(letterInlineStringFromEditor(letterInlineStringToEditor(text,labels),labels)).toBe(text);
});
it('does not ambiguously convert duplicate labels or reinterpret an existing canonical key',()=>{
 const ambiguous=new Map([['a','Same'],['b','Same'],['employee.name','a']]);expect(letterInlineStringFromEditor(letterInlineStringToEditor('{Same} {a}',ambiguous),ambiguous)).toBe('{Same} {a}');expect(letterInlineStringParts('{Same}',ambiguous).unknown).toEqual(['{Same}']);
});
it('rejects unsupported rich formatting, additional paragraphs, unknown atoms, cell delimiters and oversized values',()=>{
 const bad=[{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Bold',marks:[{type:'bold'}]}]}]},{type:'doc',content:[{type:'paragraph'},{type:'paragraph'}]},{type:'doc',content:[{type:'paragraph',content:[{type:'letterField',attrs:{key:'unknown'}}]}]},{type:'doc',content:[{type:'heading',attrs:{level:1},content:[]}]}];
 for(const value of bad)expect(()=>letterInlineStringFromEditor(value,labels)).toThrow();
 for(const text of ['One|Two','One\nTwo'])expect(()=>letterInlineStringFromEditor(letterInlineStringToEditor(text,labels),labels,true)).toThrow();
 expect(()=>letterInlineStringFromEditor(letterInlineStringToEditor('a'.repeat(20001),labels),labels)).toThrow();
});
