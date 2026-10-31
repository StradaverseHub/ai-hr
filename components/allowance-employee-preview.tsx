'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import type {AllowanceRules} from '@/lib/attendance-allowance-rules';
import {previewAllowanceEmployeeSelection} from '@/app/(app)/admin/attendance-allowance/actions';
export function AllowanceEmployeePreview({companyId,rules,method}:{companyId:string;rules:AllowanceRules;method:string}) {
  const t=useTranslations('allowanceV4'),old=useTranslations('allowanceV2');
  const [month,setMonth]=useState(todayInKualaLumpur().slice(0,7));
  const [preview,setPreview]=useState<Awaited<ReturnType<typeof previewAllowanceEmployeeSelection>>|null>(null);
  const [error,setError]=useState(false),[pending,start]=useTransition();
  const fingerprint=JSON.stringify({companyId,rules,method,month});
  const latest=useRef(fingerprint);
  useEffect(()=>{latest.current=fingerprint;setPreview(null);setError(false);},[fingerprint]);
  return <div className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">{t('previewTitle')}</h3><div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm">{old('paymentMonth')}<input type="month" value={month} className={inputCls} onChange={event=>setMonth(event.target.value)}/></label><Button type="button" variant="secondary" disabled={pending||!companyId||!month} onClick={()=>{
    const before=fingerprint;
    start(async()=>{setError(false);try{const result=await previewAllowanceEmployeeSelection({companyId,rules,method,month});if(before===latest.current)setPreview(result);}catch{if(before===latest.current)setError(true);}});
  }}>{pending?t('loading'):t('previewAction')}</Button></div><p className="max-w-prose text-xs text-muted-foreground">{t('previewHelp')}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{t('previewError')}</p>}
  {preview&&<div role="status" className="space-y-2 text-sm"><p>{t('previewCount',{count:preview.total})}</p>{preview.rows.length>0&&<ul className="divide-y divide-border">{preview.rows.map(row=><li key={`${row.employmentId}:${row.from}`} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-medium">{row.name}</span><span className="text-xs text-muted-foreground">{row.from} – {row.to} · {t('asOf',{date:row.asOf??'—'})}</span></li>)}</ul>}{preview.truncated&&<p className="text-xs text-muted-foreground">{t('previewTruncated')}</p>}</div>}
  </div>;
}
