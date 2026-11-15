'use client';
import {DerivedOrganisationFields,useDerivedOrganisation} from '@/components/derived-organisation-fields';
import {useEffect,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations,useFormatter} from 'next-intl';
import {informationContextAction,previewInformationAction,saveInformationAction} from './information-correction-actions';
import {personnelWorkflowControl,personnelWorkflowInput} from '@/lib/personnel-form-contract';
import {INFORMATION_FIELDS,INFORMATION_FIELD_IDS,type InformationPreview,type InformationChanges} from '@/lib/information-correction';
const control='w-full rounded-md border border-input bg-card px-3 py-2 text-sm';
const button='rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50 active:scale-[.98]';
type CorrectionContext = Exclude<Awaited<ReturnType<typeof informationContextAction>>, { correctionError: string }>;

function correctionValue<T extends object>(result: T | { correctionError: string }): T {
  if ('correctionError' in result && typeof result.correctionError === 'string') {
    throw new Error(result.correctionError);
  }
  return result as T;
}

export function InformationChangesTable({preview}:{preview:InformationPreview}){
 const t=useTranslations('people.informationCorrection');
 return <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-sm">{preview.effectiveOn&&<caption className="caption-bottom p-3 text-left text-xs text-muted-foreground">{t('effective',{date:preview.effectiveOn})}</caption>}<thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-3">{t('field')}</th><th className="p-3">{t('before')}</th><th className="p-3">{t('after')}</th></tr></thead><tbody>{preview.changed.map(field=><tr key={field} className="border-t"><th className="p-3 font-normal">{t(`fields.${field}`)}</th><td className="p-3">{preview.beforeLabels[field]??'—'}</td><td className="p-3 font-semibold">{preview.afterLabels[field]??'—'}</td></tr>)}</tbody></table></div>;
}
/** The same audit presentation serves correction entry and read-only movement details. */
export function InformationCorrectionAudit({history}:{history:CorrectionContext['history']}){
 const t=useTranslations('people.informationCorrection'),format=useFormatter();
 return <details id="information-correction-history" className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('history')}</summary>{history.length?history.map(event=>{const p=event.payload as {beforeLabels:InformationPreview['beforeLabels'];afterLabels:InformationPreview['afterLabels'];fields:InformationPreview['changed'];reason:string;method:string;filename?:string;batchId?:string;effectiveOn:string};return <article className="space-y-2 border-t py-3 text-sm" key={event.id}><p>{format.dateTime(new Date(event.at),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})} · {event.actorName??event.actorId} · {p.method}</p><p>{p.reason}</p>{p.filename&&<p>{p.filename} · {p.batchId}</p>}<InformationChangesTable preview={{effectiveOn:p.effectiveOn,changed:p.fields,beforeLabels:p.beforeLabels,afterLabels:p.afterLabels} as InformationPreview}/></article>;}):<p className="pt-3 text-sm text-muted-foreground">{t('noHistory')}</p>}</details>;
}
/** Board 4604dccc — the dated records in Effective Date order and what this correction does to each (the approved sketch). */
export function InformationTimeline({preview}:{preview:InformationPreview}){
 const t=useTranslations('people.informationCorrection');
 const kind=(record:NonNullable<InformationPreview['timeline']>[number])=>['hired','thisCorrection','informationCorrection','record'].includes(record.kind)?t(`timeline.kinds.${record.kind as 'hired'|'thisCorrection'|'informationCorrection'|'record'}`):record.label??record.kind;
 const tone={corrected:'border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100',unchanged:'border-border text-muted-foreground',conflict:'border-destructive/40 bg-destructive/10 text-destructive'} as const;
 if(!preview.timeline?.length)return null;
 return <section aria-label={t('timeline.title')} className="space-y-2"><h3 className="text-sm font-semibold">{t('timeline.title')}</h3><p className="text-sm text-muted-foreground">{t('timeline.intro',{date:preview.effectiveOn})}</p>
  <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-3">{t('timeline.date')}</th><th className="p-3">{t('timeline.record')}</th><th className="p-3">{t('timeline.company')}</th><th className="p-3">{t('timeline.status')}</th></tr></thead>
  <tbody>{preview.timeline.map((record,index)=><tr key={record.date+record.kind+index} className="border-t" data-timeline-status={record.status}><td className="p-3 font-medium tabular-nums">{record.date}</td><td className="p-3">{kind(record)}</td><td className="p-3">{record.company??'—'}</td><td className="p-3"><span className={'inline-flex rounded-full border px-2 py-0.5 text-xs '+tone[record.status]}>{t(`timeline.statuses.${record.status}`)}</span></td></tr>)}</tbody></table></div></section>;
}
/** Board 4604dccc — later movements whose recorded "from" values this correction contradicts. Nothing is saved. */
export function InformationConflicts({preview}:{preview:InformationPreview}){
 const t=useTranslations('people.informationCorrection');
 if(!preview.conflicts?.length)return null;
 return <div role="alert" className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><p className="font-semibold">{t('conflictTitle')}</p><ul className="list-disc space-y-1 pl-5">{preview.conflicts.map(c=><li key={c.movementId+c.field}>{t('conflict',{record:c.label??c.kind,date:c.date,field:t(`fields.${c.field}`),id:c.movementId})}</li>)}</ul></div>;
}
function InformationForm({employmentId,onPendingChange,returnHref}:{employmentId:string;onPendingChange:(pending:boolean)=>void;returnHref?:string}){
 const t=useTranslations('people.informationCorrection'),router=useRouter();
 const [context,setContext]=useState<CorrectionContext|null>(null),[changes,setChanges]=useState<InformationChanges>({}),[reason,setReason]=useState(''),[review,setReview]=useState<InformationPreview|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[effectiveOn,setEffectiveOn]=useState(''),[acknowledged,setAcknowledged]=useState(false);
 useEffect(()=>{onPendingChange(pending);return()=>onPendingChange(false);},[pending,onPendingChange]);
 useEffect(()=>{let active=true;informationContextAction(employmentId).then(data=>{if(active)setContext(correctionValue<CorrectionContext>(data));}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[employmentId]);
 const today=context?.preview.effectiveOn??'',earliest=context?.preview.earliestEffectiveOn??'',chosen=effectiveOn||today;
 const derivedOrganisation=useDerivedOrganisation({companyId:changes.companyId??context?.preview.before.companyId??undefined,asOf:chosen||undefined});
 // 2260a06b — an end date typed for a type the employee no longer has is not sent.
 const applicable=(all:InformationChanges):InformationChanges=>{const type=all.employmentType??context?.preview.before.employmentType;const next={...all};if(type!=='contract')delete next.contractEndDate;if(type!=='intern')delete next.internshipEndDate;return next;};
 async function submit(){setPending(true);setError('');setAcknowledged(false);try{const result=await previewInformationAction({employmentId,changes:applicable(changes),reason,effectiveOn:chosen});setReview(correctionValue<InformationPreview>(result));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}}
 async function confirm(){if(!review)return;setPending(true);setError('');try{correctionValue(await saveInformationAction({employmentId,changes:applicable(changes),reason,fingerprint:review.fingerprint,effectiveOn:review.effectiveOn,acknowledgeClosedPayroll:acknowledged}));setSaved(true);if(returnHref){document.querySelector('[data-personnel-movement-page]')?.dispatchEvent(new Event('personnel-movement-saved'));router.push(returnHref);router.refresh();return;}setReview(null);setChanges({});setReason('');setEffectiveOn('');setAcknowledged(false);setContext(correctionValue<CorrectionContext>(await informationContextAction(employmentId)));router.refresh();}catch(e){setError(e instanceof Error?e.message:String(e));setReview(null);}finally{setPending(false);}}
 const blocked=!!review?.conflicts?.length||(!!review?.closedPayrollPeriods?.length&&!acknowledged);
 return <section className="space-y-4 p-4" aria-label={t('title')}>
  <p className="rounded-lg bg-muted p-3 text-sm">{t('protection')}</p>
  <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">{t('warning')}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{saved&&<p role="status" className="text-sm text-green-700 dark:text-green-300">{t('saved')}</p>}
  {!context&&!error&&<p role="status">{t('loading')}</p>}
  {context&&(review?<><p className="text-sm font-medium">{t('effectiveDate')}: <span className="tabular-nums">{review.effectiveOn}</span></p><InformationChangesTable preview={review}/>{!!review.warnings?.length&&<ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">{review.warnings.map(w=><li key={w.code}>{w.code==='companyFrom'?(w.to?t('warnings.companyFromUntil',{date:w.date,to:w.to}):t('warnings.companyFrom',{date:w.date})):t('warnings.historyStartAligned',{date:w.date,from:w.from??''})}</li>)}</ul>}<InformationTimeline preview={review}/><InformationConflicts preview={review}/>
   {!!review.closedPayrollPeriods?.length&&<div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"><p>{t('closedPayroll',{periods:review.closedPayrollPeriods.join(', ')})}</p><label className="flex items-start gap-2"><input name="informationCorrectionClosedPayroll" className="mt-1" type="checkbox" checked={acknowledged} disabled={pending} onChange={e=>setAcknowledged(e.target.checked)}/><span>{t('closedPayrollAcknowledge')}</span></label></div>}
   <p className="text-sm">{t('reason')}: {review.reason}</p>{!review.changed.length&&!review.alignStart&&<p role="status">{t('unchanged')}</p>}<div className="flex justify-end gap-2"><button aria-busy={pending} className={button} disabled={pending} onClick={()=>setReview(null)}>{t('back')}</button><button aria-busy={pending} className={button+' bg-primary text-primary-foreground'} disabled={pending||blocked||(!review.changed.length&&!review.alignStart)} onClick={confirm}>{pending?t('saving'):t('confirm')}</button></div></>:<form onSubmit={e=>{e.preventDefault();void submit();}} className="space-y-4">
   <fieldset disabled={pending} className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2"><legend className="px-1 text-sm font-semibold">{t('effectiveTitle')}</legend><label htmlFor="information-effectiveOn" className="space-y-1 text-sm"><span className="block font-medium">{t('effectiveDate')}</span><input id="information-effectiveOn" name="informationCorrectionEffectiveOn" type="date" required className={control} value={chosen} min={earliest||undefined} max={today||undefined} onChange={e=>{setSaved(false);setEffectiveOn(e.target.value);}}/><span className="block text-xs text-muted-foreground">{t('effectiveDateHint',{start:earliest,today})}</span></label><p className="self-end text-xs text-muted-foreground">{t('effectiveDateJoin',{start:earliest})}</p></fieldset>
   <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">{INFORMATION_FIELDS.map(field=>{const type=changes.employmentType??context.preview.before.employmentType;if(field==='contractEndDate'&&type!=='contract'||field==='internshipEndDate'&&type!=='intern')return null;const value=changes[field]??context.preview.before[field]??'',id='information-'+field;return <label htmlFor={id} key={field} className="space-y-1 text-sm"><span className="block font-medium">{t(`fields.${field}`)}</span>{field==='hiredOn'||field==='joinDate'||field==='contractEndDate'||field==='internshipEndDate'?<input {...personnelWorkflowInput(INFORMATION_FIELD_IDS[field],'informationCorrection')} id={id} value={value} className={control} onChange={e=>{setSaved(false);setChanges(v=>({...v,[field]:e.target.value}));}}/>:<select {...personnelWorkflowControl(INFORMATION_FIELD_IDS[field],'informationCorrection')} id={id} className={control} value={value} onChange={e=>{setSaved(false);setChanges(v=>({...v,[field]:e.target.value}));}}><option value="" disabled>—</option>{field==='gradeId'&&value&&!context.options.grades.some(g=>g.id===value)&&<option value={value}>{context.preview.beforeLabels.gradeId}</option>}{field==='companyId'?context.options.companies.map(c=><option key={c.id} value={c.id}>{c.code} · {c.name}</option>):field==='gradeId'?context.options.grades.map(g=><option key={g.id} value={g.id}>{g.code} · {g.name}</option>):context.options.employmentTypes.map(type=><option key={type} value={type}>{type}</option>)}</select>}</label>;})}</fieldset><label className="block space-y-1 text-sm"><span className="block font-medium">{t('reason')}</span><textarea name="informationCorrectionReason" className={control} value={reason} required minLength={3} maxLength={1000} disabled={pending} onChange={e=>setReason(e.target.value)}/></label><div className="flex justify-end"><button aria-busy={pending} className={button+' bg-primary text-primary-foreground'} disabled={pending||reason.trim().length<3} type="submit">{pending?t('loading'):t('review')}</button></div></form>)}
  {context&&<DerivedOrganisationFields state={derivedOrganisation}/>}
  {context&&<InformationCorrectionAudit history={context.history}/>}
 </section>;
}
/** Explicit mode selection keeps the existing operational correction form intact. */
export function HireCorrectionModes({employmentId,children,returnHref}:{employmentId:string;children:ReactNode;returnHref?:string}){
 const t=useTranslations('people.informationCorrection'),[mode,setMode]=useState<'existing'|'information'>('existing'),[busy,setBusy]=useState(false);
 useEffect(()=>{if(window.location.hash==='#information-correction-history')setMode('information');},[]);
 return <><fieldset disabled={busy} className="flex flex-wrap gap-4 border-b p-4 text-sm"><legend className="sr-only">{t('mode')}</legend><label className="flex items-center gap-2"><input type="radio" name="correction-mode" checked={mode==='existing'} onChange={()=>setMode('existing')}/>{t('existing')}</label><label className="flex items-center gap-2"><input type="radio" name="correction-mode" checked={mode==='information'} onChange={()=>setMode('information')}/>{t('title')}</label></fieldset>{mode==='existing'?children:<InformationForm employmentId={employmentId} onPendingChange={setBusy} returnHref={returnHref}/>}</>;
}
