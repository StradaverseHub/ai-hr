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
export function LetterRouting({letter}:{letter:ResignationLetterView}){const t=useTranslations('resignationJourney');return <section className="rounded-lg border p-3"><h3 className="text-sm font-semibold">{t('routing')}</h3><ol className="mt-2 divide-y text-sm">{letter.routing.map(step=><li key={step.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><p>{step.order}. {t(step.action==='Review'?'review':step.action==='Approve'?'approve':'sign')} · {step.people.map(p=>p.name).join(', ')}{step.owner&&<span> · {t('owner')}</span>}</p>{step.signedBy&&<p className="text-xs text-muted-foreground">{step.signedBy} · {day(step.signedAt)}</p>}</div><Badge variant={step.status==='done'?'success':'default'}>{t(step.status==='done'?'done':step.status==='pending'?'pending':'notYet')}</Badge></li>)}</ol></section>}
/** Reuses the existing V9 renderer; the server omits blocks/values when this reader cannot open the letter. */
export function LetterPreview({letter,blocks}:{letter:ResignationLetterView;blocks?:Block[]}){const t=useTranslations('resignationJourney');if(letter.private||!letter.capabilities.open)return <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t('privateLetter')}</p>;
 const document:Document|null=letter.document;
 if(!document)return <p className="text-sm text-muted-foreground">{t('privateLetter')}</p>;
 const values={...document.mergeValues,...document.values},missing=new Set<string>();
 const resolve=(text:string)=>{const result=merge(text,values);for(const key of result.missing)missing.add(key);return result.missing.reduce((out,key)=>out.replaceAll('['+key+']','—'),result.text);};
 const preview=blocks?{...document,edits:{},blocks:blocks.map(block=>({...block,text:resolve(block.text),...(block.columns!==undefined?{columns:resolve(block.columns)}:{}),...(block.rows!==undefined?{rows:resolve(block.rows)}:{})}))}:document;
 return <section className="space-y-2" aria-label={t('preview')}>{missing.size>0&&<p role="status" className="rounded-md border border-amber-300 p-3 text-sm text-amber-900 dark:text-amber-100">{t('missingFields',{fields:[...missing].join(', ')})}</p>}<div className="overflow-x-auto rounded-lg border bg-white p-5 text-slate-950"><DocumentBody document={preview}/></div></section>;
}
export function CaseHeader({value}:{value:ResignationCaseView}){const t=useTranslations('resignationJourney');return <header className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{value.employeeName}</h3><p className="mt-1 text-xs text-muted-foreground">{[value.employeeCode,value.position,value.department,value.businessGroup,value.number].filter(Boolean).join(' · ')}</p></div><Badge variant="default">{t('stage.'+value.stage)}</Badge></header>}
export function BlockedRuns({value,onRetry,busy}:{value:ResignationCaseView;onRetry:()=>void;busy:boolean}){const t=useTranslations('resignationJourney');return value.blocked.length?<Card className="space-y-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"><h3 className="font-semibold">{t('blocked')}</h3><ul className="list-disc pl-5 text-sm">{value.blocked.map((reason,i)=><li key={i}>{reason}</li>)}</ul>{value.capabilities.retry&&<button className="v9-button" type="button" disabled={busy} onClick={onRetry}>{t('retry')}</button>}</Card>:null}
