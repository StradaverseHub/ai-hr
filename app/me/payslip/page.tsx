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
import { recordPayslipOpened } from '@/core/payroll-audit/access-log';
import { PersonalPayslipSelection } from './selection';
import { PersonalPayslipStatement } from './statement';
import { WhyLink } from '@/components/why/why-panel';
import { DeductionWhy, PayDifferenceWhy } from '@/components/why/sections';
import { PAYSLIP_DEDUCTION_WHY, type PayslipDeductionWhy } from '@/core/pay-difference';

export default async function MyPayslipPage({searchParams}:{searchParams:Promise<{companyId?:string;year?:string;month?:string;payslipId?:string;review?:string;why?:string}>}) {
  await requireModule('payroll');
  const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('myPayslip'),pay=await getTranslations('payroll.individualPayslip');
  const locale=await getLocale();
  const result=await myReleasedPayslipRuns(s).then(runs=>({runs,error:undefined})).catch(error=>({runs:[],error:publicErrorMessage(error)}));
  const selection=resolvePersonalPayslipSelection(result.runs,sp);
  const document=selection.payslipId?await myPayslipDocument(s,selection.payslipId):null;
  // AI v2 P2-2b: the employee opened their own released payslip; the Audit loop counts opens. Best effort, never blocking.
  if(document)await recordPayslipOpened(s,{payslipId:document.p.id,channel:'web'}).catch(()=>null);
  const choices=result.runs.map(run=>({...run,label:run.cycleName ?? ''}));
  const months=Array.from({length:12},(_,month)=>new Intl.DateTimeFormat(locale,{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2000,month,1))));
  const context=new URLSearchParams({...(selection.companyId?{companyId:selection.companyId}:{}),...(selection.year?{year:String(selection.year)}:{}),...(selection.month?{month:String(selection.month).padStart(2,'0')}:{}),...(selection.payslipId?{payslipId:selection.payslipId}:{})});
  const back=`/me/payslip?${context}`,pdf=document?`/me/payslip/${document.p.id}/pdf`:'';
  // AI v2 W5 — "Why?" on the deduction lines and on net pay, each opening its panel in place (`why=deduction:<line>` or
  // `why=pay`). Read only when asked for, from this payslip's own working and the person's own released payslips.
  const tw=await getTranslations('why');
  const why=typeof sp.why==='string'?sp.why:undefined;
  const whyHref=(value:string)=>{const query=new URLSearchParams(context);query.set('why',value);return `/me/payslip?${query}`;};
  const whySlots=document?(()=>{
    const l=document.strings.labels;
    const lineOf=new Map<string,PayslipDeductionWhy>([[l.epf,'epf'],[l.socso,'socso'],[l.skbbk,'skbbk'],[l.eis,'eis'],[l.pcb,'pcb'],[l.unpaidLeaveLine,'unpaidLeave'],[l.absentLine,'absent']]);
    const asked=why?.startsWith('deduction:')?why.slice('deduction:'.length) as PayslipDeductionWhy:null;
    const item=asked&&(PAYSLIP_DEDUCTION_WHY as readonly string[]).includes(asked)?asked:null;
    return {
      deductionLink:(label:string)=>{const key=lineOf.get(label);if(!key)return null;const open=item===key;
        return <WhyLink href={open?back:whyHref(`deduction:${key}`)} text={tw('link')} label={tw('deduction.linkLabel',{name:label})} expanded={open} controls="payslip-why-deduction" className="ms-1 me-auto text-xs"/>;},
      deductionPanel:item?<DeductionWhy session={s} id="payslip-why-deduction" closeHref={back} row={document.p} item={item} period={document.p.payPeriod} currency={document.p.currency}/>:undefined,
      netLink:<WhyLink href={why==='pay'?back:whyHref('pay')} text={tw('pay.linkLabel')} expanded={why==='pay'} controls="payslip-why-pay"/>,
      netPanel:why==='pay'?<PayDifferenceWhy session={s} id="payslip-why-pay" closeHref={back} companyId={document.p.companyId} period={document.p.payPeriod} currency={document.p.currency}/>:undefined,
    };
  })():undefined;
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={document?[document.p.employeeCode,document.p.employee].filter(Boolean).join(' · '):t('intro')}/>
    <ErrorBanner message={result.error}/>
    {choices.length>0&&<Card className="p-4"><PersonalPayslipSelection key={back} runs={choices} selectedId={selection.payslipId} labels={{company:pay('filterCompany'),year:pay('filterYear'),month:pay('filterMonth'),cycle:t('cycle'),view:pay('viewPayslip'),unavailable:t('unavailableChoice'),help:t('releasedHelp'),months}}/></Card>}
    {!document?<Card className="p-8 text-center text-sm text-muted-foreground">{t('unavailable')}</Card>:sp.review==='1'?<StatutoryPdfViewer title={t('review')} subtitle={`${document.p.company} · ${document.strings.labels.periodLabel}`} pdfUrl={`${pdf}?disposition=inline`} downloads={[{href:pdf,label:t('download')}]} back={{href:back,label:t('back')}} openInNewTabLabel={t('openInNewTab')} frameTitle={t('review')}/>:<PersonalPayslipStatement data={document.data} labels={document.strings.labels} why={whySlots} actions={<div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" href={`${back}&review=1`}>{t('review')}</Link><Button asChild className="min-h-11"><Link href={pdf}>{t('download')}</Link></Button></div>}/>}
  </div>;
}
