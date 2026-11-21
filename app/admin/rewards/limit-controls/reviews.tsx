'use client';
/** Board fc804e8c: the reward year's reviews and the version each uses. Draft reviews follow the current version;
 * reviews past Draft keep theirs. Group Rewards may explicitly apply the current version to reviews in the approval
 * route: they are rechecked and their current approver is told. */
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import {ReviewBeforeSavingDialog} from '../review-before-saving';
import {rewardLimitReapplicableStages,type RewardLimitReviewStage} from '@/packs/rewards/limit-controls-model';
import {previewReapplyAction,reapplyAction,type LimitReview} from './actions';

export function LimitControlReviews({year,revision,canEdit,reviews,truncated}:{year:number;revision:number|null;canEdit:boolean;reviews:RewardLimitReviewStage[];truncated:boolean}){
 const t=useTranslations('rewardLimits'),stages=useTranslations('rewards.stages'),router=useRouter(),[pending,start]=useTransition();
 const [selected,setSelected]=useState<string[]>([]),[review,setReview]=useState<(LimitReview&{ids:string[]})|null>(null),[error,setError]=useState(''),[applied,setApplied]=useState<number|null>(null);
 const eligible=(r:RewardLimitReviewStage)=>canEdit&&revision!==null&&(rewardLimitReapplicableStages as readonly string[]).includes(r.stage)&&r.pinnedRevision!==revision;
 const usedVersion=(r:RewardLimitReviewStage)=>r.stage==='draft'?(revision===null?t('baseline'):t('currentVersion',{version:revision})):r.pinnedRevision!==null?t('version',{version:r.pinnedRevision}):t('baseline');
 const preview=()=>{if(revision===null)return;setError('');setApplied(null);const ids=[...selected];start(async()=>{const result=await previewReapplyAction(year,revision,ids);if(result.review)setReview({...result.review,ids});else setError(result.error);});};
 const confirm=(reason:string,digest:string)=>{if(!review||revision===null)return;const ids=review.ids;start(async()=>{const result=await reapplyAction(year,revision,ids,reason,digest);
  if(result.ok){setReview(null);setSelected([]);setApplied(result.applied??0);router.refresh();}else{setError(result.error);if(result.review)setReview({...result.review,ids});}});};
 if(!reviews.length)return<p className="text-sm text-muted-foreground">{t('noReviews')}</p>;
 return<div className="space-y-3">
  <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{canEdit&&<th scope="col" className={thCls}><span className="sr-only">{t('select')}</span></th>}{['review','stage','versionUsed'].map(k=><th key={k} scope="col" className={thCls}>{t(`reviewColumns.${k}`)}</th>)}</tr></thead>
   <tbody className={tbodyCls}>{reviews.map(r=><tr key={r.reviewId}>
    {canEdit&&<td className="px-3 py-2">{eligible(r)&&<input type="checkbox" aria-label={t('selectReview',{review:r.label})} checked={selected.includes(r.reviewId)} onChange={e=>{const on=e.target.checked;setSelected(list=>on?[...list,r.reviewId]:list.filter(id=>id!==r.reviewId));}}/>}</td>}
    <th scope="row" className="px-3 py-2 text-left font-normal">{r.label}</th><td className="px-3 py-2">{stages(r.stage)}</td><td className="px-3 py-2">{usedVersion(r)}</td></tr>)}</tbody></table></div>
  {truncated&&<p className="text-xs text-muted-foreground">{t('reviewsTruncated')}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {applied!==null&&<p role="status" className="text-sm">{t('applied',{count:applied})}</p>}
  {canEdit&&revision!==null&&<Button type="button" disabled={!selected.length||pending} aria-busy={pending} onClick={preview}>{t('apply',{version:revision})}</Button>}
  <ReviewBeforeSavingDialog open={!!review} summary={review?.summary??null} digest={review?.digest??null} error={review?error:undefined} pending={pending} submitLabel={t('applyConfirm')} onClose={()=>setReview(null)} onConfirm={confirm}/>
 </div>;
}
