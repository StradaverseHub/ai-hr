import {notFound} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {PrivateCaseError,readHandledPrivateCase} from '@/core/private-cases';
import {Button,Card,Field,PageHeader,StatusBadge,inputCls,pageWideCls} from '@/components/ui';
import {addPrivateCaseNoteAction,setPrivateCaseStatusAction} from '../actions';
export const dynamic='force-dynamic';

const ERRORS=['invalid','not_allowed','unavailable','conflict'] as const;

/** AI v2 W11 — one private case, for its handler (ADR-0173): who wrote it and what, the handlers' notes, the status
 * steps and the case's own record of every read and change. Opening it is recorded before anything is shown. A case
 * this person may not handle (their own, one they were left out of, another company's) is not found. */
export default async function HandledPrivateCasePage({params,searchParams}:{params:Promise<{caseId:string}>;searchParams:Promise<{notice?:string;error?:string}>}){
 const {s}=await scopedSession(),{caseId}=await params,sp=await searchParams,t=await getTranslations('privateCases'),locale=await getLocale();
 const detail=await readHandledPrivateCase(s,caseId).catch(error=>{if(error instanceof PrivateCaseError&&error.code==='not_found')notFound();throw error;});
 const date=(value:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(value);
 const who=(name:string|null,own:boolean)=>own?t('handle.you'):name??t('handle.noName');
 const error=ERRORS.find(code=>code===sp.error),notice=sp.notice==='note'?t('handle.noteSaved'):sp.notice==='status'?t('handle.statusSaved'):null;
 return <div className={pageWideCls}>
  <PageHeader title={t(`categories.${detail.category}`)} description={[detail.companyName,t('handle.opened',{date:date(detail.openedAt)})].filter(Boolean).join(' · ')}
   back={{href:'/cases',label:t('handle.back')}}/>
  {error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{t(`errors.${error}`)}</p>}
  {notice&&<p role="status" className="rounded-md border p-4 text-sm">{notice}</p>}
  {detail.erasureRequested&&<p role="note" className="rounded-md bg-muted p-4 text-sm">{t('handle.erasure')}</p>}
  <Card className="space-y-5 p-4 sm:p-6">
   <dl className="grid gap-4 text-sm sm:grid-cols-3">
    <div><dt className="text-muted-foreground">{t('handle.author')}</dt><dd className="mt-1 font-medium">{detail.author??t('handle.noName')}</dd></div>
    <div><dt className="text-muted-foreground">{t('handle.status')}</dt><dd className="mt-1"><StatusBadge status={detail.status} label={t(`statuses.${detail.status}`)}/></dd></div>
   </dl>
   {detail.route==='group_admin'&&<p className="text-sm text-muted-foreground">{t('handle.toGroupAdmin')}</p>}
   <section aria-labelledby="handled-case-text" className="space-y-2"><h2 id="handled-case-text" className="text-sm font-semibold">{t('handle.text')}</h2>
    <p data-private-case-text className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{detail.text}</p></section>
   {detail.next.length>0&&<div className="flex flex-wrap gap-3">{detail.next.map(next=><form key={next} action={setPrivateCaseStatusAction}>
    <input type="hidden" name="caseId" value={detail.id}/><input type="hidden" name="expected" value={detail.status}/><input type="hidden" name="status" value={next}/>
    <Button type="submit" variant={next==='closed'?'outline':'default'} className="pointer-coarse:min-h-11">{t('handle.moveTo',{status:t(`statuses.${next}`)})}</Button></form>)}</div>}
  </Card>
  <Card className="space-y-4 p-4 sm:p-6">
   <div><h2 className="text-sm font-semibold">{t('handle.notes')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('handle.notesHelp')}</p></div>
   {detail.notes.length===0?<p className="text-sm text-muted-foreground">{t('handle.noNotes')}</p>:<ul className="space-y-3">{detail.notes.map(note=><li key={note.id} className="space-y-1">
    <p className="text-xs text-muted-foreground">{t('handle.noteBy',{name:who(note.author,note.own),date:date(note.at)})}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{note.text}</p></li>)}</ul>}
   {detail.status==='closed'?<p className="text-sm text-muted-foreground">{t('handle.closedNoNotes')}</p>:<form action={addPrivateCaseNoteAction} className="space-y-3">
    <input type="hidden" name="caseId" value={detail.id}/>
    <Field label={t('handle.noteLabel')}><textarea name="text" required maxLength={4000} rows={4} className={inputCls+' h-auto min-h-24 py-2'}/></Field>
    <Button type="submit" variant="outline" className="pointer-coarse:min-h-11">{t('handle.saveNote')}</Button></form>}
  </Card>
  <Card className="space-y-3 p-4 sm:p-6"><h2 className="text-sm font-semibold">{t('handle.audit')}</h2>
   <ol className="space-y-1 text-sm">{detail.audit.map((row,index)=>{const name=who(row.actor,row.own);
    const line=row.kind==='created'?t('handle.auditCreated',{name}):row.kind==='read'?t('handle.auditRead',{name}):row.kind==='note_added'?t('handle.auditNote',{name})
     :t('handle.auditStatus',{name,from:row.from?t(`statuses.${row.from}`):'',to:row.to?t(`statuses.${row.to}`):''});
    return <li key={index} className="flex flex-wrap justify-between gap-2"><span>{line}</span><span className="text-muted-foreground tabular-nums">{date(row.at)}</span></li>;})}</ol></Card>
 </div>;
}
