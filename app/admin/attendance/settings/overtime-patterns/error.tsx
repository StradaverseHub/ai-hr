'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {PageHeader,Card,pageWideCls,btnPrimary} from '@/components/ui';

export default function OvertimePatternsError({error,retry}:{error:Error&{digest?:string};retry:()=>void}) {
  const t=useTranslations('overtimePatterns');
  // Next's server digest matches the existing server log. Never expose a SQL error,
  // provider payload, stack or arbitrary error text in a personnel-facing screen.
  const reference=error.digest&&/^[a-zA-Z0-9_-]{1,64}$/.test(error.digest)?error.digest:null;
  return <div className={pageWideCls}>
    <PageHeader title={t('loadFailureTitle')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}}/>
    <Card className="space-y-4 p-6">
      <p role="alert">{t('loadFailureHelp')}</p>
      {reference&&<p className="text-sm text-muted-foreground">{t('supportReference',{reference})}</p>}
      <div className="flex flex-wrap items-center gap-4"><button type="button" className={btnPrimary} onClick={retry}>{t('retryLoad')}</button><Link href="/admin/attendance/settings" className="text-sm text-primary hover:underline">{t('backToSettings')}</Link></div>
    </Card>
  </div>;
}
