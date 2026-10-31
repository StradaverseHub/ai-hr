import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { myReleasedPayslipRuns } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { publicErrorMessage } from '@/lib/public-error';
import { resolvePersonalPayslipSelection } from './selection-state';
import { myPayslipDocument } from './document';
import { PersonalPayslipSelection } from './selection';
import { PersonalPayslipStatement } from './statement';

export default async function MyPayslipPage({searchParams}:{searchParams:Promise<{companyId?:string;year?:string;month?:string;payslipId?:string;review?:string}>}) {
  await requireModule('payroll');
  const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('myPayslip'),pay=await getTranslations('payroll.individualPayslip');
  const locale=await getLocale();
  const result=await myReleasedPayslipRuns(s).then(runs=>({runs,error:undefined})).catch(error=>({runs:[],error:publicErrorMessage(error)}));
  const selection=resolvePersonalPayslipSelection(result.runs,sp);
  const document=selection.payslipId?await myPayslipDocument(s,selection.payslipId):null;
  const choices=result.runs.map(run=>({...run,label:run.cycleName ?? ''}));
  const months=Array.from({length:12},(_,month)=>new Intl.DateTimeFormat(locale,{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2000,month,1))));
  const context=new URLSearchParams({...(selection.companyId?{companyId:selection.companyId}:{}),...(selection.year?{year:String(selection.year)}:{}),...(selection.month?{month:String(selection.month).padStart(2,'0')}:{}),...(selection.payslipId?{payslipId:selection.payslipId}:{})});
  const back=`/me/payslip?${context}`,pdf=document?`/me/payslip/${document.p.id}/pdf`:'';
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={document?[document.p.employeeCode,document.p.employee].filter(Boolean).join(' · '):t('intro')}/>
    <ErrorBanner message={result.error}/>
    {choices.length>0&&<Card className="p-4"><PersonalPayslipSelection key={back} runs={choices} selectedId={selection.payslipId} labels={{company:pay('filterCompany'),year:pay('filterYear'),month:pay('filterMonth'),cycle:t('cycle'),view:pay('viewPayslip'),unavailable:t('unavailableChoice'),help:t('releasedHelp'),months}}/></Card>}
    {!document?<Card className="p-8 text-center text-sm text-muted-foreground">{t('unavailable')}</Card>:sp.review==='1'?<StatutoryPdfViewer title={t('review')} subtitle={`${document.p.company} · ${document.strings.labels.periodLabel}`} pdfUrl={`${pdf}?disposition=inline`} downloads={[{href:pdf,label:t('download')}]} back={{href:back,label:t('back')}} openInNewTabLabel={t('openInNewTab')} frameTitle={t('review')}/>:<PersonalPayslipStatement data={document.data} labels={document.strings.labels} actions={<div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" href={`${back}&review=1`}>{t('review')}</Link><Button asChild className="min-h-11"><Link href={pdf}>{t('download')}</Link></Button></div>}/>}
  </div>;
}
