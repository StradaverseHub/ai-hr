import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requirePerfCompAccess} from '@/lib/authz';
import {getAssessmentAdminReport,assessmentAdminReportLinks} from '@/packs/performance/service';
import {Card,PageHeader} from '@/components/ui';
export default async function PerformanceReportPage({params,searchParams}:{params:Promise<{cycleId:string}>;searchParams:Promise<Record<string,string|undefined>>}){
 const s=await requirePerfCompAccess(),{cycleId}=await params,q=await searchParams,t=await getTranslations('onehr.adminAssistant'),report=await getAssessmentAdminReport(s,cycleId,q),links=assessmentAdminReportLinks(cycleId,report.params);
 return <div className="mx-auto max-w-[1600px] space-y-6"><PageHeader back={{href:`/performance/${cycleId}`,label:t('back')}} title={report.title} description={t('fresh')}/><div className="flex flex-wrap gap-5 text-sm text-primary"><a href={links.csv}>{t('csv')}</a><a href={links.xlsx}>{t('xlsx')}</a><span className="text-muted-foreground">{t('count',{shown:report.rows.length,total:report.total})}</span></div><Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/40"><tr>{report.columns.map(c=><th key={c} className="whitespace-nowrap p-3">{c}</th>)}</tr></thead><tbody className="divide-y divide-border">{report.rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j} className="whitespace-nowrap p-3">{c}</td>)}</tr>)}</tbody></table></div>{!report.rows.length&&<p className="p-8 text-center text-sm text-muted-foreground">{t('empty')}</p>}</Card><Link href={`/performance/${cycleId}`} className="text-sm text-primary">{t('back')}</Link></div>;
}
