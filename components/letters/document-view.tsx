import type {ReactNode} from 'react';
import type {LetterBlock,LetterCondition,LetterDocument,LetterInline} from '@/lib/letter-model';
import type {LetterEditorLabels} from './rich-editor';
/** Read-only structured preview. No HTML is injected and no employee data is fetched here. */
export function LetterDocumentView({document,labels}:{document:LetterDocument;labels:LetterEditorLabels}){
 function inline(items:LetterInline[]):ReactNode{return items.map((item,index)=>{let value:ReactNode=item.type==='text'?item.text:<span className="rounded bg-muted px-1 font-mono text-xs">{'{{'+item.key+'}}'}</span>;for(const mark of item.marks??[])value=mark==='bold'?<strong>{value}</strong>:mark==='italic'?<em>{value}</em>:<u>{value}</u>;return <span key={index} className="whitespace-pre-wrap break-words">{value}</span>;});}
 function condition(value:LetterCondition):string{
  if('conditions' in value)return labels.condition[value.type]+' ('+value.conditions.map(condition).join('; ')+')';
  if(value.type==='not')return labels.condition.not+' ('+condition(value.condition)+')';
  return value.field+' '+labels.condition[value.type]+('value' in value?' '+(value.value.kind==='currency'?value.value.currency+' ':'')+value.value.value:'');
 }
 function blocks(items:LetterBlock[]):ReactNode{return items.map((block,index)=>{
  if(block.type==='paragraph')return <p key={index} className="min-h-6">{inline(block.content)}</p>;
  if(block.type==='heading'){const Heading=block.level===1?'h2':block.level===2?'h3':'h4';return <Heading key={index} className={block.level===1?'text-2xl font-semibold':block.level===2?'text-xl font-semibold':'text-lg font-semibold'}>{inline(block.content)}</Heading>;}
  if(block.type==='list'){const List=block.ordered?'ol':'ul';return <List key={index} className={block.ordered?'list-decimal space-y-2 pl-6':'list-disc space-y-2 pl-6'}>{block.items.map((item,position)=><li key={position}>{inline(item)}</li>)}</List>;}
  if(block.type==='table')return <div key={index} className="overflow-x-auto"><table className="w-full border-collapse text-sm"><tbody>{block.rows.map((row,position)=><tr key={position}>{row.map((cell,column)=><td key={column} className="min-w-24 border p-2 align-top">{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
  return <section key={index} className="space-y-3 rounded-md border border-dashed p-4"><p className="break-words text-sm font-medium">{labels.conditional}: {condition(block.condition)}</p><div className="space-y-3 border-l-2 pl-3"><p className="text-xs font-medium text-muted-foreground">{labels.then}</p>{blocks(block.then)}</div><div className="space-y-3 border-l-2 pl-3"><p className="text-xs font-medium text-muted-foreground">{labels.otherwise}</p>{blocks(block.otherwise)}</div></section>;
 });}
 return <article lang={document.language} className="min-w-0 space-y-4 leading-relaxed">{blocks(document.blocks)}</article>;
}
