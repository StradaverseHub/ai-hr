'use client';
/** Board fc804e8c: the Limit Controls table. Group Rewards edits the Value and the Type; CTRO and EC see the same table
 * read-only. Saving shows "Review before saving" (server summary, reviews reached, reason) and creates a new version. */
import {useMemo,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useFormatter,useTranslations} from 'next-intl';
import {Button,inputCls,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import {ReviewBeforeSavingDialog} from '../review-before-saving';
import {rewardLimitTypes,rewardLimitAreas,type RewardLimitArea,type RewardLimitKey,type RewardLimitType,type RewardLimitUnit,type RewardLimitVersionValues} from '@/packs/rewards/limit-controls-model';
import {previewLimitSaveAction,saveLimitAction,type LimitReview} from './actions';

export type LimitRow={key:RewardLimitKey;area:RewardLimitArea;unit:RewardLimitUnit;appliesTo:'standard'|'h'|'all';fixed:boolean;valueEditable:boolean;typeEditable:boolean;nullable:boolean;
 value:number|null;type:RewardLimitType;changedBy:string|null;changedAt:string|null};
const scale:Record<RewardLimitUnit,number>={percent:100,points:100,ratio:10000,months:10000,myr:100,grades:1,grade:1,years:1,none:1};
const step:Record<RewardLimitUnit,string>={percent:'0.01',points:'0.01',ratio:'0.01',months:'0.01',myr:'10',grades:'1',grade:'1',years:'1',none:'1'};
export const limitMessageKey=(key:string)=>key.replace(/\./g,'_');
const shown=(row:Pick<LimitRow,'unit'|'value'>)=>row.value===null?'':String(row.value/scale[row.unit]);

export function LimitControlsEditor({year,revision,canEdit,rows}:{year:number;revision:number;canEdit:boolean;rows:LimitRow[]}){
 const t=useTranslations('rewardLimits'),format=useFormatter(),router=useRouter(),[pending,start]=useTransition();
 const initial=useMemo(()=>Object.fromEntries(rows.map(r=>[r.key,{value:shown(r),type:r.type}])),[rows]);
 const [draft,setDraft]=useState<Record<string,{value:string;type:RewardLimitType}>>(initial);
 const [review,setReview]=useState<(LimitReview&{values:RewardLimitVersionValues})|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState<number|null>(null);
 const dirty=rows.some(r=>draft[r.key].value!==initial[r.key].value||draft[r.key].type!==initial[r.key].type);
 const invalid=new Set(rows.filter(r=>!r.fixed&&r.valueEditable).filter(r=>{const raw=draft[r.key].value.trim();if(!raw)return!r.nullable;const n=Number(raw);return!Number.isFinite(n)||n<0||!Number.isInteger(Math.round(n*scale[r.unit]*1000)/1000);}).map(r=>r.key));
 const stored=():RewardLimitVersionValues=>Object.fromEntries(rows.filter(r=>!r.fixed).map(r=>{const raw=draft[r.key].value.trim();return[r.key,{value:!r.valueEditable||raw===''?null:Math.round(Number(raw)*scale[r.unit]),type:draft[r.key].type}];}));
 const preview=()=>{setError('');setSaved(null);const values=stored();start(async()=>{const result=await previewLimitSaveAction(year,revision,values);if(result.review)setReview({...result.review,values});else setError(result.error);});};
 const confirm=(reason:string,digest:string)=>{if(!review)return;const values=review.values;start(async()=>{const result=await saveLimitAction(year,revision,values,reason,digest);
  if(result.ok){setReview(null);setSaved(result.revision??null);router.refresh();}else{setError(result.error);if(result.review)setReview({...result.review,values});}});};
 return<div className="space-y-4">
  {!canEdit&&<p role="note" className="rounded-md border border-border bg-muted p-3 text-sm">{t('viewOnly')}</p>}
  <p className="text-sm text-muted-foreground">{t('typeHelp')}</p>
  <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['limit','value','type','appliesTo','lastChanged'].map(k=><th key={k} scope="col" className={thCls}>{t(`columns.${k}`)}</th>)}</tr></thead>
   <tbody className={tbodyCls}>{rewardLimitAreas.map(area=>{const group=rows.filter(r=>r.area===area);if(!group.length)return null;return[
    <tr key={area}><th colSpan={5} scope="colgroup" className="bg-muted px-3 py-2 text-left font-semibold">{t(`areas.${area}`)}</th></tr>,
    ...group.map(r=>{const label=t(`labels.${limitMessageKey(r.key)}`),current=draft[r.key];return<tr key={r.key} className="align-top">
     <th scope="row" className="px-3 py-2 text-left font-normal">{label}{r.fixed&&<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t('fixed')}</span>}</th>
     <td className="px-3 py-2">{r.unit==='none'?<span className="text-muted-foreground">—</span>:canEdit&&r.valueEditable?<span className="flex items-center gap-2">
       <input aria-label={t('valueFor',{limit:label})} type="number" inputMode="decimal" min="0" step={step[r.unit]} value={current.value} placeholder={r.nullable?t('none'):undefined} aria-invalid={invalid.has(r.key)||undefined} onChange={e=>{const value=e.target.value;setDraft(d=>({...d,[r.key]:{...d[r.key],value}}));}} className={inputCls+' w-28 tabular-nums'}/>
       <span aria-hidden="true" className="text-xs text-muted-foreground">{t(`units.${r.unit}`)}</span></span>
      :<span className="tabular-nums">{r.value===null?t('none'):`${shown(r)} ${t(`units.${r.unit}`)}`}</span>}</td>
     <td className="px-3 py-2">{canEdit&&r.typeEditable&&!r.fixed?<select aria-label={t('typeFor',{limit:label})} value={current.type} onChange={e=>{const type=e.target.value as RewardLimitType;setDraft(d=>({...d,[r.key]:{...d[r.key],type}}));}} className={inputCls}>{rewardLimitTypes.map(type=><option key={type} value={type}>{t(`types.${type}`)}</option>)}</select>
      :<span>{t(`types.${r.type}`)}</span>}</td>
     <td className="px-3 py-2">{t(`appliesTo.${r.appliesTo}`)}</td>
     <td className="px-3 py-2 text-muted-foreground">{r.fixed?t('fixedHelp'):r.changedAt?t('changedBy',{name:r.changedBy??t('unknownPerson'),date:format.dateTime(new Date(r.changedAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}):t('standardValue')}</td>
    </tr>;})];})}</tbody></table></div>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {saved!==null&&<p role="status" className="text-sm">{t('saved',{version:saved})}</p>}
  {canEdit&&<div className="flex flex-wrap gap-3"><Button type="button" disabled={!dirty||invalid.size>0||pending} aria-busy={pending} onClick={preview}>{t('reviewSave')}</Button>{dirty&&<Button type="button" variant="outline" disabled={pending} onClick={()=>{setDraft(initial);setError('');}}>{t('discard')}</Button>}</div>}
  <ReviewBeforeSavingDialog open={!!review} summary={review?.summary??null} digest={review?.digest??null} error={review?error:undefined} pending={pending} submitLabel={t('save')} onClose={()=>setReview(null)} onConfirm={confirm}/>
 </div>;
}
