'use client';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {Block} from '@/lib/lifecycle-v9-model';
/** The existing V9 block vocabulary remains authoritative. Letterhead and signature blocks are protected. */
export function ResignationBlockEditor({blocks,onChange,busy}:{blocks:Block[];onChange:(blocks:Block[])=>void;busy:boolean}){
 const t=useTranslations('resignationJourney');
 const update=(id:string,patch:Partial<Block>)=>onChange(blocks.map(b=>b.id===id?{...b,...patch}:b));
 const columns=(b:Block)=>(b.columns??'').split('|').map(x=>x.trim());
 const rows=(b:Block)=>(b.rows??'').split('\n').filter(Boolean).map(row=>row.split('|').map(x=>x.trim()));
 return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('editForCase')}</p>{blocks.map((block,index)=>{
  if(['letterhead','signature','field','fields'].includes(block.type))return <p key={block.id} className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{index+1}. {t('readOnlyBlock')}</p>;
  if(block.type==='table'){const cs=columns(block),rs=rows(block);return <fieldset key={block.id} className="space-y-2 rounded-lg border p-3" disabled={busy}><legend className="px-1 text-sm font-medium">{t('tableRows')}</legend><label className="block space-y-1 text-sm"><span>{t('tableHeader')}</span><input className={inputCls} value={block.columns??''} onChange={e=>update(block.id,{columns:e.target.value})}/></label><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{cs.map((c,i)=><th className="p-1 text-left" key={i}>{c}</th>)}<th/></tr></thead><tbody>{rs.map((row,i)=><tr key={i}>{cs.map((c,j)=><td className="p-1" key={j}><input className={inputCls} aria-label={`${c}, ${t('row',{number:i+1})}`} value={row[j]??''} onChange={e=>{const next=rs.map(r=>r.slice());next[i][j]=e.target.value;update(block.id,{rows:next.map(r=>r.join(' | ')).join('\n')});}}/></td>)}<td><button className="v9-button" type="button" onClick={()=>update(block.id,{rows:rs.filter((_,k)=>k!==i).map(r=>r.join(' | ')).join('\n')})}>{t('removeRow',{number:i+1})}</button></td></tr>)}</tbody></table></div><button className="v9-button" type="button" disabled={rs.length>=50} onClick={()=>update(block.id,{rows:[...rs,cs.map(()=> '')].map(r=>r.join(' | ')).join('\n')})}>{t('addRow')}</button></fieldset>}
  return <label key={block.id} className="block space-y-1 text-sm"><span>{index+1}. {t(block.type==='text'?'text':'heading')}</span>{block.type==='text'?<textarea className={inputCls} rows={5} maxLength={20000} disabled={busy} value={block.text} onChange={e=>update(block.id,{text:e.target.value})}/>:<input className={inputCls} maxLength={20000} disabled={busy} value={block.text} onChange={e=>update(block.id,{text:e.target.value})}/>}</label>;
 })}</div>;
}
