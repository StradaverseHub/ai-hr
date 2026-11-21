'use client';
import {useEffect,useMemo,useState} from 'react';
import {useTranslations} from 'next-intl';
import {LetterInlineEditor} from '@/components/letters/inline-editor';
import {offboardingMergeLabels} from '@/lib/lifecycle-v9-resignation-fields';
import type {Block,Field} from '@/lib/lifecycle-v9-model';
const EMPTY_FIELDS:Field[]=[];
// An empty one-column row needs a whitespace sentinel; an empty array still means no rows.
const serializeRows=(rows:string[][])=>rows.map(row=>row.join(' | ')||' ').join('\n');
/** One editor per existing block/cell. Letterhead, signature and form field structure remain protected. */
export function ResignationBlockEditor({blocks,onChange,busy,fields=EMPTY_FIELDS,onValidityChange}:{blocks:Block[];onChange:(blocks:Block[])=>void;busy:boolean;fields?:Field[];onValidityChange?:(valid:boolean)=>void}){
 const t=useTranslations('resignationJourney'),[invalid,setInvalid]=useState<Record<string,boolean>>({}),[tableGenerations,setTableGenerations]=useState<Record<string,number>>({});
 const fieldLabels=useMemo(()=>new Map([...offboardingMergeLabels,...fields.map(field=>[field.pmKey??field.id,field.label] as const)]),[fields]);
 const valid=!Object.values(invalid).some(Boolean);useEffect(()=>{onValidityChange?.(valid);},[valid,onValidityChange]);
 const update=(id:string,patch:Partial<Block>)=>onChange(blocks.map(b=>b.id===id?{...b,...patch}:b));
 const columns=(b:Block)=>(b.columns??'').split('|').map(x=>x.trim());
 const rows=(b:Block)=>(b.rows??'').split('\n').filter(Boolean).map(row=>row.split('|').map(x=>x.trim()));
 const editor=(key:string,value:string,label:string,change:(value:string)=>void,cell=false)=><LetterInlineEditor key={key} value={value} label={label} fields={fieldLabels} disabled={busy} cell={cell} onChange={change} onValidityChange={next=>setInvalid(previous=>previous[key]===!next?previous:{...previous,[key]:!next})} copy={{field:t('insertMergeField'),unknown:t('unknownMergeField'),invalid:t('invalidInlineEdit')}}/>;
 return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('editForCase')}</p>{blocks.map((block,index)=>{
  if(['letterhead','signature','field','fields'].includes(block.type))return <p key={block.id} className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{index+1}. {t('readOnlyBlock')}</p>;
  if(block.type==='table'){const cs=columns(block),rs=rows(block);return <fieldset key={block.id} className="min-w-0 space-y-2 rounded-lg border p-3" disabled={busy}><legend className="px-1 text-sm font-medium">{t('tableRows')}</legend><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{cs.map((c,i)=><th className="min-w-48 p-1 text-left align-top" key={i}>{editor(`${block.id}:${tableGenerations[block.id]??0}:header:${i}`,c,`${t('tableHeader')} ${i+1}`,next=>update(block.id,{columns:cs.map((v,j)=>j===i?next:v).join(' | ')}),true)}</th>)}<th/></tr></thead><tbody>{rs.map((row,i)=><tr key={i}>{cs.map((c,j)=><td className="p-1 align-top" key={j}>{editor(`${block.id}:${tableGenerations[block.id]??0}:cell:${i}:${j}`,row[j]??'',`${c}, ${t('row',{number:i+1})}`,value=>{const next=rs.map(r=>r.slice());next[i][j]=value;update(block.id,{rows:serializeRows(next)});},true)}</td>)}<td><button className="v9-button" type="button" disabled={!valid} onClick={()=>{setInvalid(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!key.startsWith(block.id+':'))));setTableGenerations(previous=>({...previous,[block.id]:(previous[block.id]??0)+1}));update(block.id,{rows:serializeRows(rs.filter((_,k)=>k!==i))});}}>{t('removeRow',{number:i+1})}</button></td></tr>)}</tbody></table></div><button className="v9-button" type="button" disabled={!valid||rs.length>=50} onClick={()=>update(block.id,{rows:serializeRows([...rs,cs.map(()=> '')])})}>{t('addRow')}</button></fieldset>}
  return editor(block.id,block.text,`${index+1}. ${t(block.type==='text'?'text':'heading')}`,text=>update(block.id,{text}));
 })}</div>;
}
