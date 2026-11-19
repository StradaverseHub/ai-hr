/** V9 stores plain strings per block/cell. Reuse Contract inline atoms without persisting editor JSON. */
import {letterInlineFromEditor,letterInlineToEditor,type LetterEditorNode} from './letter-editor';
import type {LetterInline} from './letter-model';
export function letterInlineStringParts(value:string,labels:ReadonlyMap<string,string>):{content:LetterInline[];unknown:string[]}{
 const aliases=new Map<string,string|null>();for(const[key,label]of labels){aliases.set(key,key);if(!aliases.has(label))aliases.set(label,key);else if(aliases.get(label)!==key)aliases.set(label,null);}
 const content:LetterInline[]=[],unknown:string[]=[];let cursor=0;
 for(const match of value.matchAll(/\{([^{}\n]+)\}/g)){
  const index=match.index!,raw=match[0],key=labels.has(match[1])?match[1]:aliases.get(match[1]);
  if(index>cursor)content.push({type:'text',text:value.slice(cursor,index)});
  if(key&&value[index-1]!=='{'&&value[index+raw.length]!=='}')content.push({type:'field',key});
  else {content.push({type:'text',text:raw});unknown.push(raw);}
  cursor=index+raw.length;
 }
 if(cursor<value.length)content.push({type:'text',text:value.slice(cursor)});
 return {content,unknown:[...new Set(unknown)]};
}
export function letterInlineStringToEditor(value:string,labels:ReadonlyMap<string,string>):LetterEditorNode{
 return {type:'doc',content:[{type:'paragraph',content:letterInlineToEditor(letterInlineStringParts(value,labels).content)}]};
}
/** No rich styles, extra paragraphs, arbitrary atoms or cell delimiters can leak into the V9 string model. */
export function letterInlineStringFromEditor(input:unknown,labels:ReadonlyMap<string,string>,cell=false):string{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('inlineDocument');
 const json=input as LetterEditorNode;
 if(Object.keys(json).some(key=>!['type','content'].includes(key))||json.type!=='doc'||json.marks?.length||json.attrs&&Object.keys(json.attrs).length||json.text!==undefined||!Array.isArray(json.content)||json.content.length!==1)throw Error('inlineDocument');
 const paragraph=json.content[0];if(paragraph.type!=='paragraph'||paragraph.marks?.length||paragraph.attrs&&Object.keys(paragraph.attrs).length||paragraph.text!==undefined)throw Error('inlineParagraph');
 const parts=letterInlineFromEditor(paragraph.content??[]);
 if(parts.some(part=>part.marks?.length||part.type==='field'&&!labels.has(part.key)))throw Error('inlineFieldOrFormat');
 const raw=parts.map(part=>part.type==='field'?'{'+part.key+'}':part.text).join('');
 const value=letterInlineStringParts(raw,labels).content.map(part=>part.type==='field'?'{'+part.key+'}':part.text).join('');
 if(value.length>20000||cell&&/[|\r\n]/.test(value))throw Error('inlineBound');return value;
}
