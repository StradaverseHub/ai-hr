'use client';

import Link from 'next/link';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {deleteOvertimePatternAction,editOvertimePatternAction,type OvertimeActionFailure} from '@/app/admin/attendance/settings/overtime-patterns/actions';

const PAGE='/admin/attendance/settings/overtime-patterns';
const link='text-primary hover:underline';
/** Board 4197534a — the listing's View, Edit and Delete. Edit appears only when the reader looks after every company in
 * the pattern; on an activated pattern it opens a new draft (the live rules keep applying until that draft is
 * activated). Delete confirms with the Pattern Code and Name, and a refusal explains what still uses the pattern. */
export function OvertimePatternListActions({row}:{row:{id:string;kind:'formula'|'legacy';code:string|null;name:string|null;revision:number;latestVersionId:string|null;liveVersionId:string|null;latestDraft:boolean;writable:boolean;archived:boolean}}) {
  const t=useTranslations('overtimePatterns.listing'),te=useTranslations('overtimePatterns');
  const router=useRouter();
  const dialog=useRef<HTMLDialogElement>(null);
  const [pending,start]=useTransition();
  const [refused,setRefused]=useState<OvertimeActionFailure|null>(null);
  const [failure,setFailure]=useState<OvertimeActionFailure|null>(null);
  const version=row.latestVersionId??'';
  const title=[row.code,row.name].filter(Boolean).join(' - ');
  const legacy=row.kind==='legacy';
  const open=()=>{setRefused(null);setFailure(null);dialog.current?.showModal?.();};
  const close=()=>dialog.current?.close?.();
  const remove=()=>start(async()=>{
    const result=await deleteOvertimePatternAction({patternId:row.id,expectedRevision:row.revision});
    if(!result.ok){if(result.reason==='deleteBlocked')setRefused(result);else setFailure(result);return;}
    close();router.push(result.value.navigate);
  });
  const edit=()=>start(async()=>{
    const result=await editOvertimePatternAction({versionId:version,expectedPatternRevision:row.revision});
    if(!result.ok){setFailure(result);return;}
    router.push(result.value.navigate);
  });
  const reasonText=(result:OvertimeActionFailure)=>{const key=result.reason?`refusal.${result.reason}`:null;return key&&te.has(key)?te(key,result.values??{}):te(`errors.${result.code}`);};
  const values=refused?.values??{};
  return <div className="flex flex-wrap items-center gap-3">
    <Link className={link} href={`${PAGE}?pattern=${row.id}&version=${version}&mode=view`}>{t('view')}</Link>
    {row.writable&&!row.archived||legacy?(legacy||row.latestDraft?<Link className={link} href={`${PAGE}?pattern=${row.id}&version=${version}`}>{t('edit')}</Link>
      :<button type="button" className={link} disabled={pending} onClick={edit}>{t('edit')}</button>):null}
    {!legacy&&row.writable&&!row.archived?<button type="button" className="text-destructive hover:underline" onClick={open}>{t('delete')}</button>:<span className="text-muted-foreground" aria-disabled="true">{t('delete')}</span>}
    {failure&&!refused?<span role="alert" className="text-xs text-destructive">{reasonText(failure)}</span>:null}
    <dialog ref={dialog} aria-labelledby={`delete-${row.id}`} className="w-full max-w-lg rounded-xl border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40">
      {refused?<div className="space-y-4">
        <h2 id={`delete-${row.id}`} className="text-lg font-semibold">{t('blockedTitle',{code:row.code??''})}</h2>
        <p className="font-medium">{title}</p>
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {Number(values.assignments)?<p>{t('blockedEmployees',{from:String(values.from??''),employees:Number(values.employees??0),capped:Number(values.employeesCapped)?'yes':'no',companies:Number(values.companies??0)})}</p>:null}
          {Number(values.groupCount)?<p>{t('blockedGroups',{groups:String(values.groups??''),count:Number(values.groupCount)})}</p>:null}
        </div>
        <p className="text-sm">{t('blockedHelp')}</p>
        <div className="flex justify-end"><button type="button" className="min-h-10 rounded-lg border border-border px-4 py-2 text-sm" onClick={close}>{t('close')}</button></div>
      </div>:<div className="space-y-4">
        <h2 id={`delete-${row.id}`} className="text-lg font-semibold">{t('deleteTitle')}</h2>
        <p className="font-medium">{title}</p>
        <p className="text-sm">{t('deleteHelp')}</p>
        {failure?<p role="alert" className="text-sm text-destructive">{reasonText(failure)}</p>:null}
        <div className="flex justify-end gap-2"><button type="button" className="min-h-10 rounded-lg border border-border px-4 py-2 text-sm" onClick={close}>{t('cancel')}</button><button type="button" className="min-h-10 rounded-lg border border-destructive px-4 py-2 text-sm text-destructive disabled:opacity-50" disabled={pending} onClick={remove}>{t('confirmDelete',{code:row.code??''})}</button></div>
      </div>}
    </dialog>
  </div>;
}
