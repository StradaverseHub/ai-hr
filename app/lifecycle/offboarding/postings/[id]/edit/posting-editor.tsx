'use client';
import {useActionState,useState} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {saveOffboardingPostingAction} from '../../actions';
import {OFFBOARDING_PERSONNEL_POSTING_EVENTS} from '@/lib/personnel-posting';
import type {PersonnelPosting} from '@/packs/personnel-postings/service';
export function PostingEditor({posting:p,choices}:{posting:PersonnelPosting;choices:{positions:{id:string;name:string}[];grades:{id:string;code:string;name:string}[]}}){
 const t=useTranslations('offboardingPostings'),[error,action,busy]=useActionState(saveOffboardingPostingAction,null);
 const [changePosition,setPosition]=useState(!!p.current.positionId),[changeGrade,setGrade]=useState(!!p.current.gradeId),[changeSalary,setSalary]=useState(!!p.current.basicSalary);
 return <form action={action} className="space-y-6 rounded-xl border bg-card p-6"><input type="hidden" name="postingId" value={p.id}/><input type="hidden" name="revision" value={p.revision}/>{error&&<p role="alert" className="text-destructive">{error}</p>}
  <div className="grid gap-4 sm:grid-cols-2"><label>{t('eventType')}<select name="eventType" defaultValue={p.eventType} disabled={busy||p.eventType==='termination'} className="mt-1 w-full rounded-lg border p-2">{OFFBOARDING_PERSONNEL_POSTING_EVENTS.filter(e=>p.eventType==='termination'?e==='termination':e!=='termination').map(e=><option key={e} value={e}>{t('event.'+e)}</option>)}</select></label><label>{t('effectiveDate')}<input type="date" name="effectiveDate" required defaultValue={p.current.effectiveDate} disabled={busy} className="mt-1 w-full rounded-lg border p-2"/></label></div>
  {p.eventType==='termination'?<label className="block">{t('exitReason')}<input name="exitReason" defaultValue={p.current.exitReason} required maxLength={200} disabled={busy} className="mt-1 w-full rounded-lg border p-2"/></label>:<div className="space-y-4">
   <label className="grid items-center gap-2 sm:grid-cols-[14rem_1fr]"><span><input type="checkbox" name="changePosition" checked={changePosition} disabled={busy} onChange={e=>setPosition(e.target.checked)}/> {t('fields.position')}</span><select name="positionId" defaultValue={p.current.positionId??''} disabled={busy||!changePosition} required={changePosition} className="rounded-lg border p-2"><option value="">{t('choose')}</option>{choices.positions.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
   <label className="grid items-center gap-2 sm:grid-cols-[14rem_1fr]"><span><input type="checkbox" name="changeGrade" checked={changeGrade} disabled={busy} onChange={e=>setGrade(e.target.checked)}/> {t('fields.jobGrade')}</span><select name="gradeId" defaultValue={p.current.gradeId??''} disabled={busy||!changeGrade} required={changeGrade} className="rounded-lg border p-2"><option value="">{t('choose')}</option>{choices.grades.map(o=><option key={o.id} value={o.id}>{o.code} · {o.name}</option>)}</select></label>
   <label className="grid items-center gap-2 sm:grid-cols-[14rem_1fr]"><span><input type="checkbox" name="changeSalary" checked={changeSalary} disabled={busy} onChange={e=>setSalary(e.target.checked)}/> {t('fields.basicSalary')}{p.baseline?.currency?' ('+p.baseline.currency+')':''}</span><input type="text" inputMode="decimal" name="basicSalary" defaultValue={p.current.basicSalary??''} disabled={busy||!changeSalary} required={changeSalary} className="rounded-lg border p-2"/></label>
   <p className="text-sm text-muted-foreground">{t('fieldRule')}</p>
  </div>}
  <label className="block">{t('remarks')}<textarea name="remarks" defaultValue={p.current.remarks??''} maxLength={200} disabled={busy} className="mt-1 w-full rounded-lg border p-2"/></label>
  <div className="flex flex-wrap gap-3">{p.canApprove&&<button type="submit" name="intent" value="approve" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground">{t('saveApprove')}</button>}<button type="submit" name="intent" value="save" disabled={busy} className="rounded-lg border px-4 py-2">{t('savePending')}</button><Link href="/lifecycle/offboarding/postings" className="rounded-lg border px-4 py-2">{t('cancel')}</Link></div>
 </form>;
}
