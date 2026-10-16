import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listEmployeeMasterReports } from '@/core/employee-master-reports';
import { masterReportCatalogue } from '@/core/employee-master-access';
import { PageHeader } from '@/components/ui';
import { MASTER_STARTERS } from '@/lib/employee-master-starters';
import { MasterReportList } from './MasterReportList';
export const dynamic='force-dynamic';
export default async function EmployeeMasterReportsPage({searchParams}:{searchParams:Promise<{q?:string}>}){
 const {s,scopeIds}=await scopedSession(),{q}=await searchParams,t=await getTranslations('employeeMasterReports');await masterReportCatalogue(s,scopeIds);const reports=await listEmployeeMasterReports(s,scopeIds,{all:true,search:q});
 return <div className="space-y-5"><PageHeader title={t('title')} description={t('subtitle')} back={{href:'/reports',label:t('back')}}/><div className="flex flex-wrap gap-2"><Link className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" href="/reports/employee-master/new">{t('newTitle')}</Link>{MASTER_STARTERS.map(starter=><Link key={starter} href={'/reports/employee-master/new?starter='+starter} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">{t(`starter.${starter}`)}</Link>)}</div><form className="flex gap-2"><input name="q" defaultValue={q} placeholder={t('searchReports')} aria-label={t('searchReports')} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"/><button className="rounded-md border border-border px-3 py-2 text-sm">{t('search')}</button></form><div className="rounded-lg border border-border p-4"><MasterReportList reports={reports}/></div></div>;
}
