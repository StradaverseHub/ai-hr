/** The editor is a consumer of the canonical letter vocabulary. Neither HTML nor editor JSON is persisted. */
import {assertLetterStructureBound,validateLetterDocument,LetterModelError,type LetterDocument,type LetterBlock,type LetterInline,type LetterField} from './letter-model';
export type LetterEditorNode={type:string;text?:string;attrs?:Record<string,unknown>;marks?:{type:string}[];content?:LetterEditorNode[]};
type ObjectValue=Record<string,unknown>;
const bad=(path:string):never=>{throw new LetterModelError('invalid','editor.'+path);};
function object(input:unknown,path:string):ObjectValue{if(!input||typeof input!=='object'||Array.isArray(input))return bad(path);const prototype=Object.getPrototypeOf(input);if(prototype!==null&&prototype!==Object.prototype)return bad(path);return input as ObjectValue;}
function keys(input:ObjectValue,allowed:string[],path:string){if(Object.keys(input).some(key=>!allowed.includes(key)))bad(path);}
function children(input:ObjectValue):unknown[]{if(input.content===undefined)return [];if(!Array.isArray(input.content))return bad('content');return input.content;}
function attributes(input:ObjectValue,allowed:string[]):ObjectValue{const value=input.attrs===undefined?{}:object(input.attrs,'attributes');keys(value,allowed,'attributes');return value;}
function node(input:unknown):ObjectValue{const value=object(input,'node');keys(value,['type','text','attrs','marks','content'],'node');if(typeof value.type!=='string')bad('type');return value;}
function marks(input:ObjectValue):('bold'|'italic'|'underline')[]|undefined{
 if(input.marks===undefined)return undefined;if(!Array.isArray(input.marks))return bad('marks');
 return input.marks.map(item=>{const value=object(item,'mark');keys(value,['type','attrs'],'mark');if(value.attrs!==undefined)keys(object(value.attrs,'mark'),[],'mark');if(!['bold','italic','underline'].includes(String(value.type)))return bad('mark');return value.type as 'bold'|'italic'|'underline';});
}
function inline(input:unknown[]):LetterInline[]{
 const output:LetterInline[]=[];
 for(const value of input){const item=node(value),style=marks(item);if(children(item).length)bad('inlineChildren');
  if(item.type==='text'){attributes(item,[]);if(typeof item.text!=='string')bad('text');output.push({type:'text',text:item.text as string,...(style?.length?{marks:style}:{})});}
  else if(item.type==='hardBreak'){attributes(item,[]);if(item.text!==undefined)bad('text');output.push({type:'text',text:'\n',...(style?.length?{marks:style}:{})});}
  else if(item.type==='letterField'){const attrs=attributes(item,['key']);if(typeof attrs.key!=='string'||item.text!==undefined)bad('field');output.push({type:'field',key:attrs.key as string,...(style?.length?{marks:style}:{})});}
  else bad('inline');
 }
 // Preserve literal line breaks as canonical text, independent of the editor's hard-break representation.
 return output.reduce<LetterInline[]>((result,item)=>{const last=result.at(-1);if(last?.type==='text'&&item.type==='text'&&JSON.stringify(last.marks??[])===JSON.stringify(item.marks??[]))last.text+=item.text;else result.push(item);return result;},[]);
}
function paragraphs(input:unknown[]):LetterInline[]{
 const output:LetterInline[]=[];for(const [index,value]of input.entries()){const item=node(value);if(item.type!=='paragraph'||item.text!==undefined||item.marks!==undefined)bad('cellParagraph');attributes(item,[]);if(index)output.push({type:'text',text:'\n\n'});output.push(...inline(children(item)));}return output;
}
function blocks(input:unknown[]):LetterBlock[]{return input.map((value):LetterBlock=>{
 const item=node(value);if(item.text!==undefined||item.marks!==undefined)bad('block');const content=children(item);
 if(item.type==='paragraph'){attributes(item,[]);return {type:'paragraph',content:inline(content)};}
 if(item.type==='heading'){const attrs=attributes(item,['level']);if(![1,2,3].includes(Number(attrs.level)))return bad('heading');return {type:'heading',level:attrs.level as 1|2|3,content:inline(content)};}
 if(item.type==='bulletList'||item.type==='orderedList'){
  const attrs=attributes(item,item.type==='orderedList'?['start','type']:[]);if(attrs.start!==undefined&&attrs.start!==1||attrs.type!==undefined&&attrs.type!==null)bad('listNumbering');
  return {type:'list',ordered:item.type==='orderedList',items:content.map(value=>{const entry=node(value);if(entry.type!=='listItem'||entry.marks!==undefined||entry.text!==undefined)bad('listItem');attributes(entry,[]);return paragraphs(children(entry));})};
 }
 if(item.type==='table'){attributes(item,[]);return {type:'table',rows:content.map(value=>{const row=node(value);if(row.type!=='tableRow'||row.marks!==undefined||row.text!==undefined)bad('tableRow');attributes(row,[]);return children(row).map(value=>{
  const cell=node(value);if(!['tableCell','tableHeader'].includes(String(cell.type))||cell.text!==undefined||cell.marks!==undefined)bad('tableCell');const attrs=attributes(cell,['colspan','rowspan','colwidth','align']);if(attrs.colspan!==undefined&&attrs.colspan!==1||attrs.rowspan!==undefined&&attrs.rowspan!==1||attrs.colwidth!==undefined&&attrs.colwidth!==null||attrs.align!==undefined&&attrs.align!==null)bad('mergedOrSizedCell');
  const content=paragraphs(children(cell));return cell.type==='tableHeader'?content.map(value=>({...value,marks:[...new Set([...(value.marks??[]),'bold' as const])]})):content;
 });})};}
 if(item.type==='letterConditional'){
  const attrs=attributes(item,['condition']);if(content.length!==2)bad('branches');
  const branch=(value:unknown,expected:string)=>{const child=node(value);if(child.type!=='letterBranch'||child.marks!==undefined||child.text!==undefined)bad('branch');const attrs=attributes(child,['branch']);if(attrs.branch!==expected)bad('branch');const result=blocks(children(child));return result.length===1&&result[0].type==='paragraph'&&result[0].content.length===0?[]:result;};
  return {type:'if',condition:attrs.condition as Extract<LetterBlock,{type:'if'}>['condition'],then:branch(content[0],'then'),otherwise:branch(content[1],'otherwise')};
 }
 return bad('unsupportedBlock');
});}
export function letterDocumentFromEditor(input:unknown,fields:LetterField[],language:LetterDocument['language']):LetterDocument{
 assertLetterStructureBound(input);const root=node(input);if(root.type!=='doc'||root.text!==undefined||root.marks!==undefined)bad('document');attributes(root,[]);return validateLetterDocument({version:1,language,blocks:blocks(children(root))},fields);
}
function editorInline(input:LetterInline[]):LetterEditorNode[]{return input.flatMap((item):LetterEditorNode[]=>{
 const marks=item.marks?.map(type=>({type}));if(item.type==='field')return [{type:'letterField',attrs:{key:item.key},...(marks?.length?{marks}:{})}];
 return item.text.split('\n').flatMap((text,index)=>[...(index?[{type:'hardBreak',...(marks?.length?{marks}:{})}]:[]),...(text?[{type:'text',text,...(marks?.length?{marks}:{})}]:[])]);
});}
function editorBlocks(input:LetterBlock[]):LetterEditorNode[]{return input.map((block):LetterEditorNode=>{
 if(block.type==='paragraph')return {type:'paragraph',content:editorInline(block.content)};
 if(block.type==='heading')return {type:'heading',attrs:{level:block.level},content:editorInline(block.content)};
 if(block.type==='list')return {type:block.ordered?'orderedList':'bulletList',...(block.ordered?{attrs:{start:1,type:null}}:{}),content:block.items.map(content=>({type:'listItem',content:[{type:'paragraph',content:editorInline(content)}]}))};
 if(block.type==='table')return {type:'table',content:block.rows.map(row=>({type:'tableRow',content:row.map(content=>({type:'tableCell',attrs:{colspan:1,rowspan:1,colwidth:null,align:null},content:[{type:'paragraph',content:editorInline(content)}]}))}))};
 return {type:'letterConditional',attrs:{condition:block.condition},content:[{type:'letterBranch',attrs:{branch:'then'},content:block.then.length?editorBlocks(block.then):[{type:'paragraph'}]},{type:'letterBranch',attrs:{branch:'otherwise'},content:block.otherwise.length?editorBlocks(block.otherwise):[{type:'paragraph'}]}]};
});}
export function letterDocumentToEditor(document:LetterDocument,fields:LetterField[]):LetterEditorNode{
 const valid=validateLetterDocument(document,fields);return {type:'doc',content:editorBlocks(valid.blocks)};
}
