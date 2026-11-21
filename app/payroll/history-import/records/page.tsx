import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {listCompanies} from '@/core/read';
import {payrollHistoryMaintenanceRecords} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import type {PayrollHistoryMaintenanceQuery} from '@/lib/payroll-history-maintenance';
import {HistoryMaintenanceRecords} from '../records-view';
export default async function ImportedHistoryRecordsPage({searchParams}:{searchParams:Promise<{companyId?:string;period?:string;search?:string;offset?:string;includeWithdrawn?:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('payrollHistoryMaintenance'),params=await searchParams;
 const query:PayrollHistoryMaintenanceQuery={companyId:params.companyId||undefined,period:params.period||undefined,search:params.search||undefined,offset:Math.max(0,Math.trunc(Number(params.offset))||0),limit:50,includeWithdrawn:params.includeWithdrawn==='on'};
 const [page,companies]=await Promise.all([payrollHistoryMaintenanceRecords(ctx,query),listCompanies(ctx)]);
 return <div className={pageWideCls}><PageHeader title={t('records')} description={t('impactHelp')} back={{href:'/payroll/history-import',label:t('backImport')}}/><nav className="mb-5 flex flex-wrap gap-4 text-sm"><Link href="/payroll/history-import" className="min-h-11 py-3 text-primary underline">{t('backImport')}</Link><Link href="/payroll/history-import/logs" className="min-h-11 py-3 text-primary underline">{t('log')}</Link></nav><HistoryMaintenanceRecords page={page} query={query} companies={companies}/></div>;
}
