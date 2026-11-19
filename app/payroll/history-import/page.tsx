import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {listImportCodes} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {HistoryWorkflow} from './history-workflow';
export default async function PayrollHistoryImportPage(){
 const ctx=await requireAdmin(),t=await getTranslations('payroll.historyImport'),workflow=await getTranslations('payroll.historyRevisions');
 const codes=await listImportCodes(ctx);
 return <div className={pageWideCls}><div className="flex flex-wrap items-start justify-between gap-4"><PageHeader back={{href:'/payroll/transactions',label:t('backLabel')}} title={t('title')} description={workflow('description')}/><Link href="/payroll/history-import/logs" className="inline-flex shrink-0 items-center rounded-lg border px-4 py-2 text-sm font-medium">{workflow('logFile')}</Link></div><HistoryWorkflow codes={codes}/></div>;
}
