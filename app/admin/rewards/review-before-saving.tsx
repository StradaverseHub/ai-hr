'use client';
/** Board 60f1fdcd: the shared "Review before saving" dialog for high-impact Rewards configuration changes.
 *
 * The server computes the summary and its digest (packs/rewards/config-change). This dialog shows what changes from
 * old to new, the reviews it reaches and what happens to them, and asks for the reason. The save carries the
 * reviewed digest; the command recomputes the summary and refuses when it changed. A native modal <dialog> keeps
 * focus inside while open, closes on Escape and fills the screen on a phone. */
import {useEffect,useRef,type ReactNode} from 'react';
import {useFormStatus} from 'react-dom';
import {useTranslations} from 'next-intl';
import {Button,Field,inputCls} from '@/components/ui';
import type {RewardConfigSummary} from '@/packs/rewards/config-change-model';

function Submit({label}:{label:string}){const {pending}=useFormStatus();const t=useTranslations('rewardConfig');return<Button type="submit" disabled={pending} aria-busy={pending}>{pending?t('saving'):label}</Button>;}

export function RewardChangeSummary({summary}:{summary:RewardConfigSummary}){
 const t=useTranslations('rewardConfig');
 return<div className="space-y-4 text-sm">
  {summary.highImpact.length>0&&<ul className="space-y-1" aria-label={t('whyReview')}>{summary.highImpact.map(reason=><li key={reason} className="rounded-md bg-primary/10 px-3 py-2 text-foreground">{t(`highImpact.${reason}`)}</li>)}</ul>}
  <section className="space-y-2"><h3 className="font-medium">{t('whatChanges',{count:summary.changedCount})}</h3>
   {summary.lines.length?<div className="max-h-64 overflow-auto rounded-md border border-border"><table className="w-full text-sm"><thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t('item')}</th><th className="px-3 py-2 font-medium">{t('before')}</th><th className="px-3 py-2 font-medium">{t('after')}</th></tr></thead>
    <tbody className="divide-y divide-border">{summary.lines.map(line=><tr key={line.key}><th scope="row" className="px-3 py-2 text-left font-normal">{line.label}</th><td className="px-3 py-2 tabular-nums text-muted-foreground">{line.before??'—'}</td><td className="px-3 py-2 tabular-nums font-medium">{line.after??'—'}</td></tr>)}</tbody></table></div>
    :<p className="text-muted-foreground">{t('noValueChanges')}</p>}
   {summary.changedCount>summary.lines.length&&<p className="text-xs text-muted-foreground">{t('moreLines',{count:summary.changedCount-summary.lines.length})}</p>}
  </section>
  <section className="space-y-2"><h3 className="font-medium">{t('affected',{count:summary.affected.length})}</h3>
   {summary.affected.length?<ul className="max-h-48 space-y-1 overflow-auto">{summary.affected.map(review=><li key={review.reviewId} className="flex flex-wrap justify-between gap-2 rounded-md border border-border px-3 py-2"><span>{review.label}</span><span className="text-muted-foreground">{t(`consequence.${review.consequence}`)}</span></li>)}</ul>
    :<p className="text-muted-foreground">{t('noReviewsAffected')}</p>}
  </section>
 </div>;
}

/** A trigger button and its dialog. `children` are the form's hidden fields; the dialog adds the digest and reason. */
export function ReviewBeforeSaving({summary,digest,action,children,triggerLabel,submitLabel,disabled,defaultReason,reasonRequired=true}:{
 summary:RewardConfigSummary;digest:string;action:(form:FormData)=>void|Promise<void>;children?:ReactNode;triggerLabel:string;submitLabel:string;disabled?:boolean;defaultReason?:string;reasonRequired?:boolean;
}){
 const t=useTranslations('rewardConfig'),dialog=useRef<HTMLDialogElement>(null);
 return<>
  <Button type="button" disabled={disabled} onClick={()=>dialog.current?.showModal()}>{triggerLabel}</Button>
  <dialog ref={dialog} aria-labelledby="reward-review-title" className="m-0 h-full max-h-none w-full max-w-none overflow-auto bg-card p-0 text-foreground backdrop:bg-black/40 sm:m-auto sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg">
   <form action={action} className="space-y-5 p-5">
    {children}<input type="hidden" name="summaryDigest" value={digest}/>
    <header className="space-y-1"><h2 id="reward-review-title" className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{summary.itemLabel}</p></header>
    <RewardChangeSummary summary={summary}/>
    <Field label={t('reason')}><textarea name="reason" required={reasonRequired} minLength={10} maxLength={2000} defaultValue={defaultReason} className={inputCls+' min-h-20'}/></Field>
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={()=>dialog.current?.close()}>{t('cancel')}</Button><Submit label={submitLabel}/></div>
   </form>
  </dialog>
 </>;
}

/** The same dialog driven by the caller (client pages that fetch the summary first, such as the PAT grid). */
export function ReviewBeforeSavingDialog({open,summary,digest,onClose,onConfirm,submitLabel,pending,error}:{
 open:boolean;summary:RewardConfigSummary|null;digest:string|null;onClose:()=>void;onConfirm:(reason:string,digest:string)=>void;submitLabel:string;pending?:boolean;error?:string;
}){
 const t=useTranslations('rewardConfig'),dialog=useRef<HTMLDialogElement>(null),reason=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{const d=dialog.current;if(!d)return;if(open&&!d.open)d.showModal();if(!open&&d.open)d.close();},[open]);
 return<dialog ref={dialog} onClose={onClose} aria-labelledby="reward-review-dialog-title" className="m-0 h-full max-h-none w-full max-w-none overflow-auto bg-card p-0 text-foreground backdrop:bg-black/40 sm:m-auto sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg">
  {summary&&digest&&<form className="space-y-5 p-5" onSubmit={event=>{event.preventDefault();onConfirm(reason.current?.value??'',digest);}}>
   <header className="space-y-1"><h2 id="reward-review-dialog-title" className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{summary.itemLabel}</p></header>
   <RewardChangeSummary summary={summary}/>
   <Field label={t('reason')}><textarea ref={reason} name="reason" required minLength={10} maxLength={2000} className={inputCls+' min-h-20'}/></Field>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button><Button type="submit" disabled={pending} aria-busy={pending}>{pending?t('saving'):submitLabel}</Button></div>
  </form>}
 </dialog>;
}
