import {it,expect,afterEach} from 'vitest';
import {Editor} from '@tiptap/core';
import {letterEditorExtensions} from '../lib/letter-editor-extensions';
import {letterDocumentFromEditor,letterDocumentToEditor} from '../lib/letter-editor';
import {sanitiseLetterPaste} from '../lib/letter-editor-paste';
import type {LetterDocument,LetterField} from '../lib/letter-model';
const fields:LetterField[]=[{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false}];
const labels={conditional:'Conditional block',then:'When true',otherwise:'Otherwise'};
const editors:Editor[]=[];
function editor(content:LetterDocument|string){const value=new Editor({element:document.createElement('div'),extensions:letterEditorExtensions(labels),content:typeof content==='string'?content:letterDocumentToEditor(content,fields)});editors.push(value);return value;}
afterEach(()=>{editors.splice(0).forEach(value=>value.destroy());});
const letter:LetterDocument={version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear ',marks:['bold','italic','underline']},{type:'field',key:'employeeName'}]},{type:'if',condition:{type:'present',field:'employeeName'},then:[{type:'paragraph',content:[{type:'text',text:'Welcome'}]}],otherwise:[]},{type:'table',rows:[[[{type:'text',text:'A'}],[{type:'field',key:'employeeName'}]]]},{type:'list',ordered:true,items:[[{type:'text',text:'Review'}]]}]};
it('preserves formatting, atomic fields, table cells and both condition branches through the actual editor schema',()=>{
 const value=editor(letter);expect(letterDocumentFromEditor(value.getJSON(),fields,'en')).toEqual(letter);
 const field=value.schema.nodes.letterField;expect(field.isInline).toBe(true);expect(field.isAtom).toBe(true);
});
it('round trips copied condition markup without saving visual branch captions or remote resources',()=>{
 const original=editor(letter),copied=editor(sanitiseLetterPaste(original.getHTML()));expect(letterDocumentFromEditor(copied.getJSON(),fields,'en')).toEqual(letter);
 expect(JSON.stringify(copied.getJSON())).not.toContain('When true');expect(JSON.stringify(copied.getJSON())).not.toContain('Otherwise');
});
it('keeps table row and column commands within the canonical document contract',()=>{
 const value=editor({version:1,language:'en',blocks:[{type:'paragraph',content:[]}]});
 expect(value.commands.insertTable({rows:2,cols:2,withHeaderRow:false})).toBe(true);
 expect(value.commands.addRowAfter()).toBe(true);expect(value.commands.addColumnAfter()).toBe(true);
 const result=letterDocumentFromEditor(value.getJSON(),fields,'en'),table=result.blocks.find(block=>block.type==='table');expect(table?.type).toBe('table');if(table?.type!=='table')throw new Error('Missing table');expect(table.rows).toHaveLength(3);expect(table.rows.every(row=>row.length===3)).toBe(true);
 expect(value.commands.deleteColumn()).toBe(true);expect(value.commands.deleteRow()).toBe(true);expect(()=>letterDocumentFromEditor(value.getJSON(),fields,'en')).not.toThrow();
});
