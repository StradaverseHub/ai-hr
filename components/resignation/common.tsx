'use client';
import {useTranslations} from 'next-intl';
import type {ResignationCaseView,ResignationLetterView} from '@/lib/resignation-journey';
import {Badge,Card} from '@/components/ui';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import {merge,type Block,type Document} from '@/lib/lifecycle-v9-model';
import {formatMoney} from '@/lib/money';
import {formatDmy} from '@/lib/date-display';
export const day=(value:string|null|undefined)=>value?formatDmy(value):'—';
export const money=(value:string|null|undefined,currency:string|null|undefined)=>formatMoney(value,currency);
/** Display arithmetic uses integer minor units. No proposed value is a Personnel fact until approved. */
export function offerDifference(current:string|null,proposed:string,currency:string|null|undefined){
 const cents=(v:string)=>/^\d{1,10}(?:\.\d{1,2})?$/.test(v)?Number(v.split('.')[0])*100+Number((v.split('.')[1]??'').padEnd(2,'0')):null;
 const before=current===null?null:cents(current),after=cents(proposed);
 if(before===null||after===null)return null;
 const diff=after-before;return {monthly:`${diff<0?'−':'+'}${money(String(Math.abs(diff)/100),currency)}`,percent:before>0?`${diff<0?'':'+'}${(diff/before*100).toFixed(1)}%`:'—'};
}
export function CaseFacts({value}:{value:ResignationCaseView}){const t=useTranslations('resignationJourney');return <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
 {[['case',value.number],['submitted',day(value.submittedOn)],['lastWorkingDay',day(value.lastWorkingDay)],['reason',value.reason||t('noReason')]].map(([key,text])=><div key={key}><dt className="text-xs text-muted-foreground">{t(key)}</dt><dd className="mt-1 break-words font-medium">{text}</dd></div>)}</dl>}
export function PriorCases({value}:{value:ResignationCaseView}){const t=useTranslations('resignationJourney');return value.priorCases.length?<div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"><strong>{value.priorCases.some(c=>c.stage==='retained')?t('retainedBefore'):t('resignedBefore')}</strong><ul className="mt-1 space-y-1">{value.priorCases.map(c=><li key={c.id}>{t('priorHint',{number:c.number,outcome:t('stage.'+c.stage)})}{c.offer&&<span> · {c.offer.position} · {c.offer.jobGrade} · {money(c.offer.basicSalary,c.currency)} · {day(c.offer.effectiveDate)}</span>}</li>)}</ul></div>:null}
export function LetterRouting({letter}:{letter:ResignationLetterView}){const t=useTranslations('resignationJourney');if(letter.private)return letter.waitingOn?.length?<p role="status" className="text-sm text-muted-foreground">{t('waitingOn',{people:letter.waitingOn.map(person=>person.name).join(', ')})}</p>:null;return <section className="rounded-lg border p-3"><h3 className="text-sm font-semibold">{t('routing')}</h3><ol className="mt-2 divide-y text-sm">{letter.routing.map(step=><li key={step.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><p>{step.order}. {t(step.action==='Review'?'review':step.action==='Approve'?'approve':'sign')} · {step.people.map(p=>p.name).join(', ')}{step.owner&&<span> · {t('owner')}</span>}</p>{step.signedBy&&<p className="text-xs text-muted-foreground">{step.signedBy} · {day(step.signedAt)}</p>}</div><Badge variant={step.status==='done'?'success':'default'}>{t(step.status==='done'?'done':step.status==='pending'?'pending':'notYet')}</Badge></li>)}</ol></section>}
export function closedRetentionOfferState(letter:ResignationLetterView):'declined'|'lapsed'|'withdrawn'|null{const state=letter.state;return letter.kind==='retention'&&(state==='declined'||state==='lapsed'||state==='withdrawn')?state:null;}
export function ClosedRetentionOfferNotice({value,letter}:{value:ResignationCaseView;letter:ResignationLetterView}){
 const t=useTranslations('resignationJourney'),state=closedRetentionOfferState(letter);if(!state)return null;
 const keys={declined:'closedOfferDeclined',lapsed:'closedOfferLapsed',withdrawn:'closedOfferWithdrawn'} as const;
 return <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm" data-resignation-closed-offer={letter.id}><p>{t(keys[state])}</p>{value.stage==='decision'&&<p className="text-muted-foreground">{value.deciders.length?t('closedOfferNextDecision',{people:value.deciders.map(person=>person.name).join(', ')}):t('closedOfferUnassigned')}</p>}</div>;
}
/** Reuses the existing V9 renderer; the server omits blocks/values when this reader cannot open the letter. */
export function LetterPreview({letter,blocks,fieldValues,fieldsDisabled=false,onFieldChange}:{letter:ResignationLetterView;blocks?:Block[];fieldValues?:Record<string,string>;fieldsDisabled?:boolean;onFieldChange?:(id:string,value:string)=>void}){const t=useTranslations('resignationJourney');if(closedRetentionOfferState(letter)&&(letter.private||!letter.capabilities.open))return null;if(letter.private||!letter.capabilities.open)return <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t('privateLetter')}</p>;
 const document:Document|null=letter.document;
 if(!document)return <p className="text-sm text-muted-foreground">{t('privateLetter')}</p>;
 const values={...document.mergeValues,...document.values,...fieldValues},missing=new Set<string>();
 const resolve=(text:string)=>{const result=merge(text,values);for(const key of result.missing)missing.add(key);return result.missing.reduce((out,key)=>out.replaceAll('['+key+']','—'),result.text);};
 const preview=blocks?{...document,edits:{},blocks:blocks.map(block=>({...block,text:resolve(block.text),...(block.columns!==undefined?{columns:resolve(block.columns)}:{}),...(block.rows!==undefined?{rows:resolve(block.rows)}:{})}))}:document;
 return <section className="space-y-2" aria-label={t('preview')}>{missing.size>0&&<p role="status" className="rounded-md border border-amber-300 p-3 text-sm text-amber-900 dark:text-amber-100">{t('missingFields',{fields:[...missing].join(', ')})}</p>}<div className="overflow-x-auto rounded-lg border bg-white p-5 text-slate-950 [&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_td]:px-3! [&_td]:py-2! [&_td]:align-top [&_td]:[overflow-wrap:anywhere] [&_th]:px-3! [&_th]:py-2! [&_th]:text-left [&_th]:align-top [&_th]:[overflow-wrap:anywhere]"><DocumentBody document={preview} values={fieldValues?{...document.values,...fieldValues}:document.values} editableFieldIds={onFieldChange?letter.editableFieldIds:undefined} disabled={fieldsDisabled} change={onFieldChange}/></div></section>;
}
export function CaseHeader({value}:{value:ResignationCaseView}){const t=useTranslations('resignationJourney');return <header className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{value.employeeName}</h3><p className="mt-1 text-xs text-muted-foreground">{[value.employeeCode,value.position,value.department,value.businessGroup,value.number].filter(Boolean).join(' · ')}</p></div><Badge variant="default">{t('stage.'+value.stage)}</Badge></header>}
export function BlockedRuns({value,onRetry,onRunAgain,busy}:{value:ResignationCaseView;onRetry:()=>void;onRunAgain?:()=>void;busy:boolean}){const t=useTranslations('resignationJourney');return value.blocked.length||value.capabilities.runAgain?<Card className="space-y-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"><h3 className="font-semibold">{t('blocked')}</h3><ul className="list-disc pl-5 text-sm">{value.blocked.map((reason,i)=><li key={i}>{reason}</li>)}</ul>{value.capabilities.runAgain&&onRunAgain&&<div className="space-y-2"><p className="text-sm text-muted-foreground">{t('runAgainHint')}</p><button className="v9-button" type="button" disabled={busy} onClick={onRunAgain}>{t('runAgain')}</button></div>}{value.capabilities.retry&&<button className="v9-button" type="button" disabled={busy} onClick={onRetry}>{t('retry')}</button>}</Card>:null}

/** Reply timing is projected by the company-calendar owner; this client never guesses working days. */
export function OfferReplyDeadline({value}:{value:ResignationCaseView}){
 const t=useTranslations('resignationJourney'),remaining=value.offerWorkingDaysRemaining;
 return <p role="status" data-offer-reply className={'rounded-md p-2 text-sm font-medium '+(value.offerReplyWarning?'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100':'')}>
  {value.offerReplyBy?t('replyBy',{date:day(value.offerReplyBy)}):t('openEnded')}{value.offerReplyBy&&remaining!==null&&remaining!==undefined&&<span> · {t(remaining<0?'replyOverdue':'workingDaysLeft',{count:Math.abs(remaining)})}</span>}
 </p>;
}

/** One terms-and-reply summary for the employee profile and their authorized direct case. */
export function ResignationOfferSummary({value}:{value:ResignationCaseView}){
 const t=useTranslations('resignationJourney');if(value.stage!=='offer'||!value.offer)return null;
 return <section className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950"><h3 className="font-semibold">{t('offerTitle')}</h3><table data-wrap-headings className="w-full table-fixed text-sm [&_td]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere]"><thead><tr><th className="py-2 text-left">{t('term')}</th><th className="text-left">{t('current')}</th><th className="text-left">{t('proposed')}</th></tr></thead><tbody>{[[t('position'),value.position,value.offer.position],[t('grade'),value.jobGrade,value.offer.jobGrade],[t('salaryMonthly')+(value.currency?' · '+value.currency:''),money(value.currentBasicSalary,value.currency),money(value.offer.basicSalary,value.currency)]].map(([label,before,after])=><tr key={label}><th className="py-2 text-left font-normal">{label}</th><td className="pr-3">{before}</td><td className="font-semibold">{after}</td></tr>)}</tbody></table><p className="text-sm">{t('effectiveDate')}: {day(value.offer.effectiveDate)}</p><OfferReplyDeadline value={value}/></section>;
}
