import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import { PayslipBlock, PayslipInformation, PayslipRow } from '@/components/payslip-sections';
import { payslipPresentationRows, type PayslipPdfData, type PayslipPdfLabels } from '@/lib/payslip-pdf';
import { formatMoney, formatRate } from '@/lib/money';

/** Own-only recorded data, using the Individual Payslip document's shared presentation. */
export function PersonalPayslipStatement({data,labels,actions}:{data:PayslipPdfData;labels:PayslipPdfLabels;actions:ReactNode}) {
  const money=(amount:unknown)=>formatMoney(amount,data.currency);
  const unavailable=labels.periodNotRecorded??'—';
  const periodAmount=(amount:number|null|undefined)=>amount==null?unavailable:money(amount);
  const rows=payslipPresentationRows(data,labels,value=>formatRate(value,data.currency));
  const table=(title:string,items:typeof rows.earnings,total?:{label:string;amount:number},tone:'slate'|'earn'|'deduct'|'other'='slate',note?:string)=><PayslipBlock title={title} tone={tone} aligned>
    <div className="mb-2 grid grid-cols-[2fr_1fr_1fr] gap-2 text-xs text-muted-foreground"><span>{labels.descriptionColumn}</span><span className="text-right">{labels.quantityColumn}</span><span className="text-right">{labels.amountColumn}</span></div>
    {items.map((item,index)=><PayslipRow key={`${item.label}-${index}`} label={item.label}
      quantity={item.quantity?<>{item.quantity}{item.sub&&<span className="block">{item.sub}</span>}</>:undefined}
      value={item.amount==null?item.text??'—':money(item.amount)}/>)}
    {total&&<div className="mt-auto flex justify-between gap-3 border-t border-border pt-3 text-sm font-semibold"><span>{total.label}</span><span className="tabular-nums">{money(total.amount)}</span></div>}
    {note&&<p className="mt-2 text-xs text-muted-foreground">{note}</p>}
  </PayslipBlock>;
  const schemes=[['EPF','epf'],['SOCSO','socso'],['EIS','eis'],['HRDF','hrdf']] as const;
  return <div className="space-y-4">
    <Card className="p-6">
      {labels.confidentialHeading&&<p className="mb-4 text-xs font-semibold">{labels.confidentialHeading}</p>}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-start gap-4">
          {/* The already-authorized document logo; no administrator-only endpoint is exposed to Mine. */}
          {data.logo&&<img src={`data:${data.logo.mimeType};base64,${Buffer.from(data.logo.bytes).toString('base64')}`} alt={data.company} className="max-h-14 w-auto max-w-24 shrink-0 object-contain"/>}
          <div className="min-w-0 self-center"><h2 className="break-words text-xl font-semibold leading-7">{data.company}</h2>
          {data.companyReg&&<p className="text-sm font-medium leading-5 text-muted-foreground">{labels.companyReg}: {data.companyReg}</p>}</div>
        </div>
        <div className="text-left leading-5 sm:text-right"><p className="text-lg font-semibold">{labels.periodLabel}</p><p className="text-xs text-muted-foreground">{labels.payPeriod}</p>{data.payDate&&<p className="mt-1 text-xs text-muted-foreground">{labels.paymentDateLabel?`${labels.paymentDateLabel}: `:''}{labels.paymentDate}</p>}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">{actions}</div>
      </div>
    </Card>
    <PayslipBlock title={labels.employeeProfile??labels.employmentInfo}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">{data.informationRows?.map((row,index)=><PayslipInformation key={`${row.label}-${index}`} label={row.label} value={row.value}/>)}</dl>
    </PayslipBlock>
    <div className="grid items-stretch gap-4 lg:grid-cols-2">
      {table(labels.earnings,rows.earnings,{label:labels.totalEarnings,amount:data.gross},'earn')}
      {table(labels.deductions,rows.deductions,{label:labels.totalDeductions,amount:data.totalDeductions},'deduct')}
    </div>
    <Card className="flex items-baseline justify-between bg-primary px-6 py-5 text-primary-foreground"><span className="text-sm font-semibold uppercase tracking-wide">{labels.netPay}</span><span className="text-2xl font-bold tabular-nums">{money(data.net)}</span></Card>
    {data.nonPayableLines?.length ? table(labels.nonPayable,data.nonPayableLines.map(row=>({label:row.name,amount:row.amount})),undefined,'other',labels.nonPayableNote) : null}
    <div className="grid items-start gap-4 lg:grid-cols-[2fr_3fr]">
      <PayslipBlock title={labels.employerContributions}>
        <table className="w-full text-sm"><thead><tr className="text-xs text-muted-foreground"><th scope="col" className="py-2 text-left">{labels.ytdItem}</th><th scope="col" className="py-2 text-right">{labels.mtdEmployerColumn}</th></tr></thead><tbody>
          {schemes.map(([label,key])=><tr key={key}><th scope="row" className="py-1 text-left font-normal">{label}</th><td className="py-1 text-right tabular-nums">{periodAmount(data.employerPeriodTotals?.mtd[key])}</td></tr>)}
        </tbody></table>{labels.normalEmployerNote&&<p className="mt-2 text-xs text-muted-foreground">{labels.normalEmployerNote}</p>}
      </PayslipBlock>
      <PayslipBlock title={labels.ytdHeading}>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-xs text-muted-foreground"><th scope="col" className="py-2 text-left">{labels.ytdItem}</th><th scope="col" className="py-2 text-right">{labels.ytdEmployeeColumn}</th><th scope="col" className="py-2 text-right">{labels.ytdEmployerColumn}</th></tr></thead><tbody>
          {schemes.map(([label,key])=><tr key={key}><th scope="row" className="py-1 text-left font-normal">{label}</th><td className="py-1 text-right tabular-nums">{key==='hrdf'?'':data.ytd?money(data.ytd[key]):unavailable}</td><td className="py-1 text-right tabular-nums">{periodAmount(data.employerPeriodTotals?.ytd[key])}</td></tr>)}
          {data.ytd&&([[labels.pcb,data.ytd.pcb],[labels.grossPay,data.ytd.gross],[labels.netPay,data.ytd.net]] as const).map(([label,value])=><tr key={label} className="border-t border-border font-medium"><th scope="row" className="py-2 text-left font-normal">{label}</th><td className="py-2 text-right tabular-nums">{money(value)}</td><td/></tr>)}
        </tbody></table></div>
      </PayslipBlock>
    </div>
    {data.configuredEmployerContributions?.length ? table(labels.configuredContributionsHeading??labels.employerContributions,data.configuredEmployerContributions.map(row=>({label:row.name,amount:row.amount}))) : null}
    {data.employerBorne.length>0&&table(labels.employerBorne,data.employerBorne,{label:labels.employerBorneTotal,amount:data.employerBorneTotal},'slate',labels.employerBorneNote)}
    {data.detailNotRecorded&&<p className="text-xs text-muted-foreground">{labels.detailNotRecorded}</p>}
    <div className="space-y-1 text-xs text-muted-foreground">{labels.periodScopeNote&&<p>{labels.periodScopeNote}</p>}{labels.hrContactNote&&<p>{labels.hrContactNote}</p>}<p>{labels.generatedNote}</p></div>
  </div>;
}
