import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { getAssessmentFinalBands } from '@/packs/performance/service';
import { pmBands } from '@/packs/performance/onehr/model';
import { Button,ErrorBanner,Field,PageHeader,inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { cn } from '@/lib/utils';
import { finalBandsAction } from '../onehr-actions';

export async function FinalBandsView({v,error}:{v:Awaited<ReturnType<typeof getAssessmentFinalBands>>;error?:string}){
 const t=await getTranslations('onehr'),f=await getTranslations('onehr.finalBands'),id=v.session.id,open=['open','calibration'].includes(v.cycle.status);
 const fields=<><input type="hidden" name="sessionId" value={id}/><input type="hidden" name="sourceDigest" value={v.sourceDigest}/></>;
 const clear=v.rows.filter(r=>r.agreed&&!r.finalized).length,decided=v.rows.filter(r=>r.final?.performance).length,locked=v.rows.filter(r=>r.groupLockedAt).length;
 const columns='md:grid-cols-[minmax(0,1.5fr)_4rem_6rem_7rem_8rem_minmax(0,1.6fr)]';
 return <div className="mx-auto max-w-7xl space-y-5">
  <PageHeader back={{href:`/performance/${v.session.cycleId}`,label:t('back')}} title={f('title')} description={`${v.session.name} · ${v.cycle.name}`}/>
  {error&&<div role="alert"><ErrorBanner message={error}/></div>}<p className="max-w-4xl text-sm text-muted-foreground">{f('help')}</p>
  <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
   <span>{t(`groupModes.${v.session.mode}`)}{v.session.mode==='blend'&&` · ${f('weights',{bg:v.session.bgWeight,group:100-v.session.bgWeight})}`}</span>
   <span>{f('counts',{total:v.rows.length,decided,locked})}</span>
   {open&&clear>0&&<form action={finalBandsAction}>{fields}<input type="hidden" name="action" value="accept_agreed"/><ConfirmSubmit description={f('acceptConfirm',{count:clear})} variant="secondary">{f('acceptClear',{count:clear})}</ConfirmSubmit></form>}
   <a href={`/performance/assessment/calibration/${id}/final-bands`} className="text-primary hover:underline">{f('download')}</a>
   <Link href={`/performance/assessment/calibration/${id}`} className="text-primary hover:underline">{f('groupView')}</Link>
  </div>
  {open&&<details className="rounded-md border border-border px-4 py-3"><summary className="cursor-pointer text-sm font-medium">{f('configure')}</summary><form action={finalBandsAction} className="mt-4 flex flex-wrap items-end gap-4">{fields}<input type="hidden" name="revision" value={v.session.revision}/><input type="hidden" name="action" value="mode"/>
   <Field label={t('groupMode')}><select aria-label={t('groupMode')} name="mode" defaultValue={v.session.mode} className={inputCls}>{(['after','replace','blend'] as const).map(mode=><option key={mode} value={mode}>{t(`groupModes.${mode}`)}</option>)}</select></Field>
   <Field label={f('bgWeight')}><input aria-label={f('bgWeight')} name="bgWeight" type="number" required min="1" max="99" defaultValue={v.session.bgWeight} className={inputCls}/></Field><Button type="submit" variant="secondary">{t('save')}</Button><p className="basis-full text-sm text-muted-foreground">{f('weightHelp')}</p>
  </form></details>}
  {!v.rows.length?<p className="py-8 text-sm text-muted-foreground">{f('empty')}</p>:<section aria-label={f('title')} className="overflow-hidden rounded-md border border-border">
   <div className={`hidden gap-3 bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground md:grid ${columns}`}>{['person','bg','group','suggested','final','decide'].map(k=><span key={k}>{f(k)}</span>)}</div>
   {v.rows.map(r=>{
    const editable=open&&r.ready&&!r.finalized;
    return <div key={`${r.reviewId}.${v.sourceDigest}`} className={`grid gap-3 border-t border-border px-4 py-4 text-sm first:border-t-0 md:items-center md:py-3 ${columns}`}>
     <div className="min-w-0"><Link href={`/performance/assessment/${r.reviewId}`} className="font-semibold text-primary hover:underline">{r.name}</Link><p className="mt-0.5 text-xs text-muted-foreground">{[r.department,r.company,r.businessGroup].filter(Boolean).join(' · ')}</p></div>
     <div><span className="mr-2 text-xs text-muted-foreground md:sr-only">{f('bg')}</span>{r.bg??'—'}</div>
     <div><span className="mr-2 text-xs text-muted-foreground md:sr-only">{f('group')}</span>{r.group??(r.draft?f('draft',{band:r.draft}):f('notYet'))}{r.groupLockedAt&&<p className="text-xs text-muted-foreground">{f('locked')}</p>}</div>
     <div><span className="mr-2 text-xs text-muted-foreground md:sr-only">{f('suggested')}</span><b>{r.suggestion?.band??r.suggestion?.tie?.join(' / ')??'—'}</b><p className="mt-1 text-xs text-muted-foreground">{r.waiting?f(`waiting.${r.waiting}`):r.suggestion?f(`why.${r.suggestion.why}`):''}</p></div>
     <div className="min-w-0"><span className="mr-2 text-xs text-muted-foreground md:sr-only">{f('final')}</span>{r.final?.performance?<><b>{r.final.performance}</b><p className="mt-1 break-words text-xs text-muted-foreground">{r.final.by}</p>{r.final.at&&<p className="text-xs text-muted-foreground">{new Date(new Date(r.final.at).getTime()+8*3600000).toISOString().slice(0,10)}</p>}{r.final.reason&&<p className="mt-1 break-words text-xs text-muted-foreground">{r.final.reason}</p>}</>:<span className="text-muted-foreground">{f('notDecided')}</span>}</div>
     <div className="flex min-w-0 flex-wrap items-center gap-2">{editable?<>
      <form action={finalBandsAction} className="contents">{fields}<input type="hidden" name="action" value="decide"/><input type="hidden" name="reviewId" value={r.reviewId}/>
       <select aria-label={f('bandFor',{name:r.name})} name="band" defaultValue={r.final?.performance??r.suggestion?.band??r.bg??'UA'} className={cn(inputCls,'w-16 shrink-0')}>{pmBands.map(b=><option key={b}>{b}</option>)}</select>
       <input aria-label={f('reasonFor',{name:r.name})} name="reason" placeholder={f('reason')} maxLength={4000} className={cn(inputCls,'w-auto min-w-0 flex-1 basis-24')}/>
       <ConfirmSubmit description={f('decideConfirm',{name:r.name})} variant="secondary" size="sm" className="min-h-11 monolith:min-h-11 md:min-h-8 md:monolith:min-h-8">{f(r.final?.performance?'change':'decide')}</ConfirmSubmit>
      </form>
      {r.final?.performance?<form action={finalBandsAction} className="contents">{fields}<input type="hidden" name="action" value="clear"/><input type="hidden" name="reviewId" value={r.reviewId}/><ConfirmSubmit description={f('clearConfirm',{name:r.name})} variant="ghost" size="sm" className="min-h-11 monolith:min-h-11 md:min-h-8 md:monolith:min-h-8">{f('clear')}</ConfirmSubmit></form>:r.groupLockedAt&&<form action={finalBandsAction} className="contents">{fields}<input type="hidden" name="action" value="reopen"/><input type="hidden" name="reviewId" value={r.reviewId}/><ConfirmSubmit description={f('reopenConfirm',{name:r.name})} variant="ghost" size="sm" className="min-h-11 monolith:min-h-11 md:min-h-8 md:monolith:min-h-8">{f('reopen')}</ConfirmSubmit></form>}
     </>:<p className="text-xs text-muted-foreground">{f(r.finalized||!open?'readOnly':'waiting.manager')}</p>}</div>
    </div>;
   })}
  </section>}
 </div>;
}
